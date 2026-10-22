import { expect, test, type Page } from '@playwright/test';
import { createBackupArchive, parseBackupArchive } from '../src/backup';
import type { AppData } from '../src/types';

async function storedData(page: Page): Promise<AppData> {
  return page.evaluate(() => new Promise<AppData>((resolve, reject) => {
    const request = indexedDB.open('health-compass-local-v1', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction('snapshots', 'readonly');
      const value = transaction.objectStore('snapshots').get('@health-compass/data-v1');
      value.onerror = () => reject(value.error);
      value.onsuccess = () => resolve(JSON.parse(value.result).data);
      transaction.oncomplete = () => db.close();
    };
  }));
}

test('a whole workout with several exercises saves as one reusable template without copying actual reps or weight', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '记训练' }).click();
  await expect(page.getByText('本次训练', { exact: true })).toBeVisible();
  for (const removed of ['本次感受', '疼痛', '动作可控', '最少剩余次数'])
    await expect(page.getByText(removed, { exact: true })).toHaveCount(0);

  await page.getByLabel('训练名称', { exact: true }).fill('拉日');
  await page.getByRole('button', { name: '选择动作1', exact: true }).click();
  await page.getByLabel('动作1 名称', { exact: true }).fill('单臂划船');
  // The quick row fills every set at once; per-set values live behind 各组详情.
  await page.getByLabel('动作1 每组次数', { exact: true }).fill('10');
  await page.getByLabel('动作1 每组重量', { exact: true }).fill('20');
  await page.getByRole('button', { name: '动作1 减少一组', exact: true }).click();
  await expect(page.getByLabel('动作1 第1组次数', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '动作1 各组详情', exact: true }).click();
  await expect(page.getByLabel('动作1 第2组次数', { exact: true })).toHaveValue('10');
  await page.getByLabel('动作1 第2组次数', { exact: true }).fill('8');
  await page.getByLabel('动作1 第2组重量', { exact: true }).fill('22');
  await expect(page.getByLabel('动作1 每组次数', { exact: true })).toHaveValue('');

  await page.getByRole('button', { name: '添加动作', exact: true }).click();
  await page.getByRole('button', { name: '引体向上', exact: true }).click();
  await page.getByLabel('动作2 每组次数', { exact: true }).fill('6');
  await page.getByLabel('动作2 每组重量', { exact: true }).fill('0');
  await expect(page.getByText('2 个动作 · 5 组 · 36 次 · 376 kg', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '保存为模板', exact: true }).click();
  await expect(page.getByText('已保存“拉日”模板 · 2 个动作', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.getByRole('button', { name: '记训练' }).click();
  await page.getByRole('button', { name: '选择训练模板', exact: true }).click();
  await page.getByRole('button', { name: '使用模板 拉日', exact: true }).click();
  await expect(page.getByText('已带出“拉日”的 2 个动作', { exact: true })).toBeVisible();
  await expect(page.getByLabel('训练名称', { exact: true })).toHaveValue('拉日');
  await expect(page.getByLabel('动作1 共 2 组', { exact: true })).toBeVisible();
  await expect(page.getByLabel('动作2 共 3 组', { exact: true })).toBeVisible();
  await expect(page.getByLabel('动作1 每组次数', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('动作2 每组重量', { exact: true })).toHaveValue('');
  await page.getByLabel('动作1 每组次数', { exact: true }).fill('9');
  await page.getByLabel('动作1 每组重量', { exact: true }).fill('21');
  await page.getByLabel('动作2 每组次数', { exact: true }).fill('5');
  await page.getByLabel('动作2 每组重量', { exact: true }).fill('0');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  const data = await storedData(page);
  expect(data.workoutTemplates).toMatchObject([{ name: '拉日', exercises: [
    { name: '单臂划船', setCount: 2, weightUnit: 'kg', weightBasis: 'total' },
    { name: '引体向上', setCount: 3, weightUnit: 'kg', weightBasis: 'total' },
  ] }]);
  expect(data.trainings).toHaveLength(2);
  const latest = data.trainings.find((item) => item.sets[0]?.reps === 9)!;
  expect(latest).toMatchObject({
    exercise: '拉日',
    pain: 'unknown', controlled: 'unknown', rir: 'unknown',
    exercises: [
      { name: '单臂划船', sets: [{ reps: 9, weight: 21, unit: 'kg' }, { reps: 9, weight: 21, unit: 'kg' }] },
      { name: '引体向上', sets: [{ reps: 5, weight: 0 }, { reps: 5, weight: 0 }, { reps: 5, weight: 0 }] },
    ],
  });
  expect(latest.sets).toHaveLength(5);
  const archive = await createBackupArchive(data, []);
  const restored = await parseBackupArchive(archive);
  expect(restored.data.workoutTemplates).toEqual(data.workoutTemplates);
  expect(errors).toEqual([]);
});
