import { beforeEach } from 'node:test';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mealRecognitionInstructions } from '../shared/nutrition.mjs';
import { registerOfflineInputs } from './meal-experiment-inputs.mjs';
import { LATENCY_CONFIG, LATENCY_PROFILES, makeLatencySchedule, sha256 } from './meal-latency-core.mjs';

beforeEach((t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Offline test attempted an unmocked supplier request.'); });
});

export const fakeProvider = { baseUrl: 'https://offline.invalid/v1', key: 'offline-test-private-credential', model: 'configured-chat-model', reasoningEffort: 'high' };
export const ranges = { calories: { min: 120, max: 160 }, protein: { min: 2, max: 5 }, carbs: { min: 22, max: 30 }, fat: { min: 1, max: 3 } };
export function recognition(changes = {}) {
  return { foodName: '米饭', components: [{ foodId: null, label: '熟米饭', confidence: 0.8, category: 'grain', candidates: [],
    evidence: ['白色颗粒可见'], uncertainty: ['无法确定具体米种'], region: null,
    nutritionEstimate: { basisGrams: 100, method: 'typical_recipe', per100g: structuredClone(ranges),
      recipeBasis: '通常熟米饭含水量的参考范围', assumptions: ['烹调含水量未知'], confidence: 0.6 } }],
    unresolved: [], assumptions: [], advice: '按实际情况记录。', confidence: 0.8, ...changes };
}
export function fixtureManifest(runId = 'offline-fixture') {
  const meals = ['breakfast', 'dinner'].flatMap((prefix) => Array.from({ length: 5 }, (_, index) => ({ mealId: `${prefix}_${String(index + 1).padStart(2, '0')}_fixture`,
    prepared: { path: `photos/${prefix}_${index + 1}.jpg`, sha256: 'fixture', bytes: 4, width: 1, height: 1, mime: 'image/jpeg' } })));
  return { schemaVersion: 'meal-latency-manifest.v1', runId, manifestSha256: 'fixture', config: LATENCY_CONFIG, profiles: LATENCY_PROFILES, meals,
    pilotSchedule: makeLatencySchedule(meals, runId), confirmationSchedules: Object.fromEntries(Object.keys(LATENCY_PROFILES)
      .map((id) => [id, makeLatencySchedule(meals, runId, 'confirm', id)])) };
}
export function acceptedRecord(task, elapsedMs = 10_000, changes = {}) {
  const analysis = recognition();
  const stage = { attemptId: task.sequence, stage: 'whole', transportCompleted: true, businessAccepted: true,
    providerCompleted: true, accepted: true, usage: null, analysis, recognition: analysis,
    captureStatus: 'saved', timing: { firstTextMs: 100, firstTextDeltaMs: 100, responseCompletedMs: elapsedMs - 2,
      businessValidatedMs: elapsedMs - 1, returnedMs: elapsedMs } };
  return { ...task, status: 'accepted', stages: [stage], transportCompleted: true, businessAccepted: true,
    analysis, recognition: analysis, captureStatus: 'saved', elapsedMs, timing: stage.timing, error: null, ...changes };
}
export function assessment(runId, changes = {}) {
  return { schemaVersion: 'meal-latency-quality.v1', runId, evidence: 'ai_observation_not_human_truth', reviewer: 'independent offline fixture',
    reviewedAt: '2026-10-18T00:00:00Z', profiles: Object.fromEntries(Object.keys(LATENCY_PROFILES).map((id) => [id,
      { obviousDegradation: false, notes: ['Fixture evidence only; no real quality claim.'], scores: { recognition: 40, evidenceAndUncertainty: 16, nutritionReferenceUsefulness: 24 }, ...changes[id] }])) };
}
export async function withTemporaryDirectory(run) {
  const prefix = resolve(tmpdir(), 'meal-latency-');
  const directory = await mkdtemp(prefix);
  try { return await run(directory); }
  finally {
    const target = resolve(directory);
    if (!target.startsWith(prefix) || target === resolve(tmpdir())) throw new Error('Refuse cleanup outside the test temporary directory.');
    await rm(target, { recursive: true, force: true });
  }
}
export const sse = (value) => `data: ${JSON.stringify(value)}\n\n`;
export function completedEnvelope(value = recognition(), usage) {
  return { status: 'completed', model: 'provider-reported-model', ...(usage ? { usage } : {}), output: [{ type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: typeof value === 'string' ? value : JSON.stringify(value) }] }] };
}
export function completeSse(value = recognition(), usage) {
  return sse({ type: 'response.created' }) + sse({ type: 'response.output_text.delta', delta: JSON.stringify(value) })
    + sse({ type: 'response.completed', response: completedEnvelope(value, usage) });
}
export function injectedProvider({ calls = [], result = recognition(), usage = null, fail = null, clockStep = () => {} } = {}) {
  return async (settings, kind, payload, _signal, options) => {
    const stage = { stage: 'whole', stageCount: 1 };
    try { await options.beforeRequest(stage); }
    catch { const error = new Error('Mandatory reservation failed.'); error.code = 'request_not_started'; throw error; }
    calls.push({ settings, kind, payload, maxStages: options.maxStages, promptProfile: options.promptProfile, timeoutMs: options.timeoutMs });
    clockStep(10); options.onTransport({ ...stage, type: 'headers', httpStatus: 200 });
    clockStep(10); options.onTransport({ ...stage, type: 'chunk', bytes: Buffer.from(sse({ type: 'response.created' })) });
    clockStep(10); options.onTransport({ ...stage, type: 'chunk', bytes: Buffer.from(sse({ type: 'response.output_text.delta', delta: 'x' })) });
    if (fail) {
      options.onDiagnostic({ ...stage, type: 'stage_error', code: fail, transportCompleted: false, httpStatus: 200 });
      const error = new Error('Offline fixture failure.'); error.code = fail; throw error;
    }
    clockStep(10); options.onTransport({ ...stage, type: 'chunk', bytes: Buffer.from(sse({ type: 'response.completed', response: completedEnvelope(result, usage) })) });
    options.onTransport({ ...stage, type: 'transport_complete', usage, httpStatus: 200 });
    clockStep(10); options.onDiagnostic({ ...stage, type: 'stage_result', recognition: result, analysis: result, transportCompleted: true, httpStatus: 200, usage });
    clockStep(10); options.onDiagnostic({ ...stage, type: 'returned', analysis: result, fallbackReason: null });
    return { analysis: result, model: settings.model, stageCount: 1, createdAt: '2026-10-18T00:00:00Z' };
  };
}

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const evidence = 'synthetic_offline_fixture_not_real_experiment';
// A generated 2x2 grey checkerboard. Each meal gets a JPEG comment identifying
// its synthetic origin; no private photo or historical artifact is read.
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD2PSdJ0260axuLjT7SaeW3jeSSSFWZ2KgkkkZJJ70UUUAf/9k=', 'base64');
const jsonText = (value) => `${JSON.stringify(value, null, 2)}\n`;

