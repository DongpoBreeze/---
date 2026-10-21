import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AI_REQUEST_TIMEOUT_MS, AiProviderError, requestProvider } from '../src/ai-provider.ts';
import { RealMealTestLedger } from './real-meal-test-ledger.mjs';
import { verifyLatencyFreeze } from './meal-latency-trial.mjs';
import { assertArtifactsHaveNoSecret } from './meal-latency-capture.mjs';
import { sha256 } from './meal-latency-core.mjs';
import { fakeProvider, acceptedRecord, recognition, completedEnvelope, completeSse, sse, withTemporaryDirectory, syntheticTrialHistory } from './meal-latency-test-helpers.mjs';
import { MULTIDISH_CONFIG, MULTIDISH_INPUT, MULTIDISH_EFFORTS, makeMultidishSchedule, multidishLedgerOptions,
  prepareMultidishTrial, verifyMultidishFreeze, runMultidishTrial, supplierEcho, buildMultidishReport, renderMultidishMarkdown } from './meal-multidish-speed-trial.mjs';

const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const opts = async (directory) => ({ ...await syntheticTrialHistory(directory), runId: 'offline-180s', outputDir: join(directory, 'multidish') });
const settings = { baseUrl: fakeProvider.baseUrl, apiKey: fakeProvider.key, model: 'gpt-6.1-sol', reasoningEffort: 'medium', protocol: 'responses' };
const response = () => new Response(completeSse(), { headers: { 'Content-Type': 'text/event-stream' } });
const flush = () => new Promise((finish) => setImmediate(finish));
function mockSupplier(t) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(init?.method, 'POST'); const body = JSON.parse(init.body); calls.push({ url: String(url), body });
    const usage = { input_tokens: 30, output_tokens: 20, total_tokens: 50, input_tokens_details: { cached_tokens: 10 }, output_tokens_details: { reasoning_tokens: 8 } };
    const envelope = { ...completedEnvelope(recognition(), usage), model: 'supplier-echo-model', reasoning: { effort: body.reasoning.effort } };
    return new Response(sse({ type: 'response.created', response: { model: envelope.model, reasoning: envelope.reasoning } })
      + sse({ type: 'response.output_text.delta', delta: JSON.stringify(recognition()) })
      + sse({ type: 'response.completed', response: envelope }), { headers: { 'Content-Type': 'text/event-stream' } });
  }); return calls;
}

test('the experiment explicitly keeps a 90-second deadline independently of the 120-second app default', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let calls = 0, settled = false;
  t.mock.method(globalThis, 'fetch', () => { calls += 1; return new Promise(() => {}); });
  const pending = requestProvider(settings, 'meal', {}, undefined, { maxStages: 1, timeoutMs: 90000 });
  void pending.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(pending, (error) => error instanceof AiProviderError && error.code === 'timeout');
  t.mock.timers.tick(89999); await Promise.resolve(); assert.equal(settled, false);
  t.mock.timers.tick(1); await rejected; assert.equal(AI_REQUEST_TIMEOUT_MS, 120000); assert.equal(calls, 1);
});

test('the ordinary provider uses its independent 120-second deadline when no diagnostic option is given', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let calls = 0, settled = false;
  t.mock.method(globalThis, 'fetch', () => { calls += 1; return new Promise(() => {}); });
  const pending = requestProvider(settings, 'meal', {}, undefined, { maxStages: 1 });
  void pending.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(pending, (error) => error instanceof AiProviderError && error.code === 'timeout');
  t.mock.timers.tick(119999); await Promise.resolve(); assert.equal(settled, false);
  t.mock.timers.tick(1); await rejected; assert.equal(calls, 1);
});

test('an explicit 180-second diagnostic option accepts a complete result at 125 seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let calls = 0, settled = false;
  t.mock.method(globalThis, 'fetch', () => new Promise((finish) => { calls += 1; setTimeout(() => finish(response()), 125000); }));
  const pending = requestProvider(settings, 'meal', {}, undefined, { maxStages: 1, timeoutMs: 180000 });
  void pending.then(() => { settled = true; });
  t.mock.timers.tick(90000); await Promise.resolve(); assert.equal(settled, false);
  t.mock.timers.tick(35000); assert.equal((await pending).stageCount, 1); assert.equal(calls, 1); assert.equal(AI_REQUEST_TIMEOUT_MS, 120000);
});

