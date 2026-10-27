import { expect, test } from '@playwright/test';
import { nutritionInput } from './helpers/meal-nutrition';
import { adaptFrontendMealRecognition } from '../shared/nutrition.mjs';
import { calculateMealNutrition, nutritionDataset } from '../src/nutrition';
import type { MealAnalysis, MealRecord } from '../src/types';
import {
  configureMockAi, fulfillProviderJson, fulfillProviderResponse, installMockAiProvider, MOCK_AI_MODEL,
} from './helpers/mock-ai-provider';
import {
  capturePortionErrors, confirmPortionReview, expectPortionFormula, expectPortionNoOverflow,
  expectPortionRanges, expectPortionSameRow, expectPortionTotals, exportPortionBackup,
  importPortionBackup, latestPortionAnalysis, openPortionMeal, pointRanges, portionAnswer,
  portionDish, portionNutrients, portionPng, portionQuantity, portionReview, reopenPortionMeal,
  reopenPortionReview, restorePortionMeals, savePortionMeal, setPortionProfile,
  setPortionRanges, uploadPortionPhoto,
} from './helpers/meal-estimated-portion';

test.beforeEach(async ({ page }) => {
  test.setTimeout(120_000);
  page.on('dialog', (dialog) => { void dialog.accept(); });
});

async function openSavedPortionReview(page: import('@playwright/test').Page, dish: ReturnType<typeof portionDish>, profile = {}) {
  const now = new Date().toISOString();
  const photoUri = `file:///saved-${encodeURIComponent(dish.label)}.png`;
  const recognition = adaptFrontendMealRecognition({ components: [dish], uncertainty: [] });
  const analysis = calculateMealNutrition(recognition as unknown as MealAnalysis, nutritionDataset, 'ai-per100g-v3', {
    provenance: { model: MOCK_AI_MODEL, createdAt: now },
  });
  const meal: MealRecord = { id: 'saved-portion-boundary', type: 'meal', createdAt: now, occurredAt: now,
    revision: 1, mealType: '午餐', foodName: dish.label, portion: '', note: '', source: 'photo', estimateStatus: 'unknown',
    imageUri: photoUri, beforeImageUris: [photoUri],
    analyses: [{ id: 'saved-portion-boundary-analysis', sourceVersion: 1, model: MOCK_AI_MODEL, createdAt: now, analysis }],
  };
  await restorePortionMeals(page, [meal], profile, [{ uri: photoUri, kind: 'image', bytes: portionPng, mimeType: 'image/png', extension: 'png' }]);
  await reopenPortionMeal(page, dish.label);
  await reopenPortionReview(page);
}

