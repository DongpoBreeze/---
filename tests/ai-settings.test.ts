import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiSettingsStore, type AiSettingsStorage } from '../src/ai-settings-store';
import { AI_REQUEST_TIMEOUT_MS, MAX_MEAL_ANALYSIS_STAGES } from '../src/ai-provider';
import type { AiSettings } from '../src/ai-provider';

const settings: AiSettings = { baseUrl: 'https://provider.example/v1/responses', apiKey: 'mock-private-key', protocol: 'responses', model: 'test/model', reasoningEffort: '' };

function storage(initial: string | null = null): AiSettingsStorage & { value(): string | null } {
  let raw = initial;
  return { read: async () => raw, write: async (value) => { raw = value; }, remove: async () => { raw = null; }, value: () => raw };
}

test('native store restores validated settings, strips unrelated fields and exposes immutable snapshots', async () => {
  const native = storage(); const store = createAiSettingsStore(native);
  assert.equal(await store.load(), null);
  await store.save({ ...settings, availableModels: ['not persisted'], healthRecords: ['not persisted'] } as AiSettings);
  const persisted = JSON.parse(native.value()!);
  assert.deepEqual(Object.keys(persisted).sort(), Object.keys(settings).sort());
  assert.equal(persisted.baseUrl, 'https://provider.example/v1');
  const saved = store.get()!; saved.apiKey = 'mutated';
  assert.equal(store.get()?.apiKey, settings.apiKey);
  const reloaded = createAiSettingsStore(native);
  assert.equal((await reloaded.load())?.apiKey, settings.apiKey);
  await reloaded.clear(); assert.equal(reloaded.get(), null); assert.equal(native.value(), null);
});

test('existing custom effort strings survive native reloads, edits and request snapshots unchanged', async () => {
  const effort = 'Vendor.Ultra-2_0';
  const native = storage(JSON.stringify({ ...settings, reasoningEffort: effort }));
  const store = createAiSettingsStore(native);
  assert.equal((await store.load())?.reasoningEffort, effort);
  const request = store.beginRequest();
  assert.equal(request.settings.reasoningEffort, effort);
  request.dispose();
  const next = 'x'.repeat(64);
  await store.save({ ...settings, reasoningEffort: next });
  assert.equal((await createAiSettingsStore(native).load())?.reasoningEffort, next);
  assert.throws(() => store.save({ ...settings, reasoningEffort: 'bad effort' }));
  assert.equal(store.get()?.reasoningEffort, next);
  await store.save({ ...settings, reasoningEffort: '' });
  assert.equal((await createAiSettingsStore(native).load())?.reasoningEffort, '');
});

test('a new store restores all saved fields and deletion survives reopening', async () => {
  const local = storage();
  const session = createAiSettingsStore(local);
  assert.equal(await session.load(), null);
  const saved = { ...settings, baseUrl: 'https://provider.example/v1', protocol: 'chat_completions' as const, reasoningEffort: 'Vendor.Ultra-2_0' };
  await session.save(saved);
  assert.deepEqual(await createAiSettingsStore(local).load(), saved);
  await session.clear();
  assert.equal(session.get(), null);
  assert.equal(await createAiSettingsStore(local).load(), null);
});

test('a missing storage adapter cannot report a successful save or clear', async () => {
  const store = createAiSettingsStore(null as unknown as AiSettingsStorage);
  await assert.rejects(store.load(), /无法读取本机/);
  await assert.rejects(store.save(settings), /无法将 AI 设置保存到本机/);
  assert.equal(store.get(), null);
  await assert.rejects(store.clear(), /无法清除本机/);
});

test('empty or corrupt persisted settings are not treated as an absent configuration', async () => {
  for (const raw of ['', '{broken', JSON.stringify({ apiKey: settings.apiKey })]) {
    const local = storage(raw);
    const store = createAiSettingsStore(local);
    await assert.rejects(store.load(), /已保存的 AI 设置无效/);
    assert.equal(local.value(), raw);
    assert.equal(store.get(), null);
    await assert.rejects(store.load(), /已保存的 AI 设置无效/);
  }
});

