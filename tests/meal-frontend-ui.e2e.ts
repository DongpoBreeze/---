import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { parseBackupArchive } from '../src/backup';
import { configureMockAi, fulfillProviderResponse, installMockAiProvider } from './helpers/mock-ai-provider';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a90sAAAAASUVORK5CYII=', 'base64');
const wire = {
  components: [
    { label: '米饭', cookingMethod: '蒸煮', confidence: 0.95, nutritionEstimate: {
      method: 'typical_recipe', per100g: { calories: { min: 130, max: 150 }, protein: { min: 2, max: 3 }, carbs: { min: 28, max: 33 }, fat: { min: 0.3, max: 1 } },
      recipeBasis: '按熟米饭的典型含水量估计可食用成品。', assumptions: ['未额外加油。'], confidence: 0.8,
    }, uncertainty: [] },
    { label: '红色饮品', cookingMethod: null, confidence: 0.4, nutritionEstimate: null, uncertainty: ['饮品种类和糖量无法确认。'] },
  ], uncertainty: ['照片边缘部分遮挡。'],
};

test('生产餐食入口在识别页本地计算数量，确认后回填精简营养值并隐藏分析过程', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => { void dialog.accept(); });
  const provider = await installMockAiProvider(page, { onResponse: async (route) => fulfillProviderResponse(route, { kind: 'meal', data: wire }) });
  await page.goto('/');
  await configureMockAi(page);
  await page.getByText('记饮食', { exact: true }).click();
  await page.getByLabel('食物名称', { exact: true }).fill('用户提供的米饭');
  await expect(page.getByLabel('份量或参考物（可选）', { exact: true })).toHaveCount(0);
  await page.getByLabel('备注（可选）', { exact: true }).fill('蒸熟');
  const picker = page.waitForEvent('filechooser');
  await page.getByText('选择照片', { exact: true }).click();
  await (await picker).setFiles({ name: 'frontend.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByText('照片识别完成，请核对。', { exact: true })).toBeVisible();
  await expect(page.getByTestId('ai-meal-review')).toBeVisible();
  await expect(page.getByLabel('食物名称', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('菜品 1 每100g热量下限', { exact: true })).toHaveValue('130');
  await expect(page.getByLabel('菜品 1 每100g热量上限', { exact: true })).toHaveValue('150');
  await expect(page.getByLabel('菜品 2 每100g热量下限', { exact: true })).toHaveValue('');
  const newMealQuantity = page.getByLabel('菜品 1 食用量', { exact: true });
  await newMealQuantity.fill('250');
  await expect(page.getByTestId('ai-meal-review').getByText(/325～375/)).toBeVisible();
  await newMealQuantity.fill('');
  await page.getByRole('button', { name: '确认填入', exact: true }).click();
  await expect(page.getByTestId('ai-meal-review')).toHaveCount(0);
  await expect(page.getByLabel('食物名称', { exact: true })).toHaveValue('米饭、红色饮品');
  await expect(page.getByTestId('meal-edit-portions')).toBeEnabled();
  await expect(page.getByText('菜品与营养', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('热量 kcal', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('热量 kcal', { exact: true })).toBeEditable();
  await expect(page.getByText(/识别到：|识别置信度|查看估算依据|配方依据：|估算假设：|识别候选：|照片区域：/)).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('confirmed-nutrition-inputs.png'), fullPage: true });
  const requests = provider.responses();
  expect(requests).toHaveLength(2);
  for (const request of requests) {
    expect(request.body?.instructions).toContain('只返回严格JSON：{components:');
    expect(request.body?.instructions).not.toContain('foodId');
    expect(request.body).toMatchObject({ model: 'mock-model', reasoning: { effort: 'high' }, max_output_tokens: 8192, stream: true });
    expect(request.record?.data).toEqual({ foodName: '用户提供的米饭', note: '蒸熟', dishCorrections: [], photoRoles: ['before'] });
  }
  expect(requests[1].record?.reviewContext?.stage).toBe('crop_review');
  expect(requests[1].record?.reviewContext?.previousAnalysis).toEqual(wire);
  expect(requests[1].body?.input[0].content[1].image_url).toBe(requests[0].body?.input[0].content[1].image_url);
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: /米饭、红色饮品 午餐/ }).click();
  await expect(page.getByTestId('current-meal-analysis').getByText(/每 100 g：热量 130～150 kcal/)).toBeVisible();
  await page.getByRole('button', { name: '填写菜品数量', exact: true }).click();
  await page.getByLabel('菜品 1 食用量', { exact: true }).fill('250');
  await page.getByRole('button', { name: '保存营养校正', exact: true }).click();
  await expect(page.getByTestId('current-meal-analysis').getByText(/325～375/)).toBeVisible();
  expect(provider.responses()).toHaveLength(2);
  await page.getByRole('button', { name: '填写菜品数量', exact: true }).click();
  await page.getByLabel('菜品 1 名称', { exact: true }).fill('油炒米饭');
  await page.getByLabel('菜品 1 做法', { exact: true }).fill('油炒');
  await page.getByRole('button', { name: '保存营养校正', exact: true }).click();
  await expect(page.getByTestId('current-meal-analysis').getByText(/旧参考已失效/)).toHaveCount(0);
  expect(provider.responses()).toHaveLength(2);
  await page.getByRole('dialog').getByLabel('关闭', { exact: true }).click();
  await page.getByRole('tab', { name: '我的', exact: true }).click();
  const downloadEvent = page.waitForEvent('download');
  await page.getByText('导出完整备份', { exact: true }).click();
  const archive = await parseBackupArchive(new Uint8Array(await readFile((await (await downloadEvent).path())!)));
  const analyses = archive.data.meals[0].analyses!;
  // Recognition/review snapshots and later local corrections remain distinct.
  expect(analyses.length).toBeGreaterThanOrEqual(3);
  expect(analyses.find((version) => !version.analysis.components?.[0].userQuantity)?.analysis).toMatchObject({ calories: null, nutritionSource: { method: 'ai-per100g-v3' }, components: [
    { foodId: null, label: '米饭', userQuantity: null }, { label: '红色饮品', source: null, userQuantity: null },
  ] });
  expect(analyses.at(-2)!.analysis.calories).toEqual({ min: 325, max: 375 });
  expect(analyses.at(-1)!.analysis.calories).toBeNull();
  expect(analyses.at(-1)!.analysis.components![0]).toMatchObject({ nutritionReferenceStale: true, userQuantity: { amount: 250, unit: 'g' } });
  expect(errors).toEqual([]);
});

