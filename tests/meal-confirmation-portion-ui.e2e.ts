import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createBackupArchive, parseBackupArchive } from '../src/backup';
import { emptyData, type DatabaseNutritionSource, type MealRecord, type NutrientRange, type NutrientRanges, type Profile } from '../src/types';
import {
  configureMockAi, fulfillProviderResponse, installMockAiProvider, MOCK_AI_MODEL,
} from './helpers/mock-ai-provider';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a90sAAAAASUVORK5CYII=', 'base64');
const nutrients = [
  ['calories', '热量', '热量 kcal'], ['protein', '蛋白质', '蛋白质 g'],
  ['carbs', '碳水', '碳水 g'], ['fat', '脂肪', '脂肪 g'],
] as const;
const originalRanges: NutrientRanges = {
  calories: { min: 130, max: 150 }, protein: { min: 2, max: 3 },
  carbs: { min: 28, max: 33 }, fat: { min: 0.3, max: 1 },
};
const manualRanges: NutrientRanges = {
  calories: { min: 180, max: 220 }, protein: { min: 8, max: 12 },
  carbs: { min: 20, max: 30 }, fat: { min: 4, max: 6 },
};

function dish(label: string, per100g: NutrientRanges | null, cookingMethod = '蒸煮') {
  return {
    label, cookingMethod, confidence: 0.95,
    nutritionEstimate: per100g ? {
      method: 'typical_recipe', per100g, recipeBasis: '按可食用成品的典型配方估算。',
      assumptions: ['实际食用量由用户填写。'], confidence: 0.9,
    } : null,
    uncertainty: per100g ? [] : ['缺少可靠的每 100 g 营养参考。'],
  };
}

const originalResponse = { components: [dish('熟米饭', originalRanges)], uncertainty: [] };

test.beforeEach(async ({ page }) => {
  page.on('dialog', (dialog) => { void dialog.accept(); });
});

function captureErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

async function setProfile(page: Page, profile: Profile) {
  await page.getByRole('tab', { name: '我的', exact: true }).click();
  await page.getByText('修改目标与资料', { exact: true }).click();
  const dialog = page.getByRole('dialog');
  for (const [key, label] of [
    ['heightCm', '身高（cm，可选）'], ['weightKg', '体重（kg，可选）'],
    ['calorieTarget', '每日热量目标（kcal，可选）'],
  ] as const) {
    await dialog.getByLabel(label, { exact: true }).fill(profile[key] === undefined ? '' : String(profile[key]));
  }
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('tab', { name: '今天', exact: true }).click();
}

async function openMeal(page: Page, profile?: Profile) {
  await page.goto('/');
  await configureMockAi(page);
  if (profile) await setProfile(page, profile);
  await page.getByText('记饮食', { exact: true }).click();
}

