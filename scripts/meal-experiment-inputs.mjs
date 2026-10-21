import { isAbsolute, relative, resolve } from 'node:path';

// Synthetic input contracts are available only to Node's isolated test workers.
// They replace input identities, never transport settings, budgets or validators.
const offlineContracts = new WeakSet();
const evidence = 'synthetic_offline_fixture_not_real_experiment';
const inside = (root, path) => {
  const rel = relative(resolve(root), resolve(path));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) freeze(entry);
    Object.freeze(value);
  }
  return value;
}

export function registerOfflineInputs(input) {
  if (!process.env.NODE_TEST_CONTEXT) throw new Error('Synthetic experiment inputs require the Node test runner.');
  const value = structuredClone(input);
  if (!isAbsolute(value.root) || value.evidence !== evidence || !Array.isArray(value.meals) || value.meals.length !== 3
    || new Set(value.meals.map((row) => row.mealId)).size !== 3
    || value.meals.some((row) => !/^(?:breakfast|dinner)_0[1-5]_offline_fixture$/.test(row.mealId)
      || typeof row.label !== 'string' || !row.label.includes('合成') || !Number.isSafeInteger(row.bytes) || row.bytes <= 0
      || !/^[a-f0-9]{64}$/.test(row.sha256))
    || !/^[a-f0-9]{64}$/.test(value.conciseSha)
    || ['latencyRunId', 'effortRunId', 'nutritionRunId'].some((key) => !/^offline-[A-Za-z0-9_-]+$/.test(value[key]))) {
    throw new Error('Invalid explicit synthetic experiment input contract.');
  }
  if (value.highInputs && (!Array.isArray(value.highInputs) || value.highInputs.length !== 3
    || value.highInputs.some((row, index) => row.mealId !== value.meals[index].mealId || row.sha256 !== value.meals[index].sha256
      || row.bytes !== value.meals[index].bytes || row.label !== value.meals[index].label
      || row.status !== (index === 2 ? 'timeout' : 'accepted') || !Number.isSafeInteger(row.attemptId) || row.attemptId <= 0
      || !Number.isFinite(row.elapsedMs) || row.elapsedMs < 0 || !Number.isFinite(row.firstTextMs) || row.firstTextMs < 0))) {
    throw new Error('Invalid synthetic historical outcome contract.');
  }
  offlineContracts.add(value);
  return freeze(value);
}

export function offlineInputs(options) {
  const value = options.offlineFixture;
  if (value === undefined) return null;
  if (!process.env.NODE_TEST_CONTEXT || !offlineContracts.has(value) || !options.runId?.startsWith('offline-')
    || typeof options.providerReader !== 'function' || !inside(value.root, options.outputDir)
    || ['sourceOutputDir', 'effortOutputDir', 'historyDir'].some((key) => options[key] && !inside(value.root, options[key]))) {
    throw new Error('Synthetic inputs cannot be used for a real or historical experiment.');
  }
  return value;
}

export function verifyOfflineProvider(options, provider, live = false) {
  if (!offlineInputs(options)) return;
  if (provider.baseUrl !== 'https://offline.invalid/v1' || provider.key !== 'offline-test-private-credential'
    || live && typeof globalThis.fetch?.mock !== 'object') {
    throw new Error('Synthetic experiments require the fixed offline provider and a mocked fetch for execution.');
  }
}

export function offlineEvidence(options) {
  return offlineInputs(options) ? { evidence } : {};
}

export function verifyOfflineEvidence(options, manifest) {
  const expected = offlineInputs(options) ? evidence : undefined;
  if (manifest.evidence !== expected) throw new Error('Synthetic and real experiment evidence cannot be mixed.');
}