test('180-second timeout and user cancellation still reject late results without success diagnostics or retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let finish, calls = 0;
  t.mock.method(globalThis, 'fetch', () => new Promise((resolve) => { calls += 1; finish = resolve; }));
  for (const cancel of [false, true]) {
    const controller = new AbortController(), events = [];
    const pending = requestProvider(settings, 'meal', {}, controller.signal, { maxStages: 1, timeoutMs: 180000, onDiagnostic: (event) => events.push(event) });
    const rejected = assert.rejects(pending, (error) => error instanceof AiProviderError && error.code === (cancel ? 'cancelled' : 'timeout'));
    if (cancel) controller.abort(); else { t.mock.timers.tick(179999); await Promise.resolve(); assert.equal(events.length, 0); t.mock.timers.tick(1); }
    await rejected; finish(response()); await flush();
    assert.equal(events.some((event) => event.type === 'stage_result' || event.type === 'returned'), false);
    assert.equal(events.filter((event) => event.type === 'stage_error').length, 1);
  }
  assert.equal(calls, 2);
});

test('late reservation completion after diagnostic timeout or cancellation cannot start a paid request', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls += 1; return response(); });
  for (const cancel of [false, true]) {
    let release; const controller = new AbortController();
    const pending = requestProvider(settings, 'meal', {}, controller.signal, { maxStages: 1, timeoutMs: 180000,
      beforeRequest: () => new Promise((finish) => { release = finish; }) });
    const rejected = assert.rejects(pending, (error) => error instanceof AiProviderError && error.code === (cancel ? 'cancelled' : 'timeout'));
    if (cancel) controller.abort(); else t.mock.timers.tick(180000);
    await rejected; release(); await flush();
  }
  assert.equal(calls, 0);
});

test('invalid diagnostic deadlines fail before any send', async (t) => {
  let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls += 1; return response(); });
  for (const timeoutMs of [0, -1, NaN, Infinity, 0.5, 2147483648]) await assert.rejects(
    requestProvider(settings, 'meal', {}, undefined, { maxStages: 1, timeoutMs }), (error) => error instanceof AiProviderError && error.code === 'invalid_request');
  assert.equal(calls, 0);
});

test('preparation freezes the original JPEG/concise hashes and new source without rewriting historical fingerprints', async (t) => {
  await withTemporaryDirectory(async (directory) => {
    let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls += 1; throw new Error('No network during prepare'); });
    const options = await opts(directory), { outputDir, manifest } = await prepareMultidishTrial(options);
    assert.equal(calls, 0); assert.deepEqual(manifest.config, MULTIDISH_CONFIG);
    assert.deepEqual(manifest.schedule.map((row) => row.profile), ['medium', 'xhigh', 'high', 'max']); assert.equal(manifest.meals.length, 1);
    const bytes = await readFile(join(outputDir, manifest.meals[0].prepared.path));
    assert.equal(sha256(bytes), options.offlineFixture.meals[2].sha256); assert.equal(bytes.length, options.offlineFixture.meals[2].bytes);
    assert.equal(manifest.evidence, 'synthetic_offline_fixture_not_real_experiment');
    assert.equal(manifest.source.providerSourceSha256, manifest.sourceFingerprints.find((row) => row.path === 'src/ai-provider.ts').sha256);
    await assert.rejects(verifyLatencyFreeze({ outputDir: options.sourceOutputDir, runId: options.sourceRunId }), /Synthetic and real/);
    assert.equal((await verifyMultidishFreeze(options)).manifestSha256, manifest.manifestSha256);
    const history = manifest.historicalReference.samples;
    assert.deepEqual(history.map((row) => row.elapsedMs), [1600, 90030, 90030]);
    assert.deepEqual(history.map((row) => row.businessAccepted), [true, false, false]);
  });
});