async function uploadPhoto(page: Page) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByText('选择照片', { exact: true }).click();
  await (await chooser).setFiles({ name: 'confirmation-portion.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByTestId('ai-meal-review')).toBeVisible();
  await expect(page.getByText('照片识别完成，请核对。', { exact: true })).toBeVisible();
}

async function setRanges(page: Page, index: number, ranges: NutrientRanges) {
  for (const [key, label] of nutrients) {
    await page.getByLabel(`菜品 ${index} 每100g${label}下限`, { exact: true }).fill(String(ranges[key].min));
    await page.getByLabel(`菜品 ${index} 每100g${label}上限`, { exact: true }).fill(String(ranges[key].max));
  }
}

async function expectRanges(page: Page, index: number, ranges: NutrientRanges) {
  for (const [key, label] of nutrients) {
    await expect(page.getByLabel(`菜品 ${index} 每100g${label}下限`, { exact: true })).toHaveValue(String(ranges[key].min));
    await expect(page.getByLabel(`菜品 ${index} 每100g${label}上限`, { exact: true })).toHaveValue(String(ranges[key].max));
  }
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

async function editNutrition(page: Page) {
  const edit = page.getByRole('button', { name: '修改营养值', exact: true });
  if (await edit.count()) await edit.click();
}

async function expectEmptyTotals(page: Page) {
  for (const [, , label] of nutrients)
    await expect(page.getByLabel(label, { exact: true })).toHaveValue('');
}

function rangeText(range: NutrientRange) {
  return range.min === range.max ? String(range.min) : `${range.min}～${range.max}`;
}

async function expectTotals(page: Page, ranges: NutrientRanges) {
  for (const [key, , label] of nutrients)
    await expect(page.getByLabel(label, { exact: true })).toHaveValue(rangeText(ranges[key]));
}

async function saveMeal(page: Page) {
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

async function reopenMeal(page: Page, title: string) {
  await page.getByRole('tab', { name: '记录', exact: true }).click();
  await page.getByText(title, { exact: true }).click();
  await expect(page.getByLabel('食物名称', { exact: true })).toHaveValue(title);
}

async function exportBackup(page: Page) {
  await page.getByRole('tab', { name: '我的', exact: true }).click();
  const downloadEvent = page.waitForEvent('download');
  await page.getByText('导出完整备份', { exact: true }).click();
  const download = await downloadEvent;
  return parseBackupArchive(new Uint8Array(await readFile((await download.path())!)));
}

async function restoreMeals(page: Page, meals: MealRecord[], profile: Profile) {
  const bytes = await createBackupArchive({ ...emptyData(), profile, meals }, []);
  await page.goto('/');
  await page.getByRole('tab', { name: '我的', exact: true }).click();
  const restored = page.waitForEvent('dialog', { predicate: (dialog) => dialog.message().includes('恢复完成') });
  const chooser = page.waitForEvent('filechooser');
  await page.getByText('恢复备份', { exact: true }).click();
  await (await chooser).setFiles({ name: 'legacy-reference.zip', mimeType: 'application/zip', buffer: Buffer.from(bytes) });
  await restored;
}

function latestAnalysis(meal: MealRecord) {
  const version = meal.analyses?.filter((entry) => entry.sourceVersion === (meal.revision ?? 1)).at(-1);
  expect(version).toBeDefined();
  return version!;
}

async function expectNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  for (const testId of ['ai-meal-review', 'meal-nutrition-header', 'meal-portion-estimate', 'review-dish-1-quantity-control']) {
    const element = page.getByTestId(testId);
    if (await element.count())
      expect(await element.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), testId).toBe(true);
  }
  if (await page.getByTestId('ai-meal-review').count()) {
    for (const name of ['AI 复核', '确认填入']) {
      const bounds = await page.getByRole('button', { name, exact: true }).boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
    }
  }
}

// Suggested grams are intentionally not pinned to the current recommendation
// formula. Check the resulting intake against the fixture's known energy and
// macro density, allowing only the documented outward display rounding.
function expectRangeCoversValue(range: NutrientRange | null | undefined, value: number, precision: number) {
  expect(range).toBeTruthy();
  expect(range!.min).toBeLessThanOrEqual(value + 1e-7);
  expect(range!.max).toBeGreaterThanOrEqual(value - 1e-7);
  expect(range!.max - range!.min).toBeLessThanOrEqual(precision + 1e-7);
}

async function expectFieldCoversValue(page: Page, field: string, value: number, precision: number) {
  const text = await page.getByLabel(field, { exact: true }).inputValue();
  expect(text).toMatch(/^\d+(?:\.\d+)?(?:～\d+(?:\.\d+)?)?$/);
  const [min, max = min] = text.split('～').map(Number);
  expectRangeCoversValue({ min, max }, value, precision);
}

test('主动清空食用量后确认保留每100g修正，重开补150g后四项正确且保存导出保持', async ({ page }, info) => {
  test.setTimeout(120_000);
  const errors = captureErrors(page);
  const provider = await installMockAiProvider(page, { onResponse: async (route) => fulfillProviderResponse(route, originalResponse) });
  await openMeal(page);
  await uploadPhoto(page);
  await setRanges(page, 1, manualRanges);
  await page.getByLabel('菜品 1 食用量', { exact: true }).fill('');
  await expect(page.getByLabel('菜品 1 食用量', { exact: true })).toHaveValue('');
  await confirmReview(page);
  const editQuantity = page.getByTestId('meal-edit-portions');
  await expect(page.getByLabel('食物名称', { exact: true })).toHaveValue('熟米饭');
  await expectEmptyTotals(page);
  await expect(editQuantity).toBeEnabled();
  await expectNoOverflow(page);
  await editQuantity.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('confirmed-reference-without-intake.png'), fullPage: true });
  await saveMeal(page);
  await page.reload();
  await reopenMeal(page, '熟米饭');
  await editNutrition(page);
  await expectEmptyTotals(page);
  await editQuantity.click();
  await expectRanges(page, 1, manualRanges);
  await expect(page.getByLabel('菜品 1 食用量', { exact: true })).toHaveValue('');
  await page.getByLabel('菜品 1 食用量', { exact: true }).fill('150');
  await confirmReview(page);
  const totals: NutrientRanges = {
    calories: { min: 270, max: 330 }, protein: { min: 12, max: 18 },
    carbs: { min: 30, max: 45 }, fat: { min: 6, max: 9 },
  };
  await expectTotals(page, totals);
  await expect(editQuantity).toBeEnabled();
  await expectNoOverflow(page);
  await editQuantity.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('confirmed-150g-updates-four-totals.png'), fullPage: true });
  await saveMeal(page);
  const archive = await exportBackup(page);
  const meal = archive.data.meals[0];
  expect(meal.estimate).toBeUndefined();
  expect(latestAnalysis(meal)).toMatchObject({ model: 'local/meal-review', analysis: {
    ...totals, components: [{ userNutritionPer100g: manualRanges, userQuantity: { amount: 150, unit: 'g' }, source: { per100gRange: originalRanges } }],
  } });
  expect(meal.analyses!.some((version) => version.analysis.components?.[0].userNutritionPer100g?.calories.min === 180
    && version.analysis.components[0].userQuantity === null && version.analysis.calories === null)).toBe(true);
  await page.reload();
  await reopenMeal(page, '熟米饭');
  await editNutrition(page);
  await expectTotals(page, totals);
  await expect(page.getByLabel('食物名称', { exact: true })).toHaveValue('熟米饭');
  expect(provider.responses()).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('保存重开后明确确认同步修正后的菜名，自定义餐名可在确认后再修改', async ({ page }, info) => {
  test.setTimeout(120_000);
  const errors = captureErrors(page);
  const provider = await installMockAiProvider(page, { onResponse: async (route) => fulfillProviderResponse(route, originalResponse) });
  await openMeal(page);
  await uploadPhoto(page);
  await page.getByLabel('菜品 1 食用量', { exact: true }).fill('100');
  await confirmReview(page);
  await expect(page.getByLabel('食物名称', { exact: true })).toHaveValue('熟米饭');
  await saveMeal(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await reopenMeal(page, '熟米饭');
  const editQuantity = page.getByTestId('meal-edit-portions');
  await editQuantity.click();
  await page.getByLabel('菜品 1 名称', { exact: true }).fill('豆香炖饭');
  await setRanges(page, 1, manualRanges);
  await confirmReview(page);
  await expect(page.getByLabel('食物名称', { exact: true })).toHaveValue('豆香炖饭');
  await expectTotals(page, manualRanges);
  await saveMeal(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await reopenMeal(page, '豆香炖饭');
  await page.getByLabel('食物名称', { exact: true }).fill('周二自带午餐');
  await editQuantity.click();
  await page.getByLabel('菜品 1 名称', { exact: true }).fill('番茄炖饭');
  await setRanges(page, 1, originalRanges);
  await confirmReview(page);
  await expect(page.getByLabel('食物名称', { exact: true })).toHaveValue('番茄炖饭');
  await expectTotals(page, originalRanges);
  await expectNoOverflow(page);
  await editQuantity.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('confirmed-custom-title-follows-updated-dish.png'), fullPage: true });
  await page.getByLabel('食物名称', { exact: true }).fill('周二自带午餐');
  await saveMeal(page);
  const archive = await exportBackup(page);
  const meal = archive.data.meals[0];
  expect(meal.foodName).toBe('周二自带午餐');
  expect(meal).toMatchObject({ foodNameSource: 'user' });
  expect(meal.revisions!.map((revision) => revision.foodName)).toEqual(expect.arrayContaining(['熟米饭', '豆香炖饭']));
  expect(meal.revisions).toEqual(expect.arrayContaining([
    expect.objectContaining({ foodName: '熟米饭', foodNameSource: 'analysis' }),
    expect.objectContaining({ foodName: '豆香炖饭', foodNameSource: 'analysis' }),
  ]));
  expect(latestAnalysis(meal).analysis).toMatchObject({ ...originalRanges,
    components: [{ label: '番茄炖饭', userNutritionPer100g: originalRanges, userQuantity: { amount: 100, unit: 'g' } }],
  });
  expect(provider.responses()).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('同名手填标题可保存归属，重开后明确确认仍同步新的菜名', async ({ page }, info) => {
  const errors = captureErrors(page);
  const provider = await installMockAiProvider(page, { onResponse: async (route) => fulfillProviderResponse(route, originalResponse) });
  await openMeal(page);
  await page.getByLabel('食物名称', { exact: true }).fill('熟米饭');
  await uploadPhoto(page);
  await page.getByLabel('菜品 1 食用量', { exact: true }).fill('100');
  await confirmReview(page);
  await expect(page.getByLabel('食物名称', { exact: true })).toHaveValue('熟米饭');
  await page.getByLabel('食物名称', { exact: true }).fill('');
  await page.getByLabel('食物名称', { exact: true }).fill('熟米饭');
  await saveMeal(page);
  await page.reload();
  await reopenMeal(page, '熟米饭');
  const editQuantity = page.getByTestId('meal-edit-portions');
  await editQuantity.click();
  await page.getByLabel('菜品 1 名称', { exact: true }).fill('南瓜炖饭');
  await setRanges(page, 1, manualRanges);
  await confirmReview(page);
  await expect(page.getByLabel('食物名称', { exact: true })).toHaveValue('南瓜炖饭');
  await expectTotals(page, manualRanges);
  await expectNoOverflow(page);
  await editQuantity.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('confirmed-title-updates-after-reopen.png'), fullPage: true });
  await saveMeal(page);
  const archive = await exportBackup(page);
  const meal = archive.data.meals[0];
  expect(meal).toMatchObject({ foodName: '南瓜炖饭', foodNameSource: 'analysis' });
  expect(meal.revisions).toEqual(expect.arrayContaining([
    expect.objectContaining({ foodName: '熟米饭', foodNameSource: 'user' }),
  ]));
  expect(latestAnalysis(meal).analysis).toMatchObject({ ...manualRanges,
    components: [{ label: '南瓜炖饭', userNutritionPer100g: manualRanges, userQuantity: { amount: 100, unit: 'g' } }],
  });
  expect(provider.responses()).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('确认备注后主表单新备注在重开确认时保留，未确认的复核备注草稿返回再打开不丢失', async ({ page }, info) => {
  const errors = captureErrors(page);
  const provider = await installMockAiProvider(page, { onResponse: async (route) => fulfillProviderResponse(route, originalResponse) });
  await openMeal(page);
  await uploadPhoto(page);
  const reviewNote = page.getByLabel('补充说明（用于复核）', { exact: true });
  const mainNote = page.getByLabel('备注（可选）', { exact: true });
  const noteA = '备注 A：本餐少油。';
  const noteB = '备注 B：主表单补充实际做法。';
  const draftNote = '未确认的备注 C：补充了新的食用说明。';
  await reviewNote.fill(noteA);
  await page.getByLabel('菜品 1 食用量', { exact: true }).fill('100');
  await confirmReview(page);
  await expect(mainNote).toHaveValue(noteA);
  await mainNote.fill(noteB);
  const editQuantity = page.getByTestId('meal-edit-portions');
  await editQuantity.click();
  await expect(reviewNote).toHaveValue(noteB);
  await confirmReview(page);
  await expect(mainNote).toHaveValue(noteB);
  await editQuantity.click();
  await reviewNote.fill(draftNote);
  await page.getByRole('button', { name: '返回饮食', exact: true }).click();
  await expect(mainNote).toHaveValue(noteB);
  await editQuantity.click();
  await expect(reviewNote).toHaveValue(draftNote);
  await expect(page.getByLabel('菜品 1 食用量', { exact: true })).toHaveValue('100');
  await expectNoOverflow(page);
  await reviewNote.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('review-note-draft-survives-back-and-reopen.png'), fullPage: true });
  await confirmReview(page);
  await expect(mainNote).toHaveValue(draftNote);
  await saveMeal(page);
  await page.reload();
  await reopenMeal(page, '熟米饭');
  await expect(mainNote).toHaveValue(draftNote);
  await saveMeal(page);
  const archive = await exportBackup(page);
  expect(archive.data.meals[0].note).toBe(draftNote);
  expect(provider.responses()).toHaveLength(1);
  expect(errors).toEqual([]);
});

