import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import JSZip from 'jszip';
import {
  BackupError,
  MAX_ENTRY_BYTES,
  canonicalJson,
  collectDraftMediaReferences,
  collectMediaReferences,
  createBackupArchive,
  mergeBackupData,
  mergeFormDrafts,
  parseBackupArchive,
  remapBackupMedia,
  remapDraftMedia,
  sha256Hex,
  validateAppData,
} from '../src/backup';
import { DATA_KEY, LocalRepository, parseLocalSnapshot } from '../src/local-store';
import { mealAnalysisSchema } from '../src/nutrition-schema';
import { emptyData, type AppData, type MealRecord } from '../src/types';

const now = '2026-10-10T03:00:00.000Z';
const imageA = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5]);
const imageB = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 8, 7, 6, 5]);
const video = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 4, 3, 2, 1]);
const media = [
  { uri: 'file:///original.jpg', kind: 'image' as const, bytes: imageA, extension: 'jpg', mimeType: 'image/jpeg' },
  { uri: 'file:///after.png', kind: 'image' as const, bytes: imageB, extension: 'png', mimeType: 'image/png' },
  { uri: 'file:///exercise.mp4', kind: 'video' as const, bytes: video, extension: 'mp4', mimeType: 'video/mp4' },
];

function fixture(): AppData {
  const meal: MealRecord = {
    id: 'meal-1', type: 'meal', createdAt: now, occurredAt: now, mealType: '午餐', foodName: 'rice, tofu', portion: 'one bowl', note: 'original\n"quoted"',
    imageUri: media[0].uri, afterImageUri: media[1].uri, remaining: 'one quarter', revision: 2, updatedAt: now, timezone: 'Asia/Shanghai', source: 'photo', estimateStatus: 'unknown',
    analyses: [{ id: 'analysis-1', model: 'mock/provider/model', createdAt: now, sourceVersion: 1, analysis: { status: 'estimated', confidence: 1, estimateScope: 'consumed_intake', coverage: { matched: 0, total: 0, unknownLabels: [] }, foodName: 'rice', calories: { min: 300, max: 450 }, protein: null, carbs: null, fat: null, assumptions: ['portion uncertain'], advice: 'check portion' } }],
  };
  const revision: Omit<MealRecord, 'revisions'> = { ...meal, revision: 1, afterImageUri: undefined, remaining: undefined };
  return {
    version: 1, profile: { goal: 'health', heightCm: 172, weightKg: 67 }, sourceVersion: 5,
    meals: [{ ...meal, revisions: [revision] }],
    trainings: [{ id: 'training-1', type: 'training', createdAt: now, occurredAt: now, exercise: 'squat', sets: [{ reps: 12, weight: 20, unit: 'kg', isWarmup: true }, { reps: 10, weight: 20, unit: 'lb' }], note: '', pain: 'no', controlled: 'yes', rir: '2', videoUri: media[2].uri, mode: 'strength', weightBasis: 'per-hand', targetSets: 1, targetMin: 8, targetMax: 12, increment: 2 }],
    sleeps: [{ id: 'sleep-1', type: 'sleep', createdAt: now, occurredAt: now, fellAsleepAt: '2026-10-09T23:30:00+08:00', wokeAt: '2026-10-10T07:00:00+08:00', awakeMinutes: null, quality: 4, note: 'unknown awake time' }],
    summaries: [{ id: 'local-2026-10-10', date: '2026-10-10', markdown: '# 2026-10-10\n\n## Diet\nText\n', sourceVersion: 5, status: 'current', source: 'local', createdAt: now }, { id: 'ai-1', date: '2026-10-10', markdown: '# AI\nSource retained\n', sourceVersion: 5, status: 'current', source: 'ai', model: 'mock/new-model', sourceRecordIds: ['meal-1', 'training-1', 'sleep-1'], createdAt: now }],
    drafts: { meal: { foodName: 'unfinished', imageUri: media[0].uri } },
  };
}

