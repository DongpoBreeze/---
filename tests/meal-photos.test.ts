import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { z } from 'zod';
import * as mealPhotos from '../src/meal-photos';
import { mealAnalysisSchema } from '../src/nutrition-schema';
import type { MealProviderOptions } from '../src/ai-provider';
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
  request?: (payload: Record<string, unknown>, options: MealProviderOptions) => Promise<void>;
} = {}) {
  const transforms: Array<{ uri: string; actions: unknown; options: unknown }> = [];
  const requests: Array<Record<string, unknown>> = [];
  const deleted: string[] = [];
  let disposed = 0;
  const mocks: Record<string, unknown> = {
    'expo-image-manipulator': { SaveFormat: { JPEG: 'jpeg' }, manipulateAsync: async (uri: string, actions: unknown, save: unknown) => {
      transforms.push({ uri, actions, options: save });
      return options.manipulate?.(uri, transforms.length) ?? {
        uri: `file:///cache/processed-${transforms.length}.jpg`, base64: Buffer.from([255, 216, 255, transforms.length]).toString('base64'), width: 1200, height: 900,
      };
    } },
    'expo-file-system/legacy': { cacheDirectory: 'file:///cache/', deleteAsync: async (uri: string) => { deleted.push(uri); } },
    'react-native': { Platform: { OS: 'ios' } },
    zod: { z },
    './domain': {},
    './nutrition-schema': { mealAnalysisSchema },
    './meal-photos': mealPhotos,
    './ai-settings': { getAiSettings: () => null, beginAiSettingsRequest: (signal?: AbortSignal) => ({
      settings: { model: 'test/model', reasoningEffort: 'Vendor.High' }, signal: signal ?? new AbortController().signal,
      assertCurrent: () => { if (signal?.aborted) throw new DOMException('cancelled', 'AbortError'); }, dispose: () => { disposed += 1; },
    }) },
    './ai-provider': { requestProvider: async (_settings: unknown, _kind: unknown, payload: Record<string, unknown>, _signal: unknown, providerOptions: MealProviderOptions) => {
      requests.push(payload);
      await options.request?.(payload, providerOptions);
      return { analysis, model: 'test/model', createdAt: now, stageCount: 1 };
    } },
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', adapterCode)((id: string) => {
    if (!(id in mocks)) throw new Error(`Unexpected adapter dependency: ${id}`);
    return mocks[id];
  }, module, module.exports);
  return { analyzeMeal: (module.exports as typeof import('../src/ai')).analyzeMeal, transforms, requests, deleted, disposed: () => disposed };
}

test('analysis preprocesses every original once as JPEG and submits ordered before views in one request', async () => {
  const original = meal({ imageUri: 'file:///original-1.heic', beforeImageUris: ['file:///original-1.heic', 'file:///original-2.png', 'file:///original-3.jpg'], afterImageUri: 'file:///legacy-after.jpg' });
  const snapshot = structuredClone(original);
  const h = adapter();
  await h.analyzeMeal(original, {});
  assert.deepEqual(h.transforms.map((call) => call.uri), ['file:///original-1.heic', 'file:///original-2.png', 'file:///original-3.jpg', 'file:///legacy-after.jpg']);
  assert.ok(h.transforms.every((call) => JSON.stringify(call.actions) === JSON.stringify([{ resize: { width: 1200 } }])));
  assert.ok(h.transforms.every((call) => JSON.stringify(call.options) === JSON.stringify({ compress: 0.75, format: 'jpeg', base64: true })));
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.requests[0].photoRoles, ['before', 'before', 'before', 'after']);
  assert.deepEqual(h.requests[0].photos, [1, 2, 3, 4].map((index) => `data:image/jpeg;base64,${Buffer.from([255, 216, 255, index]).toString('base64')}`));
  assert.deepEqual(original, snapshot);
  assert.equal(h.deleted.length, 4);
  assert.equal(h.disposed(), 1);
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