test('four actual-provider mocked requests use the frozen order, one stage, explicit 180 seconds, usage and supplier echoes', async (t) => {
  await withTemporaryDirectory(async (directory) => {
    const options = await opts(directory), { outputDir, manifest } = await prepareMultidishTrial(options), calls = mockSupplier(t), deadlines = [];
    const report = await runMultidishTrial({ ...options, live: true, requestProvider: (...args) => { deadlines.push(args[4].timeoutMs); return requestProvider(...args); } });
    assert.equal(calls.length, 4); assert.deepEqual(calls.map((row) => row.body.reasoning.effort), MULTIDISH_EFFORTS); assert.deepEqual(deadlines, [180000, 180000, 180000, 180000]);
    assert.equal(report.ledger.reservedRequests, 4); assert.equal(report.ledger.recordedDispatches, 4); assert.equal(report.summary.valid, 4);
    assert.ok(calls.every((row) => row.body.model === 'gpt-6.1-sol' && row.body.stream === true && row.body.max_output_tokens === 8192
      && row.body.input[0].content[1].detail === 'low' && sha256(Buffer.from(row.body.input[0].content[1].image_url.split(',')[1], 'base64')) === options.offlineFixture.meals[2].sha256));
    assert.ok(report.samples.every((row) => row.supplierEcho.model === 'supplier-echo-model' && row.supplierEcho.reasoningEffort === row.effort
      && row.usage.reasoning_tokens === 8 && row.usage.cached_input_tokens === 10 && row.rawArtifact));
    const state = await json(join(outputDir, 'results.json')); assert.ok(state.tasks.every((row) => row.stages.length === 1 && row.maxStages === 1 && row.timeoutMs === 180000));
    const ledger = new RealMealTestLedger(join(outputDir, 'requests.sqlite'), multidishLedgerOptions(manifest.runId));
    try { assert.equal(ledger.scope.length, 1); assert.throws(() => ledger.reserve({ mealId: 'extra', validationRunId: 'extra', stage: 'whole', model: 'gpt-6.1-sol', reasoningEffort: 'max' }), /4-request/); }
    finally { ledger.close(); }
    await runMultidishTrial({ ...options, live: true, resume: true }); assert.equal(calls.length, 4); await assertArtifactsHaveNoSecret(outputDir, fakeProvider.key);
  });
});

test('resume preserves an interrupted reservation, accounts 180 seconds, and sends only the three untouched conditions', async (t) => {
  await withTemporaryDirectory(async (directory) => {
    const options = await opts(directory), { outputDir, manifest } = await prepareMultidishTrial(options);
    const ledger = new RealMealTestLedger(join(outputDir, 'requests.sqlite'), multidishLedgerOptions(manifest.runId));
    ledger.reserve({ ...manifest.schedule[0], stage: 'whole', model: 'gpt-6.1-sol', reasoningEffort: 'medium' }); ledger.close();
    const calls = mockSupplier(t); await assert.rejects(runMultidishTrial({ ...options, live: true }), /Prior reservations/); assert.equal(calls.length, 0);
    await writeFile(join(outputDir, 'execution.lock'), JSON.stringify({ pid: 2147483647 }));
    const report = await runMultidishTrial({ ...options, live: true, resume: true });
    assert.deepEqual(calls.map((row) => row.body.reasoning.effort), ['xhigh', 'high', 'max']); assert.equal(report.ledger.reservedRequests, 4);
    assert.equal(report.samples[0].status, 'interrupted'); assert.equal(report.samples[0].accountedElapsedMs, 180000);
    assert.equal(report.summary.valid, 3); assert.equal(report.summary.denominator, 4);
    await runMultidishTrial({ ...options, live: true, resume: true }); assert.equal(calls.length, 3);
  });
});

