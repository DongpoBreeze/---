import { expect, test, type Page } from '@playwright/test';
import { adaptFrontendMealRecognition, calculateMealNutrition as calculateShared } from '../shared/nutrition.mjs';
import { mealCalories } from '../src/domain';
import { buildMealReviewAnalysis, createMealReviewRows, updateMealReviewRow } from '../src/meal-review';
import { nutritionDataset } from '../src/nutrition';
import { mealAnalysisSchema } from '../src/nutrition-schema';
import type { LocalSnapshot } from '../src/local-store';
import type { MealRecord } from '../src/types';
import {
  capturePortionErrors, confirmPortionReview, editPortionNutrition, expectPortionRanges, exportPortionBackup, importPortionBackup,
  openPortionMeal, pointRanges, portionDish, portionPng, portionQuantity, portionReview,
  reopenPortionMeal, reopenPortionReview, restorePortionMeals, savePortionMeal, uploadPortionPhoto,
} from './helpers/meal-estimated-portion';
import { configureMockAi, fulfillProviderJson, fulfillProviderResponse, installMockAiProvider } from './helpers/mock-ai-provider';

// Playwright creates a fresh browser context for each case. All AI traffic is
// intercepted below; this suite never imports the user's connection settings.
test.use({ storageState: { cookies: [], origins: [] } });
const now = '2026-10-21T03:00:00.000Z';
const photo = 'meal-persistence-fixture';

async function stored(page: Page): Promise<LocalSnapshot> {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const opening = indexedDB.open('health-compass-local-v1', 1);
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result;
      const tx = db.transaction('snapshots', 'readonly');
      const request = tx.objectStore('snapshots').get('@health-compass/data-v1');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(JSON.parse(request.result));
      tx.oncomplete = () => db.close();
    };
  })) as Promise<LocalSnapshot>;
}

function savedMeal(twoDishes = false): MealRecord {
  const dishes = [portionDish('熟米饭', pointRanges(200))];
  if (twoDishes) dishes.push(portionDish('蒸蛋', pointRanges(100), '蒸'));
  const source = mealAnalysisSchema.parse(calculateShared(adaptFrontendMealRecognition({ components: dishes, uncertainty: [] }), nutritionDataset,
    { mode: 'ai-per100g-v3', provenance: { model: 'previous/model', reasoningEffort: 'max', createdAt: now } }));
  const rows = createMealReviewRows(source).map((row, index) => updateMealReviewRow(row, { quantity: index === 0 ? '250' : '100' }));
  const confirmed = buildMealReviewAnalysis(source, rows);
  return { id: 'persisted-meal', type: 'meal', createdAt: now, occurredAt: now, mealType: '午餐', foodName: dishes.map((dish) => dish.label).join('、'),
    foodNameSource: 'analysis', portion: '', note: '本餐原备注', imageUri: photo, beforeImageUris: [photo], source: 'photo', estimateStatus: 'unknown', revision: 1,
    analyses: [{ id: 'previous-raw', model: 'previous/model', createdAt: now, sourceVersion: 1, analysis: source },
      { id: 'previous-confirmed', model: 'local/meal-review', createdAt: now, sourceVersion: 1, analysis: confirmed }] };
}

async function restoreSaved(page: Page, twoDishes = false) {
  const initial = savedMeal(twoDishes);
  await restorePortionMeals(page, [initial], {}, [{ uri: photo, kind: 'image', bytes: portionPng, extension: 'png' }]);
  await configureMockAi(page);
  await page.getByRole('tab', { name: '我的', exact: true }).click();
  await page.getByRole('button', { name: '全部记录', exact: true }).click();
  return (await stored(page)).data.meals[0];
}