const formDrafts = { 'training-new': { exercise: 'unfinished workout', videoUri: media[2].uri, sets: '3' }, 'meal-meal-1': { imageUri: media[0].uri, portion: 'corrected later' } };

async function archive(): Promise<Uint8Array> {
  return createBackupArchive(fixture(), media, now, { drafts: formDrafts });
}

async function mutateArchive(change: (zip: JSZip, manifest: any) => Promise<void> | void): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(await archive());
  const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
  await change(zip, manifest);
  zip.file('manifest.json', JSON.stringify(manifest));
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

async function updateData(zip: JSZip, manifest: any, change: (data: any) => void): Promise<void> {
  const data = JSON.parse(await zip.file('data.json')!.async('string'));
  change(data);
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  zip.file('data.json', bytes);
  manifest.files['data.json'] = { byteLength: bytes.length, sha256: await sha256Hex(bytes) };
}

function isCode(...codes: string[]) {
  return (error: unknown) => error instanceof BackupError && codes.includes(error.code);
}

test('SHA-256 adapter matches Node crypto for binary and Unicode payloads', async () => {
  for (const bytes of [new Uint8Array(), imageA, new TextEncoder().encode('原始记录😀'), new Uint8Array(130_000).fill(191)]) {
    assert.equal(await sha256Hex(bytes), createHash('sha256').update(bytes).digest('hex'));
  }
});

test('byte-complete ZIP roundtrip retains records, revisions, sources, drafts, and readable outputs', async () => {
  const data = fixture();
  data.summaries[1].inputSnapshot = { date: '2026-10-10', profile: { goal: 'health', weightKg: 67 }, summary: '# Original AI input', recordVersions: [{ id: 'meal-1', version: '2' }] };
  const parsed = await parseBackupArchive(await createBackupArchive(data, media, now, { drafts: formDrafts }));
  assert.equal(parsed.media.length, 3);
  const replacements = new Map(parsed.media.map((item) => [item.path, media.find((input) => input.bytes[0] === item.bytes[0] && input.bytes.length === item.bytes.length)!.uri]));
  const restored = remapBackupMedia(parsed.data, replacements);
  assert.equal(canonicalJson(restored), canonicalJson(validateAppData(data)));
  assert.deepEqual(remapDraftMedia(parsed.drafts, replacements), formDrafts);
  for (const item of parsed.media) {
    const original = media.find((input) => input.uri === replacements.get(item.path))!;
    assert.deepEqual(item.bytes, original.bytes);
    assert.equal(item.sha256, createHash('sha256').update(original.bytes).digest('hex'));
  }
  const zip = await JSZip.loadAsync(await archive());
  for (const path of ['data.json', 'drafts.json', 'records.csv', 'meals.csv', 'trainings.csv', 'sleeps.csv', 'README.md', 'summaries/2026-10-10-1.md', 'summaries/2026-10-10-2.md']) assert.ok(zip.file(path), path);
  assert.match(await zip.file('records.csv')!.async('string'), /"rice, tofu"/);
  assert.equal(await zip.file('summaries/2026-10-10-2.md')!.async('string'), data.summaries[1].markdown);
  assert.ok(collectMediaReferences(restored).some((ref) => ref.kind === 'video'));
  assert.equal(collectDraftMediaReferences(parsed.drafts).length, 2);
});

