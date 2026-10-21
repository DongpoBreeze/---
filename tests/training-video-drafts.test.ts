import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import * as backup from '../src/backup';
import * as domain from '../src/domain';
import * as localStore from '../src/local-store';
import * as mealPhotos from '../src/meal-photos';
import { emptyData, type AppData, type TrainingRecord } from '../src/types';
import type { TrainingDraft } from '../src/ui/app-types';

function compiled(path: string) {
  return ts.transpileModule(readFileSync(resolve(process.cwd(), path), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText;
}

function execute<T>(code: string, dependencies: Record<string, unknown>): T {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)((id: string) => {
    if (!(id in dependencies)) throw new Error(`Unexpected dependency: ${id}`);
    return dependencies[id];
  }, module, module.exports);
  return module.exports as T;
}

const storageCode = compiled('src/storage.ts');
const hookCode = compiled('src/ui/useFormDraft.ts');
const formCode = compiled('src/ui/training-form.tsx');
const formatCode = compiled('src/ui/format.ts');
const now = '2026-10-21T03:00:00.000Z';
const originalUri = 'file:///original-training.mp4';
const replacementUri = 'file:///replacement-training.mp4';
const videoBytes = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 4, 3, 2, 1]);

function record(mode: 'strength' | 'cardio' = 'strength'): TrainingRecord {
  return {
    id: 'saved-training', type: 'training', createdAt: now, occurredAt: now, exercise: '训练视频回归', mode,
    durationMinutes: mode === 'cardio' ? 20 : undefined,
    sets: mode === 'strength' ? [{ reps: 10, weight: 20, unit: 'kg' }] : [],
    note: '', pain: 'unknown', controlled: 'unknown', rir: 'unknown', videoUri: originalUri,
  };
}

function stored(data: AppData, drafts: Record<string, unknown> = {}) {
  const values = new Map([[localStore.DATA_KEY, JSON.stringify({ storageVersion: 1, data, drafts })]]);
  const store = {
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => { values.set(key, value); },
    removeItem: async (key: string) => { values.delete(key); },
  };
  const storage = execute<typeof import('../src/storage')>(storageCode, {
    '@react-native-async-storage/async-storage': { ...store, getAllKeys: async () => [] },
    'expo-document-picker': {}, 'expo-file-system/legacy': {}, 'expo-sharing': {}, 'expo-crypto': {},
    'react-native': { Platform: { OS: 'web' } }, './types': {}, './backup': backup, './local-store': localStore,
    './storage-web': { webSnapshotStore: store, webMediaKeys: async () => [] }, './meal-photos': mealPhotos,
  });
  return { storage, snapshot: () => localStore.parseLocalSnapshot(values.get(localStore.DATA_KEY)!) };
}

type Element = { type: unknown; props: Record<string, any> };
type HookSlot = { value?: any; deps?: readonly unknown[]; cleanup?: () => void };
const sameDeps = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined) => Boolean(a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index])));

