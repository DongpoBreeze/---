import { expect, test, type Page } from '@playwright/test';

async function openSleep(page: Page) {
  await page.clock.setFixedTime(new Date('2026-10-21T09:00:00+08:00'));
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '记睡眠' }).click();
  await expect(page.getByTestId('sleep-timeline')).toBeVisible();
}

async function storedSleeps(page: Page) {
  return page.evaluate(() => new Promise<any[]>((resolve, reject) => {
    const request = indexedDB.open('health-compass-local-v1', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction('snapshots', 'readonly');
      const value = transaction.objectStore('snapshots').get('@health-compass/data-v1');
      value.onerror = () => reject(value.error);
      value.onsuccess = () => resolve(JSON.parse(value.result).data.sleeps);
      transaction.oncomplete = () => db.close();
    };
  }));
}

async function pointHandle(page: Page, handle: string, ratio: number) {
  const track = page.getByTestId('sleep-range-track');
  const box = await track.boundingBox();
  if (!box) throw new Error('睡眠滑块轨道未布局');
  await page.getByTestId(handle).hover({ position: { x: 22, y: 22 } });
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * ratio, box.y + 22, { steps: 8 });
  await page.mouse.up();
}

test('sleep slider controls both endpoints, updates local times and saves without typing', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openSleep(page);
  const fell = page.getByLabel('入睡（YYYY-MM-DD HH:mm）', { exact: true });
  const woke = page.getByLabel('起床（YYYY-MM-DD HH:mm）', { exact: true });
  await expect(fell).toHaveValue('');
  await expect(woke).toHaveValue('');

  await expect(page.getByTestId('sleep-timeline').getByText('21:00', { exact: true })).toBeVisible();
  await expect(page.getByTestId('sleep-timeline').getByText('09:00', { exact: true })).toBeVisible();
  await pointHandle(page, 'sleep-fell-slider', 3 / 18);
  await expect(fell).toHaveValue('2026-10-20 21:00');
  await pointHandle(page, 'sleep-woke-slider', 15 / 18);
  await expect(woke).toHaveValue('2026-10-21 09:00');
  await expect(page.getByTestId('sleep-duration')).toHaveText('12.0 小时');
  await page.getByTestId('sleep-fell-slider').focus();
  await page.keyboard.press('ArrowRight');
  await expect(fell).toHaveValue('2026-10-20 21:05');
  await page.keyboard.press('ArrowLeft');
  await expect(fell).toHaveValue('2026-10-20 21:00');

  const fellValue = await fell.inputValue();
  await page.getByRole('button', { name: '选择入睡时间' }).click();
  await expect(page.getByTestId('date-time-picker')).toBeVisible();
  const formattedNext = '2026-10-21';
  await page.getByRole('button', { name: `选择日期 ${formattedNext}`, exact: true }).click();
  await page.getByRole('button', { name: '小时 22', exact: true }).click();
  await page.getByRole('button', { name: '分钟 15', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('time-picker.png') });
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(fell).toHaveValue(fellValue);

  await page.getByRole('button', { name: '选择入睡时间' }).click();
  await page.getByRole('button', { name: `选择日期 ${formattedNext}`, exact: true }).click();
  await page.getByRole('button', { name: '小时 22', exact: true }).click();
  await page.getByRole('button', { name: '分钟 15', exact: true }).click();
  await page.getByRole('button', { name: '确定时间', exact: true }).click();
  await expect(fell).toHaveValue(`${formattedNext} 22:15`);
  await expect(page.getByTestId('sleep-fell-slider')).toHaveAttribute('aria-valuetext', `${formattedNext} 22:15`);

  const formattedWokeDate = '2026-10-22';
  await page.getByRole('button', { name: '选择起床时间' }).click();
  await page.getByRole('button', { name: `选择日期 ${formattedWokeDate}`, exact: true }).click();
  await page.getByRole('button', { name: '确定时间', exact: true }).click();
  await expect(woke).toHaveValue(`${formattedWokeDate} 09:00`);

  await page.getByLabel('清醒时长（分钟，可明确填 0）', { exact: true }).fill('');
  await expect(page.getByText('主观质量（可选）', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const records = await storedSleeps(page);
  expect(records).toHaveLength(1);
  expect(new Date(records[0].fellAsleepAt).getTime()).toBe(new Date(`${formattedNext}T22:15:00`).getTime());
  expect(new Date(records[0].wokeAt).getTime()).toBe(new Date(`${formattedWokeDate}T09:00:00`).getTime());
  expect(records[0].awakeMinutes).toBeNull();
  expect(records[0].quality).toBeUndefined();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: '我的', exact: true }).click();
  await page.getByRole('button', { name: '全部记录', exact: true }).click();
  await page.getByText('10.8 小时估算睡眠', { exact: true }).click();
  await expect(fell).toHaveValue(`${formattedNext} 22:15`);
  await expect(woke).toHaveValue(`${formattedWokeDate} 09:00`);
  await expect(page.getByTestId('sleep-duration')).toHaveText('10.8 小时');
  await expect(page.getByText('主观质量（可选）', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  expect(errors).toEqual([]);
});

test('invalid dates show no misleading duration, keep sliders disabled, and can be corrected with the picker', async ({ page }) => {
  await openSleep(page);
  const fell = page.getByLabel('入睡（YYYY-MM-DD HH:mm）', { exact: true });
  const woke = page.getByLabel('起床（YYYY-MM-DD HH:mm）', { exact: true });
  await fell.fill('2026-10-21 23:30');
  await woke.fill('2026-10-21 07:00');
  await expect(page.getByTestId('sleep-duration')).toHaveText('待填写');
  await expect(page.getByText('当前时间区间无效', { exact: false })).toBeVisible();
  await expect(page.getByTestId('sleep-fell-slider')).toHaveAttribute('tabindex', '-1');
  await expect(page.getByTestId('sleep-fell-slider')).toHaveAttribute('aria-disabled', 'true');
  await expect(fell).toBeEnabled();
  await expect(woke).toBeEnabled();
  await page.getByRole('button', { name: '选择入睡时间' }).click();
  await expect(page.getByTestId('date-time-picker')).toBeVisible();
  await page.getByRole('button', { name: '选择日期 2026-10-20', exact: true }).click();
  await page.getByRole('button', { name: '确定时间', exact: true }).click();
  await expect(fell).toHaveValue('2026-10-20 23:30');
  await expect(page.getByTestId('sleep-duration')).toHaveText('7.5 小时');
});
