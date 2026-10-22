import { expect, test, type Browser, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createBackupArchive, parseBackupArchive } from '../src/backup';
import { emptyData, type TrainingRecord } from '../src/types';

const originalUri = 'file:///training-original.webm';
const draftKey = 'training-training-video-regression';

function originalTraining(mode: 'strength' | 'cardio'): TrainingRecord {
  const now = new Date().toISOString();
  return {
    id: 'training-video-regression', type: 'training', createdAt: now, occurredAt: now,
    exercise: `${mode === 'strength' ? '力量' : '有氧'}视频草稿回归`, mode,
    sets: mode === 'strength' ? [{ reps: 10, weight: 20, unit: 'kg' }] : [],
    durationMinutes: mode === 'cardio' ? 20 : undefined,
    note: '', pain: 'unknown', controlled: 'unknown', rir: 'unknown', videoUri: originalUri,
  };
}

async function guardPage(page: Page, errors: string[]) {
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => { void dialog.accept(); });
  // These tests use only local media and backup operations. Block inference even
  // if an unrelated application change accidentally attempts a provider request.
  await page.route('**/*', async (route) => {
    if (/\/(?:responses|chat\/completions)(?:[/?]|$)/.test(new URL(route.request().url()).pathname)) {
      errors.push('Unexpected AI request during training video regression');
      await route.abort();
    } else await route.continue();
  });
}

async function video(page: Page, color: string): Promise<Buffer> {
  return Buffer.from(await page.evaluate(async (fill) => {
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90;
    const context = canvas.getContext('2d')!;
    const stream = canvas.captureStream(10);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => chunks.push(event.data);
    const finished = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });
    recorder.start();
    let frame = 0;
    const draw = setInterval(() => {
      context.fillStyle = fill; context.fillRect(0, 0, 160, 90);
      context.fillStyle = '#fff'; context.fillRect((frame++ * 8) % 130, 20, 25, 50);
    }, 100);
    await new Promise((resolve) => setTimeout(resolve, 500));
    recorder.stop(); await finished; clearInterval(draw);
    stream.getTracks().forEach((track) => track.stop());
    return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
  }, color));
}

async function importBackup(page: Page, bytes: Uint8Array) {
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  const restored = page.waitForEvent('dialog', { predicate: (dialog) => dialog.message().includes('恢复完成') });
  const choosing = page.waitForEvent('filechooser');
  await page.getByText('恢复备份', { exact: true }).click();
  await (await choosing).setFiles({ name: 'training-video.zip', mimeType: 'application/zip', buffer: Buffer.from(bytes) });
  await restored;
}

async function exportBackup(page: Page) {
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  const downloading = page.waitForEvent('download');
  await page.getByText('导出完整备份', { exact: true }).click();
  const download = await downloading;
  const bytes = new Uint8Array(await readFile((await download.path())!));
  return { bytes, archive: await parseBackupArchive(bytes) };
}

async function seed(page: Page, mode: 'strength' | 'cardio', drafts: Record<string, unknown> = {}) {
  const source = await video(page, '#16745e');
  const original = originalTraining(mode);
  const bytes = await createBackupArchive({ ...emptyData(), trainings: [original] }, [
    { uri: originalUri, kind: 'video', bytes: source, extension: 'webm', mimeType: 'video/webm' },
  ], undefined, { drafts });
  await importBackup(page, bytes);
  return { source, original };
}

