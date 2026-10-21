import assert from 'node:assert/strict';
import test from 'node:test';
import { DATA_KEY, LocalRepository, type SnapshotStore } from '../src/local-store';
import { emptyData } from '../src/types';
import { createWebAiSettingsStorage } from '../src/ai-settings-web';

test('height, weight, goal and calorie target survive reopening without changing existing health records', async () => {
  const values = new Map<string, string>();
  const storage: SnapshotStore = {
    async getItem(key) { return values.get(key) ?? null; },
    async setItem(key, value) { values.set(key, value); },
    async removeItem(key) { values.delete(key); },
  };
  const data = emptyData();
  data.profile = { heightCm: 173.5, weightKg: 67.2, goal: 'fat-loss', calorieTarget: 2100 };
  const drafts = { 'meal-new': { foodName: 'unsaved record retained' } };
  await new LocalRepository(storage).commit({ storageVersion: 1, data, drafts });
  const reopened = await new LocalRepository(storage).read();
  assert.deepEqual(reopened.data.profile, data.profile);
  assert.deepEqual(reopened.data, data);
  assert.deepEqual(reopened.drafts, drafts);
});

test('an interrupted profile save at either staging or commit retains previously saved height and weight after reopen', async () => {
  for (const failedKey of [DATA_KEY, `${DATA_KEY}.tmp`]) {
    const values = new Map<string, string>();
    let interrupt = false;
    const storage: SnapshotStore = {
      async getItem(key) { return values.get(key) ?? null; },
      async setItem(key, value) {
        if (interrupt && key === failedKey) throw new Error('simulated interrupted write');
        values.set(key, value);
      },
      async removeItem(key) { values.delete(key); },
    };
    const data = { ...emptyData(), profile: { heightCm: 173.5, weightKg: 67.2, goal: 'health' as const } };
    const repository = new LocalRepository(storage);
    await repository.commit({ storageVersion: 1, data, drafts: {} });
    interrupt = true;
    await assert.rejects(repository.commit({ storageVersion: 1, data: { ...data, profile: { weightKg: 70 } }, drafts: {} }), /interrupted write/);
    assert.deepEqual((await new LocalRepository(storage).read()).data, data);
  }
});

test('unavailable browser configuration storage rejects every attempt instead of using session memory', async () => {
  const storage = createWebAiSettingsStorage();
  await assert.rejects(storage.read(), /不支持本机配置存储/);
  await assert.rejects(storage.read(), /不支持本机配置存储/);
  await assert.rejects(storage.write('synthetic configuration'), /不支持本机配置存储/);
});
