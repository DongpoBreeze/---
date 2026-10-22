import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { APPEARANCE_KEY } from '../src/appearance';
import { parseBackupArchive } from '../src/backup';
import { configureMockAi, fulfillProviderResponse, installMockAiProvider } from './helpers/mock-ai-provider';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a90sAAAAASUVORK5CYII=', 'base64');
const mealResponse = {
  components: [{ label: '熟米饭', cookingMethod: '蒸煮', confidence: 0.96,
    nutritionEstimate: { method: 'typical_recipe', confidence: 0.9,
      per100g: { calories: { min: 130, max: 150 }, protein: { min: 2, max: 3 },
        carbs: { min: 28, max: 33 }, fat: { min: 0.3, max: 1 } },
      recipeBasis: '按蒸熟米饭的常见含水量估算。', assumptions: ['未额外加油。'] }, uncertainty: [] }],
  uncertainty: [],
};

function luminance(css: string) {
  const channels = css.match(/[\d.]+/g)?.slice(0, 3).map(Number);
  if (!channels || channels.length !== 3) throw new Error(`无法读取颜色：${css}`);
  const linear = channels.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

async function expectScheme(page: Page, scheme: 'light' | 'dark') {
  await expect(page.locator('html')).toHaveCSS('color-scheme', scheme);
  const background = await page.locator('body').evaluate((element) => getComputedStyle(element).backgroundColor);
  if (scheme === 'dark') expect(luminance(background)).toBeLessThan(0.15);
  else expect(luminance(background)).toBeGreaterThan(0.7);
}

async function expectReadableInput(input: Locator, dark = true) {
  const colors = await input.evaluate((element) => {
    const style = getComputedStyle(element);
    return { foreground: style.color, background: style.backgroundColor };
  });
  const foreground = luminance(colors.foreground);
  const background = luminance(colors.background);
  expect((Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)).toBeGreaterThanOrEqual(4.5);
  if (dark) expect(background).toBeLessThan(0.15);
  else expect(background).toBeGreaterThan(0.7);
}

async function expectNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

async function closeSheet(page: Page) {
  await page.getByRole('dialog').getByLabel('关闭', { exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  page.on('dialog', (dialog) => { void dialog.accept(); });
});

test('暗色设置覆盖四个Tab和全部表单，手填营养保存且刷新后保留主题', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  await expect(page.getByRole('radio', { name: '跟随系统', exact: true })).toBeChecked();
  await page.getByRole('radio', { name: '暗色模式', exact: true }).click();
  await expect(page.getByRole('radio', { name: '暗色模式', exact: true })).toBeChecked();
  await expectScheme(page, 'dark');
  await page.screenshot({ path: info.outputPath('dark-settings.png'), fullPage: true });

  for (const tab of ['今天', '趋势', '我的']) {
    await page.getByRole('tab', { name: tab, exact: true }).click();
    await expectScheme(page, 'dark');
    await expectNoOverflow(page);
    const navigation = page.getByRole('tablist').filter({ has: page.getByRole('tab', { name: '我的', exact: true }) });
    expect(luminance(await navigation.evaluate((element) => getComputedStyle(element).backgroundColor))).toBeLessThan(0.15);
    await page.screenshot({ path: info.outputPath(`dark-${tab}.png`), fullPage: true });
  }
  await page.getByRole('tab', { name: '今天', exact: true }).click();
  await page.getByText('记饮食', { exact: true }).click();
  await page.getByLabel('食物名称', { exact: true }).fill('暗色手工餐');
  for (const [field, value] of [['热量 kcal', '650'], ['蛋白质 g', '40'], ['碳水 g', '80'], ['脂肪 g', '18']]) {
    const input = page.getByLabel(field, { exact: true });
    await input.fill(value);
    await expectReadableInput(input);
  }
  await expectNoOverflow(page);
  await page.getByText('营养值（可选）', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('dark-meal-form.png'), fullPage: true });
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  for (const entry of ['记训练', '记睡眠']) {
    await page.getByText(entry, { exact: true }).click();
    if (entry === '记训练') await expect(page.getByRole('button', { name: '选择训练模板' })).toBeVisible();
    else await expectReadableInput(page.getByLabel('入睡（YYYY-MM-DD HH:mm）', { exact: true }));
    await expectNoOverflow(page);
    await page.screenshot({ path: info.outputPath(`dark-${entry}-form.png`), fullPage: true });
    await closeSheet(page);
  }
  await page.getByRole('tab', { name: '我的', exact: true }).click();
  await page.getByText('修改目标与资料', { exact: true }).click();
  await expectReadableInput(page.getByLabel('体重（kg，可选）', { exact: true }));
  await closeSheet(page);
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  await page.getByText('AI 服务设置', { exact: true }).click();
  await expectReadableInput(page.getByLabel('API 地址', { exact: true }));
  await expectReadableInput(page.getByLabel('API Key', { exact: true }));
  await closeSheet(page);

  await page.reload();
  await expectScheme(page, 'dark');
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  await expect(page.getByRole('radio', { name: '暗色模式', exact: true })).toBeChecked();
  await page.getByRole('tab', { name: '我的', exact: true }).click();
  await page.getByRole('button', { name: '全部记录', exact: true }).click();
  await page.getByText('暗色手工餐', { exact: true }).click();
  await expect(page.getByLabel('热量 kcal', { exact: true })).toHaveValue('650');
  await expect(page.getByLabel('蛋白质 g', { exact: true })).toHaveValue('40');
  await closeSheet(page);
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  await page.getByRole('radio', { name: '浅色模式', exact: true }).click();
  await expectScheme(page, 'light');
  await page.reload();
  await expectScheme(page, 'light');
  expect(errors).toEqual([]);
});

