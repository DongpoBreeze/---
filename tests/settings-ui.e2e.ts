import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';

const base = 'https://settings-test.example/v1';
const key = 'fake-settings-key-not-a-real-credential';

test('user selects upstream model and effort, sends directly and keeps credentials out of backup', async ({ page }, info) => {
  const errors: string[] = [];
  const calls: Array<{ url: string; body: any }> = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => { void dialog.accept(); });
  await page.route('**/api/analyze', (route) => { throw new Error('Unexpected development gateway call'); });
  await page.route(`${base}/**`, async (route) => {
    const request = route.request();
    expect(request.headers().authorization).toBe(`Bearer ${key}`);
    if (request.method() === 'GET') {
      await route.fulfill({ json: { data: [{ id: 'vision-test', supported_reasoning_efforts: ['low', 'max'] }] } });
      return;
    }
    const body = request.postDataJSON();
    calls.push({ url: request.url(), body });
    await route.fulfill({ json: {
      status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: JSON.stringify({ text: '来自用户所选服务的总结' }) }] }],
    } });
  });
  await page.goto('/');
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  await page.getByText('AI 服务设置', { exact: true }).click();
  await page.getByLabel('API 地址', { exact: true }).fill(base);
  await page.getByLabel('API Key', { exact: true }).fill(key);
  await expect(page.getByLabel('API Key', { exact: true })).toHaveAttribute('type', 'password');
  await page.getByText('获取模型列表', { exact: true }).click();
  await page.getByRole('radio', { name: '模型 vision-test', exact: true }).click();
  await page.getByRole('radio', { name: '推理强度 max', exact: true }).click();
  await page.screenshot({ path: info.outputPath('upstream-settings.png'), fullPage: true });
  await page.getByRole('dialog').getByText('保存', { exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('vision-test · max', { exact: true })).toBeVisible();
  await page.getByText('AI 服务设置', { exact: true }).click();
  await expect(page.getByLabel('API 地址', { exact: true })).toHaveValue(base);
  await expect(page.getByLabel('API Key', { exact: true })).toHaveValue(key);
  await page.getByRole('dialog').getByLabel('关闭', { exact: true }).click();
  await page.getByRole('tab', { name: '今天', exact: true }).click();
  await page.getByText('记饮食', { exact: true }).click();
  await page.getByLabel('食物名称', { exact: true }).fill('用户配置测试餐');
  await page.getByRole('dialog').getByText('保存', { exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByText('请求 AI 综合分析', { exact: true }).click();
  await expect(page.getByText('AI 总结已保存为独立版本。', { exact: true })).toBeVisible();
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe(`${base}/responses`);
  expect(calls[0].body).toMatchObject({ model: 'vision-test', reasoning: { effort: 'max' } });
  expect(JSON.stringify(calls[0].body)).not.toContain(key);
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByText('导出完整备份', { exact: true }).click();
  const download = await downloadPromise;
  const archive = await JSZip.loadAsync(await readFile((await download.path())!));
  for (const file of Object.values(archive.files)) {
    if (!file.dir) expect(await file.async('string')).not.toContain(key);
  }
  await page.getByText('AI 服务设置', { exact: true }).click();
  await page.getByText('删除 AI 配置', { exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('尚未配置', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '我的', exact: true }).click();
  await page.getByRole('button', { name: '全部记录', exact: true }).click();
  await expect(page.getByText('用户配置测试餐', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});

test('missing capability metadata uses default and stale discovery cannot restore old choices', async ({ page }, info) => {
  let release: (() => Promise<void>) | undefined;
  let delay = false;
  await page.route(`${base}/**`, async (route) => {
    if (route.request().url().endsWith('/models/basic-model')) {
      await route.fulfill({ json: { id: 'basic-model' } }); return;
    }
    const respond = () => route.fulfill({ json: { data: [{ id: 'basic-model' }] } });
    if (delay) release = respond;
    else await respond();
  });
  await page.goto('/');
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  await page.getByText('AI 服务设置', { exact: true }).click();
  await page.getByLabel('API 地址', { exact: true }).fill(base);
  await page.getByLabel('API Key', { exact: true }).fill(key);
  await page.getByText('获取模型列表', { exact: true }).click();
  await page.getByRole('radio', { name: '模型 basic-model', exact: true }).click();
  await expect(page.getByText('上游未提供推理强度，可使用服务默认或自定义填写。', { exact: true })).toBeVisible();
  await expect(page.getByRole('radio', { name: '推理强度 服务默认', exact: true })).toBeVisible();
  await expect(page.getByRole('radio', { name: '推理强度 max', exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('missing-capabilities.png'), fullPage: true });
  delay = true;
  await page.getByText('获取模型列表', { exact: true }).click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await page.getByLabel('API 地址', { exact: true }).fill('https://changed.example/v1');
  await release!().catch(() => undefined);
  await expect(page.getByRole('radio', { name: '模型 basic-model', exact: true })).toHaveCount(0);
  await expect(page.getByRole('dialog').getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await page.getByLabel('API 地址', { exact: true }).fill('http://insecure.example/v1');
  await page.getByText('获取模型列表', { exact: true }).click();
  await expect(page.getByText('获取失败，请检查 HTTPS 地址、Key 和接口权限。', { exact: true })).toBeVisible();
  await page.getByRole('dialog').getByLabel('关闭', { exact: true }).click();
  await expect(page.getByText('尚未配置', { exact: true })).toBeVisible();
});
