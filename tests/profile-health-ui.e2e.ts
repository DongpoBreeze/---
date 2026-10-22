import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createBackupArchive, parseBackupArchive } from '../src/backup';
import { emptyData, type MealRecord, type Profile } from '../src/types';
import { configureMockAi, fulfillProviderResponse, installMockAiProvider } from './helpers/mock-ai-provider';
import {
  confirmPortionReview, expectPortionFormula, latestPortionAnalysis, pointRanges, portionAnswer,
  portionQuantity, portionReview, reopenPortionMeal, reopenPortionReview, savePortionMeal, uploadPortionPhoto,
} from './helpers/meal-estimated-portion';

async function openProfile(page: Page) {
  await page.getByRole('tab', { name: '我的', exact: true }).click();
  await page.getByText('修改目标与资料', { exact: true }).click();
  return page.getByRole('dialog');
}

async function saveProfile(dialog: Locator) {
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

async function expectWeightTarget(scope: Locator, kg: string, bmi: string, status: string) {
  await expect(scope.getByTestId('profile-weight-target-value')).toHaveText(`${kg} kg`);
  await expect(scope.getByTestId('profile-weight-target-bmi')).toHaveText(`BMI ${bmi} · ${status}`);
}

async function exportBackup(page: Page) {
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  const downloading = page.waitForEvent('download');
  await page.getByText('导出完整备份', { exact: true }).click();
  const download = await downloading;
  const bytes = new Uint8Array(await readFile((await download.path())!));
  return { bytes, archive: await parseBackupArchive(bytes) };
}

async function importBackup(page: Page, profile: Profile, meals: MealRecord[] = []) {
  const bytes = await createBackupArchive({ ...emptyData(), profile, meals }, []);
  await importBackupBytes(page, bytes);
}

async function importBackupBytes(page: Page, bytes: Uint8Array) {
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  const restored = page.waitForEvent('dialog', { predicate: (dialog) => dialog.message().includes('恢复完成') });
  const chooser = page.waitForEvent('filechooser');
  await page.getByText('恢复备份', { exact: true }).click();
  await (await chooser).setFiles({ name: 'profile-health-reference.zip', mimeType: 'application/zip', buffer: Buffer.from(bytes) });
  await restored;
}

function captureErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  return errors;
}

async function expectNoOverflow(page: Page, scope: Locator) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const testId of ['profile-health-reference', 'profile-bmi-scale', 'profile-bmi-track']) {
    const element = scope.getByTestId(testId);
    if (await element.count()) expect(await element.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), testId).toBe(true);
  }
  const trackNode = scope.getByTestId('profile-bmi-track');
  const track = await trackNode.count() ? await trackNode.boundingBox() : null;
  const markerBounds = [];
  for (const markerId of ['profile-bmi-current-marker', 'profile-bmi-target-marker']) {
    const marker = scope.getByTestId(markerId);
    if (!await marker.count()) continue;
    expect(track).not.toBeNull();
    const bounds = await marker.boundingBox();
    expect(bounds!.x, markerId).toBeGreaterThanOrEqual(track!.x - 1);
    expect(bounds!.x + bounds!.width, markerId).toBeLessThanOrEqual(track!.x + track!.width + 1);
    markerBounds.push(bounds!);
  }
  if (markerBounds.length === 2) {
    expect(markerBounds[0].y + markerBounds[0].height).toBeLessThan(markerBounds[1].y);
  }
  for (const testId of [
    'profile-bmi-number', 'profile-normal-weight', 'profile-weight-target-value', 'profile-weight-target-bmi',
    'profile-calorie-recommendation', 'profile-age-group', 'profile-age-reference', 'profile-age-error',
    ...[0, 1, 2, 3].map((index) => `profile-bmi-weight-range-${index}`),
  ]) {
    const text = scope.getByTestId(testId);
    if (!await text.count()) continue;
    expect(await text.evaluate((element) => element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 1), testId).toBe(true);
  }
}