test('新餐食估计数量可清空并切换家用份数，多道菜连续输入后保存完整小计', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => { void dialog.accept(); });
  const rice = { ...wire.components[0], label: '熟米饭', nutritionEstimate: {
    ...wire.components[0].nutritionEstimate!, per100g: {
      calories: { min: 125, max: 145 }, protein: { min: 2, max: 3 },
      carbs: { min: 21, max: 28 }, fat: { min: 0.2, max: 0.8 },
    },
  } };
  const corn = { ...rice, label: '玉米', nutritionEstimate: {
    ...rice.nutritionEstimate, per100g: {
      calories: { min: 80, max: 100 }, protein: { min: 3, max: 4 },
      carbs: { min: 16, max: 21 }, fat: { min: 1, max: 2 },
    },
  } };
  const provider = await installMockAiProvider(page, {
    onResponse: async (route) => fulfillProviderResponse(route, { components: [rice, corn], uncertainty: [] }),
  });
  await page.goto('/');
  await configureMockAi(page);
  await page.getByText('记饮食', { exact: true }).click();
  const picker = page.waitForEvent('filechooser');
  await page.getByText('选择照片', { exact: true }).click();
  await (await picker).setFiles({ name: 'quantity.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByText('照片识别完成，请核对。', { exact: true })).toBeVisible();
  await expect(page.getByTestId('ai-meal-review')).toBeVisible();
  await page.getByLabel('菜品 2 食用量', { exact: true }).fill('');
  await page.getByRole('button', { name: '家用份数', exact: true }).click();
  await expect(page.getByLabel('菜品 1 食用份数', { exact: true })).toHaveValue('');
  await page.getByLabel('菜品 1 食用份数', { exact: true }).fill('0.5');
  await expect(page.getByText(/热量 约 62～73 kcal/)).toBeVisible();
  await page.getByRole('button', { name: '克（g）', exact: true }).click();
  const firstQuantity = page.getByLabel('菜品 1 食用量', { exact: true });
  const secondQuantity = page.getByLabel('菜品 2 食用量', { exact: true });
  await expect(firstQuantity).toHaveValue('');
  await expect(page.getByText(/热量 — · 蛋白质 — · 碳水 — · 脂肪 —/)).toBeVisible();
  await firstQuantity.fill('-1');
  await page.getByRole('button', { name: '确认填入', exact: true }).click();
  await expect(page.getByText('实际食用数量请填写大于 0 且不超过 100000 的完整数字，或留空。', { exact: true })).toBeVisible();
  await firstQuantity.fill('100');
  await secondQuantity.fill('200');
  await page.getByRole('button', { name: '确认填入', exact: true }).click();
  await expect(page.getByLabel('热量 kcal', { exact: true })).toHaveValue('285～345');
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: /熟米饭、玉米 午餐/ }).click();
  await expect(page.getByTestId('current-meal-analysis').getByText(/已填写菜品小计 · 热量 约 285～345 kcal/)).toBeVisible();
  await page.getByTestId('current-meal-analysis').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('saved-dish-subtotal.png'), fullPage: true });
  await page.getByRole('dialog').getByLabel('关闭', { exact: true }).click();
  await page.getByRole('tab', { name: '我的', exact: true }).click();
  const downloadEvent = page.waitForEvent('download');
  await page.getByText('导出完整备份', { exact: true }).click();
  const archive = await parseBackupArchive(new Uint8Array(await readFile((await (await downloadEvent).path())!)));
  expect(archive.data.meals[0].analyses!.at(-1)!.analysis).toMatchObject({
    calories: { min: 285, max: 345 }, protein: { min: 8, max: 11 },
    carbs: { min: 53, max: 70 }, fat: { min: 2.2, max: 4.8 },
    components: [
      { label: '熟米饭', userQuantity: { amount: 100, unit: 'g' } },
      { label: '玉米', userQuantity: { amount: 200, unit: 'g' } },
    ], nutritionSource: { coverage: 'complete' },
  });
  expect(provider.responses()).toHaveLength(1);
  expect(errors).toEqual([]);
});