test('a pending write is not acknowledged and an interrupted write keeps the prior saved configuration', async () => {
  const initial = { ...settings, baseUrl: 'https://provider.example/v1' };
  let raw = JSON.stringify(initial);
  let rejectWrite!: (error: Error) => void;
  const local: AiSettingsStorage = {
    read: async () => raw,
    write: () => new Promise((_resolve, reject) => { rejectWrite = reject; }),
    remove: async () => { raw = ''; },
  };
  const store = createAiSettingsStore(local);
  await store.load();
  let acknowledged = false;
  const saving = store.save({ ...settings, model: 'replacement' }).then(() => { acknowledged = true; });
  await Promise.resolve();
  assert.equal(acknowledged, false);
  assert.deepEqual(store.get(), initial);
  assert.deepEqual(await createAiSettingsStore(local).load(), initial);
  rejectWrite(new Error('simulated interruption'));
  await assert.rejects(saving, /原配置已保留/);
  assert.equal(acknowledged, false);
  assert.deepEqual(await createAiSettingsStore(local).load(), initial);
});

test('secure-storage and corrupt-setting errors are surfaced without raw credentials and are retryable', async () => {
  let fail = true;
  const store = createAiSettingsStore({ read: async () => { if (fail) throw new Error(settings.apiKey); return JSON.stringify(settings); }, write: async () => { throw new Error(settings.apiKey); }, remove: async () => { throw new Error(settings.apiKey); } });
  await assert.rejects(store.load(), (error: unknown) => error instanceof Error && !error.message.includes(settings.apiKey));
  fail = false; await store.load();
  await assert.rejects(store.save({ ...settings, model: 'next' }));
  assert.equal(store.get()?.model, settings.model);
  await assert.rejects(store.clear()); assert.equal(store.get()?.apiKey, settings.apiKey);
  const bad = createAiSettingsStore(storage(`{"apiKey":"${settings.apiKey}"}`));
  await assert.rejects(bad.load(), (error: unknown) => error instanceof Error && !error.message.includes(settings.apiKey));
});

test('a delayed initial read and concurrent writes cannot overwrite the latest configuration', async () => {
  let finish!: (value: string | null) => void;
  let persisted: string | null = null;
  const store = createAiSettingsStore({ read: () => new Promise((resolve) => { finish = resolve; }), write: async (value) => { persisted = value; }, remove: async () => { persisted = null; } });
  const load = store.load(); await Promise.resolve();
  const first = store.save(settings);
  const last = store.save({ ...settings, model: 'latest' });
  finish(null); await Promise.all([load, first, last]);
  assert.equal(store.get()?.model, 'latest');
  assert.equal(JSON.parse(persisted!).model, 'latest');
});

test('settings changes abort requests and discard an old snapshot across photo preprocessing', async () => {
  const store = createAiSettingsStore(storage()); await store.save(settings);
  const revision = store.version();
  const request = store.beginRequest(); request.assertCurrent();
  const saving = store.save({ ...settings, model: 'next' });
  assert.equal(request.signal.aborted, true);
  assert.ok(store.version() > revision);
  assert.throws(request.assertCurrent, /配置已更改/);
  assert.equal(request.settings.model, settings.model);
  await saving; request.dispose();
  const latest = store.beginRequest(); await store.clear();
  assert.throws(latest.assertCurrent, /配置已更改/); latest.dispose();
});

test('caller cancellation and the maximum three-stage analysis limit preserve local data', async (t) => {
  const store = createAiSettingsStore(storage()); await store.save(settings);
  const controller = new AbortController(); const request = store.beginRequest(controller.signal);
  controller.abort(); assert.equal(request.signal.aborted, true); assert.throws(request.assertCurrent, /取消/); request.dispose();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timed = store.beginRequest(); t.mock.timers.tick(AI_REQUEST_TIMEOUT_MS * MAX_MEAL_ANALYSIS_STAGES + 5_000);
  assert.equal(timed.signal.aborted, true); assert.throws(timed.assertCurrent, /超时/); timed.dispose();
  assert.equal(store.get()?.apiKey, settings.apiKey);
});