test('nutrition provenance and component uncertainties round-trip without loss', async () => {
  const data = fixture();
  data.meals[0].analyses![0].analysis = {
    ...data.meals[0].analyses![0].analysis,
    status: 'unknown',
    calories: null,
    protein: null,
    carbs: null,
    fat: null,
    nutritionSource: { provider: 'usda-fdc', dataset: 'SR Legacy', calculatedAt: now, coverage: 'incomplete' },
    components: [{
      foodId: 'usda:123', label: '豆腐', grams: { min: 80, max: 120 }, eatenFraction: { min: 0.5, max: 1 },
      source: { provider: 'usda-fdc', fdcId: '123', dataset: 'SR Legacy' }, uncertainty: ['份量来自照片'],
    }],
    unresolved: ['油的重量未知'],
  };
  const parsed = await parseBackupArchive(await createBackupArchive(data, media, now));
  assert.deepEqual(parsed.data.meals[0].analyses![0].analysis, mealAnalysisSchema.parse(data.meals[0].analyses![0].analysis));
});

test('legacy meal analyses gain stable defaults while retaining recorded values', () => {
  const legacy = { status: 'estimated', foodName: '米饭', calories: { min: 120, max: 150 }, protein: null,
    carbs: null, fat: null, assumptions: ['旧版记录'], advice: '补充实际份量。' };
  assert.deepEqual(mealAnalysisSchema.parse(legacy), {
    ...legacy,
    confidence: 1,
    estimateScope: 'consumed_intake',
    coverage: { matched: 0, total: 0, unknownLabels: [] },
  });
});

test('shared original bytes are stored once while every record and revision is remapped', async () => {
  const data = fixture();
  data.meals[0].revisions![0].imageUri = 'file:///same-bytes-different-name.jpg';
  const parsed = await parseBackupArchive(await createBackupArchive(data, [...media, { ...media[0], uri: 'file:///same-bytes-different-name.jpg' }]));
  assert.equal(parsed.media.length, 3);
  assert.equal(parsed.data.meals[0].imageUri, parsed.data.meals[0].revisions![0].imageUri);
});

test('export rejects missing associated media instead of producing an incomplete backup', async () => {
  await assert.rejects(createBackupArchive(fixture(), media.slice(0, 2)), isCode('missing-media'));
});

test('import rejects missing files and undeclared record media', async () => {
  const missing = await mutateArchive((zip, manifest) => { zip.remove(manifest.media[0].path); });
  await assert.rejects(parseBackupArchive(missing), isCode('invalid-manifest', 'missing-media'));
  const badReference = await mutateArchive(async (zip, manifest) => updateData(zip, manifest, (data) => { data.meals[0].imageUri = 'media/missing.jpg'; }));
  await assert.rejects(parseBackupArchive(badReference), isCode('missing-media'));
});

test('import rejects tampered original bytes even when ZIP CRC is valid', async () => {
  const tampered = await mutateArchive((zip, manifest) => { zip.file(manifest.media[0].path, new Uint8Array(imageA.length).fill(0)); });
  await assert.rejects(parseBackupArchive(tampered), isCode('integrity'));
});

test('unsupported backup and source versions are reported, never converted to version one', async () => {
  await assert.rejects(parseBackupArchive(await mutateArchive((_zip, manifest) => { manifest.formatVersion = 9; })), isCode('unsupported-version'));
  await assert.rejects(parseBackupArchive(await mutateArchive(async (zip, manifest) => updateData(zip, manifest, (data) => { data.version = 2; }))), isCode('unsupported-version'));
  assert.throws(() => parseLocalSnapshot('{"version":9}'), isCode('unsupported-version'));
});

test('duplicate record IDs, corrupt nested revisions, and invalid numerical values are rejected', async () => {
  for (const change of [
    (data: any) => data.meals.push(data.meals[0]),
    (data: any) => { data.meals[0].revisions[0].id = 'different-id'; },
    (data: any) => { data.meals[0].analyses[0].analysis.calories = { min: 10, max: 1 }; },
    (data: any) => { data.sleeps[0].awakeMinutes = 800; },
    (data: any) => { data.trainings[0].sets[0].weight = -10; },
    (data: any) => { data.meals[0].timezone = 'Invalid/Zone'; },
  ]) await assert.rejects(parseBackupArchive(await mutateArchive(async (zip, manifest) => updateData(zip, manifest, change))), isCode('duplicate-id', 'invalid-data'));
});

