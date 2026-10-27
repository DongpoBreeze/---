import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { requestProvider } from '../src/ai-provider.ts';
import { RealMealTestLedger } from './real-meal-test-ledger.mjs';
import { HIGH_NUTRITION_INPUTS } from './meal-high-nutrition-comparison.mjs';
import { sha256 } from './meal-latency-core.mjs';
import { assertArtifactsHaveNoSecret } from './meal-latency-capture.mjs';
import { completedEnvelope, fakeProvider, ranges, sse, withTemporaryDirectory, syntheticTrialHistory } from './meal-latency-test-helpers.mjs';
import { FRONTEND_CONFIG, archivedOutput, frontendLedgerOptions, prepareFrontendTrial, verifyFrontendFreeze,
  runFrontendTrial, verifyFrontendArtifacts } from './test-meal-frontend.mjs';

const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const optionsFor = async (directory) => ({ ...await syntheticTrialHistory(directory, 'nutrition'), runId: 'offline-frontend', outputDir: join(directory, 'frontend') });
const wire = (withDrink = false) => ({ components: [{ label: '玉米', cookingMethod: '水煮', confidence: 0.9, recommendedShare: withDrink ? 0.8 : 1,
  nutritionEstimate: { method: 'typical_recipe', per100g: structuredClone(ranges), recipeBasis: '按熟玉米的典型含水量估计，不含玉米芯。', assumptions: ['未加油糖。'], confidence: 0.8 }, uncertainty: [] },
...(withDrink ? [{ label: '红色饮品', cookingMethod: null, confidence: 0.4, recommendedShare: 0.2, nutritionEstimate: null, uncertainty: ['种类和糖量无法从颜色确认。'] }] : [])], uncertainty: [] });
function supplier(t) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    const value = wire(calls.length === 3), envelope = { ...completedEnvelope(value, { input_tokens: 12, output_tokens: 34, total_tokens: 46,
      output_tokens_details: { reasoning_tokens: 10 } }), model: 'supplier-echo', reasoning: { effort: 'high' } };
    return new Response(sse({ type: 'response.output_text.delta', delta: JSON.stringify(value) })
      + sse({ type: 'response.completed', response: envelope }), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  return calls;
}

test('frontend preparation is offline, preserves the three JPEGs and historical failures, and owns a new cap-three ledger', async (t) => {
  await withTemporaryDirectory(async (directory) => {
    let calls = 0; t.mock.method(globalThis, 'fetch', () => { calls += 1; throw new Error('offline preparation'); });
    const opts = await optionsFor(directory), { manifest, outputDir } = await prepareFrontendTrial(opts);
    assert.equal(calls, 0); assert.deepEqual(manifest.config, FRONTEND_CONFIG);
    assert.equal(manifest.budget.cap, 3); assert.equal(manifest.budget.independentLedger, true);
    assert.equal(manifest.profiles['frontend-high'].promptProfile, 'frontend');
    for (const expected of opts.highInputs) {
      const photo = await readFile(join(outputDir, `photos/${expected.mealId}.jpg`));
      assert.equal(sha256(photo), expected.sha256); assert.equal(photo.length, expected.bytes);
    }
    const history = await json(join(outputDir, 'history.json'));
    assert.deepEqual(history.entries.filter((row) => row.arm === 'project').map((row) => row.record.status), ['accepted', 'accepted', 'timeout']);
    const prompts = await json(join(outputDir, 'prompts.json'));
    assert.ok(prompts.frontend.instructions.length < 1500); assert.equal(prompts.frontend.instructions.includes('foodId'), false);
    assert.equal((await verifyFrontendFreeze(opts)).manifestSha256, manifest.manifestSha256);
    assert.equal((await verifyFrontendArtifacts(opts)).reservedRequests, 0);
  });
});