for (const providerName of ['usda-fdc', 'local-category'] as const) {
  test(`旧${providerName}参考导入后可编辑和确认食用量，空值及导出保留原快照`, async ({ page }, info) => {
    const errors = captureErrors(page);
    const provider = await installMockAiProvider(page);
    const now = new Date().toISOString();
    const scalarReference = { calories: 200, protein: 10, carbs: 20, fat: 5 };
    const usdaRanges: NutrientRanges = { calories: { min: 200, max: 200 }, protein: { min: 10, max: 10 },
      carbs: { min: 20, max: 20 }, fat: { min: 5, max: 5 } };
    const ranges = providerName === 'usda-fdc' ? usdaRanges : manualRanges;
    const source: DatabaseNutritionSource = providerName === 'usda-fdc'
      ? { provider: 'usda-fdc', dataset: 'Saved USDA snapshot', fdcId: '168878', per100g: scalarReference }
      : { provider: 'local-category', dataset: 'Saved category snapshot', categoryId: 'mixed_dish', per100gRange: manualRanges };
    const label = providerName === 'usda-fdc' ? '熟米饭' : '家常炖菜';
    // An older title has no source marker, even when it equals the dish label.
    const title = label;
    const analysisId = `legacy-${providerName}-analysis`;
    const meal: MealRecord = {
      id: `legacy-${providerName}-meal`, type: 'meal', createdAt: now, occurredAt: now, revision: 1,
      mealType: '午餐', foodName: title, portion: '', note: '从旧备份恢复的数据库参考。', source: 'ai', estimateStatus: 'unknown',
      analyses: [{ id: analysisId, sourceVersion: 1, model: 'local/legacy-database', createdAt: now, analysis: {
        status: 'unknown', foodName: label, calories: null, protein: null, carbs: null, fat: null,
        assumptions: ['保留旧版数据库营养快照。'], advice: '填写实际食用量。',
        nutritionSource: { provider: providerName, dataset: source.dataset, coverage: 'incomplete' },
        components: [{ foodId: providerName === 'usda-fdc' ? 'rice_white_long_grain_cooked' : null, label,
          cookingMethod: providerName === 'usda-fdc' ? '蒸煮' : '炖', grams: null, quantitySource: 'unknown', consumedFraction: null,
          userQuantity: null, uncertainty: [], source }],
      } }],
    };
    await restoreMeals(page, [meal], { calorieTarget: 2000 });
    await reopenMeal(page, title);
    await page.getByTestId('meal-edit-portions').click();
    await expectRanges(page, 1, ranges);
    await expect(page.getByLabel('菜品 1 食用量', { exact: true })).toHaveValue('');
    const reference = page.getByTestId('meal-portion-estimate');
    await expect(reference).toContainText('已保留本餐保存的食用量');
    await expectNoOverflow(page);
    await reference.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`${providerName}-legacy-reference-ready.png`), fullPage: true });
    await page.getByLabel('菜品 1 食用量', { exact: true }).fill('150');
    await confirmReview(page);
    const totals: NutrientRanges = providerName === 'usda-fdc'
      ? { calories: { min: 300, max: 300 }, protein: { min: 15, max: 15 }, carbs: { min: 30, max: 30 }, fat: { min: 7.5, max: 7.5 } }
      : { calories: { min: 270, max: 330 }, protein: { min: 12, max: 18 }, carbs: { min: 30, max: 45 }, fat: { min: 6, max: 9 } };
    await expectTotals(page, totals);
    await expect(page.getByLabel('食物名称', { exact: true })).toHaveValue(title);
    await saveMeal(page);
    const archive = await exportBackup(page);
    const saved = archive.data.meals[0];
    expect(saved).toMatchObject({ foodName: title, foodNameSource: 'analysis' });
    expect(latestAnalysis(saved).analysis).toMatchObject({ ...totals,
      components: [{ label, userQuantity: { amount: 150, unit: 'g' } }],
    });
    const legacyVersion = saved.analyses!.find((version) => version.id === analysisId)!;
    expect(legacyVersion.analysis.components![0].source).toEqual(source);
    expect(legacyVersion.analysis.components![0].userQuantity).toBeNull();
    expect(legacyVersion.analysis.calories).toBeNull();
    expect(provider.responses()).toHaveLength(0);
    expect(errors).toEqual([]);
  });
}

