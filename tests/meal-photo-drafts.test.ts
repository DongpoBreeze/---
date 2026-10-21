import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import * as backup from '../src/backup';
import * as localStore from '../src/local-store';
import * as mealPhotos from '../src/meal-photos';
import { emptyData } from '../src/types';

function compiled(path: string) {
  return ts.transpileModule(readFileSync(resolve(process.cwd(), path), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
}
const storageCode = compiled('src/storage.ts');
const hookCode = compiled('src/ui/useFormDraft.ts');
function execute(code: string, dependencies: Record<string, unknown>): unknown {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)((id: string) => {
    if (!(id in dependencies)) throw new Error(`Unexpected dependency: ${id}`);
    return dependencies[id];
  }, module, module.exports);
  return module.exports;
}

function storedDrafts(drafts: Record<string, unknown>) {
  const values = new Map<string, string>([[localStore.DATA_KEY, JSON.stringify({ storageVersion: 1, data: emptyData(), drafts })]]);
  const store = {
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => { values.set(key, value); },
    removeItem: async (key: string) => { values.delete(key); },
  };
  const storage = execute(storageCode, {
    '@react-native-async-storage/async-storage': { ...store, getAllKeys: async () => [] },
    'expo-document-picker': {}, 'expo-file-system/legacy': {}, 'expo-sharing': {}, 'expo-crypto': {},
    'react-native': { Platform: { OS: 'web' } }, './types': {}, './backup': backup, './local-store': localStore,
    './storage-web': { webSnapshotStore: store, webMediaKeys: async () => [] }, './meal-photos': mealPhotos,
  }) as typeof import('../src/storage');
  return { storage, raw: () => values.get(localStore.DATA_KEY)! };
}

function formDraft<T extends object>(initial: T, load: () => Promise<unknown>) {
  const states: unknown[] = [];
  const effects: Array<() => unknown> = [];
  const writes: unknown[] = [];
  const react = {
    useState: (initialValue: unknown) => {
      const index = states.push(initialValue) - 1;
      return [initialValue, (value: unknown) => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
    },
    useRef: (value: unknown) => ({ current: value }),
    useCallback: (callback: unknown) => callback,
    useEffect: (effect: () => unknown) => { effects.push(effect); },
  };
  const hooks = execute(hookCode, { react, '../storage': {
    loadDraft: load, saveDraft: async (_key: string, value: unknown) => { writes.push(value); }, clearDraft: async () => {},
  } }) as typeof import('../src/ui/useFormDraft');
  const result = hooks.useFormDraft('meal-saved', initial);
  const start = async () => {
    effects.forEach((effect) => effect());
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  return { result, start, form: () => states[0] as T, loaded: () => states[1], error: () => states[2], writes };
}

const savedPhotos = () => ({ imageUri: 'saved-a' as string | undefined, beforeImageUris: ['saved-a', 'saved-b'], afterImageUri: 'saved-after' as string | undefined, note: 'saved note' });

test('draft media normalization is pure and leaves legacy partial values and historical helpers unchanged', () => {
  const draft = { imageUri: 'stale-alias', beforeImageUris: ['draft-c', 'draft-c', 'draft-d'], note: 'keep text' };
  const original = structuredClone(draft);
  const normalized = mealPhotos.normalizeMealPhotoDraft(draft);
  assert.deepEqual(normalized, { imageUri: 'draft-c', beforeImageUris: ['draft-c', 'draft-d'], afterImageUri: undefined, note: 'keep text' });
  assert.deepEqual(draft, original);
  assert.deepEqual(mealPhotos.mealBeforePhotoUris(draft), ['stale-alias', 'draft-c', 'draft-d']);
  for (const value of [null, undefined, false, 'legacy', [], { note: 'partial' }]) assert.strictEqual(mealPhotos.normalizeMealPhotoDraft(value), value);
  assert.throws(() => mealPhotos.normalizeMealPhotoDraft({ beforeImageUris: [null] }));
});

test('an explicit empty before array clears the saved primary after JSON persistence and production hook hydration', async () => {
  const stored = storedDrafts({ 'meal-saved': { imageUri: undefined, beforeImageUris: [], afterImageUri: undefined, note: 'draft note' } });
  const raw = stored.raw();
  assert.equal(Object.hasOwn(JSON.parse(raw).drafts['meal-saved'], 'imageUri'), false);
  const h = formDraft(savedPhotos(), () => stored.storage.loadDraft('meal-saved'));
  await h.start();
  assert.equal(h.loaded(), true); assert.equal(h.error(), '');
  assert.deepEqual(mealPhotos.mealBeforePhotoUris(h.form()), []);
  assert.equal(h.form().imageUri, undefined); assert.equal(Object.hasOwn(h.form(), 'imageUri'), true);
  assert.equal(h.form().afterImageUri, undefined); assert.equal(h.form().note, 'draft note');
  assert.equal(stored.raw(), raw, 'loading must not rewrite stored drafts or historical records');
  await stored.storage.saveDraft('meal-saved', h.form());
  const reopened = formDraft(savedPhotos(), () => stored.storage.loadDraft('meal-saved'));
  await reopened.start();
  assert.equal(reopened.error(), ''); assert.deepEqual(mealPhotos.mealBeforePhotoUris(reopened.form()), []);
  assert.equal(reopened.form().afterImageUri, undefined);
});

test('an imageUri-only legacy draft replaces the initial multi-photo group without inferring after deletion', async () => {
  const stored = storedDrafts({ 'meal-saved': { imageUri: 'draft-c', note: 'legacy note' } });
  const h = formDraft(savedPhotos(), () => stored.storage.loadDraft('meal-saved'));
  await h.start();
  assert.equal(h.error(), '');
  assert.deepEqual(mealPhotos.mealBeforePhotoUris(h.form()), ['draft-c']);
  assert.equal(h.form().imageUri, 'draft-c'); assert.equal(h.form().afterImageUri, 'saved-after');
});

test('a new multi-photo draft restores its first alias and an omitted after alias stays removed', async () => {
  const stored = storedDrafts({ 'meal-saved': { beforeImageUris: ['draft-c', 'draft-d'] } });
  const h = formDraft(savedPhotos(), () => stored.storage.loadDraft('meal-saved'));
  await h.start();
  assert.equal(h.error(), '');
  assert.deepEqual(mealPhotos.mealBeforePhotoUris(h.form()), ['draft-c', 'draft-d']);
  assert.equal(h.form().imageUri, 'draft-c'); assert.equal(h.form().afterImageUri, undefined);
  const retained = storedDrafts({ 'meal-saved': { beforeImageUris: ['draft-c'], afterImageUri: 'draft-after' } });
  const retainedHook = formDraft(savedPhotos(), () => retained.storage.loadDraft('meal-saved'));
  await retainedHook.start();
  assert.equal(retainedHook.error(), ''); assert.equal(retainedHook.form().afterImageUri, 'draft-after');
});

test('a partial old draft without photo fields preserves initial photos and non-meal drafts are returned unchanged', async () => {
  const stored = storedDrafts({ 'meal-saved': { note: 'partial' }, 'training-saved': { imageUri: 'unrelated', note: 'training' } });
  const h = formDraft(savedPhotos(), () => stored.storage.loadDraft('meal-saved'));
  await h.start();
  assert.equal(h.error(), ''); assert.equal(h.form().note, 'partial');
  assert.deepEqual(mealPhotos.mealBeforePhotoUris(h.form()), ['saved-a', 'saved-b']);
  assert.equal(h.form().afterImageUri, 'saved-after');
  assert.deepEqual(await stored.storage.loadDraft('training-saved'), { imageUri: 'unrelated', note: 'training' });
  assert.equal(await stored.storage.loadDraft('meal-missing'), null);
});

test('explicit before arrays own their primary order, retain old after media and normalize legacy meal draft keys', async () => {
  const stored = storedDrafts({
    'meal-saved': { imageUri: 'stale-primary', beforeImageUris: ['draft-c', 'draft-c', 'draft-d'], afterImageUri: 'legacy-after', note: 'keep this' },
    meal: { imageUri: 'legacy-primary', afterImageUri: 'legacy-after' },
    'meal-after-only': { afterImageUri: 'after-only' },
  });
  const loaded = await stored.storage.loadDraft<Record<string, unknown>>('meal-saved');
  assert.deepEqual(loaded, { imageUri: 'draft-c', beforeImageUris: ['draft-c', 'draft-d'], afterImageUri: 'legacy-after', note: 'keep this' });
  assert.deepEqual(await stored.storage.loadDraft('meal'), { imageUri: 'legacy-primary', beforeImageUris: ['legacy-primary'], afterImageUri: 'legacy-after' });
  assert.deepEqual(await stored.storage.loadDraft('meal-after-only'), { afterImageUri: 'after-only' });
});

test('media aliases accept own undefined during hydration while ordinary string fields retain type checks', async () => {
  const h = formDraft(savedPhotos(), async () => ({ imageUri: undefined, beforeImageUris: [], afterImageUri: undefined }));
  await h.start();
  assert.equal(h.error(), ''); assert.deepEqual(mealPhotos.mealBeforePhotoUris(h.form()), []); assert.equal(h.form().afterImageUri, undefined);
  const noOriginal = formDraft({ imageUri: undefined as string | undefined, beforeImageUris: [] as string[], afterImageUri: undefined as string | undefined },
    async () => ({ imageUri: 'legacy-before', beforeImageUris: ['legacy-before'], afterImageUri: 'legacy-after' }));
  await noOriginal.start();
  assert.equal(noOriginal.error(), ''); assert.deepEqual(mealPhotos.mealBeforePhotoUris(noOriginal.form()), ['legacy-before']);
  for (const invalid of [{ note: undefined }, { imageUri: null }, { afterImageUri: null }, { beforeImageUris: [undefined] }]) {
    const rejected = formDraft(savedPhotos(), async () => invalid);
    await rejected.start();
    assert.match(String(rejected.error()), /草稿字段不兼容/);
    assert.deepEqual(mealPhotos.mealBeforePhotoUris(rejected.form()), ['saved-a', 'saved-b']);
  }
});

test('hydration preserves edits made during a delayed draft read and keeps its existing per-field competition rules', async () => {
  let finishRead!: (value: unknown) => void;
  const h = formDraft(savedPhotos(), () => new Promise((resolve) => { finishRead = resolve; }));
  const started = h.start();
  h.result.setForm((current) => ({ ...current, imageUri: 'user-new', beforeImageUris: ['user-new'], afterImageUri: 'user-after', note: 'user typed' }));
  finishRead({ imageUri: undefined, beforeImageUris: [], afterImageUri: undefined, note: 'old draft' });
  await started;
  assert.equal(h.error(), ''); assert.equal(h.form().note, 'user typed'); assert.equal(h.form().afterImageUri, 'user-after');
  assert.deepEqual(mealPhotos.mealBeforePhotoUris(h.form()), ['user-new']);
  assert.equal(await h.result.persist(), true);
  assert.deepEqual(h.writes, [h.form()]);
});

test('loading normalized meal draft media does not mutate backup contents or original record history', async () => {
  const data = emptyData();
  const now = '2026-10-21T03:00:00.000Z';
  const original = { id: 'saved', type: 'meal' as const, createdAt: now, occurredAt: now, mealType: '午餐' as const, foodName: '饭', portion: '', note: '',
    imageUri: 'saved-a', beforeImageUris: ['saved-a', 'saved-b'], source: 'photo' as const, estimateStatus: 'unknown' as const, revision: 1 };
  data.meals.push({ ...original, revision: 2, revisions: [original] });
  const drafts = { 'meal-saved': { beforeImageUris: [] } };
  const bytes = await backup.createBackupArchive(data, [
    { uri: 'saved-a', kind: 'image', bytes: new Uint8Array([0xff, 0xd8, 0xff, 1]), extension: 'jpg' },
    { uri: 'saved-b', kind: 'image', bytes: new Uint8Array([0xff, 0xd8, 0xff, 2]), extension: 'jpg' },
  ], now, { drafts });
  const parsed = await backup.parseBackupArchive(bytes);
  const before = backup.canonicalJson(parsed);
  const stored = storedDrafts(parsed.drafts);
  const result = await stored.storage.loadDraft<Record<string, unknown>>('meal-saved');
  assert.equal(result!.imageUri, undefined); assert.equal(Object.hasOwn(result!, 'imageUri'), true);
  assert.deepEqual(result!.beforeImageUris, []);
  assert.equal(backup.canonicalJson(parsed), before);
  assert.deepEqual(parsed.data.meals[0].revisions![0].beforeImageUris, parsed.data.meals[0].beforeImageUris);
});
