import { expect, test } from '@playwright/test';

// Rows are keyed by a stable id, so removing a middle set keeps every other row's values in place.
test('removing a middle set keeps the remaining sets intact', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '记训练' }).click();
  await page.getByRole('button', { name: '选择动作1', exact: true }).click();
  await page.getByLabel('动作1 名称', { exact: true }).fill('深蹲');
  await page.getByRole('button', { name: '动作1 各组详情', exact: true }).click();
  for (const [index, reps] of ['5', '6', '7'].entries()) {
    await page.getByLabel(`动作1 第${index + 1}组次数`, { exact: true }).fill(reps);
    await page.getByLabel(`动作1 第${index + 1}组重量`, { exact: true }).fill(String(60 + index * 10));
  }
  await page.getByRole('button', { name: '动作1 删除第2组', exact: true }).click();

  await expect(page.getByLabel('动作1 共 2 组', { exact: true })).toBeVisible();
  await expect(page.getByLabel('动作1 第1组次数', { exact: true })).toHaveValue('5');
  await expect(page.getByLabel('动作1 第1组重量', { exact: true })).toHaveValue('60');
  await expect(page.getByLabel('动作1 第2组次数', { exact: true })).toHaveValue('7');
  await expect(page.getByLabel('动作1 第2组重量', { exact: true })).toHaveValue('80');
  await page.getByLabel('动作1 第2组次数', { exact: true }).fill('8');
  await expect(page.getByLabel('动作1 第1组次数', { exact: true })).toHaveValue('5');
  expect(errors).toEqual([]);
});
