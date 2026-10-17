import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { parseBackupArchive } from '../src/backup';
import {
  configureMockAi, fulfillProviderJson, fulfillProviderResponse, installMockAiProvider,
  MOCK_AI_KEY, MOCK_AI_URL, openAiSettings, saveAiSettingsUi,
  mockNutritionEstimate,
} from './helpers/mock-ai-provider';

test('configured provider and upstream effort drive analysis while keys stay out of health backups', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => { void dialog.accept(); });
  const provider = await installMockAiProvider(page, {
    models: [{ id: 'settings-model', supported_reasoning_efforts: ['medium', 'high'] }],
    onResponse: async (route) => fulfillProviderResponse(route, {
      foodName: '已确认熟白米饭',
      components: [{ foodId: 'rice_white_long_grain_cooked', label: '熟白米饭',
        nutritionEstimate: mockNutritionEstimate(), uncertainty: [] }],
      unresolved: [], assumptions: ['每道菜数量需要用户另行填写。'], advice: '填写实际食用量后查看小计。',
    }),
  });
  await page.goto('/');
  const dialog = await openAiSettings(page);
  await expect(dialog.getByLabel('API 地址', { exact: true })).toHaveValue('https://api.bblabu.ai/v1');
  await expect(dialog.getByLabel('API Key', { exact: true })).toHaveValue('');
  expect(provider.requests).toHaveLength(0);
  await dialog.getByLabel('API 地址', { exact: true }).fill(MOCK_AI_URL);
  await dialog.getByLabel('API Key', { exact: true }).fill(MOCK_AI_KEY);
  await expect(dialog.getByLabel('API Key', { exact: true })).toHaveAttribute('type', 'password');
  await dialog.getByLabel('显示 Key', { exact: true }).click();
  await expect.poll(() => dialog.getByLabel('API Key', { exact: true })
    .evaluate((input: HTMLInputElement) => input.type)).toBe('text');
  await dialog.getByLabel('隐藏 Key', { exact: true }).click();
  await expect(dialog.getByLabel('API Key', { exact: true })).toHaveAttribute('type', 'password');
  await dialog.getByText('获取模型列表', { exact: true }).click();
  await dialog.getByRole('radio', { name: '模型 settings-model', exact: true }).click();
  await dialog.getByRole('radio', { name: '推理强度 high', exact: true }).click();
  await expect(dialog.getByRole('radio', { name: '推理强度 high', exact: true })).toBeChecked();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('selected-upstream-model.png'), fullPage: true });
  await saveAiSettingsUi(page);
  await expect(page.getByText('settings-model · high', { exact: true })).toBeVisible();
  await openAiSettings(page);
  await expect(dialog.getByLabel('API 地址', { exact: true })).toHaveValue(MOCK_AI_URL);
  await expect(dialog.getByLabel('API Key', { exact: true })).toHaveValue(MOCK_AI_KEY);
  await expect(dialog.getByLabel('API Key', { exact: true })).toHaveAttribute('type', 'password');
  await expect(dialog.getByText('high（已保存；能力尚未刷新）', { exact: true })).toBeVisible();
  await dialog.getByLabel('关闭', { exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('tab', { name: '今天', exact: true }).click();
  await page.getByText('记饮食', { exact: true }).click();
  await page.getByLabel('食物名称', { exact: true }).fill('设置验收米饭');
  await page.getByLabel('份量或参考物（可选）', { exact: true }).fill('已称重 200g');
  await page.getByLabel('剩余量（可选）', { exact: true }).fill('吃下 50%，无其他油酱料');
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('tab', { name: '记录', exact: true }).click();
  await page.getByLabel('请求饮食分析', { exact: true }).click();
  await expect(page.getByText('这餐的分析已保存为独立版本。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /设置验收米饭 午餐/ }).click();
  await expect(page.getByRole('dialog').getByText('当前分析', { exact: true })).toBeVisible();
  await page.getByRole('dialog').getByText(/热量.*130 kcal/).scrollIntoViewIfNeeded();
  await expect(page.getByRole('dialog').getByText(/热量.*130 kcal/)).toBeVisible();
  await expect(page.getByText('待填写菜品数量', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('direct-provider-ai-reference.png'), fullPage: true });
  await page.getByRole('dialog').getByLabel('关闭', { exact: true }).click();
  await page.getByRole('tab', { name: '我的', exact: true }).click();
  const downloadEvent = page.waitForEvent('download');
  await page.getByText('导出完整备份', { exact: true }).click();
  const download = await downloadEvent;
  await download.saveAs(testInfo.outputPath('health-without-ai-key.zip'));
  const backup = await parseBackupArchive(new Uint8Array(await readFile(testInfo.outputPath('health-without-ai-key.zip'))));
  expect(JSON.stringify(backup)).not.toContain(MOCK_AI_KEY);
  expect(JSON.stringify(backup)).not.toContain(MOCK_AI_URL);
  expect(backup.data.meals[0].analyses?.[0]).toMatchObject({
    model: 'settings-model', analysis: { status: 'unknown', calories: null,
      components: [{ userQuantity: null, source: { provider: 'model', model: 'settings-model', basisGrams: 100 } }],
      nutritionSource: { provider: 'model', coverage: 'incomplete', method: 'ai-per100g-v3' } },
  });
  const response = provider.responses()[0];
  expect(response.body).toMatchObject({ model: 'settings-model', reasoning: { effort: 'high' }, store: false });
  expect(response.url).toBe(`${MOCK_AI_URL}/responses`);
  expect(response.authorization).toBe(`Bearer ${MOCK_AI_KEY}`);
  expect(JSON.stringify(response.body)).not.toContain(MOCK_AI_KEY);
  await openAiSettings(page);
  await dialog.getByText('删除 AI 配置', { exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('尚未配置', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '记录', exact: true }).click();
  await expect(page.getByText('设置验收米饭', { exact: true })).toBeVisible();
  await configureMockAi(page, 'settings-model', 'high');
  await page.reload();
  await openAiSettings(page);
  await expect(dialog.getByLabel('API 地址', { exact: true })).toHaveValue('https://api.bblabu.ai/v1');
  await expect(dialog.getByLabel('API Key', { exact: true })).toHaveValue('');
  await expect(dialog.getByText('删除 AI 配置', { exact: true })).toHaveCount(0);
  const localStorageText = await page.evaluate(() => JSON.stringify(Object.entries(localStorage)));
  expect(localStorageText).not.toContain(MOCK_AI_KEY);
  expect(localStorageText).not.toContain(MOCK_AI_URL);
  expect(provider.legacyRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test('changing connection cancels late discovery and absent upstream effort uses service default', async ({ page }, testInfo) => {
  page.on('dialog', (dialog) => { void dialog.accept(); });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let delayModels = false;
  let rejectModels = false;
  let releaseModels: (() => Promise<void>) | undefined;
  const provider = await installMockAiProvider(page, {
    onModels: async (route) => {
      if (rejectModels) {
        await fulfillProviderJson(route, { error: { message: 'mock access rejection' } }, 401);
        return;
      }
      if (delayModels) releaseModels = async () => {
        await fulfillProviderJson(route, { data: [{ id: 'stale-model', supported_reasoning_efforts: ['high'] }] });
      };
      else await fulfillProviderJson(route, { data: [{ id: 'default-model' }, { id: 'detail-model' }] });
    },
    details: { 'detail-model': { id: 'detail-model', supported_reasoning_efforts: ['low', 'max'] } },
    onResponse: async (route) => fulfillProviderResponse(route, { text: '服务默认强度测试总结' }),
  });
  await page.goto('/');
  const dialog = await openAiSettings(page);
  await dialog.getByLabel('API 地址', { exact: true }).fill('http://provider.example/v1');
  await dialog.getByLabel('API Key', { exact: true }).fill(MOCK_AI_KEY);
  await dialog.getByText('获取模型列表', { exact: true }).click();
  await expect(dialog.getByText('获取失败，请检查 HTTPS 地址、Key 和接口权限。', { exact: true })).toBeVisible();
  expect(provider.requests).toHaveLength(0);
  await dialog.getByLabel('API 地址', { exact: true }).fill(MOCK_AI_URL);
  rejectModels = true;
  await dialog.getByText('获取模型列表', { exact: true }).click();
  await expect(dialog.getByText('获取失败，请检查 HTTPS 地址、Key 和接口权限。', { exact: true })).toBeVisible();
  rejectModels = false;
  delayModels = true;
  await dialog.getByText('获取模型列表', { exact: true }).click();
  await expect.poll(() => Boolean(releaseModels)).toBe(true);
  await expect(dialog.getByText('取消获取', { exact: true })).toBeVisible();
  await dialog.getByLabel('API 地址', { exact: true }).fill('https://provider.example/v2');
  await expect(dialog.getByText('取消获取', { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await releaseModels!().catch(() => undefined);
  delayModels = false;
  await dialog.getByText('获取模型列表', { exact: true }).click();
  await dialog.getByRole('radio', { name: '模型 detail-model', exact: true }).click();
  await expect(dialog.getByText('已获取推理强度', { exact: true })).toBeVisible();
  await dialog.getByRole('radio', { name: '推理强度 max', exact: true }).click();
  await expect(dialog.getByRole('radio', { name: '推理强度 max', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(dialog.getByRole('radio', { name: '模型 stale-model', exact: true })).toHaveCount(0);
  expect(provider.requests.some((request) => request.url.endsWith('/v2/models/detail-model'))).toBe(true);
  await dialog.getByRole('button', { name: 'Chat Completions', exact: true }).click();
  await expect(dialog.getByRole('radio', { name: '推理强度 max', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Responses', exact: true }).click();
  await dialog.getByText('获取模型列表', { exact: true }).click();
  await dialog.getByRole('radio', { name: '模型 default-model', exact: true }).click();
  await expect(dialog.getByText('上游未提供推理强度，使用服务默认值。', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('radio', { name: /^推理强度 / })).toHaveCount(1);
  await expect(dialog.getByRole('radio', { name: '推理强度 服务默认', exact: true })).toHaveAttribute('aria-checked', 'true');
  await dialog.getByRole('radio', { name: '推理强度 服务默认', exact: true }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('service-default-effort.png'), fullPage: true });
  await saveAiSettingsUi(page);
  await page.getByRole('tab', { name: '今天', exact: true }).click();
  await page.getByText('记饮食', { exact: true }).click();
  await page.getByLabel('食物名称', { exact: true }).fill('默认强度原始记录');
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByText('请求 AI 综合分析', { exact: true }).click();
  await expect(page.getByText('AI 总结已保存为独立版本。', { exact: true })).toBeVisible();
  const response = provider.responses()[0];
  expect(response.url).toBe('https://provider.example/v2/responses');
  expect(response.body?.model).toBe('default-model');
  expect(response.body).not.toHaveProperty('reasoning');
  expect(response.record?.kind).toBe('summary');
  expect(response.authorization).toBe(`Bearer ${MOCK_AI_KEY}`);
  expect(provider.legacyRequests).toEqual([]);
  expect(errors).toEqual([]);
});