test('archive traversal and unlisted payloads are rejected', async () => {
  await assert.rejects(parseBackupArchive(await mutateArchive((zip) => { zip.file('../outside.txt', 'x'); })), isCode('path-traversal'));
  await assert.rejects(parseBackupArchive(await mutateArchive((zip) => { zip.file('unexpected.txt', 'x'); })), isCode('invalid-manifest'));
});

test('oversized declared expansion is rejected before decompression', async () => {
  const bytes = await archive();
  const modified = Uint8Array.from(bytes);
  const view = new DataView(modified.buffer);
  for (let cursor = 0; cursor < modified.length - 46; cursor++) {
    if (view.getUint32(cursor, true) === 0x02014b50) { view.setUint32(cursor + 24, MAX_ENTRY_BYTES + 1, true); break; }
  }
  await assert.rejects(parseBackupArchive(modified), isCode('entry-too-large'));
});

test('repeated import deduplicates identical IDs despite regenerated local summary timestamps', () => {
  const data = fixture();
  const afterOpen = fixture();
  afterOpen.summaries[0].createdAt = '2026-10-11T00:00:00Z';
  afterOpen.summaries[0].sourceVersion = 10;
  afterOpen.summaries[0].markdown = '# Regenerated local summary';
  afterOpen.sourceVersion = 10;
  const merged = mergeBackupData(afterOpen, data);
  assert.equal(merged.meals.length, 1);
  assert.equal(merged.trainings.length, 1);
  assert.equal(merged.sleeps.length, 1);
  assert.equal(merged.summaries.length, 2);
  assert.equal(merged.summaries[0].createdAt, afterOpen.summaries[0].createdAt);
  assert.equal(merged.sourceVersion, 10);
  assert.equal(canonicalJson(mergeBackupData(merged, data)), canonicalJson(merged));
});

test('conflicting facts, profile and drafts fail without mutating either input', () => {
  const data = fixture();
  const original = canonicalJson(data);
  const different = fixture();
  different.meals[0].portion = 'changed';
  assert.throws(() => mergeBackupData(data, different), isCode('import-conflict'));
  different.meals[0].portion = data.meals[0].portion;
  different.profile.weightKg = 90;
  assert.throws(() => mergeBackupData(data, different), isCode('import-conflict'));
  assert.throws(() => mergeFormDrafts({ meal: { portion: 'one' } }, { meal: { portion: 'two' } }), isCode('import-conflict'));
  assert.equal(canonicalJson(data), original);
});

test('local repository preserves committed data on corrupt import, schema failure and interrupted writes', async () => {
  const values = new Map<string, string>();
  let failCommit = false;
  const repository = new LocalRepository({
    async getItem(key) { return values.get(key) ?? null; },
    async setItem(key, value) { if (failCommit && key === DATA_KEY) throw new Error('storage full'); values.set(key, value); },
    async removeItem(key) { values.delete(key); },
  });
  await repository.commit({ storageVersion: 1, data: fixture(), drafts: formDrafts });
  const original = values.get(DATA_KEY)!;
  await assert.rejects(repository.run(async () => {
    const imported = await parseBackupArchive(new Uint8Array([1, 2, 3]));
    await repository.commit({ storageVersion: 1, data: imported.data, drafts: imported.drafts });
  }), isCode('invalid-archive'));
  assert.equal(values.get(DATA_KEY), original);
  const invalid = fixture();
  invalid.meals[0].createdAt = 'invalid';
  await assert.rejects(repository.commit({ storageVersion: 1, data: invalid, drafts: {} }), isCode('invalid-data'));
  assert.equal(values.get(DATA_KEY), original);
  failCommit = true;
  await assert.rejects(repository.commit({ storageVersion: 1, data: emptyData(), drafts: {} }), /storage full/);
  assert.equal(values.get(DATA_KEY), original);
  assert.equal(canonicalJson((await repository.read()).data), canonicalJson(validateAppData(fixture())));
  assert.throws(() => parseLocalSnapshot('{broken'), isCode('invalid-data'));
  assert.equal(values.get(DATA_KEY), original);
});

