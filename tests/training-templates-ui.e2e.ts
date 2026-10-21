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

test('strength actions can be selected and saved as reusable templates without copying actual reps or weight', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '记训练' }).click();
  await expect(page.getByText('本次训练完成', { exact: true })).toBeVisible();
  await expect(page.getByText('次数 × 重量 × 组数', { exact: true })).toBeVisible();
  for (const removed of ['本次感受', '疼痛', '动作可控', '最少剩余次数'])
    await expect(page.getByText(removed, { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: '选择动作模板' }).click();
  await page.getByRole('button', { name: '自定义动作', exact: true }).click();
  await page.getByLabel('自定义动作名称', { exact: true }).fill('单臂划船');
  await page.getByLabel('第1组次数', { exact: true }).fill('10');
  await page.getByLabel('第1组重量', { exact: true }).fill('20');
  const addSet = page.getByRole('button', { name: /添加一组/ });
  await addSet.scrollIntoViewIfNeeded();
  await addSet.click();
  await page.getByLabel('第2组次数', { exact: true }).fill('8');
  await page.getByLabel('第2组重量', { exact: true }).fill('22');
  await page.getByRole('button', { name: '保存为模板', exact: true }).click();
  await expect(page.getByText('已保存“单臂划船”模板', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: '选择动作模板' }).click();
  await page.getByRole('button', { name: '单臂划船', exact: true }).click();
  await expect(page.getByLabel('第1组次数', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('第1组重量', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('第2组次数', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('第2组重量', { exact: true })).toHaveValue('');

  await page.getByLabel('第1组次数', { exact: true }).fill('9');
  await page.getByLabel('第1组重量', { exact: true }).fill('21');
  await page.getByLabel('第2组次数', { exact: true }).fill('8');
  await page.getByLabel('第2组重量', { exact: true }).fill('22');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  const data = await storedData(page);
  expect(data.exerciseTemplates).toMatchObject([{ name: '单臂划船', setCount: 2, weightUnit: 'kg', weightBasis: 'total' }]);
  expect(data.trainings[0]).toMatchObject({
    exercise: '单臂划船',
    pain: 'unknown', controlled: 'unknown', rir: 'unknown',
    sets: [
      { reps: 9, weight: 21, unit: 'kg' },
      { reps: 8, weight: 22, unit: 'kg' },
    ],
  });
  const archive = await createBackupArchive(data, []);
  const restored = await parseBackupArchive(archive);
  expect(restored.data.exerciseTemplates).toEqual(data.exerciseTemplates);
  expect(errors).toEqual([]);
});