// Run the production form, draft/session hooks and JSON repository together.
// Only native rendering, the file picker and the media-copy boundary are replaced.
async function mount(store: ReturnType<typeof stored>, initial?: TrainingRecord) {
  const slots: HookSlot[] = [];
  const pendingEffects: Array<() => void> = [];
  let cursor = 0;
  let dirty = true;
  let active = true;
  let tree: Element;
  let closed = 0;
  const submitted: TrainingDraft[] = [];
  const react = {
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Element => ({ type, props: { ...props, children } }),
    Fragment: Symbol('Fragment'),
    useState: (initialValue: unknown) => {
      const index = cursor++;
      const slot = slots[index] ??= { value: typeof initialValue === 'function' ? initialValue() : initialValue };
      return [slot.value, (update: unknown) => {
        const next = typeof update === 'function' ? update(slot.value) : update;
        if (!Object.is(next, slot.value)) { slot.value = next; dirty = true; }
      }];
    },
    useRef: (value: unknown) => {
      const slot = slots[cursor++] ??= { value: { current: value } };
      return slot.value;
    },
    useCallback: (callback: unknown, deps: readonly unknown[]) => {
      const slot = slots[cursor++] ??= {};
      if (!sameDeps(slot.deps, deps)) { slot.value = callback; slot.deps = deps; }
      return slot.value;
    },
    useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => {
      const slot = slots[cursor++] ??= {};
      if (sameDeps(slot.deps, deps)) return;
      slot.deps = deps;
      pendingEffects.push(() => { slot.cleanup?.(); slot.cleanup = effect() || undefined; });
    },
  };
  const native = { Platform: { OS: 'web' }, Pressable: 'Pressable', Text: 'Text', TextInput: 'TextInput', View: 'View', StyleSheet: {} };
  const hooks = execute<typeof import('../src/ui/useFormDraft')>(hookCode, { react, '../storage': store.storage });
  const form = execute<typeof import('../src/ui/training-form')>(formCode, {
    react, 'react-native': native,
    'expo-image-picker': {
      MediaTypeOptions: { Videos: 'videos' }, requestMediaLibraryPermissionsAsync: async () => ({ granted: true }),
      launchImageLibraryAsync: async () => ({ canceled: false, assets: [{ uri: replacementUri }] }),
    },
    '@expo/vector-icons': { Ionicons: 'Ionicons' },
    '../storage': { ...store.storage, persistMedia: async (uri: string) => uri },
    '../domain': domain, './useFormDraft': hooks,
    './components': {
      ...Object.fromEntries(['Banner', 'Choice', 'DraftStatus', 'Field', 'Legend', 'Note', 'Sheet', 'SmallButton', 'VideoAttachment'].map((name) => [name, name])),
      useBaseStyles: () => ({}),
    },
    './format': execute(formatCode, { 'react-native': native, '../domain': domain }),
    './theme': {}, './theme-provider': { useTheme: () => ({ color: {}, type: {}, scheme: 'light' }), useThemedStyles: () => ({}) },
  });
  const draftKey = `training-${initial?.id ?? 'new'}`;
  const session = { id: 1, epoch: 0, isActive: () => active };
  const props = {
    initial, draftKey, session, history: [], exerciseTemplates: [], onSaveTemplate: async () => {}, onClose: () => { closed++; },
    onSave: async (draft: TrainingDraft) => {
      submitted.push(draft);
      if (!initial) return;
      const data = store.snapshot().data;
      await store.storage.saveData({ ...data, trainings: data.trainings.map((item) => item.id === initial.id ? { ...item, ...draft, updatedAt: now } : item) });
    },
  };
  const flush = async () => {
    for (let pass = 0; pass < 30; pass++) {
      if (dirty) {
        dirty = false; cursor = 0;
        tree = form.TrainingForm(props) as unknown as Element;
        pendingEffects.splice(0).forEach((effect) => effect());
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (!dirty) return;
    }
    throw new Error('Training form failed to settle');
  };
  const elements = (): Element[] => {
    const result: Element[] = [];
    const visit = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object' && 'props' in value) {
        const element = value as Element;
        result.push(element); visit(element.props.children);
      }
    };
    visit(tree); return result;
  };
  const find = (predicate: (element: Element) => boolean) => {
    const found = elements().find(predicate);
    assert.ok(found, 'Expected training form control'); return found;
  };
  const act = async (action: () => unknown) => { await action(); await flush(); };
  await flush();
  assert.equal(find((element) => element.type === 'DraftStatus').props.error, '');
  return {
    draftKey, submitted, closed: () => closed,
    video: () => elements().find((element) => element.type === 'VideoAttachment')?.props.uri,
    note: () => find((element) => element.type === 'Field' && element.props.label === '备注（可选）').props.value,
    remove: () => act(() => find((element) => element.props.accessibilityLabel === '移除训练视频').props.onPress()),
    add: () => act(() => find((element) => element.type === 'Pressable' && element.props.onPress && element.props.children?.[0]?.props?.children?.[0] === '添加').props.onPress()),
    close: () => act(() => find((element) => element.type === 'Sheet').props.onClose()),
    save: async () => {
      await act(() => find((element) => element.type === 'Sheet').props.onSave());
      assert.equal(elements().some((element) => element.type === 'Banner'), false);
    },
    dispose: () => { active = false; slots.forEach((slot) => slot.cleanup?.()); },
  };
}