test('committed record and draft operations resolve when cleanup fails and expose a consumable generic warning', async () => {
  for (const operation of ['save-data', 'save-draft', 'clear-draft']) {
    const values = new Map<string, string>();
    const repository = new LocalRepository({
      async getItem(key) { return values.get(key) ?? null; },
      async setItem(key, value) { values.set(key, value); },
      async removeItem(key) { values.delete(key); },
    });
    const before = { storageVersion: 1 as const, data: fixture(), drafts: { ...formDrafts } as Record<string, unknown> };
    await repository.commit(before);
    const after = { ...before, data: fixture(), drafts: { ...before.drafts } };
    if (operation === 'save-data') after.data.meals[0].note = 'successfully committed edit';
    if (operation === 'save-draft') after.drafts['meal-new'] = { portion: 'new unfinished input' };
    if (operation === 'clear-draft') delete after.drafts['training-new'];
    await assert.doesNotReject(repository.run(async () => {
      await repository.commit(after);
      await repository.cleanupBestEffort(async () => { throw new Error('private health input at file:///sensitive-photo.jpg'); });
    }), operation);
    assert.equal(canonicalJson(await repository.read()), canonicalJson(after), operation);
    assert.equal(repository.consumeWarning(), '媒体清理未完成，已保存的数据不受影响。稍后将重试。');
    assert.equal(repository.consumeWarning(), undefined);
  }
});

test('failed commits reject and never run post-commit cleanup or replace existing records', async () => {
  for (const failedKey of [DATA_KEY, `${DATA_KEY}.tmp`]) {
    const values = new Map<string, string>();
    let failureEnabled = false;
    let cleanupCalled = false;
    const repository = new LocalRepository({
      async getItem(key) { return values.get(key) ?? null; },
      async setItem(key, value) { if (failureEnabled && key === failedKey) throw new Error('storage write failed'); values.set(key, value); },
      async removeItem(key) { values.delete(key); },
    });
    const before = { storageVersion: 1 as const, data: fixture(), drafts: formDrafts };
    await repository.commit(before);
    const committed = values.get(DATA_KEY);
    failureEnabled = true;
    await assert.rejects(repository.run(async () => {
      await repository.commit({ storageVersion: 1, data: emptyData(), drafts: {} });
      await repository.cleanupBestEffort(async () => { cleanupCalled = true; });
    }), /storage write failed/);
    assert.equal(cleanupCalled, false);
    assert.equal(values.get(DATA_KEY), committed);
    assert.equal(repository.consumeWarning(), undefined);
  }
});

test('loading healthy data tolerates cleanup failure and retries cleanup on the next load', async () => {
  const values = new Map<string, string>();
  const repository = new LocalRepository({
    async getItem(key) { return values.get(key) ?? null; },
    async setItem(key, value) { values.set(key, value); },
    async removeItem(key) { values.delete(key); },
  });
  await repository.commit({ storageVersion: 1, data: fixture(), drafts: formDrafts });
  let attempts = 0;
  const load = () => repository.run(async () => {
    const snapshot = await repository.read();
    await repository.cleanupBestEffort(async () => {
      attempts++;
      if (attempts === 1) throw new Error('media deletion unavailable');
    });
    return snapshot.data;
  });
  assert.equal(canonicalJson(await load()), canonicalJson(fixture()));
  assert.equal(attempts, 1);
  assert.equal(canonicalJson(await load()), canonicalJson(fixture()));
  assert.equal(attempts, 2);
  assert.equal(repository.consumeWarning(), undefined, 'a successful retry clears an obsolete cleanup warning');
});
