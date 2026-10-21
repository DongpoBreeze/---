import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareLatencyTrial, verifyLatencyFreeze, runLatencyPhase, reportLatencyTrial, latencyLedgerOptions,
  validateFrozenRequest, historicalLedgerSummary, PROJECT_ROOT } from './meal-latency-trial.mjs';
import { RealMealTestLedger } from './real-meal-test-ledger.mjs';
import { LATENCY_CONFIG, sha256 } from './meal-latency-core.mjs';
import { fakeProvider, assessment, injectedProvider, completeSse, withTemporaryDirectory, syntheticLatencyOptions } from './meal-latency-test-helpers.mjs';
import { runObservedMealTask } from './meal-latency-capture.mjs';

function opts(directory, extra = {}) {
  return syntheticLatencyOptions(directory, extra);
}
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

test('offline preparation copies all ten original JPEG byte hashes, freezes distinct prompts/order, and records configured versus selected model', async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await opts(directory);
    const { manifest, outputDir } = await prepareLatencyTrial(options);
    const source = await readJson(options.frozenManifestPath);
    assert.equal(manifest.config.maxLocalRequests, 22); assert.equal(manifest.config.maxOutputTokens, 8192); assert.equal(manifest.config.timeoutMs, 90000);
    assert.equal(manifest.provider.configuredModel, fakeProvider.model); assert.equal(manifest.provider.configuredReasoningEffort, fakeProvider.reasoningEffort);
    assert.equal(manifest.provider.selectedModel, 'gpt-6.1-sol'); assert.ok(!JSON.stringify(manifest).includes(fakeProvider.key));
    assert.equal(manifest.pilotSchedule.length, 12);
    for (const meal of manifest.meals) {
      const original = source.meals.find((row) => row.mealId === meal.mealId);
      const bytes = await readFile(join(outputDir, meal.prepared.path));
      assert.equal(sha256(bytes), original.prepared.sha256); assert.equal(bytes.length, original.prepared.bytes);
      assert.deepEqual(meal.original, original.original);
    }
    const prompts = await readJson(join(outputDir, 'prompts.json'));
    assert.notEqual(prompts.current.instructionsSha256, prompts.concise.instructionsSha256);
    const ledger = new RealMealTestLedger(join(outputDir, 'requests.sqlite'), latencyLedgerOptions(manifest));
    try { assert.equal(ledger.totals().localRequests, 0); assert.equal(ledger.totals().remainingRequests, 22); }
    finally { ledger.close(); }
    assert.equal((await prepareLatencyTrial(options)).manifest.manifestSha256, manifest.manifestSha256);
    const report = await reportLatencyTrial(options);
    assert.equal(report.confirmation.status, 'not_run_blocked'); assert.equal(report.gate.reason, 'pilot_incomplete');
  });
});

test('live guard verifies actual output limit, stream, exact photo bytes, prompt, fixed tested model and explicit experimental effort before send', async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await opts(directory), { manifest, outputDir } = await prepareLatencyTrial(options);
    const prompts = await readJson(join(outputDir, 'prompts.json'));
    const task = manifest.pilotSchedule.find((row) => row.profile === 'C');
    const bytes = await readFile(join(outputDir, manifest.meals.find((row) => row.mealId === task.mealId).prepared.path));
    const p = prompts.concise;
    const body = { model: 'gpt-6.1-sol', reasoning: { effort: 'medium' }, max_output_tokens: 8192, stream: true, store: false,
      instructions: p.instructions, input: [{ role: 'user', content: [{ type: 'input_text', text: p.userText },
        { type: 'input_image', detail: 'low', image_url: `data:image/jpeg;base64,${bytes.toString('base64')}` }] }], text: { format: { type: 'json_object' } } };
    const input = { url: `${fakeProvider.baseUrl}/responses`, init: { method: 'POST', body: JSON.stringify(body) }, provider: fakeProvider,
      manifest, task, prompts, imageBytes: bytes, reservedAttempts: [{ stage: 'whole' }], sentCount: 0 };
    assert.equal(validateFrozenRequest(input), true);
    for (const change of [{ model: fakeProvider.model }, { max_output_tokens: 4096 }, { stream: false }, { reasoning: { effort: 'max' } }]) {
      assert.throws(() => validateFrozenRequest({ ...input, init: { method: 'POST', body: JSON.stringify({ ...body, ...change }) } }), /differ/);
    }
    assert.throws(() => validateFrozenRequest({ ...input, reservedAttempts: [] }), /durable/);
    assert.throws(() => validateFrozenRequest({ ...input, sentCount: 1 }), /one send/);
  });
});

