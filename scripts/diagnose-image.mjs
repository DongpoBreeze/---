import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAppServer } from '../server/index.mjs';
import { prepareLocalCodex } from '../server/local-codex.mjs';
import { chromium } from '@playwright/test';
import { inflateSync } from 'node:zlib';
import { syntheticImage } from './synthetic-image.mjs';
import { modelRequest } from '../server/protocol.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const live = process.argv.includes('--live');
const selected = process.argv.find((value) => value.startsWith('--case='))?.slice(7) ?? 'legacy-png';
const width = Number(process.argv.find((value) => value.startsWith('--width='))?.slice(8) ?? 128);
const height = Number(process.argv.find((value) => value.startsWith('--height='))?.slice(9) ?? width);
const timeoutMs = Number(process.argv.find((value) => value.startsWith('--timeout-ms='))?.slice(13) ?? 55_000);
if (!['legacy-png', 'canvas-png', 'canvas-jpeg'].includes(selected) || !Number.isInteger(width) || !Number.isInteger(height)
  || width < 1 || height < 1 || width > 1200 || height > 1200) throw new Error('Invalid synthetic case or dimensions.');
if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) throw new Error('Invalid diagnostic timeout.');

const legacyImage = syntheticImage();

function inspectPng(bytes) {
  let offset = 8;
  const chunks = [];
  const data = [];
  let dimensions;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const content = bytes.subarray(offset + 4, offset + 8 + length);
    let crc = 0xffffffff;
    for (const byte of content) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const crcValid = bytes.readUInt32BE(offset + 8 + length) === ((crc ^ 0xffffffff) >>> 0);
    if (!crcValid) throw new Error(`Invalid PNG checksum: ${type}`);
    chunks.push({ type, length, crcValid });
    if (type === 'IHDR') dimensions = { width: bytes.readUInt32BE(offset + 8), height: bytes.readUInt32BE(offset + 12), bitDepth: bytes[offset + 16], colorType: bytes[offset + 17] };
    if (type === 'IDAT') data.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const pixels = inflateSync(Buffer.concat(data));
  return { ...dimensions, chunks, inflatedBytes: pixels.length, bytes: bytes.length };
}

const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, args: ['--no-proxy-server'] });
let images;
try {
  const page = await browser.newPage();
  images = await page.evaluate(async ({ legacyImage, width, height }) => {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    context.fillStyle = '#b4b4b4'; context.fillRect(0, 0, width, height);
    const legacy = new Image(); legacy.src = legacyImage; await legacy.decode();
    const decoded = document.createElement('canvas');
    decoded.width = legacy.naturalWidth; decoded.height = legacy.naturalHeight;
    decoded.getContext('2d').drawImage(legacy, 0, 0);
    const pixels = decoded.getContext('2d').getImageData(0, 0, decoded.width, decoded.height).data;
    return { png: canvas.toDataURL('image/png'), jpeg: canvas.toDataURL('image/jpeg', 0.75),
      legacy: { width: legacy.naturalWidth, height: legacy.naturalHeight, allGray: pixels.every((value, index) => value === (index % 4 === 3 ? 255 : 180)) } };
  }, { legacyImage, width, height });
} finally { await browser.close(); }

const photo = selected === 'legacy-png' ? legacyImage : selected === 'canvas-png' ? images.png : images.jpeg;
const report = { testedAt: new Date().toISOString(), syntheticOnly: true, automaticRetries: 0,
  case: selected, width: selected === 'legacy-png' ? 128 : width, height: selected === 'legacy-png' ? 128 : height,
  bytes: Buffer.from(photo.split(',')[1], 'base64').length,
  localValidation: { legacyPng: inspectPng(Buffer.from(legacyImage.split(',')[1], 'base64')), browserDecode: images.legacy } };

if (live) {
  const { config } = await prepareLocalCodex({ projectRoot: root });
  report.model = config.modelName; report.reasoningEffort = config.modelReasoningEffort;
  report.upstreamTimeoutMs = timeoutMs;
  const originalFetch = globalThis.fetch;
  // Detailed errors stay confined to this synthetic-only runner, never production logs or client responses.
  globalThis.fetch = async (...args) => {
    const response = await originalFetch(...args);
    if (String(args[0]) === config.modelApiUrl && !response.ok) {
      const reader = response.clone().body.getReader();
      const chunks = [];
      let size = 0;
      try {
        while (size < 8192) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(Buffer.from(value).subarray(0, 8192 - size));
          size += value.byteLength;
        }
      } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
      const text = Buffer.concat(chunks).toString('utf8');
      const redact = (value) => typeof value === 'string' ? value.split(config.modelApiKey).join('[credential]')
        .replace(/data:image\/[^;\s]+;base64,[A-Za-z0-9+/=]+/g, '[image data]')
        .replace(/https?:\/\/[^\s"<>]+/g, '[url]')
        .replace(/Bearer\s+[^\s"<>]+/gi, 'Bearer [credential]').slice(0, 2000) : null;
      let error;
      try { error = JSON.parse(text).error; } catch {}
      report.upstreamError = { status: response.status, code: redact(error?.code), type: redact(error?.type),
        param: redact(error?.param), message: redact(error?.message ?? text) };
    }
    return response;
  };
  const gateway = createAppServer({ config });
  // Allow a longer synthetic diagnostic without changing the app's 55-second configuration limit.
  gateway.config.upstreamTimeoutMs = timeoutMs;
  try {
    await new Promise((resolve, reject) => { gateway.server.once('error', reject); gateway.server.listen(0, '127.0.0.1', resolve); });
    const id = randomUUID();
    const input = { requestId: `image-diagnostic-${id}`, installationId: `synthetic-${id}`, kind: 'meal',
      payload: { foodName: '', mealType: '午餐', portion: '未知', remaining: '未知',
        note: '纯测试：合成灰色图片，非食物，不是用户的照片。', photos: [photo], photoRoles: ['before'], profile: {} } };
    report.jsonModeInputMarker = /json/i.test(modelRequest(input, config).input[0].content[0].text);
    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${gateway.server.address().port}/api/analyze`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.accessToken}` },
      body: JSON.stringify(input), signal: AbortSignal.timeout(timeoutMs + 5000),
    });
    const body = await response.json();
    report.result = { status: response.status, elapsedMs: Date.now() - started, model: body.model ?? null,
      errorCode: body.error?.code ?? null, analysis: body.analysis ?? null };
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise((resolve) => { gateway.server.close(resolve); gateway.server.closeAllConnections(); });
  }
}
await mkdir(join(root, 'artifacts'), { recursive: true });
const filename = `image-diagnostic-${selected}-${report.width}x${report.height}${live ? '-live' : '-local'}-${Date.now()}.json`;
await writeFile(join(root, 'artifacts', filename), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
