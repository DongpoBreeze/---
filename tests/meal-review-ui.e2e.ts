import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createBackupArchive, parseBackupArchive } from '../src/backup';
import { emptyData, type MealRecord } from '../src/types';
import {
  configureMockAi, fulfillProviderJson, fulfillProviderResponse, installMockAiProvider,
  MOCK_AI_MODEL,
} from './helpers/mock-ai-provider';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a90sAAAAASUVORK5CYII=', 'base64');
const originalRanges = {
  calories: { min: 130, max: 150 }, protein: { min: 2, max: 3 },
  carbs: { min: 28, max: 33 }, fat: { min: 0.3, max: 1 },
};
const original = {
  components: [{ label: '熟米饭', cookingMethod: '蒸煮', confidence: 0.96,
    nutritionEstimate: { method: 'typical_recipe', per100g: originalRanges,
      recipeBasis: '按蒸熟米饭的常见含水量估算。', assumptions: ['未额外加油。'], confidence: 0.9 },
    uncertainty: [] }],
  uncertainty: [],
};
type Ranges = typeof originalRanges;

test.beforeEach(async ({ page }) => {
  page.on('dialog', (dialog) => { void dialog.accept(); });
});

function captureErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

async function openMeal(page: Page) {
  await page.goto('/');
  await configureMockAi(page);
  await page.getByText('记饮食', { exact: true }).click();
}

async function uploadPhoto(page: Page) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByText('选择照片', { exact: true }).click();
  await (await chooser).setFiles({ name: 'review.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByTestId('ai-meal-review')).toBeVisible();
  await expect(page.getByText('照片识别完成，请核对。', { exact: true })).toBeVisible();
}

async function setRanges(page: Page, dish: number, ranges: Ranges) {
  const fields = [['calories', '热量'], ['protein', '蛋白质'], ['carbs', '碳水'], ['fat', '脂肪']] as const;
  for (const [key, label] of fields) {
    await page.getByLabel(`菜品 ${dish} 每100g${label}下限`, { exact: true }).fill(String(ranges[key].min));
    await page.getByLabel(`菜品 ${dish} 每100g${label}上限`, { exact: true }).fill(String(ranges[key].max));
  }
}

async function expectRangesEmpty(page: Page, dish = 1) {
  for (const nutrient of ['热量', '蛋白质', '碳水', '脂肪']) {
    for (const bound of ['下限', '上限'])
      await expect(page.getByLabel(`菜品 ${dish} 每100g${nutrient}${bound}`, { exact: true })).toHaveValue('');
  }
}

async function expectNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const review = page.getByTestId('ai-meal-review');
  if (await review.count()) {
    expect(await review.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    const viewport = page.viewportSize()!;
    for (const control of ['AI 复核', '确认填入']) {
      const bounds = await page.getByRole('button', { name: control, exact: true }).boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height + 1);
    }
  }
}

async function expectBefore(first: Locator, second: Locator) {
  const firstTop = await first.evaluate((element) => element.getBoundingClientRect().top + window.scrollY);
  const secondTop = await second.evaluate((element) => element.getBoundingClientRect().top + window.scrollY);
  expect(firstTop).toBeLessThan(secondTop);
}

async function confirmReview(page: Page, options: { editNutrition?: boolean } = {}) {
  await page.getByRole('button', { name: '确认填入', exact: true }).click();
  await expect(page.getByTestId('ai-meal-review')).toHaveCount(0);
  await expect(page.getByTestId('meal-edit-portions')).toBeVisible();
  await expect(page.getByTestId('meal-confirmation-summary')).toHaveCount(0);
  if (options.editNutrition !== false) {
    const edit = page.getByRole('button', { name: '修改营养值', exact: true });
    if (await edit.count()) await edit.click();
  }
}

async function saveAndExport(page: Page) {
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('tab', { name: '我的', exact: true }).click();
  const downloadEvent = page.waitForEvent('download');
  await page.getByText('导出完整备份', { exact: true }).click();
  const download = await downloadEvent;
  return parseBackupArchive(new Uint8Array(await readFile((await download.path())!)));
}