test('默认成人自动估填，保存体重改变估值且有效目标优先；确认、刷新和 ZIP 恢复保留估计来源', async ({ page, browser }, info) => {
  const errors = capturePortionErrors(page);
  const provider = await installMockAiProvider(page, { onResponse: async (route) => fulfillProviderResponse(route, portionAnswer) });
  await page.emulateMedia({ colorScheme: 'light' });
  await openPortionMeal(page);
  await uploadPortionPhoto(page);
  const adultGrams = Number(await portionQuantity(page).inputValue());
  expect(adultGrams).toBeGreaterThan(0);
  // 60 kg × 25–35 kcal/kg/day × 35% lunch ÷ 200 kcal/100 g.
  expect(adultGrams).toBeGreaterThanOrEqual(262);
  expect(adultGrams).toBeLessThanOrEqual(368);
  await expect(page.getByTestId('meal-portion-estimate')).toContainText(/60\s*kg/);
  await expect(page.getByTestId('review-dish-1')).toContainText('估计');
  await expect(page.getByTestId('meal-portion-reference')).toHaveCount(0);
  await expect(portionReview(page).getByText('本餐备餐参考', { exact: true })).toHaveCount(0);
  await expect(portionReview(page).getByRole('button', { name: '填入空白食用量', exact: true })).toHaveCount(0);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator('html')).toHaveCSS('color-scheme', scheme);
    await portionQuantity(page).scrollIntoViewIfNeeded();
    await expectPortionNoOverflow(page);
    await page.screenshot({ path: info.outputPath(`default-estimated-portion-${scheme}.png`), fullPage: true });
  }
  await confirmPortionReview(page);
  await expectPortionFormula(page, [{ grams: adultGrams, per100g: pointRanges() }]);
  const header = page.getByTestId('meal-nutrition-header');
  await header.scrollIntoViewIfNeeded();
  await expect(header.getByTestId('meal-edit-portions')).toHaveAccessibleName('修改本餐食用量');
  await expectPortionSameRow(header.getByText('营养值（可选）', { exact: true }), header.getByTestId('meal-edit-portions'));
  await expect(page.getByRole('button', { name: '填写食用量', exact: true })).toHaveCount(0);
  await expect(page.getByText('已确认菜品', { exact: true })).toHaveCount(0);
  await expectPortionNoOverflow(page);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator('html')).toHaveCSS('color-scheme', scheme);
    await page.screenshot({ path: info.outputPath(`nutrition-header-entry-${scheme}.png`), fullPage: true });
  }
  await page.getByLabel('食物名称', { exact: true }).fill('默认成人午餐');
  await savePortionMeal(page);

  await setPortionProfile(page, { weightKg: 90 });
  await page.reload();
  await page.getByText('记饮食', { exact: true }).click();
  await uploadPortionPhoto(page);
  const weightedGrams = Number(await portionQuantity(page).inputValue());
  expect(weightedGrams).toBeGreaterThan(adultGrams);
  expect(weightedGrams / adultGrams).toBeCloseTo(1.5, 1);
  await expect(page.getByTestId('meal-portion-estimate')).toContainText(/90\s*kg/);
  await confirmPortionReview(page);
  await expectPortionFormula(page, [{ grams: weightedGrams, per100g: pointRanges() }]);
  await page.getByLabel('食物名称', { exact: true }).fill('90kg 体重午餐');
  await savePortionMeal(page);

  await setPortionProfile(page, { weightKg: 90, calorieTarget: 1200 });
  await page.getByText('记饮食', { exact: true }).click();
  await uploadPortionPhoto(page);
  const targetGrams = Number(await portionQuantity(page).inputValue());
  expect(targetGrams).toBeGreaterThan(0);
  expect(targetGrams).toBeLessThan(adultGrams);
  expect(targetGrams * 2).toBeCloseTo(1200 * 0.35, 0);
  await expect(page.getByTestId('meal-portion-estimate')).toContainText(/目标|1200/);
  await confirmPortionReview(page);
  await expectPortionFormula(page, [{ grams: targetGrams, per100g: pointRanges() }]);
  await page.getByLabel('食物名称', { exact: true }).fill('目标优先午餐');
  await savePortionMeal(page);

  await page.reload();
  await reopenPortionMeal(page, '默认成人午餐');
  await expectPortionFormula(page, [{ grams: adultGrams, per100g: pointRanges() }]);
  await reopenPortionReview(page);
  await expect(portionQuantity(page)).toHaveValue(String(adultGrams));
  await expect(page.getByTestId('review-dish-1')).toContainText('估计');
  await page.getByRole('button', { name: '返回饮食', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  const { archive, bytes } = await exportPortionBackup(page);
  expect(archive.data.profile).toMatchObject({ weightKg: 90, calorieTarget: 1200 });
  for (const [title, grams] of [['默认成人午餐', adultGrams], ['90kg 体重午餐', weightedGrams], ['目标优先午餐', targetGrams]] as const) {
    const meal = archive.data.meals.find((entry) => entry.foodName === title)!;
    expect(meal).toBeDefined();
    const confirmed = latestPortionAnalysis(meal).analysis;
    expect(confirmed).toMatchObject({ status: 'approximate',
      components: [{ userQuantity: { amount: grams, unit: 'g', origin: 'estimated' } }] });
    expect(confirmed.assumptions.join('\n')).toContain('食用量参考：');
    expect(confirmed.assumptions.join('\n')).toContain('kcal');
    expect(confirmed.assumptions.join('\n')).toContain('按 AI 对本次菜品组合的建议分配');
    const original = meal.analyses!.find((version) => version.model === MOCK_AI_MODEL)!;
    expect(original.analysis.components![0].userQuantity).toBeNull();
    for (const [key] of portionNutrients) expect(original.analysis[key]).toBeNull();
  }
  const restoredContext = await browser.newContext({ viewport: page.viewportSize()!, locale: 'zh-CN' });
  try {
    const restoredPage = await restoredContext.newPage();
    restoredPage.on('dialog', (dialog) => { void dialog.accept(); });
    capturePortionErrors(restoredPage, errors);
    await restoredPage.goto(page.url());
    await importPortionBackup(restoredPage, bytes);
    await reopenPortionMeal(restoredPage, '默认成人午餐');
    await expectPortionFormula(restoredPage, [{ grams: adultGrams, per100g: pointRanges() }]);
    await reopenPortionReview(restoredPage);
    await expect(portionQuantity(restoredPage)).toHaveValue(String(adultGrams));
    await expect(restoredPage.getByTestId('review-dish-1')).toContainText('估计');
    await expectPortionNoOverflow(restoredPage);
  } finally { await restoredContext.close(); }
  expect(provider.responses()).toHaveLength(3);
  expect(provider.legacyRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test('旧分析已有估计数量但缺少份额时提示复核，补估空白项并保留原数量', async ({ page }) => {
  const errors = capturePortionErrors(page);
  const now = new Date().toISOString();
  const photoUri = 'file:///meal-with-empty-portion.png';
  const riceReference = pointRanges(130, 2, 28, 0.3);
  const eggReference = pointRanges(155, 13, 1, 11);
  const provider = await installMockAiProvider(page, { onResponse: async (route) => fulfillProviderResponse(route, {
    components: [
      portionDish('熟米饭', riceReference, '蒸煮', 0.65),
      portionDish('卤鸡蛋', eggReference, '卤', 0.35),
    ], uncertainty: [],
  }) });
  const oldRecognition = adaptFrontendMealRecognition({ components: [
    portionDish('熟米饭', riceReference, '蒸煮', 0.65),
    portionDish('卤鸡蛋', eggReference, '卤', 0.35),
  ], uncertainty: [] });
  const oldInput = {
    ...oldRecognition,
    status: 'unknown', calories: null, protein: null, carbs: null, fat: null,
    components: oldRecognition.components.map(({ recommendedShare: _share, ...component }, index) => ({
      ...component,
      userQuantity: index === 0 ? { amount: 120, unit: 'g', origin: 'estimated' as const } : null,
    })),
  } as unknown as MealAnalysis;
  const oldAnalysis = calculateMealNutrition(oldInput, nutritionDataset, 'ai-per100g-v3', {
    provenance: { model: MOCK_AI_MODEL, createdAt: now },
  });
  const oldMeal: MealRecord = {
    id: 'meal-with-empty-portion', type: 'meal', createdAt: now, occurredAt: now, revision: 1,
    mealType: '午餐', foodName: '熟米饭、卤鸡蛋', portion: '', note: '', source: 'photo', estimateStatus: 'unknown',
    imageUri: photoUri, beforeImageUris: [photoUri],
    analyses: [{ id: 'old-analysis-with-empty-portion', sourceVersion: 1, model: MOCK_AI_MODEL, createdAt: now, analysis: oldAnalysis }],
  };
  await restorePortionMeals(page, [oldMeal], {}, [{ uri: photoUri, kind: 'image', bytes: portionPng, mimeType: 'image/png', extension: 'png' }]);
  await configureMockAi(page);
  await reopenPortionMeal(page, oldMeal.foodName);
  await reopenPortionReview(page);

  await expect(portionQuantity(page, 1)).toHaveValue('120');
  await expect(portionQuantity(page, 2)).toHaveValue('');
  const guidance = portionReview(page).getByTestId('meal-portion-estimate');
  await expect(guidance).toContainText('AI 复核');
  await expect(guidance).not.toContainText('并为可估算的空白菜品填入建议量');
  await portionReview(page).getByRole('button', { name: 'AI 复核', exact: true }).click();
  await expect(portionReview(page).getByText('AI 复核完成，请核对。', { exact: true })).toBeVisible();

  const riceGrams = Number(await portionQuantity(page, 1).inputValue());
  const eggGrams = Number(await portionQuantity(page, 2).inputValue());
  expect(riceGrams).toBe(120);
  expect(eggGrams).toBeGreaterThan(0);
  await confirmPortionReview(page);
  await expectPortionFormula(page, [
    { grams: riceGrams, per100g: riceReference },
    { grams: eggGrams, per100g: eggReference },
  ]);
  expect(provider.responses()).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('打开旧餐食时给已有建议份额的空白菜品补估量并保留已保存数量', async ({ page }) => {
  const errors = capturePortionErrors(page);
  const now = new Date().toISOString();
  const photoUri = 'file:///saved-meal-with-empty-quantity.png';
  const riceReference = pointRanges(130, 2, 28, 0.3);
  const eggReference = pointRanges(155, 13, 1, 11);
  const originalRecognition = adaptFrontendMealRecognition({ components: [
    portionDish('熟米饭', riceReference, '蒸煮', 0.65),
    portionDish('卤鸡蛋', eggReference, '卤', 0.35),
  ], uncertainty: [] });
  const oldInput = {
    ...originalRecognition,
    status: 'unknown', calories: null, protein: null, carbs: null, fat: null,
    components: originalRecognition.components.map((component, index) => ({ ...component,
      userQuantity: index === 0 ? { amount: 120, unit: 'g', origin: 'estimated' as const } : null,
    })),
  } as unknown as MealAnalysis;
  const oldAnalysis = calculateMealNutrition(oldInput, nutritionDataset, 'ai-per100g-v3', {
    provenance: { model: MOCK_AI_MODEL, createdAt: now },
  });
  const oldMeal: MealRecord = {
    id: 'saved-meal-with-empty-quantity', type: 'meal', createdAt: now, occurredAt: now, revision: 1,
    mealType: '午餐', foodName: '熟米饭、卤鸡蛋', portion: '', note: '', source: 'photo', estimateStatus: 'unknown',
    imageUri: photoUri, beforeImageUris: [photoUri],
    analyses: [{ id: 'saved-analysis-with-empty-quantity', sourceVersion: 1, model: MOCK_AI_MODEL, createdAt: now, analysis: oldAnalysis }],
  };
  const provider = await installMockAiProvider(page, { onResponse: async (route) => fulfillProviderResponse(route, portionAnswer) });
  await restorePortionMeals(page, [oldMeal], {}, [{ uri: photoUri, kind: 'image', bytes: portionPng, mimeType: 'image/png', extension: 'png' }]);
  await reopenPortionMeal(page, oldMeal.foodName);
  await reopenPortionReview(page);

  const riceGrams = Number(await portionQuantity(page, 1).inputValue());
  const eggGrams = Number(await portionQuantity(page, 2).inputValue());
  expect(riceGrams).toBe(120);
  expect(eggGrams).toBeGreaterThan(0);
  await expect(page.getByTestId('meal-portion-estimate')).toContainText('为新补估菜品填入建议量');
  await confirmPortionReview(page);
  await expectPortionFormula(page, [
    { grams: riceGrams, per100g: riceReference },
    { grams: eggGrams, per100g: eggReference },
  ]);
  expect(provider.responses()).toHaveLength(0);
  expect(errors).toEqual([]);
});

test('已知未成年时解释成人参考不适用，不建议为补量发起AI复核', async ({ page }) => {
  await openSavedPortionReview(page, portionDish('熟米饭'), { ageYears: 16 });
  await expect(portionQuantity(page)).toHaveValue('');
  const guidance = page.getByTestId('meal-portion-estimate');
  await expect(guidance).toContainText('未成年人');
  await expect(guidance).toContainText('请手动填写食用量');
  await expect(guidance).not.toContainText('AI 复核');
});

test('热量密度低于换算边界时说明原因，不建议无效的AI复核', async ({ page }) => {
  await openSavedPortionReview(page, portionDish('清汤蔬菜', pointRanges(40, 1, 8, 1), '煮'));
  await expect(portionQuantity(page)).toHaveValue('');
  const guidance = page.getByTestId('meal-portion-estimate');
  await expect(guidance).toContainText('热量密度');
  await expect(guidance).toContainText('请手动填写食用量');
  await expect(guidance).not.toContainText('AI 复核');
});

test('份额把握较低时仍采用 AI 的最佳估计并自动填入每道菜', async ({ page }) => {
  const errors = capturePortionErrors(page);
  const rice = portionDish('米饭', pointRanges(130, 2, 28, 0.3), '蒸煮', 0.75);
  rice.uncertainty = ['餐盘中各菜实际份额不清，按主食与主菜组合尽力估计。'];
  const main = portionDish('煎鱼', pointRanges(220, 24, 0, 13), '煎', 0.25);
  const provider = await installMockAiProvider(page, { onResponse: async (route) => fulfillProviderResponse(route,
    { components: [rice, main], uncertainty: [] }) });
  await openPortionMeal(page);
  await uploadPortionPhoto(page);

  const riceGrams = Number(await portionQuantity(page, 1).inputValue());
  const mainGrams = Number(await portionQuantity(page, 2).inputValue());
  expect(riceGrams).toBeGreaterThan(0);
  expect(mainGrams).toBeGreaterThan(0);
  expect(riceGrams).toBeGreaterThan(mainGrams);
  await expect(page.getByTestId('meal-portion-estimate')).toContainText('按实际情况修改');
  await confirmPortionReview(page);
  await expectPortionFormula(page, [
    { grams: riceGrams, per100g: pointRanges(130, 2, 28, 0.3) },
    { grams: mainGrams, per100g: pointRanges(220, 24, 0, 13) },
  ]);
  expect(provider.responses()).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('保存的自定义标题在明确确认时同步当前菜品组合，手填新四项立即回填且之后可再改标题', async ({ page }) => {
  const errors = capturePortionErrors(page);
  const provider = await installMockAiProvider(page, { onResponse: async (route) => fulfillProviderResponse(route, portionAnswer) });
  await openPortionMeal(page);
  await page.getByLabel('食物名称', { exact: true }).fill('原来手填的午餐');
  await uploadPortionPhoto(page);
  await portionQuantity(page).fill('100');
  await confirmPortionReview(page);
  await expect(page.getByLabel('食物名称', { exact: true })).toHaveValue('熟米饭');
  await page.getByLabel('食物名称', { exact: true }).fill('周三自带午餐');
  await savePortionMeal(page);
  await page.reload();
  await reopenPortionMeal(page, '周三自带午餐');
  await reopenPortionReview(page);
  await portionReview(page).getByLabel('菜品 1 名称', { exact: true }).fill('豆香炖饭');
  const updated = pointRanges(300, 15, 30, 10);
  await expectPortionRanges(page, 1, null);
  await setPortionRanges(page, 1, updated);
  await portionQuantity(page).fill('125');
  await portionReview(page).getByRole('button', { name: '添加菜品', exact: true }).click();
  await portionReview(page).getByLabel('菜品 2 名称', { exact: true }).fill('清蒸南瓜');
  const pumpkin = pointRanges(100, 2, 20, 1);
  await setPortionRanges(page, 2, pumpkin);
  await portionQuantity(page, 2).fill('200');
  await confirmPortionReview(page);
  await expect(page.getByLabel('食物名称', { exact: true })).toHaveValue('豆香炖饭、清蒸南瓜');
  await expectPortionFormula(page, [{ grams: 125, per100g: updated }, { grams: 200, per100g: pumpkin }]);
  expect(provider.responses()).toHaveLength(1);
  await page.getByLabel('食物名称', { exact: true }).fill('我的午餐备忘');
  await savePortionMeal(page);
  await page.reload();
  await reopenPortionMeal(page, '我的午餐备忘');
  await expectPortionFormula(page, [{ grams: 125, per100g: updated }, { grams: 200, per100g: pumpkin }]);
  await savePortionMeal(page);
  const { archive } = await exportPortionBackup(page);
  const meal = archive.data.meals[0];
  expect(meal).toMatchObject({ foodName: '我的午餐备忘', foodNameSource: 'user' });
  expect(latestPortionAnalysis(meal).analysis.components).toMatchObject([
    { label: '豆香炖饭', userNutritionPer100g: updated, userQuantity: { amount: 125, unit: 'g', origin: 'user' } },
    { label: '清蒸南瓜', userNutritionPer100g: pumpkin, userQuantity: { amount: 200, unit: 'g', origin: 'user' } },
  ]);
  expect(errors).toEqual([]);
});

test('旧备份记录的已有标题在确认新菜名和手填四项后同步，保留原始数据库版本', async ({ page }) => {
  const errors = capturePortionErrors(page);
  const provider = await installMockAiProvider(page);
  const now = new Date().toISOString();
  const source = { provider: 'usda-fdc' as const, dataset: 'Saved USDA snapshot', fdcId: '168878',
    per100g: { calories: 200, protein: 10, carbs: 20, fat: 5 } };
  const legacy: MealRecord = {
    id: 'estimated-legacy-meal', type: 'meal', createdAt: now, occurredAt: now, revision: 1,
    mealType: '午餐', foodName: '以前保存的午餐', portion: '', note: '', source: 'ai', estimateStatus: 'unknown',
    analyses: [{ id: 'estimated-legacy-analysis', sourceVersion: 1, model: 'local/legacy-database', createdAt: now, analysis: {
      status: 'unknown', foodName: '熟米饭', calories: null, protein: null, carbs: null, fat: null,
      assumptions: [], advice: '按保存的每 100 g 快照计算。', nutritionSource: { provider: 'usda-fdc', dataset: source.dataset, coverage: 'incomplete' },
      components: [{ foodId: 'rice_white_long_grain_cooked', label: '熟米饭', cookingMethod: '蒸煮', grams: null,
        quantitySource: 'unknown', consumedFraction: null, userQuantity: null, uncertainty: [], source }],
    } }],
  };
  await restorePortionMeals(page, [legacy]);
  await reopenPortionMeal(page, legacy.foodName);
  await reopenPortionReview(page);
  await portionReview(page).getByLabel('菜品 1 名称', { exact: true }).fill('南瓜炖饭');
  const updated = pointRanges(240, 12, 28, 8);
  await setPortionRanges(page, 1, updated);
  await portionQuantity(page).fill('150');
  await confirmPortionReview(page);
  await expect(page.getByLabel('食物名称', { exact: true })).toHaveValue('南瓜炖饭');
  await expectPortionFormula(page, [{ grams: 150, per100g: updated }]);
  await savePortionMeal(page);
  const { archive } = await exportPortionBackup(page);
  const saved = archive.data.meals[0];
  expect(saved.foodName).toBe('南瓜炖饭');
  expect(saved.analyses!.find((version) => version.id === 'estimated-legacy-analysis')!.analysis.components![0]).toMatchObject({ source, userQuantity: null });
  expect(latestPortionAnalysis(saved).analysis.components![0]).toMatchObject({ label: '南瓜炖饭', userNutritionPer100g: updated,
    userQuantity: { amount: 150, unit: 'g', origin: 'user' } });
  expect(provider.responses()).toHaveLength(0);
  expect(errors).toEqual([]);
});

test('菜名改动使旧参考失效，确认自动复核一次并直接采用新参考和当前数量', async ({ page }) => {
  const errors = capturePortionErrors(page);
  const reviewed = pointRanges(260, 12, 32, 9);
  let calls = 0;
  const provider = await installMockAiProvider(page, { onResponse: async (route) => fulfillProviderResponse(route,
    ++calls === 1 ? portionAnswer : { components: [portionDish('少油蛋炒饭', reviewed)], uncertainty: [] }) });
  await openPortionMeal(page);
  await uploadPortionPhoto(page);
  await confirmPortionReview(page);
  await reopenPortionReview(page);
  const grams = 145;
  await portionQuantity(page).fill(String(grams));
  await portionReview(page).getByLabel('菜品 1 名称', { exact: true }).fill('少油蛋炒饭');
  await expectPortionRanges(page, 1, null);
  await expect(portionReview(page).getByRole('button', { name: 'AI 复核', exact: true })).toBeEnabled();
  await confirmPortionReview(page);
  await expect(page.getByLabel('食物名称', { exact: true })).toHaveValue('少油蛋炒饭');
  await expectPortionFormula(page, [{ grams, per100g: reviewed }]);
  const requests = provider.responses();
  expect(requests).toHaveLength(2);
  expect(requests[1].record?.data.dishCorrections).toEqual(expect.arrayContaining([expect.objectContaining({ label: '少油蛋炒饭' })]));
  await savePortionMeal(page);
  const { archive } = await exportPortionBackup(page);
  const meal = archive.data.meals[0];
  expect(latestPortionAnalysis(meal).analysis.components![0]).toMatchObject({ label: '少油蛋炒饭',
    source: { per100gRange: reviewed }, userQuantity: { amount: grams, unit: 'g', origin: 'user' } });
  const modelVersions = meal.analyses!.filter((version) => version.model === MOCK_AI_MODEL);
  expect(modelVersions).toHaveLength(2);
  expect(modelVersions[0].analysis.components![0]).toMatchObject({ label: '熟米饭', source: { per100gRange: pointRanges() }, userQuantity: null });
  expect(modelVersions[1].analysis.components![0]).toMatchObject({ label: '少油蛋炒饭', source: { per100gRange: reviewed }, userQuantity: null });
  expect(errors).toEqual([]);
});

test('确认触发的复核失败保留编辑和旧表单，不自动重试，补齐新四项后可直接确认', async ({ page }) => {
  const errors = capturePortionErrors(page);
  let calls = 0;
  const provider = await installMockAiProvider(page, { onResponse: async (route) => {
    if (++calls === 1) await fulfillProviderResponse(route, portionAnswer);
    else await fulfillProviderJson(route, { id: 'invalid-review', output: [] });
  } });
  await openPortionMeal(page);
  await uploadPortionPhoto(page);
  await portionQuantity(page).fill('100');
  await confirmPortionReview(page);
  await page.getByLabel('食物名称', { exact: true }).fill('已填写的整餐标题');
  await page.clock.install();
  await reopenPortionReview(page);
  await portionReview(page).getByLabel('菜品 1 名称', { exact: true }).fill('失败后保留的菜名');
  await portionQuantity(page).fill('135');
  await portionReview(page).getByLabel('补充说明（用于复核）', { exact: true }).fill('失败后保留的修改备注');
  await portionReview(page).getByRole('button', { name: '确认填入', exact: true }).click();
  await expect(portionReview(page).getByText('AI 复核未完成，修改内容已保留。', { exact: true })).toBeVisible();
  await expect(portionReview(page).getByLabel('菜品 1 名称', { exact: true })).toHaveValue('失败后保留的菜名');
  await expect(portionQuantity(page)).toHaveValue('135');
  await expectPortionRanges(page, 1, null);
  await expect(portionReview(page).getByLabel('补充说明（用于复核）', { exact: true })).toHaveValue('失败后保留的修改备注');
  await expect(portionReview(page).getByRole('button', { name: '确认填入', exact: true })).toBeEnabled();
  await page.clock.fastForward(30_000);
  expect(provider.responses()).toHaveLength(2);
  await page.getByRole('button', { name: '返回饮食', exact: true }).click();
  await expect(page.getByLabel('食物名称', { exact: true })).toHaveValue('已填写的整餐标题');
  await expectPortionTotals(page, pointRanges());
  await expect(page.getByLabel('备注（可选）', { exact: true })).toHaveValue('');
  await reopenPortionReview(page);
  await expect(portionReview(page).getByLabel('菜品 1 名称', { exact: true })).toHaveValue('失败后保留的菜名');
  const updated = pointRanges(250, 15, 25, 8);
  await setPortionRanges(page, 1, updated);
  await confirmPortionReview(page);
  await expect(page.getByLabel('食物名称', { exact: true })).toHaveValue('失败后保留的菜名');
  await expectPortionFormula(page, [{ grams: 135, per100g: updated }]);
  expect(provider.responses()).toHaveLength(2);
  expect(errors).toEqual([]);
});

test('用户覆盖和主动清空优先，显式复核及刷新重开保持清空，部分小计只计入有数量的菜', async ({ page }) => {
  const errors = capturePortionErrors(page);
  const chicken = pointRanges(100, 20, 5, 3);
  const answer = { components: [portionDish('熟米饭', pointRanges(), '蒸煮', 0.7), portionDish('清蒸鸡肉', chicken, '清蒸', 0.3)], uncertainty: [] };
  const provider = await installMockAiProvider(page, { onResponse: async (route) => fulfillProviderResponse(route, answer) });
  await openPortionMeal(page);
  await uploadPortionPhoto(page);
  const first = Number(await portionQuantity(page).inputValue());
  expect(first).toBeGreaterThan(0);
  const second = Number(await portionQuantity(page, 2).inputValue());
  expect(second).toBeGreaterThan(0);
  expect(first).toBeGreaterThan(second);
  await portionQuantity(page).fill('120');
  await portionQuantity(page, 2).fill('');
  await portionReview(page).getByLabel('补充说明（用于复核）', { exact: true }).fill('第二道菜没有吃，不计入本餐。');
  await expect(portionQuantity(page)).toHaveValue('120');
  await expect(portionQuantity(page, 2)).toHaveValue('');
  await expect(portionReview(page)).toContainText('未计入菜品：清蒸鸡肉');
  await portionReview(page).getByRole('button', { name: 'AI 复核', exact: true }).click();
  await expect(portionReview(page).getByText('AI 复核完成，请核对。', { exact: true })).toBeVisible();
  await expect(portionQuantity(page)).toHaveValue('120');
  await expect(portionQuantity(page, 2)).toHaveValue('');
  await confirmPortionReview(page);
  await expectPortionFormula(page, [{ grams: 120, per100g: pointRanges() }]);
  await savePortionMeal(page);
  await page.reload();
  await reopenPortionMeal(page, '熟米饭、清蒸鸡肉');
  await reopenPortionReview(page);
  await expect(portionQuantity(page)).toHaveValue('120');
  await expect(portionQuantity(page, 2)).toHaveValue('');
  await expectPortionNoOverflow(page);
  await confirmPortionReview(page);
  await expectPortionFormula(page, [{ grams: 120, per100g: pointRanges() }]);
  await savePortionMeal(page);
  const { archive } = await exportPortionBackup(page);
  const meal = archive.data.meals[0];
  const analysis = latestPortionAnalysis(meal).analysis;
  expect(analysis.coverage).toMatchObject({ counted: 1, referenceCount: 2, missingQuantityLabels: ['清蒸鸡肉'] });
  expect(analysis.components).toMatchObject([
    { userQuantity: { amount: 120, unit: 'g', origin: 'user' } },
    { userQuantity: null, userQuantityCleared: true },
  ]);
  expect(meal.analyses!.filter((version) => version.model === MOCK_AI_MODEL)
    .every((version) => version.analysis.components!.every((component) => component.userQuantity === null))).toBe(true);
  expect(provider.responses()).toHaveLength(2);
  expect(errors).toEqual([]);
});

for (const kind of ['unknown', 'identity-conflict'] as const) {
  test(`${kind} 菜品不估填数量和零营养，确认仍保留未知`, async ({ page }) => {
    const errors = capturePortionErrors(page);
    const component = kind === 'unknown' ? portionDish('未知配方菜', null)
      : { ...portionDish('待确认菜品'), uncertainty: ['菜品身份待确认。'] };
    const provider = await installMockAiProvider(page, { onResponse: async (route) => fulfillProviderResponse(route,
      { components: [component], uncertainty: [] }) });
    await openPortionMeal(page);
    await uploadPortionPhoto(page);
    const recognitionCount = provider.responses().length;
    await expect(portionQuantity(page)).toHaveValue('');
    await expect(page.getByTestId('meal-portion-estimate')).toContainText(/未知|未确认|待确认|无法|缺少/);
    await expect(portionReview(page)).toContainText('热量 —');
    await confirmPortionReview(page);
    await expectPortionTotals(page, null);
    await savePortionMeal(page);
    const { archive } = await exportPortionBackup(page);
    const analysis = latestPortionAnalysis(archive.data.meals[0]).analysis;
    for (const [key] of portionNutrients) expect(analysis[key]).toBeNull();
    expect(analysis.components![0].userQuantity).toBeNull();
    expect(provider.responses()).toHaveLength(recognitionCount);
    expect(errors).toEqual([]);
  });
}

test('默认估计量确认后可手填整餐四营养，保存重开和 ZIP 保留人工总量及 estimated 数量来源', async ({ page }) => {
  const errors = capturePortionErrors(page);
  const provider = await installMockAiProvider(page, { onResponse: async (route) => fulfillProviderResponse(route, portionAnswer) });
  await openPortionMeal(page);
  await uploadPortionPhoto(page);
  const grams = Number(await portionQuantity(page).inputValue());
  expect(grams).toBeGreaterThan(0);
  await confirmPortionReview(page);
  await expectPortionFormula(page, [{ grams, per100g: pointRanges() }]);
  const manual = pointRanges(740, 40, 80, 21);
  for (const [key, , label] of portionNutrients) await (await nutritionInput(page, label)).fill(String(manual[key].min));
  await page.getByLabel('食物名称', { exact: true }).fill('整餐人工覆盖');
  await savePortionMeal(page);
  await page.reload();
  await reopenPortionMeal(page, '整餐人工覆盖');
  await expectPortionTotals(page, manual);
  await reopenPortionReview(page);
  await expect(portionQuantity(page)).toHaveValue(String(grams));
  await expect(page.getByTestId('review-dish-1')).toContainText('估计');
  await page.getByRole('button', { name: '返回饮食', exact: true }).click();
  await expectPortionTotals(page, manual);
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  const { archive } = await exportPortionBackup(page);
  const meal = archive.data.meals[0];
  expect(latestPortionAnalysis(meal)).toMatchObject({ model: 'local/manual-nutrition', analysis: {
    ...manual, status: 'estimated', nutritionSource: { provider: 'manual', method: 'manual-total-v1' },
    components: [{ userQuantity: { amount: grams, unit: 'g', origin: 'estimated' } }],
  } });
  expect(meal.analyses!.some((version) => version.model === 'local/meal-review'
    && version.analysis.status === 'approximate'
    && version.analysis.components?.[0].userQuantity?.origin === 'estimated')).toBe(true);
  expect(meal.analyses!.find((version) => version.model === MOCK_AI_MODEL)!.analysis.components![0].userQuantity).toBeNull();
  expect(provider.responses()).toHaveLength(1);
  expect(errors).toEqual([]);
});

for (const degradation of ['unknown-reference', 'same-name-identity-conflict', 'unrecognized-extra-dish'] as const) {
  test(`多菜自动复核 ${degradation} 留页核对，旧表单标题和四营养保持`, async ({ page }) => {
    const errors = capturePortionErrors(page);
    const chicken = pointRanges(100, 20, 5, 3);
    const updatedRice = pointRanges(240, 12, 30, 7);
    const original = { components: [portionDish('熟米饭'), portionDish('清蒸鸡肉', chicken, '清蒸')], uncertainty: [] };
    const affected = degradation === 'unknown-reference' ? portionDish('清蒸鸡肉', null, '清蒸')
      : degradation === 'same-name-identity-conflict'
        ? { ...portionDish('清蒸鸡肉', chicken, '清蒸'), uncertainty: ['菜品身份冲突，食材身份无法确认。'] }
        : portionDish('清蒸鸡肉', chicken, '清蒸');
    const reviewed = { components: [portionDish('番茄炖饭', updatedRice), affected],
      uncertainty: degradation === 'unrecognized-extra-dish' ? ['还有一道主食未识别。'] : [] };
    let calls = 0;
    const provider = await installMockAiProvider(page, { onResponse: async (route) => fulfillProviderResponse(route, ++calls === 1 ? original : reviewed) });
    await openPortionMeal(page);
    await uploadPortionPhoto(page);
    await portionQuantity(page).fill('100');
    await portionQuantity(page, 2).fill('100');
    await confirmPortionReview(page);
    await expectPortionFormula(page, [{ grams: 100, per100g: pointRanges() }, { grams: 100, per100g: chicken }]);
    await page.clock.install();
    await reopenPortionReview(page);
    await portionReview(page).getByLabel('菜品 1 名称', { exact: true }).fill('番茄炖饭');
    await expectPortionRanges(page, 1, null);
    await portionReview(page).getByRole('button', { name: '确认填入', exact: true }).click();
    await expectPortionRanges(page, 1, updatedRice);
    await expect(portionReview(page).getByRole('button', { name: '确认填入', exact: true })).toBeEnabled();
    await expect(portionReview(page)).toBeVisible();
    await expect(portionReview(page).getByLabel('菜品 1 名称', { exact: true })).toHaveValue('番茄炖饭');
    await expect(portionReview(page).getByLabel('菜品 2 名称', { exact: true })).toHaveValue('清蒸鸡肉');
    await expect(portionReview(page).getByLabel('菜品 1 名称', { exact: true })).toBeEditable();
    await expect(portionReview(page).getByLabel('菜品 2 名称', { exact: true })).toBeEditable();
    if (degradation === 'unknown-reference') await expectPortionRanges(page, 2, null);
    else {
      await expectPortionRanges(page, 2, chicken);
      await expect(page.getByTestId('meal-portion-estimate')).toContainText(degradation === 'same-name-identity-conflict'
        ? /身份.*(?:未确认|冲突|待确认)/ : /遗漏|不完整|未识别/);
    }
    const expectedRequests = degradation === 'same-name-identity-conflict' ? 3 : 2;
    expect(provider.responses()).toHaveLength(expectedRequests);
    // The identity case uses the existing adaptive crop review as part of one
    // confirmation-triggered operation. It must not restart a second operation.
    expect(provider.responses().filter((request) => !request.record?.reviewContext?.stage)).toHaveLength(2);
    await page.clock.fastForward(30_000);
    expect(provider.responses()).toHaveLength(expectedRequests);
    await page.getByRole('button', { name: '返回饮食', exact: true }).click();
    await expect(page.getByLabel('食物名称', { exact: true })).toHaveValue('熟米饭、清蒸鸡肉');
    await expectPortionFormula(page, [{ grams: 100, per100g: pointRanges() }, { grams: 100, per100g: chicken }]);
    await reopenPortionReview(page);
    await expect(portionReview(page).getByLabel('菜品 1 名称', { exact: true })).toHaveValue('番茄炖饭');
    await expect(portionReview(page).getByLabel('菜品 2 名称', { exact: true })).toHaveValue('清蒸鸡肉');
    await expectPortionNoOverflow(page);
    expect(errors).toEqual([]);
  });
}

test('右侧已查看的100g草稿在旧入口保存200g校正后同步，重新打开不会恢复旧数量', async ({ page }) => {
  const errors = capturePortionErrors(page);
  const provider = await installMockAiProvider(page, { onResponse: async (route) => fulfillProviderResponse(route, portionAnswer) });
  await openPortionMeal(page);
  await uploadPortionPhoto(page);
  await portionQuantity(page).fill('100');
  await confirmPortionReview(page);
  await savePortionMeal(page);
  await page.reload();
  await reopenPortionMeal(page, '熟米饭');
  await reopenPortionReview(page);
  await expect(portionQuantity(page)).toHaveValue('100');
  await page.getByRole('button', { name: '返回饮食', exact: true }).click();
  await page.getByRole('button', { name: '填写菜品数量', exact: true }).click();
  await page.getByLabel('菜品 1 食用量', { exact: true }).fill('200');
  await page.getByRole('button', { name: '保存营养校正', exact: true }).click();
  await expectPortionFormula(page, [{ grams: 200, per100g: pointRanges() }]);
  await reopenPortionReview(page);
  await expect(portionQuantity(page)).toHaveValue('200');
  await confirmPortionReview(page);
  await expectPortionFormula(page, [{ grams: 200, per100g: pointRanges() }]);
  await savePortionMeal(page);
  const { archive } = await exportPortionBackup(page);
  expect(latestPortionAnalysis(archive.data.meals[0]).analysis.components![0].userQuantity).toEqual({ amount: 200, unit: 'g', origin: 'user' });
  expect(provider.responses()).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('旧记录仅有餐后照片时改名确认仍自动更新营养，保留旧照片及原始快照', async ({ page }) => {
  const errors = capturePortionErrors(page);
  const updated = pointRanges(260, 12, 32, 9);
  const provider = await installMockAiProvider(page, { onResponse: async (route) => fulfillProviderResponse(route,
    { components: [portionDish('少油蛋炒饭', updated)], uncertainty: [] }) });
  const now = new Date().toISOString();
  const source = { provider: 'usda-fdc' as const, dataset: 'Saved USDA snapshot', fdcId: '168878',
    per100g: { calories: 200, protein: 10, carbs: 20, fat: 5 } };
  const legacy: MealRecord = {
    id: 'after-only-estimated-meal', type: 'meal', createdAt: now, occurredAt: now, revision: 1,
    mealType: '午餐', foodName: '只有餐后照片的旧午餐', portion: '', note: '', source: 'photo', estimateStatus: 'unknown',
    afterImageUri: 'file:///legacy-estimated-after.png',
    analyses: [{ id: 'after-only-original-analysis', sourceVersion: 1, model: 'local/legacy-database', createdAt: now, analysis: {
      status: 'approximate', foodName: '熟米饭', ...pointRanges(), assumptions: [], advice: '按保存的参考和数量计算。',
      nutritionSource: { provider: 'usda-fdc', dataset: source.dataset, coverage: 'complete' },
      components: [{ foodId: 'rice_white_long_grain_cooked', label: '熟米饭', cookingMethod: '蒸煮', grams: null,
        quantitySource: 'unknown', consumedFraction: null, userQuantity: { amount: 100, unit: 'g', origin: 'user' }, uncertainty: [], source }],
    } }],
  };
  await restorePortionMeals(page, [legacy], {}, [{ uri: legacy.afterImageUri!, kind: 'image', bytes: portionPng, mimeType: 'image/png', extension: 'png' }]);
  await configureMockAi(page);
  await reopenPortionMeal(page, legacy.foodName);
  await expect(page.getByText('餐后照片', { exact: true })).toBeVisible();
  await reopenPortionReview(page);
  await expect(portionQuantity(page)).toHaveValue('100');
  await portionReview(page).getByLabel('菜品 1 名称', { exact: true }).fill('少油蛋炒饭');
  await expectPortionRanges(page, 1, null);
  await confirmPortionReview(page);
  await expect(page.getByLabel('食物名称', { exact: true })).toHaveValue('少油蛋炒饭');
  await expectPortionFormula(page, [{ grams: 100, per100g: updated }]);
  expect(provider.responses()).toHaveLength(1);
  expect(provider.responses()[0].record?.data.photoRoles).toEqual(['after']);
  await savePortionMeal(page);
  const { archive } = await exportPortionBackup(page);
  const saved = archive.data.meals[0];
  expect(saved.imageUri).toBeUndefined();
  expect(saved.beforeImageUris ?? []).toEqual([]);
  expect(saved.afterImageUri).toBeTruthy();
  expect(saved.analyses!.find((version) => version.id === 'after-only-original-analysis')!.analysis.components![0]).toMatchObject({ source, userQuantity: { amount: 100, unit: 'g', origin: 'user' } });
  expect(latestPortionAnalysis(saved).analysis.components![0]).toMatchObject({ label: '少油蛋炒饭', source: { per100gRange: updated }, userQuantity: { amount: 100, unit: 'g', origin: 'user' } });
  expect(errors).toEqual([]);
});