test('reservation, raw archive and ledger-finish failures stop at zero/one/one sends and block automatic continuation', async (t) => {
  const calls = mockSupplier(t);
  await withTemporaryDirectory(async (directory) => {
    for (const mode of ['reserve', 'raw', 'finish']) {
      const options = await opts(join(directory, mode)), { outputDir } = await prepareMultidishTrial(options), before = calls.length;
      const extra = mode === 'raw' ? { artifactWrite: async (path, bytes, config) => { if (path.endsWith('.sse')) throw new Error('Offline raw save failure'); return writeFile(path, bytes, config); } }
        : { ledgerFactory: (path, config) => { const ledger = new RealMealTestLedger(path, config); ledger[mode] = () => { throw new Error('Offline ledger failure'); }; return ledger; } };
      await assert.rejects(runMultidishTrial({ ...options, live: true, ...extra }), /Further requests stopped/);
      assert.equal(calls.length - before, mode === 'reserve' ? 0 : 1); assert.ok((await json(join(outputDir, 'results.json'))).fatalPersistenceError);
      await assert.rejects(runMultidishTrial({ ...options, live: true, resume: true }), /prior persistence failure/);
      assert.equal(calls.length - before, mode === 'reserve' ? 0 : 1);
    }
  });
});

test('an unsupported or malformed completed response consumes its one attempt, and partial text is never success', async (t) => {
  await withTemporaryDirectory(async (directory) => {
    const options = await opts(directory); await prepareMultidishTrial(options); let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      calls += 1;
      if (calls === 1) return Response.json({ error: { message: `unsupported effort ${fakeProvider.key}` } }, { status: 400 });
      return new Response(sse({ type: 'response.output_text.delta', delta: 'partial only' })
        + sse({ type: 'response.incomplete', response: { status: 'incomplete' } }), { headers: { 'Content-Type': 'text/event-stream' } });
    });
    const report = await runMultidishTrial({ ...options, live: true }); assert.equal(calls, 4); assert.equal(report.summary.valid, 0);
    assert.ok(report.samples.every((row) => !row.within90Seconds && !row.within180Seconds && row.rawArtifact));
    assert.equal(report.samples[0].httpStatus, 400); await assertArtifactsHaveNoSecret(options.outputDir, fakeProvider.key);
  });
});

test('supplier echoes use only archived upstream metadata and leave missing model/effort null', () => {
  assert.equal(supplierEcho(sse({ type: 'response.output_text.delta', delta: 'requested model is gpt-6.1-sol' })).model, null);
  assert.equal(supplierEcho(completeSse()).reasoningEffort, null);
  assert.equal(supplierEcho(JSON.stringify({ model: 'echo-json', reasoning: { effort: 'high' } })).model, 'echo-json');
});

test('the report separates 90/180-second completion, waits beyond 90, partial failures and 180-second denominator accounting', () => {
  const schedule = makeMultidishSchedule('report-fixture'), manifest = { runId: 'report-fixture', config: MULTIDISH_CONFIG,
    schedule, prompts: { sha256: 'prompt' }, historicalReference: { samples: [] }, budget: { cap: 4 } };
  const tasks = schedule.map((task, index) => acceptedRecord(task, [125000, 85000, 180027, 500][index], { archiveElapsedMs: 200000 }));
  Object.assign(tasks[2], { status: 'timeout', transportCompleted: false, businessAccepted: false, error: { code: 'timeout' } });
  Object.assign(tasks[3], { status: 'interrupted', transportCompleted: false, businessAccepted: false, error: { code: 'cancelled' } });
  const report = buildMultidishReport(manifest, { tasks });
  assert.equal(report.summary.denominator, 4); assert.equal(report.summary.within90Seconds, 1); assert.equal(report.summary.within180Seconds, 2);
  assert.equal(report.summary.completedAfter90Seconds, 1); assert.equal(report.samples[0].additionalWaitBeyond90Ms, 35000);
  assert.deepEqual(report.summary.allSampleAccountedElapsedMs, [125000, 85000, 180027, 180000]); assert.equal(report.metrics.timeoutPenaltyMs, 180000);
  const markdown = renderMultidishMarkdown(report); assert.match(markdown, /额外等待 35\.000s/); assert.match(markdown, /非同期/); assert.match(markdown, /默认值由运行时代码独立维护/);
});