test('待确认菜品仅改做法仍不估填，明确菜名并补完整营养后自动估填', async ({ page }, info) => {
  const errors = captureErrors(page);
  const provider = await installMockAiProvider(page, { onResponse: async (route) => fulfillProviderResponse(route,
    { components: [{ ...dish('待确认菜品', null, '未知'), confidence: 0.2, uncertainty: ['菜品身份待确认。'] }], uncertainty: [] }) });
  await openMeal(page, { calorieTarget: 2000 });
  await uploadPhoto(page);
  // Ambiguous recognition can finish its automatic review before this page
  // opens. The subsequent manual correction and portion action stay local.
  const initialResponseCount = provider.responses().length;
  expect(initialResponseCount).toBeGreaterThan(0);
  const reference = page.getByTestId('meal-portion-estimate');
  await page.getByLabel('菜品 1 做法', { exact: true }).fill('蒸煮');
  await setRanges(page, 1, originalRanges);
  await expect(reference).toContainText(/身份.*未确认|身份.*待确认/);
  await expect(page.getByLabel('菜品 1 食用量', { exact: true })).toHaveValue('');
  await page.getByLabel('菜品 1 名称', { exact: true }).fill('熟米饭');
  await setRanges(page, 1, originalRanges);
  await expect(page.getByLabel('菜品 1 名称', { exact: true })).toHaveValue('熟米饭');
  const grams = Number(await page.getByLabel('菜品 1 食用量', { exact: true }).inputValue());
  expect(grams).toBeGreaterThan(0);
  await expectNoOverflow(page);
  await reference.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('explicit-dish-identity-enables-portion-reference.png'), fullPage: true });
  await confirmReview(page);
  await expect(page.getByLabel('食物名称', { exact: true })).toHaveValue('熟米饭');
  await saveMeal(page);
  const archive = await exportBackup(page);
  const final = latestAnalysis(archive.data.meals[0]).analysis;
  expect(final.calories!.min).toBeGreaterThan(0);
  expect(final.coverage).toMatchObject({ referenceCount: 1, counted: 1 });
  expect(final.components![0]).toMatchObject({ label: '熟米饭', userNutritionPer100g: originalRanges, userQuantity: { amount: grams, unit: 'g' } });
  expect(provider.responses()).toHaveLength(initialResponseCount);
  expect(errors).toEqual([]);
});