test('freeze rejects changed prompt, image and relevant source without any supplier calls', async () => {
  await withTemporaryDirectory(async (directory) => {
    const root = join(directory, 'project');
    await mkdir(join(root, 'data/nutrition'), { recursive: true });
    for (const path of ['usda-sr-legacy.json', 'category-ranges.json']) await copyFile(join(PROJECT_ROOT, 'data/nutrition', path), join(root, 'data/nutrition', path));
    await writeFile(join(root, 'relevant-source.mjs'), 'export const frozen = 1;\n');
    const options = await opts(directory, { projectRoot: root, sourcePaths: ['relevant-source.mjs'] });
    const { outputDir, manifest } = await prepareLatencyTrial(options);
    const promptPath = join(outputDir, 'prompts.json'), prompt = await readFile(promptPath);
    await writeFile(promptPath, Buffer.concat([prompt, Buffer.from(' ')]));
    await assert.rejects(verifyLatencyFreeze(options), /prompts changed/);
    await writeFile(promptPath, prompt);
    const imagePath = join(outputDir, manifest.meals[0].prepared.path), image = await readFile(imagePath);
    const changed = Buffer.from(image); changed[changed.length - 1] ^= 1; await writeFile(imagePath, changed);
    await assert.rejects(verifyLatencyFreeze(options), /image changed/);
    await writeFile(imagePath, image);
    await writeFile(join(root, 'relevant-source.mjs'), 'export const frozen = 2;\n');
    await assert.rejects(verifyLatencyFreeze(options), /Relevant source changed/);
  });
});

test('actual provider passes the frozen outbound guard for all twelve mocked pilot conditions without retries', async (t) => {
  await withTemporaryDirectory(async (directory) => {
    const options = await opts(directory), { manifest } = await prepareLatencyTrial(options), calls = [];
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(completeSse(undefined, { input_tokens: 30, output_tokens: 20, total_tokens: 50, output_tokens_details: { reasoning_tokens: 8 } }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    });
    const report = await runLatencyPhase({ ...options, live: true });
    assert.equal(calls.length, 12);
    assert.equal(report.pilot.profiles.A.valid, 4); assert.equal(report.pilot.profiles.B.valid, 4); assert.equal(report.pilot.profiles.C.valid, 4);
    assert.equal(report.pilot.profiles.C.usage.reasoning_tokens, 32);
    assert.ok(calls.every((row) => row.body.model === 'gpt-6.1-sol' && row.body.max_output_tokens === 8192 && row.body.stream && row.body.input[0].content[1].detail === 'low'));
    assert.equal(calls.filter((row) => row.body.reasoning.effort === 'medium').length, 4);
    for (let index = 0; index < calls.length; index += 1) {
      const task = manifest.pilotSchedule[index], p = manifest.profiles[task.profile];
      assert.equal(calls[index].body.reasoning.effort, p.reasoningEffort);
    }
    assert.ok(report.pilot.photos.every((photo) => Object.values(photo.profiles).every((row) => typeof row.timing.firstTextMs === 'number' && typeof row.timing.firstTextDeltaMs === 'number')));
  });
});

