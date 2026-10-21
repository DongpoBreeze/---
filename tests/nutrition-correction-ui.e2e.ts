import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createBackupArchive, parseBackupArchive } from '../src/backup';
import { calculateMealNutrition } from '../src/nutrition';
import { emptyData, type MealRecord } from '../src/types';
import {
  configureMockAi, fulfillProviderResponse, installMockAiProvider,
  mockNutritionEstimate, MOCK_AI_KEY, MOCK_AI_MODEL,
} from './helpers/mock-ai-provider';
import { confirmAndSaveMealReview } from './helpers/saved-meal-review';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a90sAAAAASUVORK5CYII=', 'base64');
const chickenRegion = { x: 0.1, y: 0.15, width: 0.45, height: 0.6 };
const originalRanges = {
  calories: { min: 160, max: 220 }, protein: { min: 18, max: 24 },
  carbs: { min: 4, max: 7 }, fat: { min: 9, max: 13 },
};
const correctedRanges = {
  calories: { min: 130, max: 170 }, protein: { min: 20, max: 27 },
  carbs: { min: 0, max: 2 }, fat: { min: 5, max: 9 },
};
const analysedFoodName = '红烧鸡腿、蔬菜配菜';
const correctedFoodName = '去皮清蒸鸡腿、蔬菜配菜';

async function openQuantities(page: Page) {
  await page.getByRole('button', { name: '填写菜品数量', exact: true }).click();
  const quantity = page.getByLabel(/^菜品 1 食用(?:量|份数)$/);
  await quantity.click();
  await expect(quantity).toBeFocused();
}
async function saveQuantities(page: Page) {
  await page.getByLabel('保存营养校正', { exact: true }).click();
  await expect(page.getByLabel('保存营养校正', { exact: true })).toHaveCount(0);
}
async function expectNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
}
async function restore(page: Page, buffer: Buffer) {
  const restored = page.waitForEvent('dialog', { predicate: (dialog) => dialog.message().includes('恢复完成') });
  const picker = page.waitForEvent('filechooser');
  await page.getByText('恢复备份', { exact: true }).click();
  await (await picker).setFiles({ name: 'nutrition-backup.zip', mimeType: 'application/zip', buffer });
  await restored;
}
async function exportBackup(page: Page) {
  const event = page.waitForEvent('download');
  await page.getByText('导出完整备份', { exact: true }).click();
  const download = await event;
  const bytes = await readFile((await download.path())!);
  return { bytes, backup: await parseBackupArchive(new Uint8Array(bytes)) };
}