for (const mode of ['strength', 'cardio'] as const) {
  test(`${mode}: removing a saved video survives close/reopen and saves an absent record URI`, async (t) => {
    const original = record(mode);
    const store = stored({ ...emptyData(), trainings: [original] });
    const first = await mount(store, original); t.after(first.dispose);
    assert.equal(first.video(), originalUri);
    await first.remove(); assert.equal(first.video(), undefined);
    await first.close(); assert.equal(first.closed(), 1); first.dispose();
    assert.equal((store.snapshot().drafts[first.draftKey] as { videoUri: string }).videoUri, '');
    assert.equal(store.snapshot().data.trainings[0].videoUri, originalUri, 'closing must not mutate the saved record');
    assert.deepEqual(backup.collectDraftMediaReferences(store.snapshot().drafts), []);
    assert.deepEqual(backup.collectMediaReferences(store.snapshot().data), [{ uri: originalUri, kind: 'video' }]);

    const reopened = await mount(store, original); t.after(reopened.dispose);
    assert.equal(reopened.video(), undefined);
    await reopened.save();
    assert.equal(reopened.submitted.length, 1); assert.equal(reopened.submitted[0].videoUri, undefined);
    assert.equal(reopened.submitted[0].mode, mode); assert.equal(reopened.closed(), 1);
    assert.equal(Object.hasOwn(store.snapshot().data.trainings[0], 'videoUri'), false);
    assert.equal(store.snapshot().drafts[first.draftKey], undefined);
    reopened.dispose();
    const restarted = await mount(store, store.snapshot().data.trainings[0]); t.after(restarted.dispose);
    assert.equal(restarted.video(), undefined);
  });
}

test('an unsaved video removal survives ZIP export, media remapping, restore and another form session', async (t) => {
  const original = record();
  const store = stored({ ...emptyData(), trainings: [original] });
  const first = await mount(store, original); t.after(first.dispose);
  await first.remove(); await first.close(); first.dispose();
  const snapshot = store.snapshot();
  const archive = await backup.parseBackupArchive(await backup.createBackupArchive(snapshot.data, [
    { uri: originalUri, kind: 'video', bytes: videoBytes, extension: 'mp4' },
  ], now, { drafts: snapshot.drafts }));
  assert.equal((archive.drafts[first.draftKey] as { videoUri: string }).videoUri, '');
  assert.equal(archive.media.length, 1, 'the unchanged saved record still owns its video');
  const replacements = new Map([[archive.media[0].path, 'file:///restored-original.mp4']]);
  const restored = stored(backup.remapBackupMedia(archive.data, replacements), backup.remapDraftMedia(archive.drafts, replacements));
  const reopened = await mount(restored, restored.snapshot().data.trainings[0]); t.after(reopened.dispose);
  assert.equal(reopened.video(), undefined);
  await reopened.save();
  const saved = restored.snapshot();
  const finalArchive = await backup.parseBackupArchive(await backup.createBackupArchive(saved.data, [], now, { drafts: saved.drafts }));
  assert.equal(finalArchive.data.trainings[0].videoUri, undefined);
  assert.deepEqual(finalArchive.media, []); assert.deepEqual(finalArchive.drafts, {});
});

test('replacing a video persists the new source across reopen without changing the original before save', async (t) => {
  const original = record();
  const store = stored({ ...emptyData(), trainings: [original] });
  const first = await mount(store, original); t.after(first.dispose);
  await first.remove(); await first.add(); assert.equal(first.video(), replacementUri);
  await first.close(); first.dispose();
  assert.equal(store.snapshot().data.trainings[0].videoUri, originalUri);
  assert.deepEqual(backup.collectDraftMediaReferences(store.snapshot().drafts), [{ uri: replacementUri, kind: 'video' }]);
  const reopened = await mount(store, original); t.after(reopened.dispose);
  assert.equal(reopened.video(), replacementUri); await reopened.save();
  assert.equal(reopened.submitted[0].videoUri, replacementUri);
  assert.equal(store.snapshot().data.trainings[0].videoUri, replacementUri);
});

test('legacy partial drafts without video fields retain the existing video and other draft edits', async (t) => {
  const original = record();
  const store = stored({ ...emptyData(), trainings: [original] }, { 'training-saved-training': { note: '旧草稿备注' } });
  const form = await mount(store, original); t.after(form.dispose);
  assert.equal(form.video(), originalUri); assert.equal(form.note(), '旧草稿备注');
  assert.deepEqual(store.snapshot().drafts['training-saved-training'], { note: '旧草稿备注' }, 'reading must not rewrite the old draft');
  await form.save();
  assert.equal(form.submitted[0].videoUri, originalUri);
  assert.equal(store.snapshot().data.trainings[0].note, '旧草稿备注');
});

test('new forms persist a JSON-safe empty video state without inventing a media reference', async (t) => {
  const store = stored(emptyData());
  const first = await mount(store); t.after(first.dispose);
  assert.equal(first.video(), undefined); await first.close(); first.dispose();
  assert.equal((store.snapshot().drafts['training-new'] as { videoUri: string }).videoUri, '');
  assert.deepEqual(backup.collectDraftMediaReferences(store.snapshot().drafts), []);
  const reopened = await mount(store); t.after(reopened.dispose);
  assert.equal(reopened.video(), undefined);
});
