import { expect, test, type Page } from '@playwright/test';
import { createBackupArchive } from '../src/backup';
import { emptyData, type TrainingRecord } from '../src/types';
import { fulfillProviderResponse, installMockAiProvider } from './helpers/mock-ai-provider';
import {
  capturePortionErrors, confirmPortionReview, expectPortionFormula, expectPortionNoOverflow,
  importPortionBackup, openPortionMeal, pointRanges, portionAnswer, portionQuantity,
  portionReview, savePortionMeal, setPortionProfile, uploadPortionPhoto,
} from './helpers/meal-estimated-portion';

test.use({ storageState: { cookies: [], origins: [] } });
test.beforeEach(async ({ page }) => {
  test.setTimeout(120_000);
  page.on('dialog', (dialog) => { void dialog.accept(); });
});

async function closeForm(page: Page) {
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

async function expectFreshTraining(page: Page) {
  await expect(page.getByLabel('训练名称', { exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: '选择动作1', exact: true })).toContainText('选择动作');
  await expect(page.getByLabel('动作1 每组次数', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('动作1 每组重量', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('备注（可选）', { exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: '选择动作2', exact: true })).toHaveCount(0);
}

test('新训练忽略旧备份草稿，力量和有氧未保存输入在重开及刷新后均不带入', async ({ page }, info) => {
  const errors = capturePortionErrors(page);
  const provider = await installMockAiProvider(page);
  await page.goto('/');
  const bytes = await createBackupArchive(emptyData(), [], undefined, { drafts: {
    'training-new': { exercise: '旧版未完成训练', note: '旧备注', mode: 'cardio', duration: '35' },
    'training-new-old-session': { exercise: '旧会话未完成训练', note: '不得恢复' },
  } });
  await importPortionBackup(page, bytes);
  await page.getByRole('tab', { name: '今天', exact: true }).click();
  await page.getByRole('button', { name: '记训练' }).click();
  await expectFreshTraining(page);
  await page.getByLabel('训练名称', { exact: true }).fill('本次未保存力量');
  await page.getByRole('button', { name: '选择动作1', exact: true }).click();
  await page.getByRole('button', { name: '卧推', exact: true }).click();
  await page.getByLabel('动作1 每组次数', { exact: true }).fill('8');
  await page.getByLabel('动作1 每组重量', { exact: true }).fill('40');
  await page.getByLabel('备注（可选）', { exact: true }).fill('未完成力量备注');
  await closeForm(page);
  await page.getByRole('button', { name: '记训练' }).click();
  await expectFreshTraining(page);
  await page.getByRole('button', { name: '有氧 / 其他', exact: true }).click();
  await page.getByLabel('运动名称', { exact: true }).fill('未保存慢跑');
  await page.getByLabel('时长（分钟）', { exact: true }).fill('30');
  await page.getByLabel('备注（可选）', { exact: true }).fill('未完成有氧备注');
  await closeForm(page);
  await page.reload();
  await page.getByRole('button', { name: '记训练' }).click();
  await expectFreshTraining(page);
  await page.screenshot({ path: info.outputPath('fresh-training-after-reload.png'), fullPage: true });
  expect(provider.responses()).toHaveLength(0);
  expect(errors).toEqual([]);
});

test('已保存训练仍恢复自身编辑草稿，新训练保持空白', async ({ page }) => {
  const errors = capturePortionErrors(page);
  const provider = await installMockAiProvider(page);
  await page.goto('/');
  const now = new Date().toISOString();
  const saved: TrainingRecord = {
    id: 'saved-fresh-training', type: 'training', createdAt: now, occurredAt: now,
    exercise: '已保存推日', mode: 'strength', sets: [{ reps: 10, weight: 20, unit: 'kg' }],
    note: '正式备注', pain: 'unknown', controlled: 'unknown', rir: 'unknown',
  };
  await importPortionBackup(page, await createBackupArchive({ ...emptyData(), trainings: [saved] }, []));
  const openSaved = async () => {
    await page.getByRole('tab', { name: '我的', exact: true }).click();
    await page.getByRole('button', { name: '全部记录', exact: true }).click();
    await page.getByText(saved.exercise, { exact: true }).click();
  };
  await openSaved();
  await expect(page.getByLabel('备注（可选）', { exact: true })).toHaveValue('正式备注');
  await page.getByLabel('备注（可选）', { exact: true }).fill('未保存的编辑备注');
  await closeForm(page);
  await page.getByRole('tab', { name: '今天', exact: true }).click();
  await page.getByRole('button', { name: '记训练' }).click();
  await expectFreshTraining(page);
  await closeForm(page);
  await page.reload();
  await openSaved();
  await expect(page.getByLabel('备注（可选）', { exact: true })).toHaveValue('未保存的编辑备注');
  await expect(page.getByLabel('动作1 每组次数', { exact: true })).toHaveValue('10');
  await expect(page.getByLabel('动作1 每组重量', { exact: true })).toHaveValue('20');
  expect(provider.responses()).toHaveLength(0);
  expect(errors).toEqual([]);
});

test('身高体重改变新餐建议量，显示正确依据且目标优先，用户可覆盖数量', async ({ page }, info) => {
  const errors = capturePortionErrors(page);
  const provider = await installMockAiProvider(page, {
    onResponse: async (route) => fulfillProviderResponse(route, portionAnswer),
  });
  await page.clock.setFixedTime(new Date('2026-10-27T04:00:00.000Z'));
  await openPortionMeal(page, { ageYears: 30, heightCm: 170, weightKg: 70 });
  await uploadPortionPhoto(page);
  await expect(portionQuantity(page)).toHaveValue('343');
  await expect(page.getByTestId('meal-portion-estimate')).toContainText('按你的身高与体重 70 kg');
  await expect(page.getByTestId('meal-portion-estimate')).not.toContainText('60 kg');
  await expectPortionNoOverflow(page);
  await page.screenshot({ path: info.outputPath('height-weight-portion.png'), fullPage: true });
  await page.getByRole('button', { name: '返回饮食', exact: true }).click();
  await closeForm(page);

  await setPortionProfile(page, { ageYears: 30, heightCm: 190, weightKg: 70 });
  await page.getByRole('button', { name: '记饮食' }).click();
  await uploadPortionPhoto(page);
  await expect(portionQuantity(page)).toHaveValue('368');
  await page.getByRole('button', { name: '返回饮食', exact: true }).click();
  await closeForm(page);

  await setPortionProfile(page, { ageYears: 30, heightCm: 170, weightKg: 70, calorieTarget: 2000 });
  await page.getByRole('button', { name: '记饮食' }).click();
  await uploadPortionPhoto(page);
  await expect(portionQuantity(page)).toHaveValue('350');
  await expect(page.getByTestId('meal-portion-estimate')).toContainText('按每日热量目标');
  await portionQuantity(page).fill('123');
  await confirmPortionReview(page);
  await expectPortionFormula(page, [{ grams: 123, per100g: pointRanges() }]);
  await savePortionMeal(page);
  expect(provider.responses()).toHaveLength(3);
  expect(provider.legacyRequests).toEqual([]);
  expect(errors).toEqual([]);
});
