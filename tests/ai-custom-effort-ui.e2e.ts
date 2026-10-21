import { expect, test, type Page } from '@playwright/test';
import { confirmAndSaveMealReview } from './helpers/saved-meal-review';
import {
  fulfillProviderJson, fulfillProviderResponse, installMockAiProvider, mockNutritionEstimate,
  MOCK_AI_KEY, MOCK_AI_URL, openAiSettings, saveAiSettingsUi,
} from './helpers/mock-ai-provider';

const customEffort = 'Vendor.Ultra-2_0';
const { basisGrams: _basis, ...nutritionEstimate } = mockNutritionEstimate();
const mealResult = {
  components: [{ label: '熟米饭', cookingMethod: '蒸煮', confidence: 0.95, nutritionEstimate, uncertainty: [] }],
  uncertainty: [],
};

test.beforeEach(async ({ page }) => {
  page.on('dialog', (dialog) => { void dialog.accept(); });
});

async function chooseModel(page: Page, model: string, protocol = 'responses') {
  const dialog = await openAiSettings(page);
  await dialog.getByLabel('API 地址', { exact: true }).fill(MOCK_AI_URL);
  await dialog.getByLabel('API Key', { exact: true }).fill(MOCK_AI_KEY);
  if (protocol === 'chat_completions') await dialog.getByRole('button', { name: 'Chat Completions', exact: true }).click();
  await dialog.getByText('获取模型列表', { exact: true }).click();
  await dialog.getByRole('radio', { name: `模型 ${model}`, exact: true }).click();
  await expect(dialog.getByText(model, { exact: true })).toHaveCount(2);
  return dialog;
}