test('durable interrupted reservations never resend; independent review gates only one ten-image finalist and the full local cap is exactly 22', async () => {
  await withTemporaryDirectory(async (directory) => {
    let time = 0;
    const options = await opts(directory, { clock: () => time }), { outputDir, manifest } = await prepareLatencyTrial(options), calls = [];
    let ledger = new RealMealTestLedger(join(outputDir, 'requests.sqlite'), latencyLedgerOptions(manifest));
    const first = manifest.pilotSchedule[0];
    ledger.reserve({ ...first, stage: 'whole', model: LATENCY_CONFIG.model, reasoningEffort: 'max' }); ledger.close();
    const request = injectedProvider({ calls, clockStep: (delta) => { time += delta; } });
    await assert.rejects(runLatencyPhase({ ...options, live: true, requestProvider: request }), /Prior reservations/);
    assert.equal(calls.length, 0);
    const pilot = await runLatencyPhase({ ...options, live: true, resume: true, requestProvider: request });
    assert.equal(calls.length, 11); assert.equal(pilot.pilot.profiles.A.valid, 3); assert.equal(pilot.pilot.profiles.B.valid, 4);
    assert.equal(pilot.pilot.photos[0].profiles.A.status, 'interrupted');
    assert.equal(pilot.pilot.photos[0].profiles.A.stages[0].rawArtifact, null);
    assert.equal(pilot.gate.allowed, false);
    await runLatencyPhase({ ...options, live: true, resume: true, requestProvider: request }); assert.equal(calls.length, 11);
    await assert.rejects(runLatencyPhase({ ...options, phase: 'confirm', live: true, requestProvider: request }), /Confirmation blocked/);
    assert.equal(calls.length, 11);
    const assessmentPath = join(directory, 'independent-review.json');
    const rejected = assessment(manifest.runId, { A: { obviousDegradation: true }, B: { obviousDegradation: true }, C: { obviousDegradation: true } });
    await writeFile(assessmentPath, `${JSON.stringify(rejected, null, 2)}\n`);
    const blocked = await reportLatencyTrial({ ...options, assessmentPath }); assert.equal(blocked.gate.allowed, false);
    await assert.rejects(runLatencyPhase({ ...options, phase: 'confirm', live: true, requestProvider: request }), /no_candidate/);
    assert.equal(calls.length, 11);
    await writeFile(assessmentPath, `${JSON.stringify(assessment(manifest.runId), null, 2)}\n`);
    const reviewed = await reportLatencyTrial({ ...options, assessmentPath }); assert.equal(reviewed.gate.chosenProfile, 'B');
    const confirmation = await runLatencyPhase({ ...options, phase: 'confirm', live: true, requestProvider: request });
    assert.equal(calls.length, 21); assert.equal(confirmation.confirmation.status, 'complete'); assert.equal(confirmation.confirmation.passed, true);
    const state = await readJson(join(outputDir, 'results.json'));
    assert.equal(state.tasks.filter((row) => row.phase === 'confirm').length, 10);
    assert.ok(state.tasks.filter((row) => row.phase === 'confirm').every((row) => row.profile === 'B' && row.validationRunId.endsWith('-confirm-B')));
    assert.ok(calls.every((call) => call.settings.model === 'gpt-6.1-sol' && call.maxStages === 1 && call.timeoutMs === 90000));
    assert.ok(calls.some((call) => call.settings.reasoningEffort === 'medium') && calls.some((call) => call.settings.reasoningEffort === 'max'));
    assert.ok(state.tasks.filter((row) => row.configuredProvider).every((row) => row.configuredProvider.configuredModel === fakeProvider.model));
    ledger = new RealMealTestLedger(join(outputDir, 'requests.sqlite'), latencyLedgerOptions(manifest));
    try {
      assert.equal(ledger.totals().localRequests, 22); assert.equal(ledger.totals().remainingRequests, 0);
      assert.throws(() => ledger.reserve({ mealId: 'extra', validationRunId: 'extra-condition', stage: 'whole', model: 'gpt-6.1-sol', reasoningEffort: 'max' }), /22-request/);
    } finally { ledger.close(); }
    await runLatencyPhase({ ...options, phase: 'confirm', live: true, resume: true, requestProvider: request });
    assert.equal(calls.length, 21);
  });
});