export async function syntheticLatencyOptions(directory, extra = {}) {
  const root = resolve(directory), sourceDirectory = join(root, 'synthetic-inputs');
  await mkdir(join(sourceDirectory, 'photos'), { recursive: true });
  const meals = [];
  for (const group of ['breakfast', 'dinner']) for (let index = 1; index <= 5; index += 1) {
    const mealId = `${group}_${String(index).padStart(2, '0')}_offline_fixture`;
    const comment = Buffer.from(`${evidence}:${mealId}`), marker = Buffer.from([0xff, 0xfe, 0, 0]);
    marker.writeUInt16BE(comment.length + 2, 2);
    const bytes = Buffer.concat([jpeg.subarray(0, 2), marker, comment, jpeg.subarray(2)]);
    const path = `photos/${mealId}.jpg`;
    await writeFile(join(sourceDirectory, path), bytes);
    meals.push({ mealId, original: { synthetic: true, width: 2, height: 2 },
      prepared: { path, sha256: sha256(bytes), bytes: bytes.length, width: 2, height: 2, mime: 'image/jpeg' } });
  }
  const fixtureProjectRoot = extra.projectRoot ?? projectRoot;
  const catalog = JSON.parse(await readFile(join(fixtureProjectRoot, 'data/nutrition/usda-sr-legacy.json'), 'utf8'));
  const categories = JSON.parse(await readFile(join(fixtureProjectRoot, 'data/nutrition/category-ranges.json'), 'utf8'));
  const conciseSha = sha256(mealRecognitionInstructions('whole', catalog.foods, Object.keys(categories.categories), 'concise'));
  const fixture = registerOfflineInputs({ root, evidence, conciseSha, latencyRunId: 'offline-source-latency',
    effortRunId: 'offline-source-effort', nutritionRunId: 'offline-source-nutrition',
    meals: [meals[0], meals[3], meals[5]].map((row, index) => ({ mealId: row.mealId, label: `合成测试餐 ${index + 1}`,
      bytes: row.prepared.bytes, sha256: row.prepared.sha256 })) });
  const frozenManifestPath = join(sourceDirectory, 'manifest.json');
  await writeFile(frozenManifestPath, jsonText({ schemaVersion: 'synthetic-meal-inputs.v1', runId: 'offline-synthetic-inputs', evidence, meals }));
  return { projectRoot: fixtureProjectRoot, outputDir: join(root, 'trial'), runId: 'offline-90s-fixture', frozenManifestPath,
    providerReader: async () => fakeProvider, historicalLedgerPaths: [], ...extra, offlineFixture: fixture };
}

