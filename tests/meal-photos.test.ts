import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { z } from 'zod';
import * as mealPhotos from '../src/meal-photos';
import { mealAnalysisSchema } from '../src/nutrition-schema';
import { MEAL_ANALYSIS_STAGE_TIMEOUT_MS, MAX_MEAL_ANALYSIS_STAGES, type MealProviderOptions } from '../src/ai-provider';
import type { MealRecord } from '../src/types';

const { MAX_MEAL_PHOTOS, mealBeforePhotoUris, mealAnalysisPhotoSources, canCropMealPhotoRegions } = mealPhotos;
const now = '2026-10-21T03:00:00.000Z';
const meal = (changes: Partial<MealRecord> = {}): MealRecord => ({
  id: 'meal-photos', type: 'meal', createdAt: now, occurredAt: now, mealType: '午餐', foodName: '',
  portion: '', note: '', source: 'photo', estimateStatus: 'unknown', ...changes,
});
const analysis = { status: 'unknown', foodName: '未知', calories: null, protein: null, carbs: null, fat: null, assumptions: [], advice: '补充菜品记录。' };

test('before photos retain legacy primary order, deduplicate its mirror and preserve inputs', () => {
  assert.equal(MAX_MEAL_PHOTOS, 4);
  assert.deepEqual(mealBeforePhotoUris({}), []);
  assert.deepEqual(mealBeforePhotoUris({ imageUri: 'legacy' }), ['legacy']);
  const input = { imageUri: 'legacy', beforeImageUris: ['second', 'legacy', 'second', 'third'] };
  const original = structuredClone(input);
  assert.deepEqual(mealBeforePhotoUris(input), ['legacy', 'second', 'third']);
  assert.deepEqual(input, original);
  assert.deepEqual(mealBeforePhotoUris({ beforeImageUris: ['second', 'first', 'second'] }), ['second', 'first']);
  assert.deepEqual(mealBeforePhotoUris({ beforeImageUris: [] }), []);
});

test('source limits count distinct before views plus the legacy after view and reject malformed arrays', () => {
  assert.deepEqual(mealAnalysisPhotoSources({ imageUri: 'a', beforeImageUris: ['a', 'b', 'c'], afterImageUri: 'd' }), [
    { role: 'before', uri: 'a' }, { role: 'before', uri: 'b' }, { role: 'before', uri: 'c' }, { role: 'after', uri: 'd' },
  ]);
  assert.equal(mealAnalysisPhotoSources({ imageUri: 'a', beforeImageUris: ['a', 'b', 'c', 'd'] }).length, 4);
  assert.deepEqual(mealAnalysisPhotoSources({ imageUri: 'a', afterImageUri: 'b' }), [{ role: 'before', uri: 'a' }, { role: 'after', uri: 'b' }]);
  assert.deepEqual(mealAnalysisPhotoSources({ beforeImageUris: [] }), []);
  for (const input of [
    { beforeImageUris: 'a' }, { beforeImageUris: [null] }, { beforeImageUris: [undefined] }, { beforeImageUris: new Array(1) },
    { beforeImageUris: [''] }, { beforeImageUris: [1] }, { imageUri: null }, { afterImageUri: '' },
    { beforeImageUris: ['a', 'b', 'c', 'd', 'e'] }, { imageUri: 'outside', beforeImageUris: ['a', 'b', 'c', 'd'] },
    { beforeImageUris: ['a', 'b', 'c', 'd'], afterImageUri: 'e' },
  ]) assert.throws(() => mealAnalysisPhotoSources(input as Parameters<typeof mealAnalysisPhotoSources>[0]));
});

test('unindexed regions allow a single source and legacy before/after but refuse multiple before views', () => {
  for (const [count, roles, expected] of [
    [1, ['before'], true], [1, undefined, true], [2, ['before', 'after'], true], [2, ['after', 'before'], true],
    [2, ['before', 'before'], false], [2, undefined, false], [2, ['photo_1', 'photo_2'], false],
    [3, ['before', 'before', 'after'], false], [4, ['before', 'before', 'before', 'before'], false],
  ] as const) assert.equal(canCropMealPhotoRegions(count, roles), expected);
});