test('three serial frontend requests are guarded, archived, parsed into App data, and never resent on resume', async (t) => {
  await withTemporaryDirectory(async (directory) => {
    const opts = await optionsFor(directory), { manifest, outputDir } = await prepareFrontendTrial(opts), calls = supplier(t), deadlines = [];
    const report = await runFrontendTrial({ ...opts, live: true, requestProvider: (...args) => {
      deadlines.push({ timeoutMs: args[4].timeoutMs, maxStages: args[4].maxStages, promptProfile: args[4].promptProfile }); return requestProvider(...args);
    } });
    assert.equal(calls.length, 3); assert.equal(report.ledger.reservedRequests, 3); assert.equal(report.ledger.recordedDispatches, 3);
    assert.equal(report.summary.frontend.completeAndValid, 3); assert.equal(report.ledger.metadataRequests, 0);
    assert.deepEqual(deadlines, Array.from({ length: 3 }, () => ({ timeoutMs: 90000, maxStages: 1, promptProfile: 'frontend' })));
    for (const [index, call] of calls.entries()) {
      const body = call.body;
      assert.equal(body.model, 'gpt-6.1-sol'); assert.deepEqual(body.reasoning, { effort: 'high' });
      assert.equal(body.stream, true); assert.equal(body.max_output_tokens, 8192); assert.equal(body.input[0].content[1].detail, 'low');
      assert.equal(sha256(Buffer.from(body.input[0].content[1].image_url.split(',')[1], 'base64')), opts.highInputs[index].sha256);
    }
    const results = await json(join(outputDir, 'results.json'));
    for (const task of results.tasks) {
      assert.equal(task.analysis.nutritionSource.method, 'ai-per100g-v3'); assert.equal(task.analysis.calories, null);
      assert.ok(task.analysis.components.every((row) => row.foodId === null && row.userQuantity === null));
      assert.equal(task.supplierEcho.model, 'supplier-echo'); assert.equal(task.supplierEcho.reasoningEffort, 'high');
      for (const field of ['headersMs', 'firstTextMs', 'responseCompletedMs', 'businessValidatedMs', 'returnedMs']) assert.equal(typeof task.timing[field], 'number');
      assert.equal(task.output.complete, true); assert.ok(task.output.characters > 0);
    }
    assert.equal(report.meals[2].frontend.components[1].per100g, null);
    const ledger = new RealMealTestLedger(join(outputDir, 'requests.sqlite'), frontendLedgerOptions(manifest.runId));
    try { assert.equal(ledger.scope.length, 1); assert.throws(() => ledger.reserve({ mealId: 'extra', stage: 'whole', model: 'gpt-6.1-sol', reasoningEffort: 'high', validationRunId: 'extra' }), /3-request/); }
    finally { ledger.close(); }
    await runFrontendTrial({ ...opts, live: true, resume: true }); assert.equal(calls.length, 3);
    await assertArtifactsHaveNoSecret(outputDir, fakeProvider.key);
  });
});

test('durable interrupted reservations are kept and only untouched tasks can dispatch', async (t) => {
  await withTemporaryDirectory(async (directory) => {
    const opts = await optionsFor(directory), { manifest, outputDir } = await prepareFrontendTrial(opts);
    const ledger = new RealMealTestLedger(join(outputDir, 'requests.sqlite'), frontendLedgerOptions(manifest.runId));
    ledger.reserve({ ...manifest.schedule[0], stage: 'whole', model: 'gpt-6.1-sol', reasoningEffort: 'high' }); ledger.close();
    const calls = supplier(t);
    await assert.rejects(runFrontendTrial({ ...opts, live: true }), /Prior reservations/); assert.equal(calls.length, 0);
    const report = await runFrontendTrial({ ...opts, live: true, resume: true });
    assert.equal(calls.length, 2); assert.equal(report.ledger.reservedRequests, 3); assert.equal(report.meals[0].frontend.status, 'interrupted');
    assert.equal(report.meals[0].frontend.components.length, 0); assert.equal(report.summary.frontend.completeAndValid, 2);
    await runFrontendTrial({ ...opts, live: true, resume: true }); assert.equal(calls.length, 2);
  });
});

