import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createBackupArchive, parseBackupArchive } from '../src/backup';
import { emptyData, type MealRecord } from '../src/types';
import {
  configureMockAi, fulfillProviderResponse, installMockAiProvider, mockNutritionEstimate,
} from './helpers/mock-ai-provider';

const answer = {
  components: [{ label: '熟米饭', cookingMethod: '蒸煮', confidence: 0.98,
    nutritionEstimate: mockNutritionEstimate({ confidence: 0.95 }), uncertainty: [] }],
  uncertainty: [],
};

type Photo = { name: string; mimeType: string; buffer: Buffer };

function captureErrors(page: Page, errors: string[] = []) {
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  return errors;
}

async function photos(page: Page, count: number): Promise<Photo[]> {
  const urls = await page.evaluate((length) => Array.from({ length }, (_, index) => {
    const canvas = document.createElement('canvas');
    canvas.width = 80;
    canvas.height = 60;
    const context = canvas.getContext('2d')!;
    context.fillStyle = ['#b34d2d', '#4e8c4b', '#a2a5c1', '#e5c662', '#433998'][index];
    context.fillRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  }), count);
  return urls.map((url, index) => ({ name: `angle-${index + 1}.png`, mimeType: 'image/png', buffer: Buffer.from(url.split(',')[1], 'base64') }));
}

async function pick(page: Page, label: string, selected: Photo[]) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByText(label, { exact: true }).click();
  await (await chooser).setFiles(selected);
}

async function confirmReview(page: Page) {
  await expect(page.getByTestId('ai-meal-review')).toBeVisible();
  await page.getByRole('button', { name: '确认填入', exact: true }).click();
  await expect(page.getByTestId('ai-meal-review')).toHaveCount(0);
}

async function saveMeal(page: Page) {
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

async function openSavedMeal(page: Page, name: string) {
  await page.getByRole('tab', { name: '我的', exact: true }).click();
  await page.getByRole('button', { name: '全部记录', exact: true }).click();
  await page.getByText(name, { exact: true }).click();
  await expect(page.getByLabel('食物名称', { exact: true })).toHaveValue(name);
}

async function exportBackup(page: Page) {
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  const downloading = page.waitForEvent('download');
  await page.getByText('导出完整备份', { exact: true }).click();
  const download = await downloading;
  const bytes = new Uint8Array(await readFile((await download.path())!));
  return { bytes, archive: await parseBackupArchive(bytes) };
}

async function importBackup(page: Page, bytes: Uint8Array) {
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  const restored = page.waitForEvent('dialog', { predicate: (dialog) => dialog.message().includes('恢复完成') });
  const chooser = page.waitForEvent('filechooser');
  await page.getByText('恢复备份', { exact: true }).click();
  await (await chooser).setFiles({ name: 'meal-photos.zip', mimeType: 'application/zip', buffer: Buffer.from(bytes) });
  await restored;
}

test.beforeEach(async ({ page }) => {
  test.setTimeout(120_000);
  page.on('dialog', (dialog) => { void dialog.accept(); });
});

test('餐前照片可追加多选并一起识别，删除首图后保存重开及备份恢复保留全部视角', async ({ page, browser }, info) => {
  const errors = captureErrors(page);
  const provider = await installMockAiProvider(page, { onResponse: async (route) => fulfillProviderResponse(route, answer) });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  const input = await photos(page, 3);
  await configureMockAi(page);
  await page.getByText('记饮食', { exact: true }).click();
  await page.getByLabel('食物名称', { exact: true }).fill('多角度午餐');
  await pick(page, '选择照片', [input[0]]);
  await confirmReview(page);
  await expect(page.getByRole('button', { name: '添加餐后照片', exact: true })).toHaveCount(0);
  await pick(page, '添加餐前照片', input.slice(1));
  await expect(page.getByTestId('ai-meal-review')).toBeVisible();
  await expect(page.getByTestId('review-dish-1')).toBeVisible();
  await expect(page.getByTestId('review-dish-2')).toHaveCount(0);
  await confirmReview(page);
  await expect(page.getByRole('button', { name: /^移除餐前照片/ })).toHaveCount(3);
  await page.getByLabel('食物名称', { exact: true }).fill('多角度午餐');
  expect(provider.responses()).toHaveLength(2);
  expect(provider.responses()[1].record?.data.photoRoles).toEqual(['before', 'before', 'before']);
  expect(provider.responses()[1].body?.input[0].content.filter((part: { type: string }) => part.type === 'input_image')).toHaveLength(3);
  await page.getByRole('button', { name: '移除餐前照片 1', exact: true }).click();
  await expect(page.getByRole('button', { name: /^移除餐前照片/ })).toHaveCount(2);
  await expect(page.getByTestId('meal-confirmation-summary')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('append-before-photos.png'), fullPage: true });
  await saveMeal(page);
  await page.reload();
  await openSavedMeal(page, '多角度午餐');
  await expect(page.getByRole('button', { name: /^移除餐前照片/ })).toHaveCount(2);
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  const { bytes, archive } = await exportBackup(page);
  const meal = archive.data.meals[0];
  expect(meal.beforeImageUris).toHaveLength(2);
  expect(meal.imageUri).toBe(meal.beforeImageUris![0]);
  expect(meal.afterImageUri).toBeUndefined();
  expect(archive.media).toHaveLength(2);
  const actualMedia = meal.beforeImageUris!.map((uri) => archive.media.find((item) => item.path === uri)!);
  expect(Buffer.from(actualMedia[0].bytes)).toEqual(input[1].buffer);
  expect(Buffer.from(actualMedia[1].bytes)).toEqual(input[2].buffer);

  const restoredContext = await browser.newContext({ viewport: page.viewportSize()!, locale: 'zh-CN', colorScheme: 'dark' });
  try {
    const restoredPage = await restoredContext.newPage();
    restoredPage.on('dialog', (dialog) => { void dialog.accept(); });
    captureErrors(restoredPage, errors);
    await restoredPage.goto(page.url());
    await importBackup(restoredPage, bytes);
    await openSavedMeal(restoredPage, '多角度午餐');
    await expect(restoredPage.getByRole('button', { name: /^移除餐前照片/ })).toHaveCount(2);
    await expect(restoredPage.getByRole('button', { name: '添加餐后照片', exact: true })).toHaveCount(0);
  } finally { await restoredContext.close(); }
  expect(errors).toEqual([]);
});