test('跟随系统即时切换并保留表单内容，固定浅色和暗色不受系统变化影响', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await expectScheme(page, 'light');
  await page.getByText('记饮食', { exact: true }).click();
  await page.getByLabel('食物名称', { exact: true }).fill('切换主题后保留');
  await page.getByLabel('热量 kcal', { exact: true }).fill('450～550');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectScheme(page, 'dark');
  await expect(page.getByLabel('食物名称', { exact: true })).toHaveValue('切换主题后保留');
  await expect(page.getByLabel('热量 kcal', { exact: true })).toHaveValue('450～550');
  await expectReadableInput(page.getByLabel('热量 kcal', { exact: true }));
  await page.screenshot({ path: info.outputPath('system-change-keeps-open-form.png'), fullPage: true });
  await closeSheet(page);
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  await page.getByRole('radio', { name: '浅色模式', exact: true }).click();
  await expectScheme(page, 'light');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectScheme(page, 'light');
  await page.getByRole('radio', { name: '暗色模式', exact: true }).click();
  await page.emulateMedia({ colorScheme: 'light' });
  await expectScheme(page, 'dark');
  await page.getByRole('radio', { name: '跟随系统', exact: true }).click();
  await expectScheme(page, 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectScheme(page, 'dark');
  await page.reload();
  await expectScheme(page, 'dark');
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  await expect(page.getByRole('radio', { name: '跟随系统', exact: true })).toBeChecked();
  await page.getByRole('tab', { name: '今天', exact: true }).click();
  await page.getByText('记饮食', { exact: true }).click();
  await expect(page.getByLabel('食物名称', { exact: true })).toHaveValue('切换主题后保留');
  await expect(page.getByLabel('热量 kcal', { exact: true })).toHaveValue('450～550');
  await expectNoOverflow(page);
  expect(errors).toEqual([]);
});

