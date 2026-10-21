import assert from 'node:assert/strict';
import test from 'node:test';
import { APPEARANCE_KEY, parseAppearance, resolveAppearanceScheme, serializeAppearance, type AppearanceMode } from '../src/appearance';
import { createAppearanceStore, type AppearanceStorage } from '../src/appearance-store';

function memory(initial: string | null = null) {
  let value = initial;
  let reads = 0;
  const writes: string[] = [];
  const storage: AppearanceStorage = {
    read: async () => { reads += 1; return value; },
    write: async (next) => { writes.push(next); value = next; },
  };
  return { storage, writes, value: () => value, reads: () => reads };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test('a new installation follows the system, while explicit modes ignore subsequent system changes', async () => {
  const local = memory();
  const store = createAppearanceStore(local.storage);
  assert.equal(store.getSnapshot().ready, false);
  await store.load();
  assert.deepEqual(store.getSnapshot(), { mode: 'system', ready: true, saving: false, error: '' });
  for (const system of ['light', 'dark', null, undefined, 'unexpected']) {
    assert.equal(resolveAppearanceScheme('system', system), system === 'dark' ? 'dark' : 'light');
    assert.equal(resolveAppearanceScheme('light', system), 'light');
    assert.equal(resolveAppearanceScheme('dark', system), 'dark');
  }
  assert.deepEqual(local.writes, []);
});

test('appearance uses a separate versioned preference and rejects corrupt or unsupported settings', () => {
  assert.equal(APPEARANCE_KEY, '@health-compass/appearance-v1');
  for (const mode of ['system', 'light', 'dark'] as const) {
    assert.deepEqual(JSON.parse(serializeAppearance(mode)), { version: 1, mode });
    assert.equal(parseAppearance(serializeAppearance(mode)), mode);
  }
  assert.equal(parseAppearance(null), 'system');
  for (const raw of ['', '{', 'null', '[]', '"dark"', '{"mode":"dark"}', '{"version":2,"mode":"dark"}', '{"version":1,"mode":"sepia"}']) {
    assert.throws(() => parseAppearance(raw), /外观设置无效/);
  }
  assert.throws(() => serializeAppearance('invalid' as AppearanceMode), /有效/);
});

test('all choices persist across fresh store instances without writing unrelated data', async () => {
  const local = memory();
  let store = createAppearanceStore(local.storage);
  await store.load();
  for (const mode of ['dark', 'light', 'system'] as const) {
    await store.setMode(mode);
    assert.equal(store.getSnapshot().mode, mode);
    assert.equal(store.getSnapshot().saving, false);
    assert.deepEqual(Object.keys(JSON.parse(local.value()!)).sort(), ['mode', 'version']);
    store = createAppearanceStore(local.storage);
    await store.load();
    assert.equal(store.getSnapshot().mode, mode);
  }
});

test('synchronous browser restoration selects the stored theme before rendering and does not read twice', async () => {
  const local = memory(serializeAppearance('dark'));
  const store = createAppearanceStore({ ...local.storage, readSync: local.value });
  assert.deepEqual(store.getSnapshot(), { mode: 'dark', ready: true, saving: false, error: '' });
  const initial = store.getSnapshot();
  await store.load();
  assert.equal(store.getSnapshot(), initial);
  assert.equal(local.reads(), 0);
  assert.ok(Object.isFrozen(initial));
});

test('failed restoration safely follows the system, exposes a safe error, and does not overwrite storage', async () => {
  let writes = 0;
  const store = createAppearanceStore({
    read: async () => { throw new Error('private platform details'); },
    write: async () => { writes += 1; },
  });
  await store.load();
  assert.equal(store.getSnapshot().mode, 'system');
  assert.equal(store.getSnapshot().ready, true);
  assert.match(store.getSnapshot().error, /无法读取外观设置/);
  assert.doesNotMatch(store.getSnapshot().error, /private/);
  assert.equal(writes, 0);
  await store.setMode('dark');
  assert.equal(store.getSnapshot().mode, 'dark');
  assert.equal(store.getSnapshot().error, '');
  assert.equal(writes, 1);
  const browser = createAppearanceStore({ ...memory().storage, readSync: () => { throw new Error('blocked'); } });
  assert.equal(browser.getSnapshot().ready, true);
  assert.match(browser.getSnapshot().error, /无法读取外观设置/);
});

test('corrupt stored settings remain untouched until the user explicitly chooses a replacement', async () => {
  const local = memory('{broken-preference');
  const store = createAppearanceStore(local.storage);
  await store.load();
  assert.equal(store.getSnapshot().mode, 'system');
  assert.match(store.getSnapshot().error, /外观设置无效/);
  assert.equal(local.value(), '{broken-preference');
  assert.deepEqual(local.writes, []);
  await store.setMode('system');
  assert.equal(local.value(), serializeAppearance('system'));
  assert.equal(store.getSnapshot().error, '');
  const browser = createAppearanceStore({ ...local.storage, readSync: () => '{broken-preference' });
  assert.equal(browser.getSnapshot().ready, true);
  assert.match(browser.getSnapshot().error, /外观设置无效/);
});

test('a failed write rolls back the preview, reports failure, and allows retrying the same choice', async () => {
  const local = memory(serializeAppearance('light'));
  const gate = deferred<void>();
  let fail = true;
  const store = createAppearanceStore({
    read: local.storage.read,
    write: async (raw) => {
      await gate.promise;
      if (fail) throw new Error('private storage details');
      await local.storage.write(raw);
    },
  });
  await store.load();
  const pending = store.setMode('dark');
  assert.equal(store.getSnapshot().mode, 'dark');
  assert.equal(store.getSnapshot().saving, true);
  const rejection = assert.rejects(pending, /外观.*保存失败/);
  gate.resolve();
  await rejection;
  assert.equal(store.getSnapshot().mode, 'light');
  assert.equal(local.value(), serializeAppearance('light'));
  assert.equal(store.getSnapshot().saving, false);
  assert.match(store.getSnapshot().error, /外观.*保存失败/);
  assert.doesNotMatch(store.getSnapshot().error, /private/);
  fail = false;
  await store.setMode('dark');
  assert.equal(store.getSnapshot().mode, 'dark');
  assert.equal(local.value(), serializeAppearance('dark'));
  assert.equal(store.getSnapshot().error, '');
});

test('an initial read cannot overwrite a later user choice or race its persistence', async () => {
  const read = deferred<string | null>();
  const local = memory();
  const store = createAppearanceStore({ read: () => read.promise, write: local.storage.write });
  const hydration = store.load();
  await flush();
  const save = store.setMode('dark');
  assert.equal(store.getSnapshot().mode, 'dark');
  await flush();
  assert.deepEqual(local.writes, []);
  read.resolve(serializeAppearance('light'));
  await hydration;
  assert.equal(store.getSnapshot().mode, 'dark');
  await save;
  assert.equal(store.getSnapshot().ready, true);
  assert.equal(local.value(), serializeAppearance('dark'));
});

test('a choice made before hydration starts still takes precedence, and failure restores the actual stored mode', async () => {
  const read = deferred<string | null>();
  const store = createAppearanceStore({ read: () => read.promise, write: async () => { throw new Error('full'); } });
  const save = store.setMode('dark');
  const rejection = assert.rejects(save, /保存失败/);
  const hydration = store.load();
  assert.equal(store.getSnapshot().mode, 'dark');
  read.resolve(serializeAppearance('light'));
  await hydration;
  assert.equal(store.getSnapshot().mode, 'dark');
  await rejection;
  assert.equal(store.getSnapshot().mode, 'light');
  assert.equal(store.getSnapshot().saving, false);
});

test('rapid choices serialize writes and retain the latest preview while earlier writes complete', async () => {
  const writes: Array<{ raw: string; done: ReturnType<typeof deferred<void>> }> = [];
  let persisted: string | null = null;
  const store = createAppearanceStore({
    read: async () => null,
    write: async (raw) => {
      const done = deferred<void>();
      writes.push({ raw, done });
      await done.promise;
      persisted = raw;
    },
  });
  await store.load();
  const first = store.setMode('dark');
  const middle = store.setMode('light');
  const last = store.setMode('system');
  await flush();
  assert.equal(writes.length, 1);
  assert.equal(store.getSnapshot().mode, 'system');
  writes[0].done.resolve();
  await first;
  await flush();
  assert.equal(writes.length, 2);
  assert.equal(store.getSnapshot().mode, 'system');
  assert.equal(store.getSnapshot().saving, true);
  writes[1].done.resolve();
  await middle;
  await flush();
  assert.equal(writes.length, 3);
  writes[2].done.resolve();
  await last;
  assert.deepEqual(writes.map(({ raw }) => parseAppearance(raw)), ['dark', 'light', 'system']);
  assert.equal(persisted, serializeAppearance('system'));
  assert.equal(store.getSnapshot().saving, false);
  assert.equal(store.getSnapshot().mode, 'system');
});

test('an older failed write cannot roll back a newer choice or leave a stale error', async () => {
  const local = memory(serializeAppearance('light'));
  let attempts = 0;
  const store = createAppearanceStore({
    read: local.storage.read,
    write: async (raw) => { if (++attempts === 1) throw new Error('full'); await local.storage.write(raw); },
  });
  await store.load();
  const first = assert.rejects(store.setMode('dark'), /保存失败/);
  const last = store.setMode('system');
  await Promise.all([first, last]);
  assert.deepEqual(store.getSnapshot(), { mode: 'system', ready: true, saving: false, error: '' });
  assert.equal(local.value(), serializeAppearance('system'));
});

test('the latest failed write rolls back to the preceding successful queued choice', async () => {
  const local = memory(serializeAppearance('light'));
  let attempts = 0;
  const store = createAppearanceStore({
    read: local.storage.read,
    write: async (raw) => { if (++attempts === 2) throw new Error('full'); await local.storage.write(raw); },
  });
  await store.load();
  const first = store.setMode('dark');
  const last = assert.rejects(store.setMode('system'), /保存失败/);
  await Promise.all([first, last]);
  assert.equal(store.getSnapshot().mode, 'dark');
  assert.equal(local.value(), serializeAppearance('dark'));
  assert.match(store.getSnapshot().error, /保存失败/);
});

test('hydration is idempotent and invalid API input cannot change the last good preference', async () => {
  const local = memory(serializeAppearance('dark'));
  const store = createAppearanceStore(local.storage);
  const first = store.load();
  const second = store.load();
  assert.equal(first, second);
  await first;
  await store.setMode('light');
  const saved = store.getSnapshot();
  await assert.rejects(store.setMode('sepia' as AppearanceMode), /有效/);
  await store.load();
  assert.equal(store.getSnapshot(), saved);
  assert.equal(local.reads(), 1);
  assert.equal(local.value(), serializeAppearance('light'));
});
