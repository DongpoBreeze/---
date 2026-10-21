import { test, expect, type Page } from '@playwright/test';
import { createBackupArchive } from '../src/backup';
import { emptyData, type MealAnalysis, type MealRecord } from '../src/types';

function legacyMeal(id: string, nutrition: Pick<MealAnalysis, 'calories' | 'protein' | 'carbs' | 'fat'>): MealRecord {
  const now = new Date().toISOString();
  return {
    id, type: 'meal', createdAt: now, occurredAt: now, timezone: 'Asia/Shanghai',
    mealType: '午餐', foodName: id, portion: '', note: '', source: 'manual',
    revision: 1, estimateStatus: 'unknown',
    analyses: [{
      id: id + '-analysis', model: 'legacy/offline-fixture', createdAt: now, sourceVersion: 1,
      analysis: {
        status: nutrition.calories ? 'estimated' : 'unknown', foodName: id,
        ...nutrition, assumptions: [], advice: '保留旧分析中各项已知与未知数据。',
      },
    }],
  };
}

async function restoreMeals(page: Page, meals: MealRecord[]) {
  page.on('dialog', (dialog) => { void dialog.accept(); });
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || ['blob:', 'data:'].includes(url.protocol) ? route.continue() : route.abort();
  });
  await page.goto('/');
  await page.getByRole('tab', { name: '我的', exact: true }).click();
  const bytes = await createBackupArchive({ ...emptyData(), meals }, []);
  const restored = page.waitForEvent('dialog', { predicate: (dialog) => dialog.message().includes('恢复完成') });
  const picker = page.waitForEvent('filechooser');
  await page.getByText('恢复备份', { exact: true }).click();
  await (await picker).setFiles({ name: 'legacy-nutrients.zip', mimeType: 'application/zip', buffer: Buffer.from(bytes) });
  await restored;
  await page.getByRole('tab', { name: '今天', exact: true }).click();
}

test('A 今日营养显示区间中点并为部分数据标注已知小计与未知餐数', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await restoreMeals(page, [
    legacyMeal('有蛋白质与碳水的餐食', {
      calories: { min: 100, max: 120 }, protein: { min: 10, max: 12 },
      carbs: { min: 20, max: 24 }, fat: null,
    }),
    legacyMeal('有脂肪但其余宏量未知的餐食', {
      calories: { min: 200, max: 220 }, protein: null, carbs: null, fat: { min: 5, max: 7 },
    }),
  ]);
  const card = page.getByTestId('today-nutrition');
  await expect(card.getByText('320', { exact: true })).toBeVisible();
  await expect(card.getByText('有营养估算 2 餐', { exact: true })).toBeVisible();
  await expect(card.getByText('信息不足 2 餐', { exact: true })).toBeVisible();
  for (const [nutrient, value] of [['protein', '11.0'], ['carbs', '22.0'], ['fat', '6.0']]) {
    const macro = page.getByTestId('today-nutrient-' + nutrient);
    const number = macro.getByText(value, { exact: true });
    const unit = macro.getByText('g', { exact: true });
    await expect(number).toBeVisible();
    await expect(unit).toBeVisible();
    const numberBox = await number.boundingBox();
    const unitBox = await unit.boundingBox();
    expect(numberBox).not.toBeNull();
    expect(unitBox).not.toBeNull();
    expect(unitBox!.x).toBeGreaterThanOrEqual(numberBox!.x + numberBox!.width);
    expect(unitBox!.y).toBeLessThan(numberBox!.y + numberBox!.height);
    expect(unitBox!.y + unitBox!.height).toBeGreaterThan(numberBox!.y);
    await expect(macro.getByText('已知小计', { exact: true })).toBeVisible();
    await expect(macro.getByText('1 餐未知', { exact: true })).toBeVisible();
  }
  await expect(card).not.toContainText('～');
  await page.screenshot({ path: testInfo.outputPath('mixed-known-and-missing-macros.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  expect(errors).toEqual([]);
});

test('A 今日所有营养未知时不补写为零', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await restoreMeals(page, [legacyMeal('营养仍未知的餐食', { calories: null, protein: null, carbs: null, fat: null })]);
  const card = page.getByTestId('today-nutrition');
  await expect(card.getByText('未知', { exact: true })).toBeVisible();
  await expect(card.getByText('有营养估算 0 餐', { exact: true })).toBeVisible();
  await expect(card.getByText('信息不足 1 餐', { exact: true })).toBeVisible();
  for (const nutrient of ['protein', 'carbs', 'fat']) {
    const macro = page.getByTestId('today-nutrient-' + nutrient);
    await expect(macro.getByText('—', { exact: true })).toBeVisible();
    await expect(macro.getByText('1 餐未知', { exact: true })).toBeVisible();
    await expect(macro.getByText('g', { exact: true })).toHaveCount(0);
    await expect(macro.getByText(/^0(?:\.0)?$/)).toHaveCount(0);
  }
  await page.screenshot({ path: testInfo.outputPath('all-nutrients-unknown.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  expect(errors).toEqual([]);
});