async function expectAgeRestricted(scope: Locator, reason: RegExp) {
  await expect(scope.getByTestId('profile-bmi-reading')).toHaveText('21.6 · 需分龄解读');
  await expect(scope.getByTestId('profile-health-reference')).toContainText(reason);
  for (const testId of ['profile-bmi-scale', 'profile-normal-weight', 'profile-weight-target', 'profile-calorie-recommendation'])
    await expect(scope.getByTestId(testId)).toHaveCount(0);
}

test('optional demographics enforce integer age, preserve manual goals and restore adult recommendations after clearing or crossing boundaries', async ({ page }, info) => {
  test.setTimeout(120_000);
  const errors = captureErrors(page);
  page.on('dialog', (dialog) => { void dialog.accept(); });
  const provider = await installMockAiProvider(page);
  await page.goto('/');
  const untouched = await openProfile(page);
  await expect(untouched.getByLabel('年龄（岁，可选）', { exact: true })).toHaveValue('');
  await saveProfile(untouched);
  const omitted = (await exportBackup(page)).archive.data.profile;
  expect(Object.hasOwn(omitted, 'sex')).toBe(false);
  expect(Object.hasOwn(omitted, 'ageYears')).toBe(false);
  const dialog = await openProfile(page);
  const age = dialog.getByLabel('年龄（岁，可选）', { exact: true });
  const calories = dialog.getByLabel('每日热量目标（kcal，可选）', { exact: true });
  await expect(age).toHaveValue('');
  await expect(dialog.getByTestId('profile-age-group')).toContainText('年龄未填写 · 成人参考');
  await dialog.getByRole('button', { name: '保持健康', exact: true }).click();
  await dialog.getByLabel('身高（cm，可选）', { exact: true }).fill('180');
  await dialog.getByLabel('体重（kg，可选）', { exact: true }).fill('70');
  await expect(calories).toHaveValue('2100');
  for (const sex of ['男', '女']) {
    await dialog.getByRole('button', { name: sex, exact: true }).click();
    await expect(calories).toHaveValue('2100');
    await expect(dialog.getByTestId('profile-bmi-reading')).toHaveText('21.6 · 正常');
  }
  for (const [value, label, restricted] of [
    ['17', '未成年（1–17 岁）', true], ['18', '成人（18–64 岁）', false],
    ['64', '成人（18–64 岁）', false], ['65', '老年（65–120 岁）', true],
  ] as const) {
    await age.fill(value);
    await expect(dialog.getByTestId('profile-age-group')).toContainText(label);
    await expect(calories).toHaveValue(restricted ? '' : '2100');
    if (restricted) await expectAgeRestricted(dialog, value === '17' ? /未提供儿童生长曲线/ : /未提供老年专用模型/);
    else await expectWeightTarget(dialog, '70.0', '21.6', '正常');
  }
  await calories.fill('1980');
  for (const value of ['17', '65', '18']) {
    await age.fill(value);
    await expect(calories).toHaveValue('1980');
  }
  for (const [value, message] of [
    ['abc', '整数周岁'], ['NaN', '整数周岁'], ['Infinity', '整数周岁'],
    ['-1', '1–120 岁之间'], ['0', '1–120 岁之间'], ['17.5', '不支持小数'], ['121', '1–120 岁之间'],
  ]) {
    await age.fill(value);
    await expect(dialog.getByTestId('profile-age-group')).toContainText('年龄无效');
    await expect(dialog.getByTestId('profile-age-error')).toContainText(message);
    await expectAgeRestricted(dialog, /年龄/);
    await expect(calories).toHaveValue('1980');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('profile-age-error')).toContainText(message);
  }
  await dialog.getByRole('button', { name: '使用推荐', exact: true }).click();
  await expect(calories).toHaveValue('');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toBeVisible();
  await age.fill('18');
  await expect(calories).toHaveValue('2100');
  await age.fill('65');
  await expect(calories).toHaveValue('');
  await saveProfile(dialog);
  const automatic = (await exportBackup(page)).archive.data.profile;
  expect(automatic).toEqual({ goal: 'health', sex: 'female', ageYears: 65, heightCm: 180, weightKg: 70, calorieTargetSource: 'recommended' });
  await page.reload();
  const manual = await openProfile(page);
  await expect(manual.getByTestId('profile-calorie-mode')).toContainText('当前使用自动建议');
  await expect(manual.getByLabel('每日热量目标（kcal，可选）', { exact: true })).toHaveValue('');
  await expectAgeRestricted(manual, /老年专用模型/);
  await manual.getByLabel('每日热量目标（kcal，可选）', { exact: true }).fill('1980');
  await expectNoOverflow(page, manual);
  await manual.screenshot({ path: info.outputPath('female-65-manual-target.png') });
  await saveProfile(manual);
  await expect(page.getByTestId('profile-demographics')).toHaveText('性别：女 · 年龄：65 岁');
  await expect(page.getByTestId('profile-age-group')).toContainText('老年（65–120 岁）');
  await page.reload();
  const reopened = await openProfile(page);
  await expect(reopened.getByLabel('年龄（岁，可选）', { exact: true })).toHaveValue('65');
  await expect(reopened.getByLabel('每日热量目标（kcal，可选）', { exact: true })).toHaveValue('1980');
  await saveProfile(reopened);
  const saved = await exportBackup(page);
  expect(saved.archive.data.profile).toEqual({ goal: 'health', sex: 'female', ageYears: 65, heightCm: 180, weightKg: 70, calorieTarget: 1980 });
  const cleared = await openProfile(page);
  await cleared.getByRole('button', { name: '暂不填写', exact: true }).click();
  await cleared.getByLabel('年龄（岁，可选）', { exact: true }).fill('');
  await expect(cleared.getByTestId('profile-age-group')).toContainText('年龄未填写 · 成人参考');
  await expect(cleared.getByTestId('profile-bmi-reading')).toHaveText('21.6 · 正常');
  await expect(cleared.getByLabel('每日热量目标（kcal，可选）', { exact: true })).toHaveValue('1980');
  await cleared.getByRole('button', { name: '使用推荐', exact: true }).click();
  await expect(cleared.getByLabel('每日热量目标（kcal，可选）', { exact: true })).toHaveValue('2100');
  await saveProfile(cleared);
  await page.reload();
  await page.getByRole('tab', { name: '我的', exact: true }).click();
  await expect(page.getByTestId('profile-demographics')).toHaveText('性别：未填写 · 年龄：未填写');
  const exported = await exportBackup(page);
  expect(exported.archive.data.profile).toEqual({ goal: 'health', heightCm: 180, weightKg: 70, calorieTarget: 2100, calorieTargetSource: 'recommended' });
  expect(Object.hasOwn(exported.archive.data.profile, 'sex')).toBe(false);
  expect(Object.hasOwn(exported.archive.data.profile, 'ageYears')).toBe(false);
  expect(provider.requests.filter((request) => request.method === 'POST')).toEqual([]);
  expect(provider.legacyRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test('minor and older-adult meals keep new quantities empty, allow manual nutrition and leave earlier meals unchanged through backup restoration', async ({ page, browser }, info) => {
  test.setTimeout(150_000);
  const errors = captureErrors(page);
  page.on('dialog', (dialog) => { void dialog.accept(); });
  const provider = await installMockAiProvider(page, { onResponse: async (route) => fulfillProviderResponse(route, portionAnswer) });
  await page.goto('/');
  await configureMockAi(page);
  const first = await openProfile(page);
  await first.getByRole('button', { name: '保持健康', exact: true }).click();
  await first.getByRole('button', { name: '男', exact: true }).click();
  await first.getByLabel('年龄（岁，可选）', { exact: true }).fill('18');
  await first.getByLabel('身高（cm，可选）', { exact: true }).fill('180');
  await first.getByLabel('体重（kg，可选）', { exact: true }).fill('70');
  await saveProfile(first);
  await page.getByRole('tab', { name: '今天', exact: true }).click();
  await page.getByText('记饮食', { exact: true }).click();
  await uploadPortionPhoto(page);
  const originalGrams = Number(await portionQuantity(page).inputValue());
  expect(originalGrams).toBeGreaterThan(0);
  await confirmPortionReview(page);
  await expectPortionFormula(page, [{ grams: originalGrams, per100g: pointRanges() }]);
  await page.getByLabel('食物名称', { exact: true }).fill('成年时原餐');
  await savePortionMeal(page);
  const original = (await exportBackup(page)).archive.data.meals[0];
  for (const [age, reason, grams, title] of [
    ['65', /老年专用模型/, 100, '老年分组手填餐'], ['17', /儿童生长曲线/, 120, '未成年分组手填餐'],
  ] as const) {
    const dialog = await openProfile(page);
    await dialog.getByLabel('年龄（岁，可选）', { exact: true }).fill(age);
    await dialog.getByLabel('每日热量目标（kcal，可选）', { exact: true }).fill('1980');
    await saveProfile(dialog);
    await page.getByRole('tab', { name: '今天', exact: true }).click();
    await page.getByText('记饮食', { exact: true }).click();
    await uploadPortionPhoto(page);
    await expect(portionQuantity(page)).toHaveValue('');
    await expect(page.getByTestId('meal-portion-estimate')).toContainText(reason);
    await expect(page.getByTestId('meal-portion-estimate')).toContainText('逐菜填写食用量');
    await portionQuantity(page).fill(String(grams));
    await confirmPortionReview(page);
    await expectPortionFormula(page, [{ grams, per100g: pointRanges() }]);
    await page.getByLabel('食物名称', { exact: true }).fill(title);
    await savePortionMeal(page);
    const state = (await exportBackup(page)).archive.data;
    expect(state.meals.find((entry) => entry.id === original.id)).toEqual(original);
    const added = state.meals.find((entry) => entry.foodName === title)!;
    expect(latestPortionAnalysis(added).analysis.components![0].userQuantity).toEqual({ amount: grams, unit: 'g', origin: 'user' });
    expect(state.profile.calorieTarget).toBe(1980);
  }
  const adult = await openProfile(page);
  await adult.getByLabel('年龄（岁，可选）', { exact: true }).fill('64');
  await adult.getByRole('button', { name: '使用推荐', exact: true }).click();
  await expect(adult.getByLabel('每日热量目标（kcal，可选）', { exact: true })).toHaveValue('2100');
  await saveProfile(adult);
  await page.getByRole('tab', { name: '今天', exact: true }).click();
  await page.getByText('记饮食', { exact: true }).click();
  await uploadPortionPhoto(page);
  await expect(portionQuantity(page)).toHaveValue(String(originalGrams));
  await confirmPortionReview(page);
  await page.getByLabel('食物名称', { exact: true }).fill('恢复成人自动量');
  await savePortionMeal(page);
  const final = await exportBackup(page);
  expect(final.archive.data.meals.find((entry) => entry.id === original.id)).toEqual(original);
  expect(final.archive.data.profile).toMatchObject({ sex: 'male', ageYears: 64, calorieTargetSource: 'recommended', calorieTarget: 2100 });
  const context = await browser.newContext({ viewport: info.project.use.viewport, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  try {
    const restored = await context.newPage();
    const restoredErrors = captureErrors(restored);
    restored.on('dialog', (dialog) => { void dialog.accept(); });
    await restored.goto(page.url());
    await importBackupBytes(restored, final.bytes);
    await restored.getByRole('tab', { name: '我的', exact: true }).click();
    await expect(restored.getByTestId('profile-demographics')).toHaveText('性别：男 · 年龄：64 岁');
    await reopenPortionMeal(restored, '成年时原餐');
    await reopenPortionReview(restored);
    await expect(portionQuantity(restored)).toHaveValue(String(originalGrams));
    await portionReview(restored).getByRole('button', { name: '返回饮食', exact: true }).click();
    await restored.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
    const roundtrip = await exportBackup(restored);
    expect(roundtrip.archive.data.meals).toEqual(final.archive.data.meals);
    expect(roundtrip.archive.data.profile).toEqual(final.archive.data.profile);
    expect(restoredErrors).toEqual([]);
  } finally { await context.close(); }
  expect(provider.responses()).toHaveLength(4);
  expect(provider.legacyRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test('live BMI, distinct markers and automatic/manual calorie targets persist and reach the home screen without inference', async ({ page }, info) => {
  test.setTimeout(120_000);
  const errors = captureErrors(page);
  page.on('dialog', (dialog) => { void dialog.accept(); });
  const provider = await installMockAiProvider(page);
  await page.goto('/');
  await configureMockAi(page);
  const dialog = await openProfile(page);
  const calories = dialog.getByLabel('每日热量目标（kcal，可选）', { exact: true });
  await dialog.getByLabel('身高（cm，可选）', { exact: true }).fill('180');
  await dialog.getByLabel('体重（kg，可选）', { exact: true }).fill('70');
  await expect(dialog.getByTestId('profile-bmi-reading')).toHaveText('21.6 · 正常');
  await expect(calories).toHaveValue(''); // A goal has not been invented.
  await dialog.getByRole('button', { name: '保持健康', exact: true }).click();
  await expect(calories).toHaveValue('2100');
  await expectWeightTarget(dialog, '70.0', '21.6', '正常');
  await expect(dialog.getByTestId('profile-normal-weight')).toContainText('59.9–77.4 kg');
  await expect(dialog.getByRole('img', { name: '当前 BMI 21.6', exact: true })).toBeVisible();
  await expect(dialog.getByRole('img', { name: '建议目标 BMI 21.6', exact: true })).toBeVisible();
  await expect(dialog.getByTestId('profile-health-basis')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '查看计算依据', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await dialog.getByRole('button', { name: '查看计算依据', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '收起计算依据', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await expect(dialog.getByTestId('profile-health-basis')).toContainText('70 kg × 30 kcal/kg/日');
  await dialog.getByRole('button', { name: '收起计算依据', exact: true }).click();
  await expect(dialog.getByTestId('profile-health-basis')).toHaveCount(0);
  await expectNoOverflow(page, dialog);

  await dialog.getByLabel('体重（kg，可选）', { exact: true }).fill('80');
  await expect(calories).toHaveValue('2400');
  await expect(dialog.getByTestId('profile-bmi-reading')).toHaveText('24.7 · 超重');
  await dialog.getByRole('button', { name: '减脂', exact: true }).click();
  await expect(calories).toHaveValue('2150');
  await calories.fill('2000');
  await dialog.getByLabel('体重（kg，可选）', { exact: true }).fill('75');
  await expect(calories).toHaveValue('2000');
  await expect(dialog.getByTestId('profile-calorie-mode')).toContainText('当前使用手动目标');
  await dialog.getByRole('button', { name: '使用推荐', exact: true }).click();
  await expect(calories).toHaveValue('2050');
  await saveProfile(dialog);
  await expect(page.getByTestId('profile-bmi-reading')).toHaveText('23.1 · 正常');
  const automatic = await exportBackup(page);
  expect(automatic.archive.data.profile).toEqual({ goal: 'fat-loss', heightCm: 180, weightKg: 75, calorieTarget: 2050, calorieTargetSource: 'recommended' });
  await page.getByRole('tab', { name: '今天', exact: true }).click();
  await expect(page.getByText('— / 2050 kcal', { exact: true })).toBeVisible();
  await page.reload();
  const reopened = await openProfile(page);
  await expect(reopened.getByLabel('每日热量目标（kcal，可选）', { exact: true })).toHaveValue('2050');
  await expect(reopened.getByTestId('profile-calorie-mode')).toContainText('当前使用自动建议');
  await reopened.getByLabel('每日热量目标（kcal，可选）', { exact: true }).fill('');
  await saveProfile(reopened);
  await page.reload();
  const empty = await openProfile(page);
  await expect(empty.getByLabel('每日热量目标（kcal，可选）', { exact: true })).toHaveValue('');
  await expect(empty.getByTestId('profile-calorie-mode')).toContainText('当前使用手动目标');
  await empty.getByLabel('体重（kg，可选）', { exact: true }).fill('80');
  await expect(empty.getByLabel('每日热量目标（kcal，可选）', { exact: true })).toHaveValue('');
  await empty.screenshot({ path: info.outputPath('manual-empty-target.png') });
  await saveProfile(empty);
  const manual = await exportBackup(page);
  expect(manual.archive.data.profile).toEqual({ goal: 'fat-loss', heightCm: 180, weightKg: 80, calorieTargetSource: 'manual' });
  expect(provider.requests.filter((request) => request.method === 'POST')).toEqual([]);
  expect(provider.legacyRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test('legacy manual goals and meal facts survive edits, export and restoration into a fresh browser context', async ({ page, browser }, info) => {
  test.setTimeout(120_000);
  const errors = captureErrors(page);
  page.on('dialog', (dialog) => { void dialog.accept(); });
  await page.goto('/');
  const original: MealRecord = {
    id: 'before-profile-change', type: 'meal', createdAt: '2026-10-21T04:00:00Z', occurredAt: '2026-10-21T04:00:00Z',
    mealType: '午餐', foodName: '原来的午餐', portion: '100 g', note: '保留原记录', source: 'manual',
    estimateStatus: 'estimated', estimate: { calories: 250, protein: 10, carbs: 30, fat: 5 },
  };
  await importBackup(page, { goal: 'health', heightCm: 170, weightKg: 70, calorieTarget: 2100 }, [original]);
  const dialog = await openProfile(page);
  await expect(dialog.getByTestId('profile-calorie-mode')).toContainText('当前使用手动目标');
  await dialog.getByLabel('体重（kg，可选）', { exact: true }).fill('80');
  await dialog.getByRole('button', { name: '增肌', exact: true }).click();
  await expect(dialog.getByLabel('每日热量目标（kcal，可选）', { exact: true })).toHaveValue('2100');
  await expectWeightTarget(dialog, '80.0', '27.7', '超重');
  await saveProfile(dialog);
  const exported = await exportBackup(page);
  expect(exported.archive.data.profile).toEqual({ goal: 'muscle-gain', heightCm: 170, weightKg: 80, calorieTarget: 2100 });
  expect(exported.archive.data.meals).toEqual([original]);

  const context = await browser.newContext({ viewport: info.project.use.viewport, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  try {
    const restored = await context.newPage();
    restored.on('dialog', (event) => { void event.accept(); });
    await restored.goto(page.url());
    await importBackup(restored, exported.archive.data.profile, exported.archive.data.meals);
    const reopened = await openProfile(restored);
    await expect(reopened.getByTestId('profile-calorie-mode')).toContainText('当前使用手动目标');
    await expect(reopened.getByLabel('每日热量目标（kcal，可选）', { exact: true })).toHaveValue('2100');
    await reopened.getByRole('button', { name: '使用推荐', exact: true }).click();
    await expect(reopened.getByLabel('每日热量目标（kcal，可选）', { exact: true })).toHaveValue('2400');
    await saveProfile(reopened);
    const result = await exportBackup(restored);
    expect(result.archive.data.profile.calorieTargetSource).toBe('recommended');
    expect(result.archive.data.meals).toEqual([original]);
  } finally { await context.close(); }
  expect(errors).toEqual([]);
});

test('light and dark body references fit 360/390 or desktop widths and clamp extreme BMI markers', async ({ page }, info) => {
  test.setTimeout(120_000);
  const errors = captureErrors(page);
  await page.goto('/');
  await page.getByRole('tab', { name: '我的', exact: true }).click();
  const widths = info.project.name === 'mobile' ? [360, 390] : [1440];
  for (const width of widths) {
    await page.setViewportSize({ width, height: info.project.name === 'mobile' ? 844 : 1000 });
    for (const mode of ['浅色模式', '暗色模式'] as const) {
      await page.getByRole('tab', { name: '设置', exact: true }).click();
      await page.getByRole('radio', { name: mode, exact: true }).click();
      const dialog = await openProfile(page);
      await expect(dialog.getByTestId('profile-bmi-reading')).toHaveText('待补充');
      await expect(dialog.getByTestId('profile-bmi-range-context')).toContainText('BMI 分类');
      await expect(dialog.getByTestId('profile-bmi-current-marker')).toHaveCount(0);
      await expect(dialog.getByTestId('profile-bmi-target-marker')).toHaveCount(0);
      await expect(dialog.getByText('暂无建议目标', { exact: true })).toBeVisible();
      await expectNoOverflow(page, dialog);
      await dialog.getByTestId('profile-health-reference').screenshot({ path: info.outputPath(`${width}-${mode}-empty.png`) });
      await dialog.getByLabel('身高（cm，可选）', { exact: true }).fill('180');
      await expect(dialog.getByTestId('profile-bmi-range-context')).toContainText('按 180 cm 换算');
      await expect(dialog.getByTestId('profile-bmi-weight-range-0')).toHaveText('<59.9');
      await expect(dialog.getByTestId('profile-bmi-weight-range-1')).toHaveText(/59.9–\s*<77.8/);
      await expect(dialog.getByTestId('profile-bmi-weight-range-2')).toHaveText(/77.8–\s*<90.7/);
      await expect(dialog.getByTestId('profile-bmi-weight-range-3')).toHaveText('≥90.7');
      await dialog.getByLabel('体重（kg，可选）', { exact: true }).fill('70');
      await dialog.getByRole('button', { name: '保持健康', exact: true }).click();
      await expect(dialog.getByTestId('profile-bmi-reading')).toHaveText('21.6 · 正常');
      await expect(dialog.getByTestId('profile-bmi-current-marker')).toContainText('你');
      await expect(dialog.getByTestId('profile-bmi-target-marker')).toContainText('目标');
      await expectNoOverflow(page, dialog);
      await dialog.getByTestId('profile-health-reference').screenshot({ path: info.outputPath(`${width}-${mode}-reference.png`) });
      await dialog.getByRole('button', { name: '女', exact: true }).click();
      for (const [age, group, reason] of [['17', 'minor', /儿童生长曲线/], ['65', 'older-adult', /老年专用模型/]] as const) {
        await dialog.getByLabel('年龄（岁，可选）', { exact: true }).fill(age);
        await expectAgeRestricted(dialog, reason);
        await expect(dialog.getByLabel('每日热量目标（kcal，可选）', { exact: true })).toHaveValue('');
        await expectNoOverflow(page, dialog);
        await dialog.getByTestId('profile-health-reference').screenshot({ path: info.outputPath(`${width}-${mode}-${group}.png`) });
        await dialog.getByLabel('年龄（岁，可选）', { exact: true }).scrollIntoViewIfNeeded();
        await dialog.screenshot({ path: info.outputPath(`${width}-${mode}-${group}-form.png`) });
      }
      await dialog.getByLabel('年龄（岁，可选）', { exact: true }).fill('');
      await expect(dialog.getByTestId('profile-age-reference')).toHaveText('年龄未填写 · 成人参考');
      await dialog.getByRole('button', { name: '减脂', exact: true }).click();
      await dialog.getByLabel('身高（cm，可选）', { exact: true }).fill('200');
      await dialog.getByLabel('体重（kg，可选）', { exact: true }).fill('95.84');
      await expect(dialog.getByTestId('profile-bmi-reading')).toHaveText('23.96 · 正常');
      await expect(dialog.getByRole('img', { name: '当前 BMI 23.96', exact: true })).toBeVisible();
      await expect(dialog.getByText('当前 BMI 23.96', { exact: true })).toBeVisible();
      await expect(dialog.getByTestId('profile-calorie-recommendation')).toHaveText('2600 kcal/日');
      await dialog.getByRole('button', { name: '保持健康', exact: true }).click();
      await expectWeightTarget(dialog, '95.8', '23.96', '正常');
      await expect(dialog.getByRole('img', { name: '建议目标 BMI 23.96', exact: true })).toBeVisible();
      await expect(dialog.getByText('建议目标 BMI 23.96', { exact: true })).toBeVisible();
      await expectNoOverflow(page, dialog);
      await dialog.getByTestId('profile-health-reference').screenshot({ path: info.outputPath(`${width}-${mode}-boundary.png`) });
      await dialog.getByLabel('体重（kg，可选）', { exact: true }).fill('95.9996');
      await expect(dialog.getByTestId('profile-bmi-reading')).toHaveText('<24 · 正常');
      await expectWeightTarget(dialog, '96.0', '<24', '正常');
      for (const label of ['当前 BMI <24', '建议目标 BMI <24']) {
        await expect(dialog.getByRole('img', { name: label, exact: true })).toBeVisible();
        await expect(dialog.getByText(label, { exact: true })).toBeVisible();
      }
      await expectNoOverflow(page, dialog);
      await dialog.getByTestId('profile-health-reference').screenshot({ path: info.outputPath(`${width}-${mode}-near-threshold.png`) });
      await dialog.getByLabel('体重（kg，可选）', { exact: true }).fill('96');
      await expect(dialog.getByTestId('profile-bmi-reading')).toHaveText('24.0 · 超重');
      await dialog.getByLabel('身高（cm，可选）', { exact: true }).fill('250');
      await expect(dialog.getByTestId('profile-bmi-weight-range-0')).toHaveText('<115.6');
      await expect(dialog.getByTestId('profile-bmi-weight-range-1')).toHaveText(/115.6–\s*<150.0/);
      await expect(dialog.getByTestId('profile-bmi-weight-range-2')).toHaveText(/150.0–\s*<175.0/);
      await expect(dialog.getByTestId('profile-bmi-weight-range-3')).toHaveText('≥175.0');
      await expectNoOverflow(page, dialog);
      await dialog.getByLabel('身高（cm，可选）', { exact: true }).fill('160');
      await dialog.getByLabel('体重（kg，可选）', { exact: true }).fill('180');
      await expect(dialog.getByTestId('profile-bmi-reading')).toHaveText('70.3 · 肥胖');
      await expect(dialog.getByTestId('profile-calorie-recommendation')).toHaveText('暂不自动推荐');
      await expect(dialog.getByText(/超出热量自动建议范围/)).toBeVisible();
      await expect(dialog.getByTestId('profile-bmi-target-marker')).toHaveCount(0);
      await expectNoOverflow(page, dialog);
      await dialog.getByTestId('profile-health-reference').screenshot({ path: info.outputPath(`${width}-${mode}-extreme.png`) });
      await dialog.getByLabel('体重（kg，可选）', { exact: true }).fill('20');
      await expect(dialog.getByTestId('profile-bmi-reading')).toHaveText('7.8 · 偏瘦');
      await expectNoOverflow(page, dialog);
      await dialog.getByLabel('体重（kg，可选）', { exact: true }).fill('NaN');
      await expect(dialog.getByTestId('profile-bmi-reading')).toHaveText('待补充');
      await expect(dialog.getByTestId('profile-bmi-current-marker')).toHaveCount(0);
      await expect(dialog.getByLabel('每日热量目标（kcal，可选）', { exact: true })).toHaveValue('');
      await dialog.getByLabel('关闭', { exact: true }).click();
    }
  }
  expect(errors).toEqual([]);
});