test('本餐自动估填克数，已有用户数量优先并保存独立的每100g参考及版本', async ({ page }, info) => {
  const errors = captureErrors(page);
  const rice: NutrientRanges = { calories: { min: 200, max: 200 }, protein: { min: 10, max: 10 },
    carbs: { min: 20, max: 20 }, fat: { min: 10, max: 10 } };
  const chicken: NutrientRanges = { calories: { min: 100, max: 100 }, protein: { min: 10, max: 10 },
    carbs: { min: 10, max: 10 }, fat: { min: 10, max: 10 } };
  const provider = await installMockAiProvider(page, { onResponse: async (route) => fulfillProviderResponse(route,
    { components: [dish('熟米饭', rice), dish('清蒸鸡肉', chicken, '清蒸')], uncertainty: [] }) });
  await openMeal(page, { calorieTarget: 2000 });
  await uploadPhoto(page);
  const reference = page.getByTestId('meal-portion-estimate');
  await expect(reference).toContainText(/目标|2000/);
  const riceQuantity = page.getByLabel('菜品 1 食用量', { exact: true });
  const chickenQuantity = page.getByLabel('菜品 2 食用量', { exact: true });
  expect(Number(await riceQuantity.inputValue())).toBeGreaterThan(0);
  expect(Number(await chickenQuantity.inputValue())).toBeGreaterThan(0);
  await expect(page.getByTestId('ai-meal-review').getByRole('button', { name: '填入空白食用量', exact: true })).toHaveCount(0);
  await expectNoOverflow(page);
  await reference.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('portion-estimated-automatically.png'), fullPage: true });
  await page.getByTestId('review-dish-1-quantity-unit').getByRole('button', { name: '家用份数', exact: true }).click();
  await expect(page.getByLabel('菜品 1 食用份数', { exact: true })).toHaveValue('');
  await page.getByTestId('review-dish-1-quantity-unit').getByRole('button', { name: '克（g）', exact: true }).click();
  await expect(riceQuantity).toBeVisible();
  await expect(page.getByLabel('菜品 1 食用份数', { exact: true })).toHaveCount(0);
  await expect(riceQuantity).toHaveValue('');
  expect(Number(await chickenQuantity.inputValue())).toBeGreaterThan(0);
  await riceQuantity.fill('120');
  await expect(riceQuantity).toHaveValue('120');
  const chickenGrams = Number(await chickenQuantity.inputValue());
  expect(chickenGrams).toBeGreaterThan(0);
  await expect(page.getByTestId('ai-meal-review').getByText(/^热量 约 \d/)).toBeVisible();
  await expectNoOverflow(page);
  await chickenQuantity.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('portion-adopted-preserves-manual-120g.png'), fullPage: true });
  await confirmReview(page);
  const expected = {
    calories: 240 + chickenGrams, protein: 12 + chickenGrams / 10,
    carbs: 24 + chickenGrams / 10, fat: 12 + chickenGrams / 10,
  };
  for (const [key, , label] of nutrients)
    await expectFieldCoversValue(page, label, expected[key], key === 'calories' ? 1 : 0.1);
  await saveMeal(page);
  const archive = await exportBackup(page);
  const meal = archive.data.meals[0];
  expect(archive.data.profile.calorieTarget).toBe(2000);
  expect(meal.estimate).toBeUndefined();
  const final = latestAnalysis(meal);
  expect(final).toMatchObject({ model: 'local/meal-review', analysis: {
    nutritionSource: { method: 'ai-per100g-v3' }, components: [
      { userQuantity: { amount: 120, unit: 'g', origin: 'user' }, source: { per100gRange: rice } },
      { userQuantity: { amount: chickenGrams, unit: 'g', origin: 'estimated' }, source: { per100gRange: chicken } },
    ],
  } });
  for (const [key] of nutrients)
    expectRangeCoversValue(final.analysis[key], expected[key], key === 'calories' ? 1 : 0.1);
  const modelVersion = meal.analyses!.find((version) => version.model === MOCK_AI_MODEL)!;
  expect(modelVersion.analysis.calories).toBeNull();
  expect(modelVersion.analysis.components!.every((component) => !component.userQuantity)).toBe(true);
  expect(modelVersion.analysis.components!.map((component) => component.source?.per100gRange)).toEqual([rice, chicken]);
  expect(provider.responses()).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('无体重按成人默认估填，每100g营养未知仍不给数量或生成摄入', async ({ page }, info) => {
  const errors = captureErrors(page);
  let calls = 0;
  const provider = await installMockAiProvider(page, { onResponse: async (route) => fulfillProviderResponse(route,
    ++calls === 1 ? originalResponse : { components: [dish('未知配方菜', null)], uncertainty: [] }) });
  await openMeal(page);
  await uploadPhoto(page);
  const reference = page.getByTestId('meal-portion-estimate');
  await expect(reference).toContainText(/成人|60\s*kg/);
  const grams = Number(await page.getByLabel('菜品 1 食用量', { exact: true }).inputValue());
  expect(grams).toBeGreaterThan(0);
  await expectNoOverflow(page);
  await reference.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('portion-estimate-default-adult.png'), fullPage: true });
  await confirmReview(page);
  for (const [key, , label] of nutrients) {
    const raw = originalRanges[key];
    const text = await page.getByLabel(label, { exact: true }).inputValue();
    const [min, max = min] = text.split('～').map(Number);
    expect(min).toBeLessThanOrEqual(raw.min * grams / 100 + 1e-7);
    expect(max).toBeGreaterThanOrEqual(raw.max * grams / 100 - 1e-7);
  }
  await saveMeal(page);
  await setProfile(page, { heightCm: 170, weightKg: 65, calorieTarget: 2000 });
  await page.getByText('记饮食', { exact: true }).click();
  await uploadPhoto(page);
  await expect(reference).toContainText(/未知|缺少|不足|无法/);
  await expect(reference).toContainText(/营养|热量|每\s*100\s*g/);
  await expect(page.getByLabel('菜品 1 食用量', { exact: true })).toHaveValue('');
  await expect(page.getByTestId('ai-meal-review').getByText(/^热量 —/)).toBeVisible();
  await expectNoOverflow(page);
  await reference.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('portion-reference-unknown-density.png'), fullPage: true });
  await confirmReview(page);
  await expectEmptyTotals(page);
  await saveMeal(page);
  const archive = await exportBackup(page);
  expect(archive.data.meals).toHaveLength(2);
  const adultMeal = archive.data.meals.find((meal) => meal.foodName === '熟米饭')!;
  expect(adultMeal.estimate).toBeUndefined();
  expect(latestAnalysis(adultMeal).analysis.components![0].userQuantity).toMatchObject({ amount: grams, unit: 'g', origin: 'estimated' });
  const unknownMeal = archive.data.meals.find((meal) => meal.foodName === '未知配方菜')!;
  expect(unknownMeal.estimate).toBeUndefined();
  const final = latestAnalysis(unknownMeal).analysis;
  for (const [key] of nutrients) expect(final[key]).toBeNull();
  expect(final.components![0].userQuantity).toBeNull();
  expect(provider.responses()).toHaveLength(2);
  expect(errors).toEqual([]);
});

