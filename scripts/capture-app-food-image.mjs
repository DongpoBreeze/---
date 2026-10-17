import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const imagePath = process.argv.find((arg) => arg.startsWith('--image='))?.slice(8)
  ?? 'C:/Users/14360/.codex/attachments/b1448d7b-6357-4c30-94a9-a8a9ebd08c21/image-1.png';
const original = await readFile(imagePath);
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined,
  args: ['--no-proxy-server'] });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('dialog', (dialog) => void dialog.accept());
  let captured;
  await page.route('**/api/analyze', async (route) => {
    if (captured) throw new Error('Unexpected additional analysis request.');
    captured = route.request().postDataJSON();
    await route.fulfill({ status: 503, contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'Offline image capture; no upstream request.' } }) });
  });
  await page.goto(process.env.TEST_BASE_URL ?? 'http://localhost:8084/');
  await page.getByText('记饮食', { exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByText('选择照片', { exact: true }).click();
  await (await chooser).setFiles({ name: 'reference-photo.jpg', mimeType: 'image/jpeg', buffer: original });
  await page.getByText('保存', { exact: true }).click();
  await page.getByLabel('食物名称', { exact: true }).waitFor({ state: 'hidden' });
  await page.getByRole('tab', { name: '记录', exact: true }).click();
  const response = page.waitForResponse('**/api/analyze');
  await page.getByLabel('请求饮食分析', { exact: true }).click();
  await response;
  if (!captured || captured.payload.photos.length !== 1) throw new Error('App did not produce one image.');
  const photo = captured.payload.photos[0];
  if (!photo.startsWith('data:image/jpeg;base64,')) throw new Error('Unexpected image format.');
  const bytes = Buffer.from(photo.slice(photo.indexOf(',') + 1), 'base64');
  const dimensions = await page.evaluate(async (source) => {
    const image = new Image(); image.src = source; await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight };
  }, photo);
  const { photos: _photos, ...payload } = captured.payload;
  const sha256 = (value) => createHash('sha256').update(value).digest('hex');
  const report = { capturedAt: new Date().toISOString(), originalPath: imagePath,
    original: { bytes: original.length, sha256: sha256(original) },
    outputPath: 'artifacts/real-food-app-copy.jpg',
    transmitted: { contentType: 'image/jpeg', bytes: bytes.length, dimensions, sha256: sha256(bytes) },
    transform: { method: 'App analyzeMeal / Expo ImageManipulator web', width: 1200, quality: 0.75,
      parity: 'actual-web-app', nativeParityVerified: false },
    payload, interceptedRequests: 1, realRequests: 0 };
  await mkdir('artifacts', { recursive: true });
  await writeFile(report.outputPath, bytes);
  await writeFile('artifacts/real-food-app-copy.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
