import { expect, test, type Locator, type Page } from '@playwright/test';
import { createBackupArchive } from '../src/backup';
import { emptyData, type SleepRecord, type TrainingRecord } from '../src/types';
import { capturePortionErrors, editPortionNutrition, exportPortionBackup, importPortionBackup,
  reopenPortionMeal, savePortionMeal } from './helpers/meal-estimated-portion';
import { installMockAiProvider } from './helpers/mock-ai-provider';

const noon = '2026-10-27T04:00:00.000Z';
test.use({ storageState: { cookies: [], origins: [] } });
test.beforeEach(async ({ page }) => {
  test.setTimeout(120_000);
  page.on('dialog', (dialog) => { void dialog.accept(); });
  // Keep the selected day deterministic while allowing JS-driven fades to finish.
  await page.clock.install({ time: new Date(noon) });
});

async function settleVisible(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  await expect.poll(() => locator.evaluate((node) => {
    let opacity = 1;
    for (let element: Element | null = node; element; element = element.parentElement)
      opacity *= Number(getComputedStyle(element).opacity);
    return opacity;
  })).toBeGreaterThan(0.99);
}

async function saveForm(page: Page) {
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

async function openSavedSleep(page: Page, hours: string) {
  await page.getByRole('tab', { name: '我的', exact: true }).click();
  await page.getByRole('button', { name: '全部记录', exact: true }).click();
  await page.getByText(`${hours} 小时估算睡眠`, { exact: true }).click();
}

async function expectSleepHome(page: Page, hours: string) {
  await page.getByRole('tab', { name: '今天', exact: true }).click();
  await expect(page.getByTestId('today-sleep-value')).toHaveText(`${hours} h`);
  await expect(page.getByTestId('today-sleep-note')).toHaveText('按记录时间估算 · 非设备测量');
  await expect(page.getByText('时长未知', { exact: true })).toHaveCount(0);
}

test('睡眠只填两端时间可用，编辑清醒时长和端点后首页及备份同步，缺省项不显示未知', async ({ page }, info) => {
  const errors = capturePortionErrors(page);
  const provider = await installMockAiProvider(page);
  await page.goto('/');
  await page.getByRole('button', { name: '记睡眠' }).click();
  const fell = page.getByLabel('入睡（YYYY-MM-DD HH:mm）', { exact: true });
  const woke = page.getByLabel('起床（YYYY-MM-DD HH:mm）', { exact: true });
  const awake = page.getByLabel('清醒时长（分钟，可明确填 0）', { exact: true });
  await fell.fill('2026-10-26 23:30');
  await woke.fill('2026-10-27 07:00');
  await expect(awake).toHaveValue('');
  await saveForm(page);
  await expectSleepHome(page, '7.5');
  await openSavedSleep(page, '7.5');
  await fell.fill('2026-10-26 23:00');
  await saveForm(page);
  await expectSleepHome(page, '8.0');
  await page.reload();
  await expectSleepHome(page, '8.0');
  await openSavedSleep(page, '8.0');
  await awake.fill('30');
  await saveForm(page);
  await expectSleepHome(page, '7.5');
  await openSavedSleep(page, '7.5');
  await awake.fill('');
  await saveForm(page);
  await expectSleepHome(page, '8.0');
  await page.getByRole('button', { name: '查看完整摘要' }).click();
  await expect(page.getByText(/估算睡眠 8\.0 小时/)).toBeVisible();
  await settleVisible(page.getByTestId('today-sleep-value'));
  await page.screenshot({ path: info.outputPath('sleep-without-optional-fields.png'), fullPage: true });
  const { archive } = await exportPortionBackup(page);
  expect(archive.data.sleeps).toHaveLength(1);
  expect(archive.data.sleeps[0].awakeMinutes).toBeNull();
  expect(archive.data.sleeps[0].quality).toBeUndefined();
  expect(archive.data.sleeps[0].note).toBe('');
  const sleepSection = archive.data.summaries.find((item) => item.date === '2026-10-27' && item.source === 'local')!
    .markdown.split('## 睡眠')[1].split('## 今日关注')[0];
  expect(sleepSection).toContain('估算睡眠 8.0 小时');
  expect(sleepSection).not.toMatch(/未知|未填写|清醒|质量|备注/);
  expect(provider.responses()).toHaveLength(0);
  expect(errors).toEqual([]);
});

test('旧备份中清醒和质量留空的睡眠仍进入首页和趋势，未记录日期保持空白', async ({ page }) => {
  const errors = capturePortionErrors(page);
  await page.goto('/');
  const sleeps: SleepRecord[] = [23, 25, 27].map((day) => ({
    id: `legacy-sleep-${day}`, type: 'sleep', createdAt: noon,
    occurredAt: `2026-10-${day}T07:00:00+08:00`,
    fellAsleepAt: `2026-10-${day - 1}T23:30:00+08:00`, wokeAt: `2026-10-${day}T07:00:00+08:00`,
    awakeMinutes: null, note: '', timezone: 'Asia/Shanghai',
  }));
  await importPortionBackup(page, await createBackupArchive({ ...emptyData(), sleeps }, []));
  await expectSleepHome(page, '7.5');
  await page.getByRole('tab', { name: '趋势', exact: true }).click();
  await expect(page.getByText('估算睡眠（每日平均）', { exact: true })).toBeVisible();
  for (const day of [23, 25, 27]) {
    await expect(page.getByLabel(`2026-10-${day} 估算睡眠（每日平均）：7.5 小时`, { exact: true })).toBeVisible();
  }
  await expect(page.getByLabel('2026-10-24 估算睡眠（每日平均）：未记录', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '近 30 日', exact: true }).click();
  await expect(page.getByLabel('2026-10-27 估算睡眠（每日平均）：7.5 小时', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('手动饮食可只填热量或蛋白质，分别汇总并在重开和备份中保持其余空值', async ({ page }, info) => {
  const errors = capturePortionErrors(page);
  const provider = await installMockAiProvider(page);
  await page.goto('/');
  const labels = ['热量 kcal', '蛋白质 g', '碳水 g', '脂肪 g'];
  for (const [name, nutrientLabel, amount] of [
    ['只记录热量的午餐', labels[0], '350～450'],
    ['只记录蛋白质的加餐', labels[1], '20.5'],
  ]) {
    await page.getByRole('button', { name: '记饮食' }).click();
    await page.getByLabel('食物名称', { exact: true }).fill(name);
    await editPortionNutrition(page);
    await page.getByLabel(nutrientLabel, { exact: true }).fill(amount);
    await savePortionMeal(page);
  }
  const nutrition = page.getByTestId('today-nutrition');
  await expect(nutrition.getByText('400', { exact: true })).toBeVisible();
  await expect(page.getByTestId('today-nutrient-protein')).toContainText('20.5');
  await expect(page.getByTestId('today-nutrient-carbs')).toContainText('—');
  await expect(page.getByTestId('today-nutrient-fat')).toContainText('—');
  await page.reload();
  await reopenPortionMeal(page, '只记录热量的午餐');
  await editPortionNutrition(page);
  await expect(page.getByLabel(labels[0], { exact: true })).toHaveValue('350～450');
  for (const label of labels.slice(1)) await expect(page.getByLabel(label, { exact: true })).toHaveValue('');
  await savePortionMeal(page);
  await page.getByRole('tab', { name: '今天', exact: true }).click();
  await settleVisible(page.getByTestId('today-nutrient-protein'));
  await page.screenshot({ path: info.outputPath('partial-meal-nutrients.png'), fullPage: true });
  const { archive } = await exportPortionBackup(page);
  expect(archive.data.meals).toHaveLength(2);
  for (const meal of archive.data.meals) {
    expect(meal.estimate).toBeUndefined();
    const analysis = meal.analyses!.at(-1)!.analysis;
    expect(analysis.status).toBe('estimated');
    expect(analysis.nutritionSource?.provider).toBe('manual');
    expect(analysis.calories).toEqual(meal.foodName.includes('热量') ? { min: 350, max: 450 } : null);
    expect(analysis.protein).toEqual(meal.foodName.includes('蛋白质') ? { min: 20.5, max: 20.5 } : null);
    expect(analysis.carbs).toBeNull();
    expect(analysis.fat).toBeNull();
  }
  expect(provider.responses()).toHaveLength(0);
  expect(errors).toEqual([]);
});

test('仅有部分旧训练目标时仍可编辑保存实际训练，选填反馈不会使汇总不可用', async ({ page }) => {
  const errors = capturePortionErrors(page);
  const provider = await installMockAiProvider(page);
  await page.goto('/');
  const record: TrainingRecord = { id: 'partial-targets', type: 'training', createdAt: noon, occurredAt: noon,
    exercise: '仅填目标组数的旧训练', mode: 'strength', sets: [{ reps: 8, weight: 20, unit: 'kg' }],
    targetSets: 3, weightBasis: 'total', pain: 'unknown', controlled: 'unknown', rir: 'unknown', note: '' };
  await importPortionBackup(page, await createBackupArchive({ ...emptyData(), trainings: [record] }, []));
  await page.getByRole('tab', { name: '我的', exact: true }).click();
  await page.getByRole('button', { name: '全部记录', exact: true }).click();
  await page.getByText(record.exercise, { exact: true }).click();
  await page.getByLabel('动作1 每组次数', { exact: true }).fill('10');
  await saveForm(page);
  await page.getByRole('tab', { name: '今天', exact: true }).click();
  await expect(page.getByText('1 工作组', { exact: true })).toBeVisible();
  const { archive } = await exportPortionBackup(page);
  expect(archive.data.trainings).toHaveLength(1);
  const saved = archive.data.trainings[0];
  expect(saved.sets).toEqual([{ reps: 10, weight: 20, unit: 'kg', isWarmup: false }]);
  expect(saved.targetSets).toBe(3);
  for (const key of ['targetMin', 'targetMax', 'increment'] as const) expect(saved[key]).toBeUndefined();
  const summary = archive.data.summaries.find((value) => value.date === '2026-10-27' && value.source === 'local')!.markdown;
  expect(summary).toContain('工作组 20 kg × 10 次');
  expect(summary).not.toMatch(/疼痛：未填写|动作可控：未填写|最少剩余次数：未填写/);
  expect(provider.responses()).toHaveLength(0);
  expect(errors).toEqual([]);
});
