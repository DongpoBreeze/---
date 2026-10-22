import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { parseBackupArchive } from '../src/backup';
import { installMockAiProvider, MOCK_AI_KEY, MOCK_AI_URL, openAiSettings, saveAiSettingsUi } from './helpers/mock-ai-provider';

const model = 'persistence-model';
const effort = 'Vendor.Max-2_1';
const aiDatabase = 'health-compass-ai-settings-v1';
const aiKey = 'health-compass.ai-settings.v1';

function captureErrors(page: Page, errors: string[] = []) {
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  return errors;
}

async function corruptSavedConnection(page: Page) {
  await page.evaluate(async (databaseName) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('Unable to prepare corrupt test settings'));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('settings', 'readwrite');
        tx.objectStore('settings').put('{broken', 'health-compass.ai-settings.v1');
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(new Error('Unable to prepare corrupt test settings'));
      });
    } finally { db.close(); }
  }, aiDatabase);
}

async function mockProvider(page: Page) {
  return installMockAiProvider(page, {
    models: [{ id: model, supported_reasoning_efforts: ['high'] }],
    onResponse: async (route) => { await route.abort(); throw new Error('Persistence tests must not invoke inference.'); },
  });
}

async function saveConnection(page: Page, protocol: 'responses' | 'chat_completions' = 'responses', alreadyOpen = false) {
  const dialog = alreadyOpen ? page.getByRole('dialog') : await openAiSettings(page);
  await dialog.getByLabel('API 地址', { exact: true }).fill(MOCK_AI_URL);
  await dialog.getByLabel('API Key', { exact: true }).fill(MOCK_AI_KEY);
  await dialog.getByRole('button', { name: protocol === 'responses' ? 'Responses' : 'Chat Completions', exact: true }).click();
  await dialog.getByText('获取模型列表', { exact: true }).click();
  await dialog.getByRole('radio', { name: `模型 ${model}`, exact: true }).click();
  await dialog.getByRole('radio', { name: '推理强度 自定义', exact: true }).click();
  await dialog.getByLabel('自定义推理强度', { exact: true }).fill(effort);
  await saveAiSettingsUi(page);
  await expect(page.getByText('AI 配置已保存到本机。', { exact: true })).toBeVisible();
}

async function saveProfile(page: Page) {
  await page.getByRole('tab', { name: '我的', exact: true }).click();
  await page.getByText('修改目标与资料', { exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '减脂', exact: true }).click();
  await dialog.getByLabel('身高（cm，可选）', { exact: true }).fill('173.5');
  await dialog.getByLabel('体重（kg，可选）', { exact: true }).fill('67.2');
  await dialog.getByLabel('每日热量目标（kcal，可选）', { exact: true }).fill('2100');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('目标与身高体重已保存到本机。', { exact: true })).toBeVisible();
}