async function closeMeal(page: Page) {
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

async function requestSaved(page: Page) {
  await page.getByRole('tab', { name: '我的', exact: true }).click();
  await page.getByRole('button', { name: '全部记录', exact: true }).click();
  await page.getByRole('button', { name: '请求饮食分析', exact: true }).click();
}

test('确认识别后主表单显示新菜名和营养范围，保存后记录列表立即显示更新结果', async ({ page }) => {
  const errors = capturePortionErrors(page);
  page.on('dialog', (dialog) => { void dialog.accept(); });
  const ranges = {
    calories: { min: 180, max: 200 }, protein: { min: 12, max: 14 },
    carbs: { min: 25, max: 30 }, fat: { min: 5, max: 7 },
  };
  await installMockAiProvider(page, { onResponse: async (route) => fulfillProviderResponse(route,
    { components: [portionDish('鸡肉饭', ranges)], uncertainty: [] }) });
  await openPortionMeal(page);
  await uploadPortionPhoto(page);
  await portionQuantity(page).fill('150');
  await confirmPortionReview(page, { editNutrition: false });
  await expect(page.getByLabel('食物名称', { exact: true })).toHaveValue('鸡肉饭');
  await expect(page.getByTestId('meal-nutrition-summary')).toBeVisible();
  await expect(page.getByTestId('meal-nutrition-calories')).toContainText('估算范围 270～300 kcal');
  await editPortionNutrition(page);
  await expect(page.getByLabel('热量 kcal', { exact: true })).toHaveValue('270～300');
  await savePortionMeal(page);

  await page.getByRole('tab', { name: '我的', exact: true }).click();
  await page.getByRole('button', { name: '全部记录', exact: true }).click();
  await expect(page.getByText('鸡肉饭', { exact: true })).toBeVisible();
  await page.getByText('鸡肉饭', { exact: true }).click();
  await expect(page.getByLabel('食物名称', { exact: true })).toHaveValue('鸡肉饭');
  await expect(page.getByTestId('meal-nutrition-summary')).toContainText('估算范围 270～300 kcal');
  await editPortionNutrition(page);
  await expect(page.getByLabel('热量 kcal', { exact: true })).toHaveValue('270～300');
  const saved = (await stored(page)).data.meals[0];
  expect(saved.foodName).toBe('鸡肉饭');
  expect(mealCalories(saved)).toEqual({ min: 270, max: 300 });
  expect(errors).toEqual([]);
});

test('未保存的新餐关闭、刷新及从备份恢复后再次打开均为全新记录', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = capturePortionErrors(page);
  page.on('dialog', (dialog) => { void dialog.accept(); });
  const answer = { components: [portionDish('熟米饭', pointRanges(200)), portionDish('蒸蛋', pointRanges(100), '蒸')], uncertainty: [] };
  await installMockAiProvider(page, { onResponse: async (route) => fulfillProviderResponse(route, answer) });
  await openPortionMeal(page);
  await uploadPortionPhoto(page);
  await portionQuantity(page).fill('250');
  await portionQuantity(page, 2).fill('');
  await portionReview(page).getByLabel('菜品 1 每100g热量下限', { exact: true }).fill('220');
  await portionReview(page).getByLabel('菜品 1 每100g热量上限', { exact: true }).fill('220');
  await confirmPortionReview(page);
  await expect(page.getByLabel('热量 kcal', { exact: true })).toHaveValue('550');
  await closeMeal(page);
  const draftBackup = await exportPortionBackup(page);
  const abandonedKey = Object.keys(draftBackup.archive.drafts).find((key) => key.startsWith('meal-new-'));
  expect(abandonedKey).toBeTruthy();
  const draft = draftBackup.archive.drafts[abandonedKey!] as any;
  expect(draft.analysisDraft).toMatchObject({ version: 1, confirmed: { model: 'local/meal-review' }, review: { pending: false } });
  expect(draft.analysisDraft.confirmed.analysis.components[0]).toMatchObject({ userQuantity: { amount: 250, unit: 'g', origin: 'user' },
    userNutritionPer100g: { calories: { min: 220, max: 220 } }, source: { per100gRange: { calories: { min: 200, max: 200 } } } });
  expect(draft.analysisDraft.confirmed.analysis.components[1].userQuantityCleared).toBe(true);

  const expectBlankNewMeal = async () => {
    await expect(page.getByLabel('食物名称', { exact: true })).toHaveValue('');
    await expect(page.getByTestId('ai-meal-review')).toHaveCount(0);
    await expect(page.getByLabel('热量 kcal', { exact: true })).toHaveValue('');
  };
  await page.getByRole('tab', { name: '今天', exact: true }).click();
  await page.getByText('记饮食', { exact: true }).click();
  await expectBlankNewMeal();
  await closeMeal(page);

  await page.reload();
  await page.getByRole('tab', { name: '今天', exact: true }).click();
  await page.getByText('记饮食', { exact: true }).click();
  await expectBlankNewMeal();
  await closeMeal(page);

  await importPortionBackup(page, draftBackup.bytes);
  await page.getByRole('tab', { name: '今天', exact: true }).click();
  await page.getByText('记饮食', { exact: true }).click();
  await expectBlankNewMeal();
  await closeMeal(page);
  await page.getByRole('tab', { name: '我的', exact: true }).click();
  await page.getByRole('button', { name: '全部记录', exact: true }).click();
  await expect(page.getByText('熟米饭、蒸蛋', { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('新餐食未确认直接保存时只保留原始识别为当前版本，估算食用量不进入摄入汇总', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = capturePortionErrors(page);
  page.on('dialog', (dialog) => { void dialog.accept(); });
  const provider = await installMockAiProvider(page, { onResponse: async (route) =>
    fulfillProviderResponse(route, { components: [portionDish('熟米饭', pointRanges(200))], uncertainty: [] }) });
  await openPortionMeal(page, { heightCm: 170, weightKg: 70, calorieTarget: 2000 });
  await uploadPortionPhoto(page);
  await expect(portionQuantity(page)).not.toHaveValue('');
  await portionReview(page).getByRole('button', { name: '返回饮食', exact: true }).click();
  await expect(portionReview(page)).toHaveCount(0);
  await savePortionMeal(page);

  const saved = (await stored(page)).data.meals[0];
  const current = saved.analyses?.at(-1);
  expect(current?.model).toBe('mock-model');
  expect(current?.analysis.calories).toBeNull();
  expect(current?.analysis.components?.[0].userQuantity).toBeNull();
  expect(saved.estimate).toBeUndefined();
  expect(mealCalories(saved)).toBeNull();
  expect(saved.analyses?.some((version) => version.model === 'local/meal-review'
    && version.analysis.components?.[0].userQuantity?.origin === 'estimated')).toBe(true);
  expect(provider.responses()).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('已保存餐食重分析按菜名做法重排保留数量，确认和保存前正式餐食及日摘要保持原值', async ({ page }) => {
  const errors = capturePortionErrors(page);
  page.on('dialog', (dialog) => { void dialog.accept(); });
  const answer = { components: [portionDish('蒸蛋', pointRanges(130), '蒸'), portionDish('熟米饭', pointRanges(300))], uncertainty: [] };
  const provider = await installMockAiProvider(page, { onResponse: async (route) => fulfillProviderResponse(route, answer) });
  const initial = await restoreSaved(page, true);
  const before = await stored(page);
  const summary = before.data.summaries.filter((value) => value.source !== 'ai').map((value) => value.markdown);
  expect(mealCalories(initial)).toEqual({ min: 600, max: 600 });
  await requestSaved(page);
  await expect(portionReview(page)).toBeVisible();
  await expect(portionQuantity(page)).toHaveValue('100');
  await expect(portionQuantity(page, 2)).toHaveValue('250');
  expect((await stored(page)).data.meals[0]).toEqual(initial);
  await portionReview(page).getByRole('button', { name: '返回饮食', exact: true }).click();
  await editPortionNutrition(page);
  await expect(page.getByLabel('热量 kcal', { exact: true })).toHaveValue('600');
  await closeMeal(page);
  expect((await stored(page)).data.meals[0]).toEqual(initial);
  expect((await stored(page)).data.summaries.filter((value) => value.source !== 'ai').map((value) => value.markdown)).toEqual(summary);
  await page.reload();
  await reopenPortionMeal(page, initial.foodName);
  await reopenPortionReview(page);
  await expect(portionQuantity(page)).toHaveValue('100');
  await expect(portionQuantity(page, 2)).toHaveValue('250');
  await confirmPortionReview(page);
  await expect(page.getByLabel('热量 kcal', { exact: true })).toHaveValue('880');
  expect((await stored(page)).data.meals[0]).toEqual(initial);
  await savePortionMeal(page);
  const final = (await stored(page)).data.meals[0];
  expect(final.revision).toBe(2);
  expect(mealCalories(final)).toEqual({ min: 880, max: 880 });
  expect(final.analyses!.slice(0, 2)).toEqual(initial.analyses);
  expect(final.analyses!.at(-2)!.analysis.components!.every((component) => component.userQuantity === null)).toBe(true);
  expect(final.analyses!.at(-1)!.analysis.components!.map((component) => component.userQuantity?.amount)).toEqual([100, 250]);
  expect(provider.responses()).toHaveLength(1);
  expect(errors).toEqual([]);
});

for (const [label, components] of [
  ['改名', [portionDish('炒饭', pointRanges(300))]],
  ['改做法', [portionDish('熟米饭', pointRanges(300), '炒')]],
  ['重复菜品', [portionDish('熟米饭'), portionDish('熟米饭')]],
  ['身份模糊', [{ ...portionDish('熟米饭'), uncertainty: ['菜品身份不确定。'] }]],
] as const) {
  test(`重分析${label}不会套用原250g，返回关闭后原摄入及历史保留`, async ({ page }) => {
    page.on('dialog', (dialog) => { void dialog.accept(); });
    await installMockAiProvider(page, { onResponse: async (route) => fulfillProviderResponse(route, { components, uncertainty: [] }) });
    const initial = await restoreSaved(page);
    await requestSaved(page);
    await expect(portionReview(page)).toBeVisible();
    for (let index = 0; index < components.length; index += 1) await expect(portionQuantity(page, index + 1)).toHaveValue('');
    await portionReview(page).getByRole('button', { name: '返回饮食', exact: true }).click();
    await editPortionNutrition(page);
    await expect(page.getByLabel('热量 kcal', { exact: true })).toHaveValue('500');
    await closeMeal(page);
    expect((await stored(page)).data.meals[0]).toEqual(initial);
    const pending = (await stored(page)).drafts['meal-persisted-meal'] as any;
    expect(pending.analysisDraft.review.pending).toBe(true);
    expect(pending.analysisDraft.review.rows.every((row: any) => row.quantity === '')).toBe(true);
  });
}

test('重新分析失败与取消不改原记录，关闭会话后迟到结果不进入新的餐食草稿', async ({ page }) => {
  page.on('dialog', (dialog) => { void dialog.accept(); });
  let mode: 'failure' | 'held' = 'failure';
  let release: (() => void) | undefined;
  const provider = await installMockAiProvider(page, { onResponse: async (route) => {
    if (mode === 'failure') {
      await fulfillProviderJson(route, { status: 'completed', output: [] });
      return;
    }
    await new Promise<void>((resolve) => { release = resolve; });
    await fulfillProviderResponse(route, { components: [portionDish('迟到结果')], uncertainty: [] }).catch(() => undefined);
  } });
  const initial = await restoreSaved(page);
  await requestSaved(page);
  await expect(page.getByText(/^照片识别失败：/)).toBeVisible();
  await editPortionNutrition(page);
  await expect(page.getByLabel('热量 kcal', { exact: true })).toHaveValue('500');
  expect((await stored(page)).data.meals[0]).toEqual(initial);
  await closeMeal(page);
  mode = 'held';
  await requestSaved(page);
  await expect(page.getByRole('button', { name: '取消照片分析', exact: true })).toBeVisible();
  await expect.poll(() => Boolean(release)).toBe(true);
  await page.getByRole('button', { name: '取消照片分析', exact: true }).click();
  await closeMeal(page);
  await page.getByRole('tab', { name: '今天', exact: true }).click();
  await page.getByText('记饮食', { exact: true }).click();
  await page.getByLabel('食物名称', { exact: true }).fill('新会话的手动餐食');
  release!();
  await expect(page.getByTestId('ai-meal-review')).toHaveCount(0);
  await expect(page.getByLabel('食物名称', { exact: true })).toHaveValue('新会话的手动餐食');
  await closeMeal(page);
  expect((await stored(page)).data.meals[0]).toEqual(initial);
  const snapshots = await stored(page);
  const newMealDraftKey = Object.keys(snapshots.drafts).find((key) => key.startsWith('meal-new-'));
  expect(newMealDraftKey).toBeTruthy();
  const draft = snapshots.drafts[newMealDraftKey!] as any;
  expect(draft.foodName).toBe('新会话的手动餐食');
  expect(draft.analysisDraft.history).toHaveLength(0);
  expect(draft.analysisDraft.review).toBeNull();
  expect(provider.responses().length).toBeGreaterThanOrEqual(2);
});

test('新建饮食按本地 24 小时进食时段默认选中餐次', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-27T00:30:00.000Z') });
  await page.goto('/');

  const cases: Array<[string, string]> = [
    ['2026-10-27T00:30:00.000Z', '早餐'],
    ['2026-10-27T03:30:00.000Z', '午餐'],
    ['2026-10-27T10:30:00.000Z', '晚餐'],
    ['2026-10-27T15:00:00.000Z', '加餐'],
  ];

  for (const [instant, mealType] of cases) {
    await page.clock.setFixedTime(new Date(instant));
    await page.getByText('记饮食', { exact: true }).click();
    const selectedWeight = await page.getByText(mealType, { exact: true }).evaluate((element) => getComputedStyle(element).fontWeight);
    const unselected = cases.find(([, candidate]) => candidate !== mealType)![1];
    const unselectedWeight = await page.getByText(unselected, { exact: true }).evaluate((element) => getComputedStyle(element).fontWeight);
    expect(Number(selectedWeight)).toBeGreaterThan(Number(unselectedWeight));
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
});