test('historical counts are informational even beyond 75 and do not decrement the isolated cap22', async () => {
  await withTemporaryDirectory(async (directory) => {
    const history = join(directory, 'history.sqlite');
    const old = new RealMealTestLedger(history, { limits: { totalRequests: null, perMealRequests: 1, reviewMeals: 0, cohortMeals: 100 } });
    for (let i = 0; i < 80; i += 1) old.reserve({ mealId: `historical-${i}`, stage: 'whole', model: 'gpt-6.1-sol', reasoningEffort: 'max' });
    old.close();
    const summary = historicalLedgerSummary([history]); assert.equal(summary[0].requests, 80); assert.equal(summary[0].access, 'read_only_information');
    const options = await opts(directory, { historicalLedgerPaths: [history] }), { manifest, outputDir } = await prepareLatencyTrial(options);
    const ledger = new RealMealTestLedger(join(outputDir, 'requests.sqlite'), latencyLedgerOptions(manifest));
    try { assert.equal(ledger.totals().localRequests, 0); assert.equal(ledger.totals().remainingRequests, 22); assert.equal(ledger.scope.length, 1); }
    finally { ledger.close(); }
    assert.equal(historicalLedgerSummary([history])[0].requests, 80);
  });
});

test('a raw archive write failure stops after the first attempt and blocks subsequent live/resume execution', async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await opts(directory), { outputDir } = await prepareLatencyTrial(options), calls = [];
    await assert.rejects(runLatencyPhase({ ...options, live: true, requestProvider: injectedProvider({ calls }),
      artifactWrite: async (path, value, config) => { if (path.endsWith('.sse')) throw new Error('offline save failure'); return writeFile(path, value, config); } }), /Further paid calls stopped/);
    assert.equal(calls.length, 1);
    const state = await readJson(join(outputDir, 'results.json')); assert.equal(state.fatalPersistenceError, 'raw_archive_write_failed');
    await assert.rejects(runLatencyPhase({ ...options, live: true, resume: true, requestProvider: injectedProvider({ calls }) }), /previous artifact or ledger persistence failure/);
    assert.equal(calls.length, 1);
    const report = await reportLatencyTrial(options); assert.equal(report.gate.allowed, false);
    assert.equal(report.gate.reason, 'artifact_or_ledger_persistence_failed');
  });
});

test('resume detects persisted stage/raw/ledger failures even if the crash preceded results.json persistence, and sends nothing further', async () => {
  await withTemporaryDirectory(async (directory) => {
    for (const mode of ['raw', 'stage', 'ledger']) {
      const options = await opts(join(directory, mode)), { outputDir, manifest } = await prepareLatencyTrial(options), calls = [];
      const ledger = new RealMealTestLedger(join(outputDir, 'requests.sqlite'), latencyLedgerOptions(manifest));
      const task = manifest.pilotSchedule[0], meal = manifest.meals.find((row) => row.mealId === task.mealId);
      const bytes = await readFile(join(outputDir, meal.prepared.path));
      if (mode === 'ledger') ledger.finish = () => { throw new Error('offline ledger finish failed'); };
      const result = await runObservedMealTask({ task, ledger, provider: { ...fakeProvider, model: 'gpt-6.1-sol', reasoningEffort: 'max' },
        photo: `data:image/jpeg;base64,${bytes.toString('base64')}`, artifactDir: outputDir, requestProvider: injectedProvider(),
        write: async (path, value, config) => {
          if (mode === 'raw' && path.endsWith('.sse') || mode === 'stage' && path.endsWith('.json')) throw new Error('offline capture save failed');
          return writeFile(path, value, config);
        } });
      assert.ok(result.fatalPersistenceError);
      ledger.close();
      // Deliberately leave the original empty results.json to model a crash.
      assert.equal((await readJson(join(outputDir, 'results.json'))).tasks.length, 0);
      await assert.rejects(runLatencyPhase({ ...options, live: true, resume: true, requestProvider: injectedProvider({ calls }) }), /Further paid calls stopped/);
      assert.equal(calls.length, 0, mode);
      const state = await readJson(join(outputDir, 'results.json'));
      assert.ok(state.fatalPersistenceError, mode); assert.equal(state.tasks[0].businessAccepted, false, mode);
    }
  });
});