test('AI 每100g参考、数量小计、菜品修正与备份恢复保留独立历史', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => { void dialog.accept(); });
  const provider = await installMockAiProvider(page, {
    onResponse: async (route, request) => {
      expect(request.record?.kind).toBe('meal');
      const corrected = Boolean(request.record?.data.dishCorrections?.length);
      await fulfillProviderResponse(route, {
        foodName: '鸡腿蔬菜餐盘', confidence: 0.94,
        components: [
          {
            foodId: null, label: corrected ? '去皮清蒸鸡腿' : '红烧鸡腿', category: 'meat',
            cookingMethod: corrected ? '清蒸' : '红烧', confidence: 0.94,
            candidates: [{ foodId: null, label: corrected ? '去皮清蒸鸡腿' : '红烧鸡腿', category: 'meat', confidence: 0.94 }],
            evidence: [{ kind: corrected ? 'user' : 'visual', text: corrected ? '采用用户修正的菜名与做法。' : '可见带酱色的熟鸡腿。' }],
            region: chickenRegion, uncertainty: [],
            nutritionEstimate: mockNutritionEstimate({
              per100g: corrected ? correctedRanges : originalRanges, confidence: 0.67,
              recipeBasis: corrected ? '按去皮鸡腿清蒸后的典型配方估算。' : '按鸡腿、少量烹调油和红烧酱汁的典型配方估算。',
              assumptions: ['成品可食用部分，不含骨头。', corrected ? '按去皮和少油清蒸估算。' : '酱汁和用油差异已计入范围。'],
            }),
          },
          {
            foodId: null, label: '蔬菜配菜', category: 'vegetable', cookingMethod: '清炒', confidence: 0.91,
            candidates: [{ foodId: null, label: '蔬菜配菜', category: 'vegetable', confidence: 0.91 }],
            evidence: [{ kind: 'visual', text: '右侧为熟蔬菜配菜。' }],
            region: { x: 0.6, y: 0.2, width: 0.3, height: 0.5 }, uncertainty: ['具体蔬菜和用油量不确定'],
            nutritionEstimate: mockNutritionEstimate({
              method: 'category', confidence: 0.46,
              per100g: { calories: { min: 20, max: 70 }, protein: { min: 1, max: 3 }, carbs: { min: 3, max: 9 }, fat: { min: 0.5, max: 4 } },
              recipeBasis: '无法判断具体蔬菜配方，按熟蔬菜菜品类别近似。',
              assumptions: ['少量烹调油的差异已计入范围。'],
            }),
          },
        ],
        unresolved: [], assumptions: ['每 100 g 指可食用成品，照片不用于推断实际食用量。'],
        advice: '核对菜名和做法，再填写实际吃下的克数。',
      });
    },
  });
  await page.goto('/');
  await configureMockAi(page);
  await page.getByText('记饮食', { exact: true }).click();
  const photoPicker = page.waitForEvent('filechooser');
  await page.getByText('选择照片', { exact: true }).click();
  await (await photoPicker).setFiles({ name: 'chicken-plate.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByText('照片识别完成，请核对。', { exact: true })).toBeVisible();
  await expect(page.getByTestId('ai-meal-review')).toBeVisible();
  // This regression starts from an explicitly uncounted meal so it can test
  // the older saved-record quantity editor independently of automatic defaults.
  await page.getByLabel('菜品 1 食用量', { exact: true }).fill('');
  await page.getByLabel('菜品 2 食用量', { exact: true }).fill('');
  await page.getByRole('button', { name: '确认填入', exact: true }).click();
  await expect(page.getByLabel('食物名称', { exact: true })).toHaveValue(analysedFoodName);
  await expect(page.getByLabel('份量或参考物（可选）', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('meal-nutrition-summary')).toContainText('未填写');
  await page.getByRole('button', { name: '修改营养值', exact: true }).click();
  await expect(page.getByLabel('热量 kcal', { exact: true })).toHaveValue('');
  await expect(page.getByText('菜品与营养', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/识别置信度|来源：AI|营养置信度|配方依据：|生成模型：|查看估算依据/)).toHaveCount(0);
  await expectNoOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('ai-per100g-photo-reference.png'), fullPage: true });
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // Low nutrition confidence alone must not cause extra identification requests.
  expect(provider.responses()).toHaveLength(1);

  await page.getByRole('tab', { name: '记录', exact: true }).click();
  await page.getByText(analysedFoodName, { exact: true }).click();
  const current = page.getByTestId('current-meal-analysis');
  const originalReferenceText = await current.getByText(/每 100 g：热量/).allTextContents();
  await expect(current.getByText('待填写菜品数量', { exact: true })).toBeVisible();
  await openQuantities(page);
  await expect(page.getByRole('button', { name: '选择 USDA 食材', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('菜品 1 食用量', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('菜品 2 食用量', { exact: true })).toHaveValue('');
  await expect(page.getByText('无可靠家用换算，请用克数填写。', { exact: true })).toHaveCount(2);
  await page.getByLabel('菜品 1 食用量', { exact: true }).fill('250');
  await saveQuantities(page);
  await expect(current.getByText(/已填写菜品小计 · 热量 约 400～550 kcal/)).toBeVisible();
  await expect(current.getByText('约 45.0～60.0', { exact: true })).toBeVisible();
  await expect(current.getByText('未计入菜品：蔬菜配菜', { exact: true })).toBeVisible();
  expect(await current.getByText(/每 100 g：热量/).allTextContents()).toEqual(originalReferenceText);
  expect(provider.responses()).toHaveLength(1);
  await expectNoOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('ai-per100g-250g-partial.png'), fullPage: true });
  await page.getByRole('dialog').getByLabel('关闭', { exact: true }).click();
  await page.getByRole('tab', { name: '今天', exact: true }).click();
  await expect(page.getByText(/1 餐数据不完整/).first()).toBeVisible();
  await expect(page.getByText(/1 餐均已估算/)).toHaveCount(0);
  await page.getByRole('tab', { name: '记录', exact: true }).click();
  await page.getByText(analysedFoodName, { exact: true }).click();

  await openQuantities(page);
  await expect(page.getByLabel('菜品 1 食用量', { exact: true })).toHaveValue('250');
  await page.getByLabel('菜品 1 食用量', { exact: true }).press('ControlOrMeta+A');
  await page.getByLabel('菜品 1 食用量', { exact: true }).press('Backspace');
  await expect(page.getByLabel('菜品 1 食用量', { exact: true })).toHaveValue('');
  await saveQuantities(page);
  await expect(current.getByText('待填写菜品数量', { exact: true })).toBeVisible();
  expect(await current.getByText(/每 100 g：热量/).allTextContents()).toEqual(originalReferenceText);
  expect(provider.responses()).toHaveLength(1);

  await openQuantities(page);
  await page.getByLabel('菜品 1 食用量', { exact: true }).fill('250');
  await page.getByLabel('菜品 2 食用量', { exact: true }).fill('100');
  await saveQuantities(page);
  await expect(current.getByText(/已填写菜品小计 · 热量 约 420～620 kcal/)).toBeVisible();
  await expect(current.getByText(/旧参考已失效/)).toHaveCount(0);
  expect(provider.responses()).toHaveLength(1);

  await openQuantities(page);
  await page.getByLabel('菜品 1 名称', { exact: true }).fill('去皮清蒸鸡腿');
  await page.getByLabel('菜品 1 做法', { exact: true }).fill('清蒸');
  await saveQuantities(page);
  await expect(current.getByText(/已填写菜品小计 · 热量 约 20～70 kcal/)).toBeVisible();
  await expect(page.getByRole('button', { name: '重新分析已修正菜品', exact: true })).toBeVisible();
  expect(provider.responses()).toHaveLength(1);
  await page.screenshot({ path: testInfo.outputPath('ai-per100g-stale-reference.png'), fullPage: true });
  await page.getByRole('button', { name: '重新分析已修正菜品', exact: true }).click();
  const review = page.getByTestId('ai-meal-review');
  await expect(review).toBeVisible();
  await expect(review.getByLabel('菜品 1 食用量', { exact: true })).toHaveValue('250');
  await expect(review.getByLabel('菜品 2 食用量', { exact: true })).toHaveValue('100');
  await confirmAndSaveMealReview(page);
  expect(provider.responses()).toHaveLength(2);
  expect(provider.responses()[1].record?.data.dishCorrections).toEqual([
    { label: '去皮清蒸鸡腿', cookingMethod: '清蒸' },
  ]);
  await page.getByText(correctedFoodName, { exact: true }).click();
  await expect(current.getByText(/已填写菜品小计 · 热量 约 345～495 kcal/)).toBeVisible();
  await expect(current.getByText(/每 100 g：热量 130～170 kcal/)).toBeVisible();
  await expect(current.getByText(/旧参考已失效/)).toHaveCount(0);
  await openQuantities(page);
  await expect(page.getByLabel('菜品 1 食用量', { exact: true })).toHaveValue('250');
  await expect(page.getByLabel('菜品 2 食用量', { exact: true })).toHaveValue('100');
  await page.getByLabel('关闭校正', { exact: true }).click();
  const historyButton = page.getByRole('button', { name: /^查看 \d+ 个历史分析$/ });
  const historyCount = Number((await historyButton.innerText()).match(/\d+/)?.[0]);
  expect(Number.isInteger(historyCount)).toBe(true);
  await historyButton.click();
  await expect(page.getByText(/^历史营养 · 输入版本 \d+$/)).toHaveCount(historyCount);
  await expect(page.getByText('已填数量：250 g', { exact: true }).first()).toBeVisible();
  await expectNoOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('ai-per100g-history.png'), fullPage: true });
  await page.getByRole('dialog').getByLabel('关闭', { exact: true }).click();
  await page.getByRole('tab', { name: '我的', exact: true }).click();
  const { bytes, backup } = await exportBackup(page);
  const meal = backup.data.meals[0];
  const versions = meal.analyses ?? [];
  expect(versions).toHaveLength(historyCount + 1);
  expect(versions[1].model).toBe('local/meal-review');
  expect(versions[1].analysis).toMatchObject({ status: 'unknown', calories: null, coverage: { referenceCount: 2, counted: 0 } });
  expect(versions[0].analysis).toMatchObject({
    status: 'unknown', calories: null, coverage: { referenceCount: 2, counted: 0 },
    nutritionSource: { provider: 'model', method: 'ai-per100g-v3', coverage: 'incomplete' },
  });
  const originalSource = versions[0].analysis.components?.[0].source;
  expect(originalSource).toMatchObject({
    provider: 'model', model: MOCK_AI_MODEL, reasoningEffort: 'high', basisGrams: 100,
    method: 'typical_recipe', per100gRange: originalRanges, confidence: 0.67,
  });
  for (const version of versions.slice(1, 6)) expect(version.analysis.components?.[0].source).toEqual(originalSource);
  expect(versions[2].analysis).toMatchObject({
    status: 'approximate', calories: { min: 400, max: 550 }, coverage: { counted: 1, missingQuantityLabels: ['蔬菜配菜'] },
    components: [{ userQuantity: { amount: 250, unit: 'g' } }, { userQuantity: null }],
  });
  expect(versions[3].analysis).toMatchObject({ status: 'unknown', calories: null, coverage: { counted: 0, referenceCount: 2 } });
  expect(versions[4].analysis).toMatchObject({ status: 'approximate', coverage: { counted: 2 }, nutritionSource: { coverage: 'complete' } });
  expect(versions[5].analysis.components?.[0]).toMatchObject({
    label: '去皮清蒸鸡腿', cookingMethod: '清蒸', nutritionReferenceStale: true, userQuantity: { amount: 250, unit: 'g' },
  });
  expect(versions[5].model).toBe('local/ai-per100g-v3');
  const correctedRaw = versions.slice(6).find((version) => version.model === MOCK_AI_MODEL);
  expect(correctedRaw?.analysis.components).toMatchObject([
    { label: '去皮清蒸鸡腿', userQuantity: null, source: { provider: 'model', per100gRange: correctedRanges } },
    { label: '蔬菜配菜', userQuantity: null, source: { provider: 'model', method: 'category' } },
  ]);
  expect(versions.at(-1)).toMatchObject({
    sourceVersion: meal.revision,
    model: 'local/meal-review',
    analysis: {
      calories: { min: 345, max: 495 },
      coverage: { counted: 2 },
      components: [{ userQuantity: { amount: 250, unit: 'g' } }, { userQuantity: { amount: 100, unit: 'g' } }],
    },
  });
  expect(meal.revisions?.some((revision) => revision.foodName === analysedFoodName)).toBe(true);
  expect(JSON.stringify(backup)).not.toContain(MOCK_AI_KEY);
  await page.getByText('删除本机数据', { exact: true }).click();
  await restore(page, bytes);
  await restore(page, bytes);
  await page.reload();
  await page.getByRole('tab', { name: '记录', exact: true }).click();
  await expect(page.getByText(correctedFoodName, { exact: true })).toHaveCount(1);
  await page.getByText(correctedFoodName, { exact: true }).click();
  await expect(current.getByText(/每 100 g：热量 130～170 kcal/)).toBeVisible();
  await expect(current.getByText(/已填写菜品小计 · 热量 约 345～495 kcal/)).toBeVisible();
  await expect(page.getByRole('button', { name: `查看 ${historyCount} 个历史分析`, exact: true })).toBeVisible();
  await page.getByRole('dialog').getByLabel('关闭', { exact: true }).click();
  await page.getByRole('tab', { name: '我的', exact: true }).click();
  const restored = await exportBackup(page);
  expect(restored.backup.data.meals).toEqual([meal]);
  expect(provider.legacyRequests).toEqual([]);
  expect(errors).toEqual([]);
  await expectNoOverflow(page);
});

