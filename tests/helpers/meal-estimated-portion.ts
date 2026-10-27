import { expect, type Locator, type Page } from '@playwright/test';
import { nutritionInput } from './meal-nutrition';
import { readFile } from 'node:fs/promises';
import { createBackupArchive, parseBackupArchive } from '../../src/backup';
import { emptyData, type MealRecord, type NutrientRanges, type Profile } from '../../src/types';
import { configureMockAi } from './mock-ai-provider';

export const portionPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a90sAAAAASUVORK5CYII=', 'base64');
export const portionNutrients = [
  ['calories', '热量', '热量 kcal'], ['protein', '蛋白质', '蛋白质 g'],
  ['carbs', '碳水', '碳水 g'], ['fat', '脂肪', '脂肪 g'],
] as const;

export function pointRanges(calories = 200, protein = 10, carbs = 20, fat = 5): NutrientRanges {
  return {
    calories: { min: calories, max: calories }, protein: { min: protein, max: protein },
    carbs: { min: carbs, max: carbs }, fat: { min: fat, max: fat },
  };
}

export function portionDish(label: string, per100g: NutrientRanges | null = pointRanges(), cookingMethod = '蒸煮', recommendedShare = 1) {
  return {
    label, cookingMethod, confidence: 0.97, recommendedShare,
    nutritionEstimate: per100g ? {
      method: 'typical_recipe', per100g, recipeBasis: '按每 100 g 可食用成品的典型配方估算。',
      assumptions: ['食用量为可调整的成人估值。'], confidence: 0.95,
    } : null,
    uncertainty: per100g ? [] : ['每 100 g 营养未知。'],
  };
}

export const portionAnswer = { components: [portionDish('熟米饭')], uncertainty: [] };

export function capturePortionErrors(page: Page, errors: string[] = []) {
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`console.error: ${message.text()}`); });
  return errors;
}

export function portionReview(page: Page) { return page.getByTestId('ai-meal-review'); }
export function portionQuantity(page: Page, index = 1) {
  return portionReview(page).getByLabel(`菜品 ${index} 食用量`, { exact: true });
}

export async function setPortionProfile(page: Page, profile: Profile) {
  await page.getByRole('tab', { name: '我的', exact: true }).click();
  await page.getByText('修改目标与资料', { exact: true }).click();
  const dialog = page.getByRole('dialog');
  for (const [key, label] of [
    ['ageYears', '年龄（岁，可选）'],
    ['heightCm', '身高（cm，可选）'], ['weightKg', '体重（kg，可选）'],
    ['calorieTarget', '每日热量目标（kcal，可选）'],
  ] as const) await dialog.getByLabel(label, { exact: true }).fill(profile[key] === undefined ? '' : String(profile[key]));
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('tab', { name: '今天', exact: true }).click();
}

export async function openPortionMeal(page: Page, profile?: Profile) {
  await page.goto('/');
  await configureMockAi(page);
  if (profile) await setPortionProfile(page, profile);
  await page.getByText('记饮食', { exact: true }).click();
}

export async function uploadPortionPhoto(page: Page) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByText('选择照片', { exact: true }).click();
  await (await chooser).setFiles({ name: 'estimated-portion.png', mimeType: 'image/png', buffer: portionPng });
  await expect(portionReview(page)).toBeVisible();
  await expect(portionReview(page).getByText('照片识别完成，请核对。', { exact: true })).toBeVisible();
}

export async function setPortionRanges(page: Page, index: number, ranges: NutrientRanges) {
  for (const [key, label] of portionNutrients) {
    await portionReview(page).getByLabel(`菜品 ${index} 每100g${label}下限`, { exact: true }).fill(String(ranges[key].min));
    await portionReview(page).getByLabel(`菜品 ${index} 每100g${label}上限`, { exact: true }).fill(String(ranges[key].max));
  }
}

export async function expectPortionRanges(page: Page, index: number, ranges: NutrientRanges | null) {
  for (const [key, label] of portionNutrients) {
    await expect(portionReview(page).getByLabel(`菜品 ${index} 每100g${label}下限`, { exact: true })).toHaveValue(ranges ? String(ranges[key].min) : '');
    await expect(portionReview(page).getByLabel(`菜品 ${index} 每100g${label}上限`, { exact: true })).toHaveValue(ranges ? String(ranges[key].max) : '');
  }
}

export async function confirmPortionReview(page: Page, options: { editNutrition?: boolean } = {}) {
  await portionReview(page).getByRole('button', { name: '确认填入', exact: true }).click();
  await expect(portionReview(page)).toHaveCount(0);
  await expect(page.getByTestId('meal-edit-portions')).toBeVisible();
  await expect(page.getByTestId('meal-confirmation-summary')).toHaveCount(0);
  if (options.editNutrition !== false) {
    const edit = page.getByRole('button', { name: '修改营养值', exact: true });
    if (await edit.count()) await edit.click();
  }
}