/** Build new, explicitly synthetic rounds with real archive/SQLite invariants. */
export async function syntheticTrialHistory(directory, through = 'effort') {
  const { prepareLatencyTrial } = await import('./meal-latency-trial.mjs');
  const { prepareEffortSpeedTrial, effortSpeedLedgerOptions } = await import('./meal-effort-speed-trial.mjs');
  const { RealMealTestLedger } = await import('./real-meal-test-ledger.mjs');
  const { runObservedMealTask } = await import('./meal-latency-capture.mjs');
  const root = resolve(directory), sourceOutputDir = join(root, 'synthetic-history', 'latency');
  const initial = await syntheticLatencyOptions(root, { runId: 'offline-source-latency', outputDir: sourceOutputDir });
  let fixture = initial.offlineFixture;
  const { manifest: latency } = await prepareLatencyTrial(initial);
  const confirmation = latency.confirmationSchedules.C.map((task, index) => acceptedRecord(task, 1100 + index * 100, { evidence }));
  await writeFile(join(sourceOutputDir, 'results.json'), jsonText({ schemaVersion: 'meal-latency-results.v1', runId: latency.runId,
    manifestSha256: latency.manifestSha256, evidence, tasks: confirmation }));
  const effortOutputDir = join(root, 'synthetic-history', 'effort');
  const common = { providerReader: async () => fakeProvider, sourceOutputDir, sourceRunId: latency.runId, offlineFixture: fixture };
  const { manifest: effort } = await prepareEffortSpeedTrial({ ...common, outputDir: effortOutputDir, runId: fixture.effortRunId });
  const ledger = new RealMealTestLedger(join(effortOutputDir, 'requests.sqlite'), effortSpeedLedgerOptions(effort.runId));
  const tasks = [];
  try {
    for (const task of effort.schedule) {
      const meal = effort.meals.find((row) => row.mealId === task.mealId), bytes = await readFile(join(effortOutputDir, meal.prepared.path));
      let time = 0;
      const failed = task.mealId === fixture.meals[2].mealId;
      const record = await runObservedMealTask({ task, ledger, provider: { ...fakeProvider, model: effort.config.model, reasoningEffort: task.profile },
        photo: `data:image/jpeg;base64,${bytes.toString('base64')}`, artifactDir: effortOutputDir, clock: () => time,
        providerOptions: { promptProfile: 'concise', timeoutMs: 90000 },
        requestProvider: injectedProvider({ fail: failed ? 'timeout' : null, clockStep: () => { time += failed ? 30010 : 17; } }) });
      if (record.fatalPersistenceError) throw new Error(`Synthetic history persistence failed: ${record.fatalPersistenceError}`);
      tasks.push({ ...record, evidence });
    }
  } finally { ledger.close(); }
  await writeFile(join(effortOutputDir, 'results.json'), jsonText({ schemaVersion: 'meal-effort-speed-results.v1', runId: effort.runId,
    manifestSha256: effort.manifestSha256, metadataDiscovery: { evidence }, evidence, tasks }));
  fixture = registerOfflineInputs({ ...fixture, highInputs: fixture.meals.map((meal) => {
    const row = tasks.find((task) => task.mealId === meal.mealId && task.profile === 'high');
    return { ...meal, attemptId: row.stages[0].attemptId, status: row.status, elapsedMs: row.elapsedMs, firstTextMs: row.timing.firstTextMs };
  }) });
  const result = { offlineFixture: fixture, providerReader: async () => fakeProvider, sourceOutputDir, sourceRunId: latency.runId,
    effortOutputDir, highInputs: fixture.highInputs };
  if (through !== 'nutrition') return result;
  const { prepareHighNutritionComparison, highNutritionLedgerOptions } = await import('./meal-high-nutrition-comparison.mjs');
  const historyDir = join(root, 'synthetic-history', 'nutrition');
  const { manifest: nutrition } = await prepareHighNutritionComparison({ ...result, sourceOutputDir: effortOutputDir,
    outputDir: historyDir, runId: fixture.nutritionRunId });
  const directLedger = new RealMealTestLedger(join(historyDir, 'requests.sqlite'), highNutritionLedgerOptions(nutrition.runId));
  const directTasks = [];
  try {
    for (const task of nutrition.schedule) {
      const value = { components: [{ label: '合成参考菜', evidence: ['合成响应，无实物照片'], uncertainty: ['仅用于离线代码验证'],
        per100g: structuredClone(ranges), recipeBasis: '合成 fixture', assumptions: ['没有营养实测'] }], uncertainty: [] };
      directTasks.push(await runObservedMealTask({ task, ledger: directLedger, provider: { ...fakeProvider, model: nutrition.config.model, reasoningEffort: 'high' },
        photo: 'data:image/jpeg;base64,synthetic', artifactDir: historyDir, requestProvider: injectedProvider({ result: value }),
        providerOptions: { contract: 'direct', timeoutMs: 90000 } }));
    }
  } finally { directLedger.close(); }
  await writeFile(join(historyDir, 'results.json'), jsonText({ schemaVersion: 'meal-high-nutrition-results.v1', runId: nutrition.runId,
    manifestSha256: nutrition.manifestSha256, evidence, tasks: directTasks }));
  return { ...result, historyDir };
}