test('最多四张且超额不覆盖已有照片，草稿刷新恢复，删光后可手动保存', async ({ page }) => {
  const errors = captureErrors(page);
  await page.goto('/');
  const input = await photos(page, 5);
  await page.getByText('记饮食', { exact: true }).click();
  await pick(page, '选择照片', input);
  await expect(page.getByText('本餐还可添加 4 张照片，请重新选择。', { exact: true })).toBeVisible();
  await expect(page.getByTestId('meal-before-photos')).toHaveCount(0);
  await pick(page, '选择照片', input.slice(0, 4));
  await expect(page.getByRole('button', { name: /^移除餐前照片/ })).toHaveCount(4);
  await expect(page.getByRole('button', { name: '添加餐前照片', exact: true })).toBeDisabled();
  await expect(page.getByText('已达到每餐 4 张照片上限', { exact: true })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await page.reload();
  await page.getByText('记饮食', { exact: true }).click();
  await expect(page.getByRole('button', { name: /^移除餐前照片/ })).toHaveCount(4);
  while (await page.getByRole('button', { name: /^移除餐前照片/ }).count())
    await page.getByRole('button', { name: /^移除餐前照片/ }).first().click();
  await expect(page.getByText('选择照片', { exact: true })).toBeVisible();
  await page.getByLabel('食物名称', { exact: true }).fill('无图手动餐食');
  await saveMeal(page);
  const { archive } = await exportBackup(page);
  expect(archive.data.meals[0].imageUri).toBeUndefined();
  expect(archive.data.meals[0].beforeImageUris ?? []).toEqual([]);
  expect(archive.media).toHaveLength(0);
  expect(errors).toEqual([]);
});

test('追加和删除会取消旧分析，迟到响应不打开确认页或覆盖手填内容', async ({ page }) => {
  const errors = captureErrors(page);
  const finishes: Array<() => Promise<void>> = [];
  const provider = await installMockAiProvider(page, { onResponse: async (route) => {
    finishes.push(() => fulfillProviderResponse(route, answer));
    if (finishes.length === 3) await finishes[2]();
  } });
  await page.goto('/');
  const input = await photos(page, 2);
  await configureMockAi(page);
  await page.getByText('记饮食', { exact: true }).click();
  await page.getByLabel('食物名称', { exact: true }).fill('保留手填餐名');
  await pick(page, '选择照片', [input[0]]);
  await expect.poll(() => provider.responses().length).toBe(1);
  await pick(page, '添加餐前照片', [input[1]]);
  await expect.poll(() => provider.responses().length).toBe(2);
  await finishes[0]().catch(() => undefined); // An aborted request may reject fulfillment.
  await expect(page.getByRole('button', { name: /^移除餐前照片/ })).toHaveCount(2);
  await page.getByRole('button', { name: '移除餐前照片 1', exact: true }).click();
  await finishes[1]().catch(() => undefined);
  await expect(page.getByTestId('analysis-wait-time')).toHaveCount(0);
  await expect(page.getByTestId('ai-meal-review')).toHaveCount(0);
  await expect(page.getByLabel('食物名称', { exact: true })).toHaveValue('保留手填餐名');
  await expect(page.getByRole('button', { name: '移除餐前照片', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '重新识别照片', exact: true }).click();
  await confirmReview(page);
  expect(provider.responses()).toHaveLength(3);
  expect(provider.responses()[2].record?.data.photoRoles).toEqual(['before']);
  // Explicit confirmation syncs the dish name (product spec F-08); only the late responses above must not.
  await expect(page.getByLabel('食物名称', { exact: true })).toHaveValue('熟米饭');
  expect(errors).toEqual([]);
});

test('已保存餐食删光照片后草稿刷新不会恢复旧首图，保存仍保留原始修订媒体', async ({ page }) => {
  const errors = captureErrors(page);
  await page.goto('/');
  const input = await photos(page, 1);
  await page.getByText('记饮食', { exact: true }).click();
  await page.getByLabel('食物名称', { exact: true }).fill('清空照片回归餐');
  await pick(page, '选择照片', input);
  await expect(page.getByRole('button', { name: '移除餐前照片', exact: true })).toBeVisible();
  await saveMeal(page);
  await openSavedMeal(page, '清空照片回归餐');
  await page.getByRole('button', { name: '移除餐前照片', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await page.reload();
  await openSavedMeal(page, '清空照片回归餐');
  await expect(page.getByRole('button', { name: /^移除餐前照片/ })).toHaveCount(0);
  await expect(page.getByText('选择照片', { exact: true })).toBeVisible();
  await saveMeal(page);
  const { archive } = await exportBackup(page);
  const saved = archive.data.meals[0];
  expect(saved.imageUri).toBeUndefined();
  expect(saved.beforeImageUris ?? []).toEqual([]);
  expect(saved.revisions!.some((revision) => Boolean(revision.imageUri))).toBe(true);
  expect(archive.media).toHaveLength(1);
  expect(Buffer.from(archive.media[0].bytes)).toEqual(input[0].buffer);
  expect(errors).toEqual([]);
});

test('旧餐后照片保留查看和备份，不再提供新增入口，仍可追加餐前照片', async ({ page }) => {
  const errors = captureErrors(page);
  await page.goto('/');
  const input = await photos(page, 3);
  const now = new Date().toISOString();
  const legacy: MealRecord = {
    id: 'legacy-two-photos', type: 'meal', createdAt: now, occurredAt: now, mealType: '午餐',
    foodName: '旧双照片餐食', portion: '', note: '', source: 'photo', estimateStatus: 'unknown',
    imageUri: 'file:///legacy-before.png', afterImageUri: 'file:///legacy-after.png',
  };
  const bytes = await createBackupArchive({ ...emptyData(), meals: [legacy] }, [
    { uri: legacy.imageUri!, kind: 'image', bytes: input[0].buffer, mimeType: 'image/png', extension: 'png' },
    { uri: legacy.afterImageUri!, kind: 'image', bytes: input[1].buffer, mimeType: 'image/png', extension: 'png' },
  ]);
  await importBackup(page, bytes);
  await openSavedMeal(page, legacy.foodName);
  await expect(page.getByText('餐后照片', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '添加餐后照片', exact: true })).toHaveCount(0);
  await pick(page, '添加餐前照片', [input[2]]);
  await expect(page.getByRole('button', { name: /^移除餐前照片/ })).toHaveCount(2);
  await expect(page.getByText('餐后照片', { exact: true })).toBeVisible();
  await saveMeal(page);
  const { archive } = await exportBackup(page);
  expect(archive.data.meals[0].beforeImageUris).toHaveLength(2);
  const after = archive.media.find((item) => item.path === archive.data.meals[0].afterImageUri)!;
  expect(Buffer.from(after.bytes)).toEqual(input[1].buffer);
  expect(errors).toEqual([]);
});