test('照片请求中切换系统主题不会取消分析，暗色识别页编辑确认和数量校正均可用', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let release: (() => Promise<void>) | undefined;
  const provider = await installMockAiProvider(page, { onResponse: async (route) => {
    release = () => fulfillProviderResponse(route, mealResponse);
  } });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await configureMockAi(page);
  await page.getByText('记饮食', { exact: true }).click();
  await page.getByLabel('食物名称', { exact: true }).fill('暗色识别测试');
  const chooser = page.waitForEvent('filechooser');
  await page.getByText('选择照片', { exact: true }).click();
  await (await chooser).setFiles({ name: 'appearance-meal.png', mimeType: 'image/png', buffer: png });
  await expect.poll(() => Boolean(release)).toBe(true);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectScheme(page, 'dark');
  await expect(page.getByLabel('食物名称', { exact: true })).toHaveValue('暗色识别测试');
  await release!();
  await expect(page.getByTestId('ai-meal-review')).toBeVisible();
  await expectReadableInput(page.getByLabel('菜品 1 名称', { exact: true }));
  await expectReadableInput(page.getByLabel('菜品 1 每100g热量下限', { exact: true }));
  await page.getByLabel('菜品 1 食用量', { exact: true }).fill('100');
  await expectNoOverflow(page);
  await page.screenshot({ path: info.outputPath('dark-ai-review.png'), fullPage: true });
  await page.getByRole('button', { name: '确认填入', exact: true }).click();
  await expect(page.getByLabel('热量 kcal', { exact: true })).toHaveValue('130～150');
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('tab', { name: '我的', exact: true }).click();
  await page.getByRole('button', { name: '全部记录', exact: true }).click();
  await page.getByText('熟米饭', { exact: true }).click();
  await page.getByRole('button', { name: '填写菜品数量', exact: true }).click();
  await expectReadableInput(page.getByLabel('菜品 1 食用量', { exact: true }));
  await page.getByLabel('菜品 1 食用量', { exact: true }).fill('200');
  await page.getByRole('button', { name: '保存营养校正', exact: true }).click();
  await expect(page.getByLabel('热量 kcal', { exact: true })).toHaveValue('260～300');
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByText('导出完整备份', { exact: true }).click();
  const backup = await parseBackupArchive(new Uint8Array(await readFile((await (await downloadPromise).path())!)));
  expect(backup.data.meals[0].analyses!.at(-1)!.analysis.calories).toEqual({ min: 260, max: 300 });
  expect(JSON.stringify(backup)).not.toContain(APPEARANCE_KEY);
  expect(provider.responses()).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('外观设置保存失败可见且保留旧选择，恢复存储后可以重新选择并持久化', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  await page.getByRole('radio', { name: '浅色模式', exact: true }).click();
  await expect(page.getByRole('radio', { name: '浅色模式', exact: true })).toBeChecked();
  await page.evaluate((key) => {
    const original = Storage.prototype.setItem;
    (window as any).__restoreAppearanceStorage = () => { Storage.prototype.setItem = original; };
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException('模拟外观设置存储不可用', 'QuotaExceededError');
      return original.call(this, name, value);
    };
  }, APPEARANCE_KEY);
  await page.getByRole('radio', { name: '暗色模式', exact: true }).click();
  await expect(page.getByText(/外观.*保存失败|保存外观.*失败/)).toBeVisible();
  await expect(page.getByRole('radio', { name: '浅色模式', exact: true })).toBeChecked();
  await expectScheme(page, 'light');
  await page.evaluate(() => (window as any).__restoreAppearanceStorage());
  await page.getByRole('radio', { name: '暗色模式', exact: true }).click();
  await expectScheme(page, 'dark');
  await page.reload();
  await expectScheme(page, 'dark');
  expect(errors).toEqual([]);
});

test('损坏的外观设置安全回落系统并提示，用户可以重新选择修复', async ({ page }) => {
  await page.addInitScript((key) => { localStorage.setItem(key, '{invalid-appearance'); }, APPEARANCE_KEY);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  await expect(page.getByRole('radio', { name: '跟随系统', exact: true })).toBeChecked();
  await expectScheme(page, 'dark');
  await expect(page.getByText(/已保存的外观设置无效/)).toBeVisible();
  await page.getByRole('radio', { name: '浅色模式', exact: true }).click();
  await expectScheme(page, 'light');
  await expect(page.getByText(/已保存的外观设置无效/)).toHaveCount(0);
  await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), APPEARANCE_KEY))
    .toEqual({ version: 1, mode: 'light' });
});