test('可靠本地家用单位按 AI 参考换算，单独修改做法会使旧参考失效', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => { void dialog.accept(); });
  const provider = await installMockAiProvider(page, {
    onResponse: async (route) => fulfillProviderResponse(route, {
      foodName: '家用单位米饭', confidence: 0.94,
      components: [{
        foodId: 'rice_white_long_grain_cooked', label: '熟米饭', cookingMethod: '水煮',
        confidence: 0.94, category: 'grain', uncertainty: [],
        nutritionEstimate: mockNutritionEstimate({ per100g: {
          calories: { min: 125, max: 145 }, protein: { min: 2, max: 3 },
          carbs: { min: 21, max: 28 }, fat: { min: 0.2, max: 0.8 },
        } }),
      }],
      unresolved: [], assumptions: ['实际数量由用户填写。'], advice: '填写实际食用量。',
    }),
  });
  await page.goto('/');
  await configureMockAi(page);
  await page.getByText('记饮食', { exact: true }).click();
  await page.getByLabel('食物名称', { exact: true }).fill('家用单位米饭');
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('tab', { name: '记录', exact: true }).click();
  await page.getByLabel('请求饮食分析', { exact: true }).click();
  await confirmAndSaveMealReview(page, { clearQuantities: true, foodName: '家用单位米饭' });
  await page.getByText('家用单位米饭', { exact: true }).click();
  await openQuantities(page);
  await page.getByRole('button', { name: '家用份数', exact: true }).click();
  await expect(page.getByLabel('菜品 1 食用份数', { exact: true })).toHaveValue('');
  await page.getByLabel('菜品 1 食用份数', { exact: true }).fill('0.5');
  await expect(page.getByText('1 份 半碗熟米饭 ≈ 100 g', { exact: true })).toBeVisible();
  await expectNoOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('ai-per100g-household.png'), fullPage: true });
  await saveQuantities(page);
  const current = page.getByTestId('current-meal-analysis');
  await expect(current.getByText(/已填写菜品小计 · 热量 约 62～73 kcal/)).toBeVisible();
  await expect(current.getByText('已填数量：0.5 × 半碗熟米饭', { exact: true })).toBeVisible();
  expect(provider.responses()).toHaveLength(1);
  await openQuantities(page);
  await page.getByLabel('菜品 1 做法', { exact: true }).fill('蛋炒');
  await expect(page.getByLabel('菜品 1 食用量', { exact: true })).toHaveValue('');
  await expect(page.getByText('无可靠家用换算，请用克数填写。', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '家用份数', exact: true })).toHaveCount(0);
  await saveQuantities(page);
  await expect(current.getByText('每 100 g：—', { exact: true })).toBeVisible();
  await expect(current.getByText(/每 100 g：热量 125～145 kcal/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: '重新分析已修正菜品', exact: true })).toBeVisible();
  expect(provider.responses()).toHaveLength(1);
  await page.getByRole('dialog').getByLabel('关闭', { exact: true }).click();
  await page.getByRole('tab', { name: '我的', exact: true }).click();
  const { backup } = await exportBackup(page);
  const analyses = backup.data.meals[0].analyses!;
  expect(analyses).toHaveLength(4);
  expect(analyses[2].analysis.components?.[0]).toMatchObject({ userQuantity: { amount: 0.5, unit: 'household' } });
  expect(analyses[3].analysis.components?.[0]).toMatchObject({
    label: '熟米饭', cookingMethod: '蛋炒', foodId: null, userQuantity: null, nutritionReferenceStale: true,
  });
  expect(analyses[1].analysis.components?.[0].source).toEqual(analyses[0].analysis.components?.[0].source);
  expect(analyses[2].analysis.components?.[0].source).toEqual(analyses[0].analysis.components?.[0].source);
  expect(analyses[3].analysis.components?.[0].source).toEqual(analyses[0].analysis.components?.[0].source);
  expect(errors).toEqual([]);
  await expectNoOverflow(page);
});