test('食用量标签右侧同排单位在手机和桌面均无溢出，家用半份仍按本地参考换算', async ({ page }, info) => {
  const errors = captureErrors(page);
  const provider = await installMockAiProvider(page, { onResponse: async (route) => fulfillProviderResponse(route, originalResponse) });
  await openMeal(page);
  await uploadPhoto(page);
  const control = page.getByTestId('review-dish-1-quantity-control');
  const unit = page.getByTestId('review-dish-1-quantity-unit');
  await expect(control).toBeVisible();
  await expect(unit.getByRole('button', { name: '克（g）', exact: true })).toBeVisible();
  await expect(unit.getByRole('button', { name: '家用份数', exact: true })).toBeVisible();
  await expect(page.getByTestId('ai-meal-review').getByText('单位', { exact: true })).toHaveCount(0);
  await control.scrollIntoViewIfNeeded();
  const label = control.getByText(/食用量$/);
  const labelBounds = await label.boundingBox();
  const unitBounds = await unit.boundingBox();
  expect(labelBounds).not.toBeNull();
  expect(unitBounds).not.toBeNull();
  expect(labelBounds!.x + labelBounds!.width).toBeLessThanOrEqual(unitBounds!.x + 1);
  expect(Math.min(labelBounds!.y + labelBounds!.height, unitBounds!.y + unitBounds!.height)
    - Math.max(labelBounds!.y, unitBounds!.y)).toBeGreaterThan(0);
  await expectNoOverflow(page);
  await page.screenshot({ path: info.outputPath('quantity-label-and-unit-same-row.png'), fullPage: true });
  await unit.getByRole('button', { name: '家用份数', exact: true }).click();
  await page.getByLabel('菜品 1 食用份数', { exact: true }).fill('0.5');
  await expect(page.getByTestId('ai-meal-review').getByText(/^热量 约 65～75 kcal/)).toBeVisible();
  await expectNoOverflow(page);
  await confirmReview(page);
  await expectTotals(page, {
    calories: { min: 65, max: 75 }, protein: { min: 1, max: 1.5 },
    carbs: { min: 14, max: 16.5 }, fat: { min: 0.1, max: 0.5 },
  });
  await expectNoOverflow(page);
  await saveMeal(page);
  const archive = await exportBackup(page);
  expect(latestAnalysis(archive.data.meals[0]).analysis.components![0]).toMatchObject({
    userQuantity: { amount: 0.5, unit: 'household' }, source: { per100gRange: originalRanges },
  });
  expect(provider.responses()).toHaveLength(1);
  expect(errors).toEqual([]);
});
