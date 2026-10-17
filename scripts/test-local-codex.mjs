import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { syntheticImage } from './synthetic-image.mjs';

if (!process.argv.includes('--live')) {
  console.error('This uses the real provider. Run with --live to send synthetic requests.');
  process.exit(1);
}

async function syntheticJpeg() {
  const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, args: ['--no-proxy-server'] });
  try {
    const page = await browser.newPage();
    return await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 1200; canvas.height = 900;
      const context = canvas.getContext('2d');
      context.fillStyle = '#b4b4b4'; context.fillRect(0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.75);
    });
  } finally { await browser.close(); }
}

try {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const settings = JSON.parse(await readFile(join(root, 'server/data/local-codex.json'), 'utf8'));
  const installationId = `synthetic-${randomUUID()}`;
  const photo = process.argv.includes('--jpeg') ? await syntheticJpeg() : syntheticImage();
  const samples = [
    { kind: 'summary', payload: { date: '2026-10-10', profile: {}, summary: '纯测试的虚构记录：早餐燕麦，份量未记录；训练和睡眠未记录。不是任何用户的健康数据。' } },
    { kind: 'meal', payload: { foodName: '', mealType: '午餐', portion: '未知', remaining: '未知', note: '纯测试：合成灰色图片，非食物，不是用户的照片。', photos: [photo], photoRoles: ['before'], profile: {} } },
  ].filter((sample) => !process.argv.includes('--meal-only') || sample.kind === 'meal');
  const results = [];
  for (const sample of samples) {
    const requestId = `synthetic-${randomUUID()}`;
    const started = Date.now();
    try {
      const response = await fetch('http://127.0.0.1:8787/api/analyze', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.accessToken}` },
        body: JSON.stringify({ requestId, installationId, ...sample }), signal: AbortSignal.timeout(60_000),
      });
      const body = await response.json();
      const passed = response.ok && body.model === 'gpt-6.1-sol' && (sample.kind === 'summary'
        ? typeof body.analysis?.text === 'string' && body.analysis.text.length > 0
        : body.analysis?.status === 'unknown' && ['calories', 'protein', 'carbs', 'fat'].every((key) => body.analysis[key] === null));
      const result = { kind: sample.kind, status: response.status, passed, elapsedMs: Date.now() - started, model: body.model ?? null,
        errorCode: body.error?.code ?? null, analysisStatus: body.analysis?.status ?? null };
      results.push(result);
      console.log(JSON.stringify(result));
    } catch {
      const result = { kind: sample.kind, passed: false, elapsedMs: Date.now() - started, errorCode: 'transport_or_timeout' };
      results.push(result); console.log(JSON.stringify(result));
    }
  }
  await mkdir(join(root, 'artifacts'), { recursive: true });
  const reportName = process.argv.includes('--jpeg') ? 'local-codex-jpeg-test.json' : process.argv.includes('--meal-only') ? 'local-codex-image-diagnostic.json' : 'local-codex-live-test.json';
  await writeFile(join(root, 'artifacts', reportName), `${JSON.stringify({ testedAt: new Date().toISOString(), model: 'gpt-6.1-sol', reasoningEffort: 'max', syntheticOnly: true, automaticRetries: 0, results }, null, 2)}\n`);
  if (results.some((result) => !result.passed)) process.exitCode = 1;
} catch {
  console.error('Cannot run the local synthetic test. Check local gateway setup.');
  process.exitCode = 1;
}