test('已有 USDA 历史可恢复、填写数量并继续保留原版本', async ({ page }) => {
  page.on('dialog', (dialog) => { void dialog.accept(); });
  const now = new Date().toISOString();
  const legacyAnalysis = await calculateMealNutrition({
    status: 'unknown', foodName: '历史熟米饭', calories: null, protein: null, carbs: null, fat: null,
    assumptions: ['既有本地数据库参考'], advice: '填写数量。', unresolved: [],
    components: [{ foodId: 'rice_white_long_grain_cooked', label: '熟白米饭', grams: null, userQuantity: null, uncertainty: [] }],
  }, undefined, 'user-quantity-v2');
  const meal: MealRecord = {
    id: 'legacy-rice', type: 'meal', createdAt: now, occurredAt: now, mealType: '午餐',
    foodName: '历史熟米饭', portion: '', note: '', source: 'manual', estimateStatus: 'unknown', revision: 1,
    analyses: [{ id: 'legacy-analysis', sourceVersion: 1, model: 'legacy-model', createdAt: now, analysis: legacyAnalysis }],
  };
  const bytes = await createBackupArchive({ ...emptyData(), meals: [meal] }, [], now);
  await page.goto('/');
  await page.getByRole('tab', { name: '我的', exact: true }).click();
  await restore(page, Buffer.from(bytes));
  await page.getByRole('tab', { name: '记录', exact: true }).click();
  await page.getByText('历史熟米饭', { exact: true }).click();
  await expect(page.getByTestId('current-meal-analysis').getByText(/每 100 g：热量 130 kcal/)).toBeVisible();
  await page.getByRole('button', { name: '填写菜品数量', exact: true }).click();
  await expect(page.getByRole('button', { name: '选择 USDA 食材', exact: true })).toBeVisible();
  await page.getByLabel('食材 1 数量', { exact: true }).fill('200');
  await page.getByLabel('我已确认所有食物、油和酱料均已列出', { exact: true }).click();
  await saveQuantities(page);
  await expect(page.getByTestId('current-meal-analysis').getByText(/热量 约 260 kcal/)).toBeVisible();
  await page.getByRole('button', { name: '查看 1 个历史分析', exact: true }).click();
  await expect(page.getByText('历史营养 · 输入版本 1', { exact: true })).toBeVisible();
  await expectNoOverflow(page);
});