export async function editPortionNutrition(page: Page) {
  const edit = page.getByRole('button', { name: '修改营养值', exact: true });
  if (await edit.count()) await edit.click();
}

export async function reopenPortionReview(page: Page) {
  await page.getByTestId('meal-edit-portions').click();
  await expect(portionReview(page)).toBeVisible();
}

export async function savePortionMeal(page: Page) {
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

export async function reopenPortionMeal(page: Page, title: string) {
  await page.getByRole('tab', { name: '我的', exact: true }).click();
  await page.getByRole('button', { name: '全部记录', exact: true }).click();
  await page.getByText(title, { exact: true }).click();
  await expect(page.getByLabel('食物名称', { exact: true })).toHaveValue(title);
}

export async function exportPortionBackup(page: Page) {
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  const downloading = page.waitForEvent('download');
  await page.getByText('导出完整备份', { exact: true }).click();
  const download = await downloading;
  const bytes = new Uint8Array(await readFile((await download.path())!));
  return { bytes, archive: await parseBackupArchive(bytes) };
}

export async function importPortionBackup(page: Page, bytes: Uint8Array) {
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  const restored = page.waitForEvent('dialog', { predicate: (dialog) => dialog.message().includes('恢复完成') });
  const chooser = page.waitForEvent('filechooser');
  await page.getByText('恢复备份', { exact: true }).click();
  await (await chooser).setFiles({ name: 'estimated-portion.zip', mimeType: 'application/zip', buffer: Buffer.from(bytes) });
  await restored;
}

export async function restorePortionMeals(page: Page, meals: MealRecord[], profile: Profile = {}, media: Parameters<typeof createBackupArchive>[1] = []) {
  const bytes = await createBackupArchive({ ...emptyData(), profile, meals }, media);
  await page.goto('/');
  await importPortionBackup(page, bytes);
}

export function latestPortionAnalysis(meal: MealRecord) {
  const result = meal.analyses?.filter((version) => version.sourceVersion === (meal.revision ?? 1)).at(-1);
  expect(result).toBeDefined();
  return result!;
}

export async function expectPortionTotals(page: Page, ranges: NutrientRanges | null) {
  for (const [key, , label] of portionNutrients) {
    const expected = ranges ? ranges[key].min === ranges[key].max ? String(ranges[key].min) : `${ranges[key].min}～${ranges[key].max}` : '';
    await expect((await nutritionInput(page, label))).toHaveValue(expected);
  }
}

// Validate the formula independently from the production estimator. The UI
// rounds nutrient ranges outwards to 1 kcal / 0.1 g, including point estimates.
export async function expectPortionFormula(page: Page, dishes: Array<{ grams: number; per100g: NutrientRanges }>) {
  for (const [key, , label] of portionNutrients) {
    const min = dishes.reduce((total, dish) => total + dish.per100g[key].min * dish.grams / 100, 0);
    const max = dishes.reduce((total, dish) => total + dish.per100g[key].max * dish.grams / 100, 0);
    const text = await (await nutritionInput(page, label)).inputValue();
    expect(text, label).toMatch(/^\d+(?:\.\d+)?(?:～\d+(?:\.\d+)?)?$/);
    const [actualMin, actualMax = actualMin] = text.split('～').map(Number);
    const precision = key === 'calories' ? 1 : 0.1;
    expect(actualMin, `${label} lower`).toBeLessThanOrEqual(min + 1e-7);
    expect(actualMax, `${label} upper`).toBeGreaterThanOrEqual(max - 1e-7);
    expect(min - actualMin, label).toBeLessThanOrEqual(precision + 1e-7);
    expect(actualMax - max, label).toBeLessThanOrEqual(precision + 1e-7);
  }
}

export async function expectPortionNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  for (const id of ['ai-meal-review', 'meal-nutrition-header', 'meal-portion-estimate', 'review-dish-1-quantity-control']) {
    const node = page.getByTestId(id);
    if (await node.count()) expect(await node.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), id).toBe(true);
  }
  if (await portionReview(page).count()) {
    for (const name of ['AI 复核', '确认填入']) {
      const bounds = await portionReview(page).getByRole('button', { name, exact: true }).boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
    }
  }
}

export async function expectPortionSameRow(label: Locator, action: Locator) {
  const a = await label.boundingBox();
  const b = await action.boundingBox();
  expect(a).not.toBeNull();
  expect(b).not.toBeNull();
  expect(a!.x + a!.width).toBeLessThanOrEqual(b!.x + 1);
  expect(Math.min(a!.y + a!.height, b!.y + b!.height) - Math.max(a!.y, b!.y)).toBeGreaterThan(0);
}