async function openTraining(page: Page, original: TrainingRecord) {
  await page.getByRole('tab', { name: '我的', exact: true }).click();
  await page.getByRole('button', { name: '全部记录', exact: true }).click();
  await page.getByText(original.exercise, { exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('button', { name: '保存', exact: true })).toBeEnabled();
}

async function closeTraining(page: Page) {
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

async function saveTraining(page: Page) {
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

async function expectVideo(page: Page) {
  await expect(page.getByRole('button', { name: '移除训练视频', exact: true })).toBeVisible();
  await expect.poll(() => page.locator('video').evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(2);
}

async function expectNoVideo(page: Page) {
  await expect(page.getByRole('button', { name: '移除训练视频', exact: true })).toHaveCount(0);
  await expect(page.locator('video')).toHaveCount(0);
  await expect(page.getByText('训练视频（可选）', { exact: true })).toBeVisible();
}

async function inRestoredContext(browser: Browser, sourcePage: Page, bytes: Uint8Array, errors: string[], check: (page: Page) => Promise<void>) {
  const context = await browser.newContext({ viewport: sourcePage.viewportSize(), locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  try {
    const restored = await context.newPage();
    await guardPage(restored, errors);
    await restored.goto(sourcePage.url());
    await importBackup(restored, bytes);
    await check(restored);
  } finally { await context.close(); }
}

test.beforeEach(() => { test.setTimeout(120_000); });

for (const mode of ['strength', 'cardio'] as const) {
  test(`${mode} 视频删除草稿在关闭、刷新和备份恢复后生效，保存后清除正式视频`, async ({ page, browser }) => {
    const errors: string[] = []; await guardPage(page, errors); await page.goto('/');
    const { source, original } = await seed(page, mode);
    await openTraining(page, original); await expectVideo(page);
    await page.getByRole('button', { name: '移除训练视频', exact: true }).click();
    await expectNoVideo(page); await closeTraining(page);
    await openTraining(page, original); await expectNoVideo(page); await closeTraining(page);
    await page.reload();
    await openTraining(page, original); await expectNoVideo(page); await closeTraining(page);

    const { bytes, archive } = await exportBackup(page);
    expect((archive.drafts[draftKey] as { videoUri: string }).videoUri).toBe('');
    expect(archive.data.trainings[0].videoUri).toBeTruthy();
    expect(archive.media).toHaveLength(1);
    expect(Buffer.from(archive.media[0].bytes)).toEqual(source);

    await inRestoredContext(browser, page, bytes, errors, async (restored) => {
      await openTraining(restored, original); await expectNoVideo(restored);
      await saveTraining(restored);
      const saved = (await exportBackup(restored)).archive;
      expect(saved.data.trainings[0].videoUri).toBeUndefined();
      expect(Object.hasOwn(saved.data.trainings[0], 'videoUri')).toBe(false);
      expect(saved.drafts[draftKey]).toBeUndefined(); expect(saved.media).toHaveLength(0);
      await restored.reload();
      await openTraining(restored, original); await expectNoVideo(restored); await closeTraining(restored);
    });
    expect(errors).toEqual([]);
  });
}

test('替换视频的草稿恢复新来源，保存前原始记录与原始视频仍可备份', async ({ page, browser }) => {
  const errors: string[] = []; await guardPage(page, errors); await page.goto('/');
  const { source, original } = await seed(page, 'strength');
  const replacement = await video(page, '#375bb5');
  await openTraining(page, original);
  await page.getByRole('button', { name: '移除训练视频', exact: true }).click();
  const choosing = page.waitForEvent('filechooser');
  await page.getByRole('dialog').getByText('添加', { exact: true }).click();
  await (await choosing).setFiles({ name: 'replacement.webm', mimeType: 'video/webm', buffer: replacement });
  await expectVideo(page); await closeTraining(page);
  await page.reload();
  await openTraining(page, original); await expectVideo(page); await closeTraining(page);
  const { bytes, archive } = await exportBackup(page);
  const savedUri = archive.data.trainings[0].videoUri!;
  const replacementPath = (archive.drafts[draftKey] as { videoUri: string }).videoUri;
  expect(replacementPath).not.toBe(savedUri); expect(archive.media).toHaveLength(2);
  expect(Buffer.from(archive.media.find((item) => item.path === savedUri)!.bytes)).toEqual(source);
  expect(Buffer.from(archive.media.find((item) => item.path === replacementPath)!.bytes)).toEqual(replacement);

  await inRestoredContext(browser, page, bytes, errors, async (restored) => {
    await openTraining(restored, original); await expectVideo(restored); await saveTraining(restored);
    const saved = (await exportBackup(restored)).archive;
    expect(saved.media).toHaveLength(1);
    expect(Buffer.from(saved.media.find((item) => item.path === saved.data.trainings[0].videoUri)!.bytes)).toEqual(replacement);
    expect(saved.drafts[draftKey]).toBeUndefined();
  });
  expect(errors).toEqual([]);
});

test('旧草稿没有视频字段时继续继承原视频并保留备注', async ({ page }) => {
  const errors: string[] = []; await guardPage(page, errors); await page.goto('/');
  const { source, original } = await seed(page, 'cardio', { [draftKey]: { note: '旧草稿中的备注' } });
  await openTraining(page, original); await expectVideo(page);
  await expect(page.getByLabel('备注（可选）', { exact: true })).toHaveValue('旧草稿中的备注');
  await saveTraining(page);
  const { archive } = await exportBackup(page);
  expect(archive.data.trainings[0].note).toBe('旧草稿中的备注');
  expect(archive.data.trainings[0].videoUri).toBeTruthy();
  expect(archive.media).toHaveLength(1); expect(Buffer.from(archive.media[0].bytes)).toEqual(source);
  expect(errors).toEqual([]);
});