async function addMeal(page: Page, name: string) {
  await page.getByRole('tab', { name: '今天', exact: true }).click();
  await page.getByText('记饮食', { exact: true }).click();
  await page.getByLabel('食物名称', { exact: true }).fill(name);
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

for (const protocol of ['responses', 'chat_completions'] as const) {
  test(`${protocol}: custom effort persists across reopening and model refresh, then drives meal and summary requests`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const provider = await installMockAiProvider(page, {
      models: [{ id: 'custom-model', supported_reasoning_efforts: ['low', 'high'] }],
      onResponse: async (route, request) => {
        const reply = request.record?.kind === 'summary' ? { text: '使用自定义强度的总结' } : mealResult;
        if (protocol === 'responses') await fulfillProviderResponse(route, reply);
        else await fulfillProviderJson(route, { choices: [{ index: 0, finish_reason: 'stop',
          message: { role: 'assistant', content: JSON.stringify(reply) } }] });
      },
    });
    await page.goto('/');
    const dialog = await chooseModel(page, 'custom-model', protocol);
    await expect(dialog.getByRole('radio', { name: '推理强度 high', exact: true })).toBeVisible();
    await dialog.getByRole('radio', { name: '推理强度 自定义', exact: true }).click();
    await dialog.getByLabel('自定义推理强度', { exact: true }).fill(customEffort);
    await expect(dialog.getByRole('radio', { name: '推理强度 自定义', exact: true })).toBeChecked();
    await expect(dialog.getByRole('radio', { name: '推理强度 high', exact: true })).not.toBeChecked();
    await saveAiSettingsUi(page);
    await expect(page.getByText(`custom-model · ${customEffort}`, { exact: true })).toBeVisible();
    await openAiSettings(page);
    await expect(dialog.getByLabel('自定义推理强度', { exact: true })).toHaveValue(customEffort);
    await expect(dialog.getByRole('radio', { name: '推理强度 自定义', exact: true })).toBeChecked();
    await dialog.getByText('获取模型列表', { exact: true }).click();
    await expect(dialog.getByText('已获取 1 个模型，保留当前模型与推理强度。', { exact: true })).toBeVisible();
    await expect(dialog.getByLabel('自定义推理强度', { exact: true })).toHaveValue(customEffort);
    await dialog.getByRole('radio', { name: '模型 custom-model', exact: true }).click();
    await expect(dialog.getByLabel('自定义推理强度', { exact: true })).toHaveValue(customEffort);
    await dialog.getByLabel('自定义推理强度', { exact: true }).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    await page.screenshot({ path: info.outputPath('custom-effort-restored.png'), fullPage: true });
    await dialog.getByLabel('关闭', { exact: true }).click();
    await addMeal(page, '自定义强度米饭');
    await page.getByText('请求 AI 综合分析', { exact: true }).click();
    await expect(page.getByText('AI 总结已保存为独立版本。', { exact: true })).toBeVisible();
    await page.getByRole('tab', { name: '记录', exact: true }).click();
    await page.getByLabel('请求饮食分析', { exact: true }).click();
    await confirmAndSaveMealReview(page);
    expect(provider.responses()).toHaveLength(2);
    expect(provider.responses().map((request) => request.record?.kind)).toEqual(['summary', 'meal']);
    for (const request of provider.responses()) {
      expect(request.body?.model).toBe('custom-model');
      if (protocol === 'responses') {
        expect(request.body?.reasoning).toEqual({ effort: customEffort });
        expect(request.body).not.toHaveProperty('reasoning_effort');
      } else {
        expect(request.body?.reasoning_effort).toBe(customEffort);
        expect(request.body).not.toHaveProperty('reasoning');
      }
    }
    expect(provider.legacyRequests).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test('custom effort works without metadata, validates exact tokens, and blank omits the parameter', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const provider = await installMockAiProvider(page, {
    models: [{ id: 'basic-model' }, { id: 'other-model', supported_reasoning_efforts: ['max'] }],
    onResponse: async (route) => fulfillProviderResponse(route, { text: '留空使用服务默认强度' }),
  });
  await page.goto('/');
  const dialog = await chooseModel(page, 'basic-model');
  await expect(dialog.getByText('上游未提供推理强度，可使用服务默认或自定义填写。', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('radio', { name: /^推理强度 / })).toHaveCount(2);
  await dialog.getByRole('radio', { name: '推理强度 自定义', exact: true }).click();
  const input = dialog.getByLabel('自定义推理强度', { exact: true });
  const boundaryToken = 'A'.repeat(64);
  await input.fill(boundaryToken);
  await dialog.getByText('获取模型列表', { exact: true }).click();
  await dialog.getByRole('radio', { name: '模型 basic-model', exact: true }).click();
  await expect(input).toHaveValue(boundaryToken);
  await saveAiSettingsUi(page);
  await openAiSettings(page);
  await expect(input).toHaveValue(boundaryToken);
  const savedNotice = dialog.getByText(`${boundaryToken}（已保存；能力尚未刷新）`, { exact: true });
  const validationMessage = dialog.getByText('推理强度最多 64 位，只能包含英文字母、数字、.、_ 或 -，请修改后保存。', { exact: true });
  for (const value of ['bad effort', ' bad', 'bad/effort', '强', 'a'.repeat(65)]) {
    await input.fill(value);
    await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
    await expect(validationMessage).toBeVisible();
    await expect(savedNotice).toBeVisible();
  }
  await validationMessage.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await page.screenshot({ path: info.outputPath('invalid-custom-effort.png'), fullPage: true });
  await input.fill('');
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
  await expect(dialog.getByRole('radio', { name: '推理强度 自定义', exact: true })).toBeChecked();
  await saveAiSettingsUi(page);
  await expect(page.getByText('basic-model · 默认强度', { exact: true })).toBeVisible();
  await openAiSettings(page);
  await expect(dialog.getByRole('radio', { name: '推理强度 服务默认', exact: true })).toBeChecked();
  await expect(dialog.getByText('服务默认（已保存；能力尚未刷新）', { exact: true })).toBeVisible();
  await expect(input).toHaveCount(0);
  await dialog.getByLabel('关闭', { exact: true }).click();
  await addMeal(page, '留空强度原始记录');
  await page.getByText('请求 AI 综合分析', { exact: true }).click();
  await expect(page.getByText('AI 总结已保存为独立版本。', { exact: true })).toBeVisible();
  expect(provider.responses()).toHaveLength(1);
  expect(provider.responses()[0].body).not.toHaveProperty('reasoning');
  expect(provider.responses()[0].body).not.toHaveProperty('reasoning_effort');
  await openAiSettings(page);
  await dialog.getByText('获取模型列表', { exact: true }).click();
  await dialog.getByRole('radio', { name: '推理强度 自定义', exact: true }).click();
  await input.fill(customEffort);
  await dialog.getByRole('radio', { name: '模型 other-model', exact: true }).click();
  await expect(dialog.getByText('模型已更改，推理强度已重置。已获取推理强度', { exact: true })).toBeVisible();
  await expect(input).toHaveCount(0);
  await expect(dialog.getByRole('radio', { name: '推理强度 服务默认', exact: true })).toBeChecked();
  await expect(dialog.getByRole('radio', { name: '推理强度 max', exact: true })).toBeVisible();
  await dialog.getByRole('radio', { name: '推理强度 自定义', exact: true }).click();
  await input.fill(customEffort);
  await dialog.getByRole('button', { name: 'Chat Completions', exact: true }).click();
  await expect(dialog.getByText('连接已更改，已清除模型和推理强度，请重新获取模型列表。', { exact: true })).toBeVisible();
  await expect(input).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  expect(errors).toEqual([]);
});

test('late metadata preserves edits and cannot restore choices after model, connection or form-session changes', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let delayModels = false;
  let delayDetail = false;
  let releaseModels: (() => Promise<void>) | undefined;
  let releaseDetail: (() => Promise<void>) | undefined;
  const list = [{ id: 'first-model' }, { id: 'other-model' }];
  await installMockAiProvider(page, {
    onModels: async (route) => {
      if (delayModels) releaseModels = () => fulfillProviderJson(route, { data: list });
      else await fulfillProviderJson(route, { data: list });
    },
    onModel: async (route, _request, id) => {
      if (delayDetail && id === 'first-model') releaseDetail = () => fulfillProviderJson(route, { id, supported_reasoning_efforts: ['low'] });
      else await fulfillProviderJson(route, { id });
    },
  });
  await page.goto('/');
  const dialog = await chooseModel(page, 'first-model');
  await dialog.getByRole('radio', { name: '推理强度 自定义', exact: true }).click();
  const input = dialog.getByLabel('自定义推理强度', { exact: true });
  await input.fill(customEffort);
  delayDetail = true;
  await dialog.getByRole('radio', { name: '模型 first-model', exact: true }).click();
  await expect.poll(() => Boolean(releaseDetail)).toBe(true);
  await input.fill('Edited.Level-3');
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await releaseDetail!();
  await expect(dialog.getByText('已获取推理强度', { exact: true })).toBeVisible();
  await expect(input).toHaveValue('Edited.Level-3');
  await expect(dialog.getByRole('radio', { name: '推理强度 自定义', exact: true })).toBeChecked();
  await saveAiSettingsUi(page);
  await openAiSettings(page);
  await dialog.getByText('获取模型列表', { exact: true }).click();
  releaseDetail = undefined;
  await dialog.getByRole('radio', { name: '模型 first-model', exact: true }).click();
  await expect.poll(() => Boolean(releaseDetail)).toBe(true);
  await dialog.getByRole('radio', { name: '模型 other-model', exact: true }).click();
  await expect(dialog.getByRole('radio', { name: '模型 other-model', exact: true })).toBeChecked();
  await releaseDetail!().catch(() => undefined);
  await expect(dialog.getByRole('radio', { name: '模型 other-model', exact: true })).toBeChecked();
  await expect(dialog.getByRole('radio', { name: '推理强度 服务默认', exact: true })).toBeChecked();
  await expect(input).toHaveCount(0);
  await dialog.getByRole('radio', { name: '推理强度 自定义', exact: true }).click();
  await input.fill('Other-Token');
  delayModels = true;
  await dialog.getByText('获取模型列表', { exact: true }).click();
  await expect.poll(() => Boolean(releaseModels)).toBe(true);
  await dialog.getByLabel('API 地址', { exact: true }).fill('https://provider.example/v2');
  await releaseModels!().catch(() => undefined);
  await expect(dialog.getByRole('radio', { name: /^模型 / })).toHaveCount(0);
  await expect(input).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await dialog.getByLabel('关闭', { exact: true }).click();
  await openAiSettings(page);
  await expect(input).toHaveValue('Edited.Level-3');
  releaseModels = undefined;
  await dialog.getByText('获取模型列表', { exact: true }).click();
  await expect.poll(() => Boolean(releaseModels)).toBe(true);
  await dialog.getByLabel('关闭', { exact: true }).click();
  await openAiSettings(page);
  await releaseModels!().catch(() => undefined);
  await expect(input).toHaveValue('Edited.Level-3');
  await expect(dialog.getByRole('radio', { name: /^模型 / })).toHaveCount(0);
  await input.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('custom-effort-after-late-responses.png'), fullPage: true });
  expect(errors).toEqual([]);
});