// Execute the production adapter with only its platform boundaries substituted.
// Expo's React Native entry points cannot be imported directly by the Node runner.
const adapterCode = ts.transpileModule(readFileSync(resolve(process.cwd(), 'src/ai.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
function adapter(options: {
  manipulate?: (uri: string, index: number) => Promise<{ uri: string; base64?: string; width: number; height: number }>;
  getSize?: (uri: string) => Promise<{ width: number; height: number }>;
  request?: (payload: Record<string, unknown>, options: MealProviderOptions) => Promise<void>;
} = {}) {
  const transforms: Array<{ uri: string; actions: unknown; options: unknown }> = [];
  const requests: Array<Record<string, unknown>> = [];
  const deleted: string[] = [];
  const lifecycleDurations: Array<number | undefined> = [];
  const providerOptions: MealProviderOptions[] = [];
  let disposed = 0;
  const mocks: Record<string, unknown> = {
    'expo-image-manipulator': { SaveFormat: { JPEG: 'jpeg' }, manipulateAsync: async (uri: string, actions: unknown, save: unknown) => {
      transforms.push({ uri, actions, options: save });
      return options.manipulate?.(uri, transforms.length) ?? {
        uri: `file:///cache/processed-${transforms.length}.jpg`, base64: Buffer.from([255, 216, 255, transforms.length]).toString('base64'), width: 1200, height: 900,
      };
    } },
    'expo-file-system/legacy': { cacheDirectory: 'file:///cache/', deleteAsync: async (uri: string) => { deleted.push(uri); } },
    'react-native': { Image: { getSize: (uri: string, success: (width: number, height: number) => void, failure: (error: unknown) => void) => {
      const result = options.getSize?.(uri) ?? Promise.resolve({ width: 1600, height: 2400 });
      void result.then(({ width, height }) => success(width, height), failure);
      // React Native Web returns void; callers must wait for the callback.
    } }, Platform: { OS: 'ios' } },
    zod: { z },
    './domain': {},
    './nutrition-schema': { mealAnalysisSchema },
    './meal-photos': mealPhotos,
    './ai-settings': { getAiSettings: () => null, beginAiSettingsRequest: (signal?: AbortSignal, maximumDurationMs?: number) => {
      lifecycleDurations.push(maximumDurationMs);
      return {
        settings: { model: 'test/model', reasoningEffort: 'Vendor.High' }, signal: signal ?? new AbortController().signal,
        assertCurrent: () => { if (signal?.aborted) throw new DOMException('cancelled', 'AbortError'); }, dispose: () => { disposed += 1; },
      };
    } },
    './ai-provider': { MEAL_ANALYSIS_STAGE_TIMEOUT_MS, MAX_MEAL_ANALYSIS_STAGES, requestProvider: async (_settings: unknown, _kind: unknown, payload: Record<string, unknown>, _signal: unknown, providerRequestOptions: MealProviderOptions) => {
      requests.push(payload);
      providerOptions.push(providerRequestOptions);
      await options.request?.(payload, providerRequestOptions);
      return { analysis, model: 'test/model', createdAt: now, stageCount: 1 };
    } },
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', adapterCode)((id: string) => {
    if (!(id in mocks)) throw new Error(`Unexpected adapter dependency: ${id}`);
    return mocks[id];
  }, module, module.exports);
  return { analyzeMeal: (module.exports as typeof import('../src/ai')).analyzeMeal, transforms, requests, deleted, lifecycleDurations, providerOptions, disposed: () => disposed };
}

test('analysis preprocesses every original once as JPEG and submits ordered before views in one request', async () => {
  const original = meal({ imageUri: 'file:///original-1.heic', beforeImageUris: ['file:///original-1.heic', 'file:///original-2.png', 'file:///original-3.jpg'], afterImageUri: 'file:///legacy-after.jpg' });
  const snapshot = structuredClone(original);
  const h = adapter();
  await h.analyzeMeal(original, {});
  assert.deepEqual(h.transforms.map((call) => call.uri), ['file:///original-1.heic', 'file:///original-2.png', 'file:///original-3.jpg', 'file:///legacy-after.jpg']);
  assert.ok(h.transforms.every((call) => JSON.stringify(call.actions) === JSON.stringify([{ resize: { height: 1200 } }])));
  assert.ok(h.transforms.every((call) => JSON.stringify(call.options) === JSON.stringify({ compress: 0.75, format: 'jpeg', base64: true })));
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.requests[0].photoRoles, ['before', 'before', 'before', 'after']);
  assert.deepEqual(h.requests[0].photos, [1, 2, 3, 4].map((index) => `data:image/jpeg;base64,${Buffer.from([255, 216, 255, index]).toString('base64')}`));
  assert.deepEqual(original, snapshot);
  assert.equal(h.deleted.length, 4);
  assert.equal(h.disposed(), 1);
  assert.equal(h.lifecycleDurations[0], MEAL_ANALYSIS_STAGE_TIMEOUT_MS * MAX_MEAL_ANALYSIS_STAGES + 5_000);
  assert.equal(h.providerOptions[0].timeoutMs, MEAL_ANALYSIS_STAGE_TIMEOUT_MS);
});

test('source photos use one longest-side limit and compression while at most two preprocess concurrently in source order', async () => {
  const uris = ['wide', 'portrait', 'small', 'last'];
  const dimensions = new Map([
    ['wide', { width: 2400, height: 1600 }], ['portrait', { width: 900, height: 1800 }],
    ['small', { width: 600, height: 400 }], ['last', { width: 1400, height: 2100 }],
  ]);
  const releases = new Map<number, () => void>();
  const started: number[] = [];
  let active = 0, maxActive = 0;
  const h = adapter({
    getSize: async (uri) => dimensions.get(uri)!,
    manipulate: async (uri, index) => {
      started.push(index); active += 1; maxActive = Math.max(maxActive, active);
      return new Promise((resolve) => releases.set(index, () => {
        active -= 1;
        resolve({ uri: `file:///cache/processed-${index}.jpg`, base64: Buffer.from([255, 216, 255, index]).toString('base64'), width: 100, height: 100 });
      }));
    },
  });
  const pending = h.analyzeMeal(meal({ imageUri: uris[0], beforeImageUris: uris }), {});
  const waitForStarts = async (count: number) => {
    for (let attempt = 0; attempt < 50 && started.length < count; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(started.length, count);
  };
  await waitForStarts(2);
  assert.deepEqual(started, [1, 2]);
  assert.equal(maxActive, 2);
  releases.get(2)!();
  await waitForStarts(3);
  assert.deepEqual(started, [1, 2, 3]);
  releases.get(3)!();
  await waitForStarts(4);
  assert.deepEqual(started, [1, 2, 3, 4]);
  releases.get(4)!(); releases.get(1)!();
  await pending;
  assert.equal(maxActive, 2);
  assert.deepEqual(h.transforms.map((call) => call.actions), [
    [{ resize: { width: 1200 } }], [{ resize: { height: 1200 } }],
    [{ resize: { width: 600 } }], [{ resize: { height: 1200 } }],
  ]);
  assert.ok(h.transforms.every((call) => JSON.stringify(call.options) === JSON.stringify({ compress: 0.75, format: 'jpeg', base64: true })));
  assert.deepEqual(h.requests[0].photos, [1, 2, 3, 4].map((index) => `data:image/jpeg;base64,${Buffer.from([255, 216, 255, index]).toString('base64')}`));
  assert.deepEqual(h.requests[0].photoRoles, ['before', 'before', 'before', 'before']);
  assert.equal(h.requests.length, 1);
});

test('a failed parallel image transform waits for sibling cleanup and does not start later photos or call the provider', async () => {
  const uris = ['first', 'second', 'third', 'fourth'];
  let releaseSibling!: () => void;
  const siblingGate = new Promise<void>((resolve) => { releaseSibling = resolve; });
  const calls: string[] = [];
  const h = adapter({
    manipulate: async (uri, index) => {
      calls.push(uri);
      if (uri === 'first') throw new Error('image decode failed');
      if (uri === 'second') await siblingGate;
      return { uri: `file:///cache/${index}.jpg`, base64: '/9j/AA==', width: 1200, height: 900 };
    },
  });
  const pending = h.analyzeMeal(meal({ imageUri: uris[0], beforeImageUris: uris }), {});
  for (let attempt = 0; attempt < 50 && calls.length < 2; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['first', 'second']);
  releaseSibling();
  await assert.rejects(pending, /image decode failed/);
  assert.deepEqual(calls, ['first', 'second']);
  assert.deepEqual(h.deleted, ['file:///cache/2.jpg']);
  assert.equal(h.requests.length, 0);
  assert.equal(h.disposed(), 1);
});

test('image-size callback failures send no provider request or resize and keep the original intact', async () => {
  const original = meal({ imageUri: 'file:///unreadable.png' });
  const snapshot = structuredClone(original);
  const h = adapter({ getSize: async () => { throw new Error('image decode failed'); } });
  await assert.rejects(h.analyzeMeal(original, {}), /image decode failed/);
  assert.equal(h.transforms.length, 0);
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.deleted, []);
  assert.equal(h.disposed(), 1);
  assert.deepEqual(original, snapshot);
});

test('invalid or excessive originals are rejected before preprocessing and before requests', async () => {
  for (const changes of [
    { beforeImageUris: ['a', 'b', 'c', 'd', 'e'] }, { beforeImageUris: ['a', 'b', 'c', 'd'], afterImageUri: 'e' },
    { beforeImageUris: [null] }, { beforeImageUris: 'a' },
  ]) {
    const h = adapter();
    await assert.rejects(h.analyzeMeal(meal(changes as Partial<MealRecord>), {}));
    assert.equal(h.transforms.length, 0); assert.equal(h.requests.length, 0); assert.equal(h.disposed(), 1);
  }
});

test('multiple before photos refuse ambiguous local crops while old before/after still uses the before image', async () => {
  for (const multipleBefore of [true, false]) {
    let crops: Awaited<ReturnType<NonNullable<MealProviderOptions['createCrops']>>>;
    const h = adapter({ request: async (_payload, options) => {
      crops = await options.createCrops!({ componentIndices: [0], regions: [{ x: 0.1, y: 0.1, width: 0.3, height: 0.3 }], signal: new AbortController().signal });
    } });
    await h.analyzeMeal(meal({ imageUri: 'before', beforeImageUris: multipleBefore ? ['before', 'before-2'] : undefined, afterImageUri: 'after' }), {});
    assert.equal(crops !== undefined, !multipleBefore);
    assert.equal(h.transforms.length, 3);
    if (!multipleBefore) {
      assert.equal(h.transforms[2].uri, 'file:///cache/processed-1.jpg');
      assert.deepEqual(crops!.photoRoles, ['before:crop:1']);
    }
  }
});

test('preprocessing cancellation and malformed images send zero requests and clean generated copies only', async () => {
  const controller = new AbortController();
  const cancelled = adapter({ manipulate: async () => {
    controller.abort(); return { uri: 'file:///cache/cancelled-copy.jpg', base64: '/9j/AA==', width: 1200, height: 900 };
  } });
  await assert.rejects(cancelled.analyzeMeal(meal({ imageUri: 'file:///cache/original.jpg' }), {}, controller.signal), { name: 'AbortError' });
  assert.deepEqual(cancelled.deleted, ['file:///cache/cancelled-copy.jpg']); assert.equal(cancelled.requests.length, 0); assert.equal(cancelled.disposed(), 1);
  for (const base64 of [undefined, '', 'A'.repeat(4 * 1024 * 1024 + 1)]) {
    const invalid = adapter({ manipulate: async () => ({ uri: 'file:///cache/invalid-copy.jpg', base64, width: 1200, height: 900 }) });
    await assert.rejects(invalid.analyzeMeal(meal({ imageUri: 'file:///cache/original.jpg' }), {}), /照片过大/);
    assert.equal(invalid.requests.length, 0); assert.deepEqual(invalid.deleted, ['file:///cache/invalid-copy.jpg']);
  }
  const originalReturned = adapter({ manipulate: async (uri) => ({ uri, base64: '/9j/AA==', width: 1200, height: 900 }) });
  await originalReturned.analyzeMeal(meal({ imageUri: 'file:///cache/original.jpg' }), {});
  assert.deepEqual(originalReturned.deleted, []);
});