async function verifyProfile(page: Page) {
  await page.getByRole('tab', { name: '我的', exact: true }).click();
  await expect(page.getByText('减脂', { exact: true })).toBeVisible();
  await page.getByText('修改目标与资料', { exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('身高（cm，可选）', { exact: true })).toHaveValue('173.5');
  await expect(dialog.getByLabel('体重（kg，可选）', { exact: true })).toHaveValue('67.2');
  await expect(dialog.getByLabel('每日热量目标（kcal，可选）', { exact: true })).toHaveValue('2100');
  await dialog.getByLabel('关闭', { exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

async function verifyConnection(page: Page, protocol: 'responses' | 'chat_completions') {
  const dialog = await openAiSettings(page);
  await expect(dialog.getByLabel('API 地址', { exact: true })).toHaveValue(MOCK_AI_URL);
  await expect(dialog.getByLabel('API Key', { exact: true })).toHaveValue(MOCK_AI_KEY);
  await expect(dialog.getByLabel('API Key', { exact: true })).toHaveAttribute('type', 'password');
  // React Native Web omits selected state for button roles; verify the saved
  // protocol directly while checking the restored form fields above/below.
  const protocolRestored = await page.evaluate(async ({ databaseName, key, expected }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('Unable to verify saved protocol'));
    });
    try {
      return await new Promise<boolean>((resolve, reject) => {
        const request = db.transaction('settings').objectStore('settings').get(key);
        request.onsuccess = () => resolve(JSON.parse(request.result).protocol === expected);
        request.onerror = () => reject(new Error('Unable to verify saved protocol'));
      });
    } finally { db.close(); }
  }, { databaseName: aiDatabase, key: aiKey, expected: protocol });
  expect(protocolRestored).toBe(true);
  await expect(dialog.getByText(model, { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('自定义推理强度', { exact: true })).toHaveValue(effort);
  await dialog.getByLabel('关闭', { exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

for (const protocol of ['responses', 'chat_completions'] as const) {
  test(`${protocol} settings and health profile survive refresh and a full browser restart at the same origin`, async ({ playwright }, info) => {
    // Covers two browser launches, refreshes, export, another origin and deletion.
    // Keep this end-to-end budget independent of the App's provider timeout.
    test.setTimeout(240_000);
    const userDataDir = await mkdtemp(join(tmpdir(), 'health-compass-settings-'));
    const baseURL = String(info.project.use.baseURL ?? 'http://localhost:8081');
    const errors: string[] = [];
    let context: BrowserContext | undefined;
    const launch = async () => {
      context = await playwright.chromium.launchPersistentContext(userDataDir, {
        channel: info.project.use.channel, headless: true, args: ['--no-proxy-server'],
        baseURL, viewport: info.project.use.viewport, isMobile: info.project.use.isMobile,
        hasTouch: info.project.use.hasTouch, locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
      });
      const page = context.pages()[0] ?? await context.newPage();
      page.on('dialog', (dialog) => { void dialog.accept(); });
      captureErrors(page, errors);
      return page;
    };
    try {
      let page = await launch();
      const initialProvider = await mockProvider(page);
      await page.goto('/');
      await saveConnection(page, protocol);
      await saveProfile(page);
      await page.reload();
      await verifyConnection(page, protocol);
      await verifyProfile(page);
      await page.getByRole('tab', { name: '设置', exact: true }).click();
      const downloadPromise = page.waitForEvent('download');
      await page.getByText('导出完整备份', { exact: true }).click();
      const download = await downloadPromise;
      const backup = await parseBackupArchive(new Uint8Array(await readFile((await download.path())!)));
      expect(JSON.stringify(backup)).not.toContain(MOCK_AI_KEY);
      expect(JSON.stringify(backup)).not.toContain(MOCK_AI_URL);
      expect(backup.data.profile).toEqual({ goal: 'fat-loss', heightCm: 173.5, weightKg: 67.2, calorieTarget: 2100 });
      expect(initialProvider.responses()).toHaveLength(0);
      await context!.close(); context = undefined;

      page = await launch();
      const reopenedProvider = await mockProvider(page);
      await page.goto('/');
      await verifyConnection(page, protocol);
      await verifyProfile(page);
      await page.screenshot({ path: info.outputPath(`${protocol}-profile-after-browser-restart.png`), fullPage: true });

      // The host is part of the storage origin; do not silently migrate a Key.
      const otherOrigin = new URL(baseURL);
      otherOrigin.hostname = otherOrigin.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
      await page.goto(otherOrigin.href);
      await page.getByRole('tab', { name: '设置', exact: true }).click();
      await expect(page.getByText('尚未配置', { exact: true })).toBeVisible();
      await page.getByRole('tab', { name: '我的', exact: true }).click();
      await page.getByText('修改目标与资料', { exact: true }).click();
      await expect(page.getByRole('dialog').getByLabel('身高（cm，可选）', { exact: true })).toHaveValue('');
      await expect(page.getByRole('dialog').getByLabel('体重（kg，可选）', { exact: true })).toHaveValue('');
      await page.goto(baseURL);
      await verifyConnection(page, protocol);
      await verifyProfile(page);

      await openAiSettings(page);
      await page.getByRole('dialog').getByText('删除 AI 配置', { exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.reload();
      await page.getByRole('tab', { name: '设置', exact: true }).click();
      await expect(page.getByText('尚未配置', { exact: true })).toBeVisible();
      await verifyProfile(page);
      expect(reopenedProvider.requests).toHaveLength(0);
      expect(errors).toEqual([]);
      await info.attach('persistence-result', {
        contentType: 'application/json', body: JSON.stringify({ protocol, keyRecovered: true, otherFieldsRecovered: 4, profileFieldsRecovered: 4, browserRestart: true, backupExcludesCredentials: true, otherOriginIsolated: true, inferenceRequests: 0 }),
      });
    } finally {
      await context?.close();
      const absolute = resolve(userDataDir);
      if (!absolute.startsWith(`${resolve(tmpdir())}${sep}`) || !basename(absolute).startsWith('health-compass-settings-')) throw new Error('Unexpected browser test directory.');
      await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}

test('slow AI initialization and read failure keep offline profile usable and restore credentials without clearing storage', async ({ page }) => {
  test.setTimeout(150_000);
  const errors = captureErrors(page);
  page.on('dialog', (dialog) => { void dialog.accept(); });
  const provider = await mockProvider(page);
  await page.goto('/');
  await saveConnection(page);
  await saveProfile(page);
  await page.addInitScript((databaseName) => {
    const open = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (name, version) {
      const mode = sessionStorage.getItem('test-ai-read-fault') ?? 'delay';
      if (name === databaseName && mode === 'deny') throw new DOMException('simulated read denial', 'SecurityError');
      const request = version === undefined ? open.call(this, name) : open.call(this, name, version);
      if (name === databaseName && mode === 'delay') {
        request.addEventListener('success', (event) => {
          event.stopImmediatePropagation();
          (window as any).__releaseAiSettingsRead = () => {
            sessionStorage.setItem('test-ai-read-fault', 'none');
            request.onsuccess?.call(request, event);
          };
        }, { once: true });
      }
      return request;
    };
    (window as any).__restoreAiSettingsRead = () => {
      sessionStorage.setItem('test-ai-read-fault', 'none');
      IDBFactory.prototype.open = open;
    };
  }, aiDatabase);
  await page.reload();
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  await expect(page.getByText('读取中', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '今天', exact: true }).click();
  await page.getByText('请求 AI 综合分析', { exact: true }).click();
  await expect(page.getByText('正在读取本机 AI 配置，请稍后重试。', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => typeof (window as any).__releaseAiSettingsRead === 'function')).toBe(true);
  await page.evaluate(() => (window as any).__releaseAiSettingsRead());
  await verifyConnection(page, 'responses');
  await verifyProfile(page);
  await page.evaluate(() => sessionStorage.setItem('test-ai-read-fault', 'deny'));
  await page.reload();
  await expect(page.getByText(/读取 AI 设置失败：.*原配置未清除/)).toBeVisible();
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  await expect(page.getByText('读取失败，点此重试', { exact: true })).toBeVisible();
  await expect(page.getByText('尚未配置', { exact: true })).toHaveCount(0);
  await verifyProfile(page);
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  await page.getByText('AI 服务设置', { exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('读取失败，点此重试', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).__restoreAiSettingsRead());
  await page.getByRole('button', { name: '重试读取 AI 设置', exact: true }).click();
  await expect(page.getByText(`${model} · ${effort}`, { exact: true })).toBeVisible();
  await verifyConnection(page, 'responses');
  await corruptSavedConnection(page);
  await page.reload();
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  await expect(page.getByText(/已保存的 AI 设置无效/)).toBeVisible();
  await page.getByRole('button', { name: '重新配置 AI 服务', exact: true }).click();
  await expect(page.getByRole('dialog').getByText(/原存储仍保留/)).toBeVisible();
  await saveConnection(page, 'responses', true);
  await verifyConnection(page, 'responses');
  await verifyProfile(page);
  await corruptSavedConnection(page);
  await page.reload();
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  await expect(page.getByRole('button', { name: '重新配置 AI 服务', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '重新配置 AI 服务', exact: true }).click();
  await page.getByRole('dialog').getByText('删除 AI 配置', { exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  await expect(page.getByText('尚未配置', { exact: true })).toBeVisible();
  await verifyProfile(page);
  expect(provider.responses()).toHaveLength(0);
  expect(errors).toEqual([]);
});

test('aborted write transactions keep previous AI and profile values and leave failed edits visible', async ({ page }) => {
  const errors = captureErrors(page);
  await mockProvider(page);
  await page.goto('/');
  await saveConnection(page);
  await saveProfile(page);
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    (window as any).__settingsWriteFault = 'ai';
    (window as any).__settingsRequestsAbortedAfterSuccess = 0;
    IDBObjectStore.prototype.put = function (value, key) {
      const request = key === undefined ? put.call(this, value) : put.call(this, value, key);
      const fault = (window as any).__settingsWriteFault;
      if ((fault === 'ai' && this.name === 'settings') || (fault === 'profile' && this.name === 'snapshots' && key === '@health-compass/data-v1')) {
        const tx = this.transaction;
        request.addEventListener('success', () => {
          (window as any).__settingsRequestsAbortedAfterSuccess += 1;
          tx.abort();
        }, { once: true });
      }
      return request;
    };
  });
  const dialog = await openAiSettings(page);
  await dialog.getByLabel('自定义推理强度', { exact: true }).fill('new-unsaved-effort');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog.getByText(/保存 AI 配置失败：.*原配置已保留/)).toBeVisible();
  await expect(dialog.getByLabel('自定义推理强度', { exact: true })).toHaveValue('new-unsaved-effort');
  await expect(page.getByText('AI 配置已保存到本机。', { exact: true })).toHaveCount(0);
  const unchanged = await page.evaluate(async ({ databaseName, key, expectedEffort }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error('Unable to verify test storage'));
    });
    try {
      return await new Promise<boolean>((resolve, reject) => {
        const request = db.transaction('settings').objectStore('settings').get(key);
        request.onsuccess = () => resolve(JSON.parse(request.result).reasoningEffort === expectedEffort);
        request.onerror = () => reject(new Error('Unable to verify test storage'));
      });
    } finally { db.close(); }
  }, { databaseName: aiDatabase, key: aiKey, expectedEffort: effort });
  expect(unchanged).toBe(true);
  await dialog.getByLabel('关闭', { exact: true }).click();
  await page.evaluate(() => { (window as any).__settingsWriteFault = 'profile'; });
  await page.getByRole('tab', { name: '我的', exact: true }).click();
  await page.getByText('修改目标与资料', { exact: true }).click();
  await dialog.getByLabel('身高（cm，可选）', { exact: true }).fill('190');
  await dialog.getByLabel('体重（kg，可选）', { exact: true }).fill('90');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog.getByText(/浏览器存储空间不足或写入失败/)).toBeVisible();
  await expect(dialog.getByLabel('身高（cm，可选）', { exact: true })).toHaveValue('190');
  await expect(dialog.getByLabel('体重（kg，可选）', { exact: true })).toHaveValue('90');
  await expect(page.getByText('目标与身高体重已保存到本机。', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__settingsRequestsAbortedAfterSuccess)).toBe(2);
  await dialog.getByLabel('关闭', { exact: true }).click();
  await page.reload();
  await verifyConnection(page, 'responses');
  await verifyProfile(page);
  expect(errors).toEqual([]);
});

test('empty saved and unreadable AI settings forms render without console errors', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = captureErrors(page);
  page.on('dialog', (dialog) => { void dialog.accept(); });
  const provider = await mockProvider(page);
  await page.goto('/');
  const dialog = await openAiSettings(page);
  await expect(dialog.getByText('删除 AI 配置', { exact: true })).toHaveCount(0);
  await dialog.getByLabel('关闭', { exact: true }).click();
  await saveConnection(page);
  await openAiSettings(page);
  await expect(dialog.getByText('删除 AI 配置', { exact: true })).toBeVisible();
  await dialog.getByLabel('关闭', { exact: true }).click();
  await corruptSavedConnection(page);
  await page.reload();
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '重新配置 AI 服务', exact: true }).click();
  await expect(dialog.getByText(/原存储仍保留/)).toBeVisible();
  await dialog.getByText('删除 AI 配置', { exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await openAiSettings(page);
  await expect(dialog.getByText('删除 AI 配置', { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel('API Key', { exact: true })).toHaveValue('');
  expect(provider.responses()).toHaveLength(0);
  expect(errors).toEqual([]);
});