test('reservation, finish, raw archive and result write failures block every subsequent request', async (t) => {
  const calls = supplier(t);
  await withTemporaryDirectory(async (directory) => {
    for (const mode of ['reserve', 'finish', 'raw', 'results']) {
      const opts = await optionsFor(join(directory, mode)), { outputDir } = await prepareFrontendTrial(opts), before = calls.length;
      const inject = mode === 'raw' ? { artifactWrite: async (path) => { throw new Error(`offline ${path.endsWith('.sse') ? 'raw' : 'stage'} archive failure`); } }
        : mode === 'results' ? { resultsWrite: async () => { throw new Error('offline results failure'); } }
          : { ledgerFactory: (path, settings) => { const ledger = new RealMealTestLedger(path, settings); ledger[mode] = () => { throw new Error('offline ledger failure'); }; return ledger; } };
      await assert.rejects(runFrontendTrial({ ...opts, live: true, ...inject }));
      assert.equal(calls.length - before, ['reserve', 'results'].includes(mode) ? 0 : 1);
      assert.ok(await json(join(outputDir, 'fatal-stop.json')));
      await assert.rejects(runFrontendTrial({ ...opts, live: true, resume: true }), /prior persistence or guard failure/);
    }
  });
});

test('invalid business JSON, partial SSE and HTTP errors spend one attempt each and never become frontend nutrition', async (t) => {
  await withTemporaryDirectory(async (directory) => {
    const opts = await optionsFor(directory), { outputDir } = await prepareFrontendTrial(opts); let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      calls += 1;
      if (calls === 1) return new Response(sse({ type: 'response.completed', response: completedEnvelope({ ...wire(), totals: ranges }) }), { headers: { 'Content-Type': 'text/event-stream' } });
      if (calls === 2) return new Response(sse({ type: 'response.output_text.delta', delta: '{"components":[' }), { headers: { 'Content-Type': 'text/event-stream' } });
      return new Response(`private ${fakeProvider.key}`, { status: 503 });
    });
    const report = await runFrontendTrial({ ...opts, live: true });
    assert.equal(calls, 3); assert.equal(report.summary.frontend.completeAndValid, 0); assert.equal(report.summary.frontend.completedTransports, 1);
    assert.ok(report.meals.every((row) => row.frontend.components.length === 0 && row.frontend.rawArtifact));
    await runFrontendTrial({ ...opts, live: true, resume: true }); assert.equal(calls, 3);
    await assertArtifactsHaveNoSecret(outputDir, fakeProvider.key);
  });
});

test('outgoing model drift consumes its reservation without reaching network and permanently blocks the run', async (t) => {
  await withTemporaryDirectory(async (directory) => {
    const opts = await optionsFor(directory), { outputDir } = await prepareFrontendTrial(opts), calls = supplier(t);
    await assert.rejects(runFrontendTrial({ ...opts, live: true,
      requestProvider: (settings, ...args) => requestProvider({ ...settings, model: 'unexpected-model' }, ...args) }));
    assert.equal(calls.length, 0);
    const ledger = new RealMealTestLedger(join(outputDir, 'requests.sqlite'), frontendLedgerOptions(opts.runId));
    try { assert.equal(ledger.attempts().length, 1); } finally { ledger.close(); }
    assert.ok(await json(join(outputDir, 'fatal-stop.json')));
  });
});

test('archived body lengths distinguish partial prefixes from completed outputs', () => {
  assert.deepEqual(archivedOutput(sse({ type: 'response.output_text.delta', delta: '部分' })), {
    characters: 2, utf8Bytes: 6, complete: false, textSha256: sha256('部分') });
  const bytes = sse({ type: 'response.output_text.delta', delta: 'part' }) + sse({ type: 'response.completed', response: completedEnvelope('full') });
  assert.equal(archivedOutput(bytes).characters, 4); assert.equal(archivedOutput(bytes).textSha256, sha256('full')); assert.equal(archivedOutput(bytes).complete, true);
});