test('完整响应进入独立确认页，确认后只回填可编辑营养值并移除重复展示和旧份量字段', async ({ page }, info) => {
  const errors = captureErrors(page);
  const provider = await installMockAiProvider(page, { onResponse: async (route) => fulfillProviderResponse(route, original) });
  await openMeal(page);
  await page.getByLabel('食物名称', { exact: true }).fill('原始午餐');
  await expect(page.getByLabel('份量或参考物（可选）', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('剩余量（可选）', { exact: true })).toHaveCount(0);
  await page.getByLabel('备注（可选）', { exact: true }).fill('需要保留的备注');
  await uploadPhoto(page);
  const review = page.getByTestId('ai-meal-review');
  await expect(review.getByText('AI 识别', { exact: true })).toBeVisible();
  await expect(page.getByLabel('食物名称', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '保存', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('菜品 1 名称', { exact: true })).toHaveValue('熟米饭');
  await page.getByLabel('菜品 1 食用量', { exact: true }).fill('200');
  await expect(review.getByText(/热量 约 260～300 kcal/)).toBeVisible();
  await expectNoOverflow(page);
  await page.getByLabel('菜品 1 名称', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('ai-review-before-confirmation.png'), fullPage: true });
  await page.getByRole('button', { name: '返回饮食', exact: true }).click();
  await expect(review).toHaveCount(0);
  await expect(page.getByLabel('食物名称', { exact: true })).toHaveValue('原始午餐');
  await expect(page.getByLabel('备注（可选）', { exact: true })).toHaveValue('需要保留的备注');
  await expect(page.getByLabel('热量 kcal', { exact: true })).toHaveValue('');
  await expect(page.getByText('菜品与营养', { exact: true })).toHaveCount(0);
  await expect(page.getByText('照片识别完成，请核对。', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '查看识别结果', exact: true }).click();
  await expect(page.getByLabel('菜品 1 食用量', { exact: true })).toHaveValue('200');
  await confirmReview(page, { editNutrition: false });
  await expect(page.getByLabel('食物名称', { exact: true })).toHaveValue('熟米饭');
  await expect(page.getByLabel('备注（可选）', { exact: true })).toHaveValue('需要保留的备注');
  await expect(page.getByTestId('meal-nutrition-summary')).toBeVisible();
  await expect(page.getByTestId('meal-nutrition-calories')).toContainText('约 280 kcal');
  await expect(page.getByTestId('meal-nutrition-calories')).toContainText('估算范围 260～300 kcal');
  await expect(page.getByLabel('热量 kcal', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '修改营养值', exact: true }).click();
  await expect(page.getByLabel('热量 kcal', { exact: true })).toHaveValue('260～300');
  for (const field of ['热量 kcal', '蛋白质 g', '碳水 g', '脂肪 g'])
    await expect(page.getByLabel(field, { exact: true })).toBeEditable();
  await expect(page.getByTestId('confirmed-meal-table')).toHaveCount(0);
  await expect(page.getByText('菜品与营养', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('实际食用量（g）', { exact: true })).toHaveCount(0);
  await expect(page.getByText('营养值（可选）', { exact: true })).toBeVisible();
  await expect(page.getByText('手动营养值（可选）', { exact: true })).toHaveCount(0);
  await expectBefore(page.getByText('餐次', { exact: true }), page.getByLabel('食物名称', { exact: true }));
  await expectBefore(page.getByText('营养值（可选）', { exact: true }), page.getByLabel('备注（可选）', { exact: true }));
  await expectNoOverflow(page);
  await page.getByText('营养值（可选）', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('confirmed-form-nutrition-before-note.png'), fullPage: true });
  const archive = await saveAndExport(page);
  const meal = archive.data.meals[0];
  expect(meal.estimate).toBeUndefined();
  expect(meal.analyses!.at(-1)!.analysis.calories).toEqual({ min: 260, max: 300 });
  expect(provider.responses()).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('修正菜名和做法清空旧营养，AI复核发送修正并用新范围保留食用量', async ({ page }, info) => {
  const errors = captureErrors(page);
  const reviewedRanges: Ranges = {
    calories: { min: 200, max: 240 }, protein: { min: 6, max: 9 },
    carbs: { min: 25, max: 30 }, fat: { min: 8, max: 12 },
  };
  const reviewed = { components: [{ ...original.components[0], label: '少油蛋炒饭', cookingMethod: '少油炒',
    nutritionEstimate: { ...original.components[0].nutritionEstimate, per100g: reviewedRanges } }], uncertainty: [] };
  let calls = 0;
  const provider = await installMockAiProvider(page, {
    onResponse: async (route) => fulfillProviderResponse(route, ++calls === 1 ? original : reviewed),
  });
  await openMeal(page);
  await uploadPhoto(page);
  await page.getByLabel('菜品 1 名称', { exact: true }).fill('少油蛋炒饭');
  await page.getByLabel('菜品 1 做法', { exact: true }).fill('少油炒');
  await expectRangesEmpty(page);
  await page.getByLabel('菜品 1 食用量', { exact: true }).fill('150');
  await page.getByLabel('补充说明（用于复核）', { exact: true }).fill('鸡蛋已拌入米饭，少油炒制。');
  await page.getByRole('button', { name: 'AI 复核', exact: true }).click();
  await expect(page.getByLabel('菜品 1 每100g热量下限', { exact: true })).toHaveValue('200');
  await expect(page.getByLabel('菜品 1 每100g热量上限', { exact: true })).toHaveValue('240');
  await expect(page.getByLabel('菜品 1 食用量', { exact: true })).toHaveValue('150');
  await expect(page.getByTestId('ai-meal-review').getByText(/热量 约 300～360 kcal/)).toBeVisible();
  const requests = provider.responses();
  expect(requests).toHaveLength(2);
  expect(requests[1].record?.data.dishCorrections).toEqual(expect.arrayContaining([
    expect.objectContaining({ label: '少油蛋炒饭', cookingMethod: '少油炒' }),
  ]));
  expect(JSON.stringify(requests[1].record?.data)).toContain('鸡蛋已拌入米饭，少油炒制。');
  for (const request of requests)
    expect(request.body).toMatchObject({ model: MOCK_AI_MODEL, reasoning: { effort: 'high' } });
  await expectNoOverflow(page);
  await page.getByLabel('菜品 1 名称', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('ai-review-refreshed-nutrition.png'), fullPage: true });
  await confirmReview(page);
  await expect(page.getByLabel('食物名称', { exact: true })).toHaveValue('少油蛋炒饭');
  await expect(page.getByLabel('热量 kcal', { exact: true })).toHaveValue('300～360');
  const archive = await saveAndExport(page);
  const history = archive.data.meals[0].analyses!;
  expect(history.length).toBeGreaterThanOrEqual(3);
  expect(history[0].analysis.components![0]).toMatchObject({ label: '熟米饭', source: { per100gRange: originalRanges } });
  expect(history.slice(1, -1).some((version) => version.analysis.components?.[0].label === '少油蛋炒饭'
    && version.analysis.components[0].source?.per100gRange?.calories.min === 200)).toBe(true);
  expect(history.at(-1)!.analysis).toMatchObject({ calories: { min: 300, max: 360 }, components: [
    { label: '少油蛋炒饭', cookingMethod: '少油炒', userQuantity: { amount: 150, unit: 'g' }, source: { per100gRange: reviewedRanges } },
  ] });
  expect(errors).toEqual([]);
});

test('人工修改每100g四项范围并增删菜品可直接确认，不追加AI请求且导出完整人工版本', async ({ page }, info) => {
  const errors = captureErrors(page);
  const provider = await installMockAiProvider(page, { onResponse: async (route) => fulfillProviderResponse(route, original) });
  await openMeal(page);
  await uploadPhoto(page);
  const manualRanges: Ranges = { calories: { min: 180, max: 220 }, protein: { min: 8, max: 12 },
    carbs: { min: 20, max: 30 }, fat: { min: 4, max: 6 } };
  const pumpkinRanges: Ranges = { calories: { min: 20, max: 40 }, protein: { min: 1, max: 2 },
    carbs: { min: 4, max: 8 }, fat: { min: 0, max: 1 } };
  await page.getByLabel('菜品 1 名称', { exact: true }).fill('手工校正菜');
  await page.getByLabel('菜品 1 做法', { exact: true }).fill('炖煮');
  await setRanges(page, 1, manualRanges);
  await page.getByLabel('菜品 1 食用量', { exact: true }).fill('150');
  await page.getByRole('button', { name: '添加菜品', exact: true }).click();
  await page.getByLabel('菜品 2 名称', { exact: true }).fill('应删除菜');
  await page.getByRole('button', { name: '删除菜品 2', exact: true }).click();
  await expect(page.getByLabel('菜品 2 名称', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '添加菜品', exact: true }).click();
  await page.getByLabel('菜品 2 名称', { exact: true }).fill('清蒸南瓜');
  await page.getByLabel('菜品 2 做法', { exact: true }).fill('清蒸');
  await setRanges(page, 2, pumpkinRanges);
  await page.getByLabel('菜品 2 食用量', { exact: true }).fill('200');
  await expect(page.getByTestId('ai-meal-review').getByText(/热量 约 310～410 kcal/)).toBeVisible();
  await expectNoOverflow(page);
  await page.screenshot({ path: info.outputPath('manual-nutrition-added-dish.png'), fullPage: true });
  await confirmReview(page);
  await expect(page.getByLabel('食物名称', { exact: true })).toHaveValue('手工校正菜、清蒸南瓜');
  await expect(page.getByText('应删除菜', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('热量 kcal', { exact: true })).toHaveValue('310～410');
  const archive = await saveAndExport(page);
  const history = archive.data.meals[0].analyses!;
  expect(history.length).toBeGreaterThanOrEqual(2);
  expect(history[0].analysis.components![0].source?.per100gRange).toEqual(originalRanges);
  expect(history.at(-1)!.analysis).toMatchObject({
    calories: { min: 310, max: 410 }, protein: { min: 14, max: 22 }, carbs: { min: 38, max: 61 }, fat: { min: 6, max: 11 },
    components: [
      { label: '手工校正菜', cookingMethod: '炖煮', userNutritionPer100g: manualRanges, userQuantity: { amount: 150, unit: 'g' } },
      { label: '清蒸南瓜', cookingMethod: '清蒸', userNutritionPer100g: pumpkinRanges, userQuantity: { amount: 200, unit: 'g' } },
    ],
  });
  // Reopening an existing record must not apply this manual reference to a
  // different dish through the older quantity-correction entry point.
  await page.getByRole('tab', { name: '记录', exact: true }).click();
  await page.getByText(archive.data.meals[0].foodName, { exact: true }).click();
  await page.getByRole('button', { name: '填写菜品数量', exact: true }).click();
  await page.getByLabel('菜品 1 名称', { exact: true }).fill('已换成另一道菜');
  await page.getByRole('button', { name: '保存营养校正', exact: true }).click();
  await expect(page.getByTestId('current-meal-analysis').getByText(/热量 约 40～80 kcal/)).toBeVisible();
  await page.getByRole('dialog').getByLabel('关闭', { exact: true }).click();
  await page.getByRole('tab', { name: '我的', exact: true }).click();
  const exportEvent = page.waitForEvent('download');
  await page.getByText('导出完整备份', { exact: true }).click();
  const correctedArchive = await parseBackupArchive(new Uint8Array(await readFile((await (await exportEvent).path())!)));
  expect(correctedArchive.data.meals[0].analyses!.at(-1)!.analysis.components![0]).toMatchObject({
    label: '已换成另一道菜', userNutritionPer100g: null, nutritionReferenceStale: true,
    source: { per100gRange: originalRanges },
  });
  expect(provider.responses()).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('未确认复核和编辑不覆盖已确认营养值，保存保留每次模型结果和最终确认版本', async ({ page }) => {
  const errors = captureErrors(page);
  const provider = await installMockAiProvider(page, { onResponse: async (route) => fulfillProviderResponse(route, original) });
  await openMeal(page);
  await uploadPhoto(page);
  await page.getByLabel('菜品 1 食用量', { exact: true }).fill('200');
  await confirmReview(page);
  await page.getByRole('button', { name: '查看识别结果', exact: true }).click();
  await page.getByRole('button', { name: 'AI 复核', exact: true }).click();
  await expect(page.getByText('AI 复核完成，请核对。', { exact: true })).toBeVisible();
  await expect(page.getByLabel('菜品 1 食用量', { exact: true })).toHaveValue('200');
  await page.getByLabel('菜品 1 名称', { exact: true }).fill('尚未确认的新菜品');
  await page.getByRole('button', { name: '返回饮食', exact: true }).click();
  await expect(page.getByLabel('食物名称', { exact: true })).toHaveValue('熟米饭');
  await expect(page.getByText('尚未确认的新菜品', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('热量 kcal', { exact: true })).toHaveValue('260～300');
  const archive = await saveAndExport(page);
  const versions = archive.data.meals[0].analyses!;
  expect(versions.filter((version) => version.model === MOCK_AI_MODEL)).toHaveLength(2);
  expect(versions.at(-1)).toMatchObject({ model: 'local/meal-review', analysis: {
    calories: { min: 260, max: 300 }, components: [
      { label: '熟米饭', userQuantity: { amount: 200, unit: 'g' } },
    ],
  } });
  expect(provider.responses()).toHaveLength(2);
  expect(errors).toEqual([]);
});

test('确认页家用份数按本地换算，改做法清空旧参考和份数后确认自动更新营养', async ({ page }) => {
  const errors = captureErrors(page);
  const updatedRanges: Ranges = { calories: { min: 180, max: 220 }, protein: { min: 8, max: 12 },
    carbs: { min: 20, max: 30 }, fat: { min: 4, max: 6 } };
  let calls = 0;
  const provider = await installMockAiProvider(page, { onResponse: async (route) => fulfillProviderResponse(route,
    ++calls === 1 ? original : { ...original, components: [{ ...original.components[0], cookingMethod: '油炒',
      nutritionEstimate: { ...original.components[0].nutritionEstimate, per100g: updatedRanges } }] }) });
  await openMeal(page);
  await uploadPhoto(page);
  await page.getByRole('button', { name: '家用份数', exact: true }).click();
  await page.getByLabel('菜品 1 食用份数', { exact: true }).fill('0.5');
  await expect(page.getByTestId('ai-meal-review').getByText(/热量 约 65～75 kcal/)).toBeVisible();
  await page.getByLabel('菜品 1 做法', { exact: true }).fill('油炒');
  await expectRangesEmpty(page);
  await expect(page.getByLabel('菜品 1 食用份数', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('菜品 1 食用量', { exact: true })).toHaveValue('');
  await page.getByLabel('菜品 1 食用量', { exact: true }).fill('100');
  await confirmReview(page);
  await expect(page.getByLabel('热量 kcal', { exact: true })).toHaveValue('180～220');
  await expect(page.getByLabel('蛋白质 g', { exact: true })).toHaveValue('8～12');
  await expect(page.getByLabel('碳水 g', { exact: true })).toHaveValue('20～30');
  await expect(page.getByLabel('脂肪 g', { exact: true })).toHaveValue('4～6');
  await expect(page.getByRole('button', { name: '家用份数', exact: true })).toHaveCount(0);
  const archive = await saveAndExport(page);
  const final = archive.data.meals[0].analyses!.at(-1)!.analysis;
  expect(final.calories).toEqual(updatedRanges.calories);
  expect(final.components![0]).toMatchObject({ label: '熟米饭', cookingMethod: '油炒',
    userQuantity: { amount: 100, unit: 'g', origin: 'user' }, source: { per100gRange: updatedRanges } });
  expect(archive.data.meals[0].analyses![0].analysis.components![0].source?.per100gRange).toEqual(originalRanges);
  expect(provider.responses()).toHaveLength(2);
  expect(errors).toEqual([]);
});

test('复核失败、取消和返回均保留编辑，迟到结果不能覆盖编辑或回填原表单', async ({ page }, info) => {
  const errors = captureErrors(page);
  const manualRanges: Ranges = { calories: { min: 160, max: 180 }, protein: { min: 3, max: 5 },
    carbs: { min: 20, max: 25 }, fat: { min: 5, max: 8 } };
  const late = { ...original, components: [{ ...original.components[0], label: '迟到结果不得填入' }] };
  const finishes: Array<() => Promise<void>> = [];
  let calls = 0;
  const provider = await installMockAiProvider(page, {
    onResponse: async (route) => {
      calls += 1;
      if (calls === 1) await fulfillProviderResponse(route, original);
      else if (calls === 2) await fulfillProviderJson(route, { error: { message: '模拟复核失败' } }, 503);
      else finishes.push(() => fulfillProviderResponse(route, late));
    },
  });
  await openMeal(page);
  await page.getByLabel('食物名称', { exact: true }).fill('原表单保留');
  await page.getByLabel('备注（可选）', { exact: true }).fill('原始备注');
  await uploadPhoto(page);
  await page.getByLabel('菜品 1 名称', { exact: true }).fill('保留编辑');
  await page.getByLabel('菜品 1 做法', { exact: true }).fill('少油炒');
  await setRanges(page, 1, manualRanges);
  await page.getByLabel('菜品 1 食用量', { exact: true }).fill('125');
  await page.getByLabel('补充说明（用于复核）', { exact: true }).fill('复核失败也保留本说明');
  const reviewButton = page.getByRole('button', { name: 'AI 复核', exact: true });
  await reviewButton.click();
  await expect(page.getByText(/复核失败/).first()).toBeVisible();
  await expect(reviewButton).toBeEnabled();
  await expect(page.getByLabel('菜品 1 名称', { exact: true })).toHaveValue('保留编辑');
  await expect(page.getByLabel('菜品 1 每100g热量下限', { exact: true })).toHaveValue('160');
  await expect(page.getByLabel('菜品 1 食用量', { exact: true })).toHaveValue('125');
  await reviewButton.click();
  await expect.poll(() => finishes.length).toBe(1);
  await expect(page.getByRole('button', { name: '确认填入', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '取消复核', exact: true }).click();
  await expect(reviewButton).toBeEnabled();
  await finishes[0]();
  await expect(page.getByLabel('菜品 1 名称', { exact: true })).toHaveValue('保留编辑');
  await expect(page.getByLabel('菜品 1 每100g热量下限', { exact: true })).toHaveValue('160');
  await expect(page.getByLabel('补充说明（用于复核）', { exact: true })).toHaveValue('复核失败也保留本说明');
  await reviewButton.click();
  await expect.poll(() => finishes.length).toBe(2);
  await page.getByRole('button', { name: '返回饮食', exact: true }).click();
  await finishes[1]();
  await expect(page.getByTestId('ai-meal-review')).toHaveCount(0);
  await expect(page.getByLabel('食物名称', { exact: true })).toHaveValue('原表单保留');
  await expect(page.getByLabel('备注（可选）', { exact: true })).toHaveValue('原始备注');
  await expect(page.getByText('菜品与营养', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '查看识别结果', exact: true }).click();
  await expect(page.getByLabel('菜品 1 名称', { exact: true })).toHaveValue('保留编辑');
  await expect(page.getByLabel('菜品 1 每100g热量下限', { exact: true })).toHaveValue('160');
  await expect(page.getByLabel('菜品 1 食用量', { exact: true })).toHaveValue('125');
  await expectNoOverflow(page);
  await page.getByLabel('菜品 1 名称', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('review-edits-after-failure-cancel-return.png'), fullPage: true });
  await confirmReview(page);
  await expect(page.getByLabel('食物名称', { exact: true })).toHaveValue('保留编辑');
  await expect(page.getByText('迟到结果不得填入', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('热量 kcal', { exact: true })).toHaveValue('200～225');
  expect(provider.responses()).toHaveLength(4);
  expect(errors).toEqual([]);
});

test('确认后可手改整餐数值和区间，保存重开及摘要采用修改值并保留原AI版本', async ({ page }, info) => {
  const errors = captureErrors(page);
  const provider = await installMockAiProvider(page, { onResponse: async (route) => fulfillProviderResponse(route, original) });
  await openMeal(page);
  await uploadPhoto(page);
  await page.getByLabel('菜品 1 食用量', { exact: true }).fill('200');
  await confirmReview(page);
  const calories = page.getByLabel('热量 kcal', { exact: true });
  await expect(calories).toHaveValue('260～300');
  await calories.fill('300～200');
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText(/热量请填写完整的非负数字或从小到大的区间/)).toBeVisible();
  await expect(page.getByRole('dialog')).toBeVisible();
  await calories.fill('280');
  await page.getByLabel('蛋白质 g', { exact: true }).fill('4.5～5.5');
  await page.getByLabel('碳水 g', { exact: true }).fill('60');
  await page.getByLabel('脂肪 g', { exact: true }).fill('0.8~1.5');
  await expectNoOverflow(page);
  await page.getByText('营养值（可选）', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('editable-whole-meal-nutrition.png'), fullPage: true });
  const archive = await saveAndExport(page);
  const meal = archive.data.meals[0];
  expect(meal.estimate).toBeUndefined();
  expect(meal.analyses!.at(-1)).toMatchObject({ model: 'local/manual-nutrition', analysis: {
    calories: { min: 280, max: 280 }, protein: { min: 4.5, max: 5.5 },
    carbs: { min: 60, max: 60 }, fat: { min: 0.8, max: 1.5 },
    nutritionSource: { provider: 'manual', method: 'manual-total-v1' },
    components: [{ label: '熟米饭', userQuantity: { amount: 200, unit: 'g' }, source: { per100gRange: originalRanges } }],
  } });
  expect(meal.analyses!.some((version) => version.analysis.calories?.min === 260 && version.analysis.calories.max === 300)).toBe(true);
  await page.reload();
  await page.getByRole('tab', { name: '今天', exact: true }).click();
  await expect(page.getByTestId('today-nutrition').getByText('280', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '记录', exact: true }).click();
  await page.getByText(meal.foodName, { exact: true }).click();
  await expect(page.getByLabel('热量 kcal', { exact: true })).toHaveValue('280');
  await expect(page.getByLabel('蛋白质 g', { exact: true })).toHaveValue('4.5～5.5');
  await expect(page.getByLabel('脂肪 g', { exact: true })).toHaveValue('0.8～1.5');
  await expect(page.getByTestId('meal-nutrition-header').getByText('营养值（可选）', { exact: true })).toBeVisible();
  await page.getByLabel('备注（可选）', { exact: true }).fill('重开后仅修改备注');
  const savedAgain = await saveAndExport(page);
  const revised = savedAgain.data.meals[0];
  expect(revised).toMatchObject({ revision: 2, note: '重开后仅修改备注' });
  expect(revised.estimate).toBeUndefined();
  expect(revised.analyses!.at(-1)!.analysis).toMatchObject({ calories: { min: 280, max: 280 },
    protein: { min: 4.5, max: 5.5 }, carbs: { min: 60, max: 60 }, fat: { min: 0.8, max: 1.5 },
    nutritionSource: { provider: 'manual', method: 'manual-total-v1' } });
  expect(provider.responses()).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('手动清空全部营养后保存为未知，重新打开不恢复旧AI总量', async ({ page }) => {
  const errors = captureErrors(page);
  const provider = await installMockAiProvider(page, { onResponse: async (route) => fulfillProviderResponse(route, original) });
  await openMeal(page);
  await uploadPhoto(page);
  await page.getByLabel('菜品 1 食用量', { exact: true }).fill('200');
  await confirmReview(page);
  for (const field of ['热量 kcal', '蛋白质 g', '碳水 g', '脂肪 g'])
    await page.getByLabel(field, { exact: true }).fill('');
  const archive = await saveAndExport(page);
  const meal = archive.data.meals[0];
  expect(meal.estimate).toBeUndefined();
  expect(meal.analyses!.at(-1)!.analysis).toMatchObject({ status: 'unknown',
    calories: null, protein: null, carbs: null, fat: null,
    nutritionSource: { provider: 'manual', method: 'manual-total-v1' },
  });
  expect(meal.analyses!.some((version) => version.analysis.calories?.min === 260 && version.analysis.calories.max === 300)).toBe(true);
  await page.getByRole('tab', { name: '记录', exact: true }).click();
  await page.getByText(meal.foodName, { exact: true }).click();
  for (const field of ['热量 kcal', '蛋白质 g', '碳水 g', '脂肪 g'])
    await expect(page.getByLabel(field, { exact: true })).toHaveValue('');
  expect(provider.responses()).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('旧记录隐藏份量和剩余量后仍保留原数据，无需AI也可手动修改营养', async ({ page }) => {
  const errors = captureErrors(page);
  const provider = await installMockAiProvider(page);
  const now = new Date().toISOString();
  const originalMeal: MealRecord = {
    id: 'legacy-manual-meal', type: 'meal', createdAt: now, occurredAt: now,
    mealType: '午餐', foodName: '旧餐食记录', portion: '原记录半碗', remaining: '原记录剩余四分之一',
    note: '旧备注', revision: 1, source: 'manual', estimateStatus: 'estimated',
    estimate: { calories: 400, protein: 18, carbs: 50, fat: 10 },
  };
  const bytes = await createBackupArchive({ ...emptyData(), meals: [originalMeal] }, []);
  await page.goto('/');
  await page.getByRole('tab', { name: '我的', exact: true }).click();
  const restored = page.waitForEvent('dialog', { predicate: (dialog) => dialog.message().includes('恢复完成') });
  const chooser = page.waitForEvent('filechooser');
  await page.getByText('恢复备份', { exact: true }).click();
  await (await chooser).setFiles({ name: 'old-meal.zip', mimeType: 'application/zip', buffer: Buffer.from(bytes) });
  await restored;
  await page.getByRole('tab', { name: '记录', exact: true }).click();
  await page.getByText(originalMeal.foodName, { exact: true }).click();
  await expect(page.getByLabel('份量或参考物（可选）', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('剩余量（可选）', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('热量 kcal', { exact: true })).toHaveValue('400');
  await page.getByLabel('热量 kcal', { exact: true }).fill('450');
  await page.getByLabel('蛋白质 g', { exact: true }).fill('20');
  await page.getByLabel('碳水 g', { exact: true }).fill('60');
  await page.getByLabel('脂肪 g', { exact: true }).fill('15');
  const archive = await saveAndExport(page);
  expect(archive.data.meals[0]).toMatchObject({
    foodName: originalMeal.foodName, portion: originalMeal.portion, remaining: originalMeal.remaining,
    note: originalMeal.note, revision: 2, estimate: { calories: 450, protein: 20, carbs: 60, fat: 15 },
  });
  expect(provider.responses()).toHaveLength(0);
  expect(errors).toEqual([]);
});

test('手动整餐营养之后可按原AI参考重新填写数量，新计算可保存且旧手动版本保留', async ({ page }) => {
  const errors = captureErrors(page);
  const provider = await installMockAiProvider(page, { onResponse: async (route) => fulfillProviderResponse(route, original) });
  await openMeal(page);
  await uploadPhoto(page);
  await page.getByLabel('菜品 1 食用量', { exact: true }).fill('200');
  await confirmReview(page);
  await page.getByLabel('热量 kcal', { exact: true }).fill('280');
  await page.getByLabel('蛋白质 g', { exact: true }).fill('5');
  await page.getByLabel('碳水 g', { exact: true }).fill('60');
  await page.getByLabel('脂肪 g', { exact: true }).fill('1');
  const first = await saveAndExport(page);
  await page.getByRole('tab', { name: '记录', exact: true }).click();
  await page.getByText(first.data.meals[0].foodName, { exact: true }).click();
  await expect(page.getByLabel('热量 kcal', { exact: true })).toHaveValue('280');
  await page.getByRole('button', { name: '填写菜品数量', exact: true }).click();
  await expect(page.getByRole('button', { name: '选择 USDA 食材', exact: true })).toHaveCount(0);
  await page.getByLabel('菜品 1 食用量', { exact: true }).fill('150');
  await page.getByRole('button', { name: '保存营养校正', exact: true }).click();
  await expect(page.getByTestId('current-meal-analysis').getByText(/热量 约 195～225 kcal/)).toBeVisible();
  await expect(page.getByLabel('热量 kcal', { exact: true })).toHaveValue('195～225');
  const final = await saveAndExport(page);
  const meal = final.data.meals[0];
  expect(meal.estimate).toBeUndefined();
  expect(meal.analyses!.at(-1)!.analysis).toMatchObject({
    calories: { min: 195, max: 225 }, nutritionSource: { method: 'ai-per100g-v3' },
    components: [{ userQuantity: { amount: 150, unit: 'g' }, source: { per100gRange: originalRanges } }],
  });
  expect(meal.analyses!.some((version) => version.analysis.nutritionSource?.method === 'manual-total-v1'
    && version.analysis.calories?.min === 280)).toBe(true);
  expect(provider.responses()).toHaveLength(1);
  expect(errors).toEqual([]);
});

for (const keepPhoto of [true, false]) {
  test(`${keepPhoto ? '有照片' : '移除照片后'}确认新识别数量时隔离旧数量入口，保存重开后再校正不会回退`, async ({ page }) => {
    const errors = captureErrors(page);
    const provider = await installMockAiProvider(page, { onResponse: async (route) => fulfillProviderResponse(route, original) });
    await openMeal(page);
    await uploadPhoto(page);
    await page.getByLabel('菜品 1 食用量', { exact: true }).fill('100');
    await confirmReview(page);
    const first = await saveAndExport(page);
    const foodName = first.data.meals[0].foodName;
    await page.getByRole('tab', { name: '记录', exact: true }).click();
    await page.getByText(foodName, { exact: true }).click();
    if (!keepPhoto) await page.getByLabel('移除餐前照片', { exact: true }).click();
    await page.getByRole('button', { name: '修改识别结果', exact: true }).click();
    await page.getByLabel('菜品 1 食用量', { exact: true }).fill('200');
    await confirmReview(page);
    await expect(page.getByLabel('热量 kcal', { exact: true })).toHaveValue('260～300');
    await expect(page.getByRole('button', { name: '填写菜品数量', exact: true })).toHaveCount(0);
    await expect(page.getByTestId('current-meal-analysis')).toHaveCount(0);
    await page.getByRole('button', { name: '查看识别结果', exact: true }).click();
    await expect(page.getByLabel('菜品 1 食用量', { exact: true })).toHaveValue('200');
    await page.getByRole('button', { name: '返回饮食', exact: true }).click();
    const second = await saveAndExport(page);
    expect(second.data.meals[0].analyses!.at(-1)!.analysis.components![0].userQuantity).toEqual({ amount: 200, unit: 'g', origin: 'user' });
    await page.getByRole('tab', { name: '记录', exact: true }).click();
    await page.getByText(foodName, { exact: true }).click();
    await expect(page.getByLabel('热量 kcal', { exact: true })).toHaveValue('260～300');
    await page.getByRole('button', { name: '填写菜品数量', exact: true }).click();
    await expect(page.getByLabel('菜品 1 食用量', { exact: true })).toHaveValue('200');
    await page.getByLabel('菜品 1 食用量', { exact: true }).fill('300');
    await page.getByRole('button', { name: '保存营养校正', exact: true }).click();
    await expect(page.getByTestId('current-meal-analysis').getByText(/热量 约 390～450 kcal/)).toBeVisible();
    await expect(page.getByLabel('热量 kcal', { exact: true })).toHaveValue('390～450');
    const final = await saveAndExport(page);
    const meal = final.data.meals[0];
    expect(meal.analyses!.at(-1)!.analysis).toMatchObject({ calories: { min: 390, max: 450 },
      components: [{ userQuantity: { amount: 300, unit: 'g' } }], nutritionSource: { method: 'ai-per100g-v3' } });
    expect(meal.analyses!.some((version) => version.analysis.components?.[0].userQuantity?.amount === 200)).toBe(true);
    expect(Boolean(meal.imageUri)).toBe(keepPhoto);
    expect(provider.responses()).toHaveLength(1);
    expect(errors).toEqual([]);
  });
}

test('后台AI完整响应不会覆盖打开表单中的手动营养，保存保留手填值与AI版本', async ({ page }) => {
  const errors = captureErrors(page);
  let release: (() => Promise<void>) | undefined;
  const provider = await installMockAiProvider(page, { onResponse: async (route) => {
    release = () => fulfillProviderResponse(route, original);
  } });
  await openMeal(page);
  await page.getByLabel('食物名称', { exact: true }).fill('后台响应测试餐食');
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('tab', { name: '记录', exact: true }).click();
  await page.getByLabel('请求饮食分析', { exact: true }).click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await page.getByText('后台响应测试餐食', { exact: true }).click();
  const values = [['热量 kcal', '650'], ['蛋白质 g', '40'], ['碳水 g', '80'], ['脂肪 g', '18']] as const;
  for (const [field, value] of values) await page.getByLabel(field, { exact: true }).fill(value);
  await release!();
  await expect(page.getByTestId('current-meal-analysis')).toBeVisible();
  for (const [field, value] of values) await expect(page.getByLabel(field, { exact: true })).toHaveValue(value);
  await expect(page.getByTestId('ai-meal-review')).toHaveCount(0);
  const archive = await saveAndExport(page);
  const meal = archive.data.meals[0];
  expect(meal.analyses!.at(-1)).toMatchObject({ model: 'local/manual-nutrition', analysis: {
    calories: { min: 650, max: 650 }, protein: { min: 40, max: 40 },
    carbs: { min: 80, max: 80 }, fat: { min: 18, max: 18 },
    nutritionSource: { provider: 'manual', method: 'manual-total-v1' },
  } });
  expect(meal.analyses!.some((version) => version.model === MOCK_AI_MODEL)).toBe(true);
  expect(provider.responses()).toHaveLength(1);
  expect(errors).toEqual([]);
});
