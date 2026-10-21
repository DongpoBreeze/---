import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { requestProvider } from '../src/ai-provider.ts';
import { RealMealTestLedger } from './real-meal-test-ledger.mjs';
import { sha256 } from './meal-latency-core.mjs';
import { assertArtifactsHaveNoSecret } from './meal-latency-capture.mjs';
import { fakeProvider, acceptedRecord, completeSse, withTemporaryDirectory, syntheticTrialHistory } from './meal-latency-test-helpers.mjs';
import { EFFORT_SPEED_CONFIG, EFFORT_SPEED_PROFILES, EFFORT_SPEED_MEALS, makeEffortSpeedSchedule, effortSpeedLedgerOptions,
  prepareEffortSpeedTrial, verifyEffortSpeedFreeze, runEffortSpeedTrial, buildEffortSpeedReport, renderEffortSpeedMarkdown } from './meal-effort-speed-trial.mjs';

const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const options = async (directory, extra = {}) => ({ ...await syntheticTrialHistory(directory),
  outputDir: join(directory, 'effort-speed'), runId: 'offline-high-xhigh', ...extra });
function mockSupplier(t, { metadata = 'declared', reject = false } = {}) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const method = init?.method ?? 'GET', body = method === 'POST' ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), method, body });
    if (method === 'GET') {
      if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'gpt-6.1-sol',
        ...(metadata === 'declared' ? { supported_reasoning_efforts: ['medium', 'high', 'xhigh'], vision: true } : {}) }] });
      return Response.json({ error: { message: 'No detail endpoint' } }, { status: 404 });
    }
    if (reject) return Response.json({ error: { message: `unsupported effort; ${fakeProvider.key}` } }, { status: 400 });
    return new Response(completeSse(undefined, { input_tokens: 30, output_tokens: 20, total_tokens: 50,
      output_tokens_details: { reasoning_tokens: 8 } }), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  return calls;
}

test('offline preparation freezes exactly three original JPEGs and the six interleaved, fixed-model single-stage conditions', async (t) => {
  await withTemporaryDirectory(async (directory) => {
    let sends = 0; t.mock.method(globalThis, 'fetch', async () => { sends += 1; throw new Error('No network during preparation'); });
    const opts = await options(directory), { outputDir, manifest } = await prepareEffortSpeedTrial(opts);
    assert.equal(sends, 0); assert.deepEqual(manifest.config, EFFORT_SPEED_CONFIG); assert.deepEqual(manifest.profiles, EFFORT_SPEED_PROFILES);
    assert.deepEqual(manifest.schedule.map((row) => row.profile), ['high', 'xhigh', 'xhigh', 'high', 'high', 'xhigh']);
    assert.equal(manifest.provider.configuredModel, fakeProvider.model); assert.equal(manifest.provider.selectedModel, 'gpt-6.1-sol');
    assert.equal(manifest.meals.length, 3); assert.equal(manifest.budget.cap, 6);
    for (const meal of opts.offlineFixture.meals) {
      const bytes = await readFile(join(outputDir, `photos/${meal.mealId}.jpg`));
      assert.equal(sha256(bytes), meal.sha256); assert.equal(bytes.length, meal.bytes);
    }
    const ledger = new RealMealTestLedger(join(outputDir, 'requests.sqlite'), effortSpeedLedgerOptions(opts.runId));
    try {
      assert.equal(ledger.totals().remainingRequests, 6); assert.equal(ledger.scope.length, 1);
      for (const task of manifest.schedule) ledger.reserve({ ...task, stage: 'whole', model: 'gpt-6.1-sol', reasoningEffort: task.profile });
      assert.equal(ledger.totals().localRequests, 6);
      assert.throws(() => ledger.reserve({ mealId: 'extra', validationRunId: 'extra', stage: 'whole', model: 'gpt-6.1-sol', reasoningEffort: 'high' }), /6-request/);
    } finally { ledger.close(); }
    assert.equal((await verifyEffortSpeedFreeze(opts)).manifestSha256, manifest.manifestSha256);
    await assertArtifactsHaveNoSecret(outputDir, fakeProvider.key);
  });
});

test('the actual provider passes the outbound guard for six mocked analyses, explicit efforts, usage, metadata-first order, and idempotent resume', async (t) => {
  await withTemporaryDirectory(async (directory) => {
    const opts = await options(directory), { outputDir, manifest } = await prepareEffortSpeedTrial(opts), calls = mockSupplier(t);
    const report = await runEffortSpeedTrial({ ...opts, live: true });
    const posts = calls.filter((row) => row.method === 'POST');
    assert.equal(calls[0].method, 'GET'); assert.equal(calls.filter((row) => row.method === 'GET').length, 1); assert.equal(posts.length, 6);
    assert.equal(report.ledger.reservedRequests, 6); assert.equal(report.ledger.recordedDispatches, 6);
    assert.equal(report.metadataDiscovery.requestedEfforts.high, 'declared_supported'); assert.equal(report.metadataDiscovery.requestedEfforts.xhigh, 'declared_supported');
    for (let index = 0; index < posts.length; index += 1) {
      const body = posts[index].body, task = manifest.schedule[index], meal = manifest.meals.find((row) => row.mealId === task.mealId);
      assert.equal(body.model, 'gpt-6.1-sol'); assert.equal(body.reasoning.effort, task.profile); assert.equal(body.max_output_tokens, 8192);
      assert.equal(body.stream, true); assert.equal(body.store, false); assert.equal(body.input[0].content[1].detail, 'low');
      assert.equal(sha256(Buffer.from(body.input[0].content[1].image_url.split(',')[1], 'base64')), meal.prepared.sha256);
    }
    for (const effort of ['high', 'xhigh']) {
      assert.equal(report.profiles[effort].completed, 3); assert.equal(report.profiles[effort].valid, 3);
      assert.equal(report.profiles[effort].successOnlyLatencyMs.denominator, 3); assert.equal(report.profiles[effort].usage.reasoning_tokens, 24);
    }
    const state = await json(join(outputDir, 'results.json'));
    assert.ok(state.tasks.every((row) => row.maxStages === 1 && row.stages.length === 1 && row.fallbackReason === null));
    assert.ok(report.samples.every((row) => row.rawArtifact && Number.isFinite(row.timing.firstTextMs)));
    assert.equal(report.historicalMedium.phase, 'confirm'); assert.match(report.historicalMedium.label, /非同期/);
    await runEffortSpeedTrial({ ...opts, live: true, resume: true }); assert.equal(calls.length, 7);
    await assertArtifactsHaveNoSecret(outputDir, fakeProvider.key);
  });
});

test('undisclosed effort capabilities remain unconfirmed; unsupported HTTP responses consume all six attempts without retry or fallback', async (t) => {
  await withTemporaryDirectory(async (directory) => {
    const opts = await options(directory), { outputDir } = await prepareEffortSpeedTrial(opts), calls = mockSupplier(t, { metadata: 'unknown', reject: true });
    const report = await runEffortSpeedTrial({ ...opts, live: true });
    assert.equal(report.metadataDiscovery.metadataGetCount, 2); assert.deepEqual(report.metadataDiscovery.reasoningEfforts, []);
    assert.equal(report.metadataDiscovery.requestedEfforts.high, 'unconfirmed'); assert.equal(report.metadataDiscovery.requestedEfforts.xhigh, 'unconfirmed');
    const posts = calls.filter((row) => row.method === 'POST'); assert.equal(posts.length, 6);
    assert.deepEqual(posts.map((row) => row.body.reasoning.effort), ['high', 'xhigh', 'xhigh', 'high', 'high', 'xhigh']);
    assert.equal(report.profiles.high.valid, 0); assert.equal(report.profiles.xhigh.valid, 0);
    assert.equal(report.profiles.high.latencyMs.denominator, 3); assert.equal(report.profiles.xhigh.successOnlyLatencyMs.denominator, 0);
    assert.ok(report.samples.every((row) => row.httpStatus === 400 && row.businessAccepted === false && row.rawArtifact));
    await runEffortSpeedTrial({ ...opts, live: true, resume: true }); assert.equal(calls.filter((row) => row.method === 'POST').length, 6);
    await assertArtifactsHaveNoSecret(outputDir, fakeProvider.key);
  });
});

test('a durable reservation is preserved on resume, never resent; an accidental non-resume invocation leaves resume usable', async (t) => {
  await withTemporaryDirectory(async (directory) => {
    const opts = await options(directory), { manifest, outputDir } = await prepareEffortSpeedTrial(opts);
    const ledger = new RealMealTestLedger(join(outputDir, 'requests.sqlite'), effortSpeedLedgerOptions(opts.runId));
    ledger.reserve({ ...manifest.schedule[0], stage: 'whole', model: 'gpt-6.1-sol', reasoningEffort: 'high' }); ledger.close();
    const calls = mockSupplier(t);
    await assert.rejects(runEffortSpeedTrial({ ...opts, live: true }), /Prior reservations/); assert.equal(calls.length, 0);
    const report = await runEffortSpeedTrial({ ...opts, live: true, resume: true });
    assert.equal(calls.filter((row) => row.method === 'POST').length, 5); assert.equal(report.ledger.reservedRequests, 6);
    assert.equal(report.samples[0].status, 'interrupted'); assert.equal(report.profiles.high.valid, 2);
    assert.ok(report.profiles.high.latencyMs.allSampleValues.includes(90000)); assert.equal(report.profiles.high.successOnlyLatencyMs.denominator, 2);
    await runEffortSpeedTrial({ ...opts, live: true, resume: true }); assert.equal(calls.filter((row) => row.method === 'POST').length, 5);
  });
});

test('reservation persistence failure makes zero analysis sends and blocks later execution', async (t) => {
  await withTemporaryDirectory(async (directory) => {
    const opts = await options(directory), { outputDir } = await prepareEffortSpeedTrial(opts), calls = mockSupplier(t);
    await assert.rejects(runEffortSpeedTrial({ ...opts, live: true, ledgerFactory: (path, settings) => {
      const ledger = new RealMealTestLedger(path, settings);
      ledger.reserve = () => { throw Object.assign(new Error('Offline durable reservation failure'), { code: 'disk_failure' }); }; return ledger;
    } }), /Further requests stopped/);
    assert.equal(calls.filter((row) => row.method === 'POST').length, 0);
    assert.equal((await json(join(outputDir, 'results.json'))).fatalPersistenceError, 'request_reservation_failed');
    await assert.rejects(runEffortSpeedTrial({ ...opts, live: true, resume: true }), /previous artifact or ledger persistence failure/);
  });
});

test('an actual outgoing parameter mismatch is stopped before POST and never replaced by a fallback effort', async (t) => {
  await withTemporaryDirectory(async (directory) => {
    const opts = await options(directory), { outputDir } = await prepareEffortSpeedTrial(opts), calls = mockSupplier(t);
    await assert.rejects(runEffortSpeedTrial({ ...opts, live: true,
      requestProvider: (settings, ...args) => requestProvider({ ...settings, reasoningEffort: 'max' }, ...args) }), /Further requests stopped/);
    assert.equal(calls.filter((row) => row.method === 'POST').length, 0);
    assert.equal((await json(join(outputDir, 'results.json'))).fatalPersistenceError, 'outbound_guard_failed');
  });
});

test('archive and results persistence failures each stop after one analysis and permanently block automatic resume', async (t) => {
  const calls = mockSupplier(t);
  await withTemporaryDirectory(async (directory) => {
    for (const failure of ['raw', 'results']) {
      const opts = await options(join(directory, failure)), { outputDir } = await prepareEffortSpeedTrial(opts);
      const before = calls.filter((row) => row.method === 'POST').length;
      const extra = failure === 'raw' ? { artifactWrite: async (path, text, config) => {
        if (path.endsWith('.sse')) throw new Error('Offline raw archive failure'); return writeFile(path, text, config);
      } } : { resultsWrite: async (path, state) => {
        if (state.tasks.length) throw new Error('Offline results write failure'); return writeFile(path, `${JSON.stringify(state)}\n`);
      } };
      await assert.rejects(runEffortSpeedTrial({ ...opts, live: true, ...extra }), /(?:Further requests stopped|Results persistence failed)/);
      assert.equal(calls.filter((row) => row.method === 'POST').length - before, 1);
      assert.equal((await json(join(outputDir, 'fatal-stop.json'))).code, failure === 'raw' ? 'raw_archive_write_failed' : 'results_persistence_failed');
      await assert.rejects(runEffortSpeedTrial({ ...opts, live: true, resume: true }), /previous artifact or ledger persistence failure/);
      assert.equal(calls.filter((row) => row.method === 'POST').length - before, 1);
    }
  });
});

test('a changed frozen image or prompt is rejected before metadata or paid calls', async (t) => {
  await withTemporaryDirectory(async (directory) => {
    const opts = await options(directory), { outputDir } = await prepareEffortSpeedTrial(opts), calls = mockSupplier(t);
    const path = join(outputDir, 'prompts.json'), original = await readFile(path);
    await writeFile(path, Buffer.concat([original, Buffer.from(' ')]));
    await assert.rejects(runEffortSpeedTrial({ ...opts, live: true }), /Frozen concise prompt/); await writeFile(path, original);
    const photo = join(outputDir, `photos/${opts.offlineFixture.meals[0].mealId}.jpg`), bytes = await readFile(photo); bytes[bytes.length - 1] ^= 1;
    await writeFile(photo, bytes); await assert.rejects(runEffortSpeedTrial({ ...opts, live: true }), /Frozen image changed/);
    assert.equal(calls.length, 0);
  });
});

test('reports retain all-three failure denominators and separately label success-only timing without adding archive I/O', () => {
  const schedule = makeEffortSpeedSchedule('metric-fixture');
  const manifest = { runId: 'metric-fixture', manifestSha256: 'fixture', config: EFFORT_SPEED_CONFIG, profiles: EFFORT_SPEED_PROFILES, schedule,
    meals: EFFORT_SPEED_MEALS.map((meal) => ({ ...meal, prepared: meal })), prompts: { sha256: 'prompt' }, budget: { cap: 6 }, historicalMedium: { samples: [] } };
  const tasks = schedule.map((task, index) => acceptedRecord(task, [10000, 5000, 8000, 90000, 2000, 12000][index], { archiveElapsedMs: 120000 }));
  Object.assign(tasks[3], { status: 'timeout', businessAccepted: false, transportCompleted: false, error: { code: 'timeout' } });
  Object.assign(tasks[4], { status: 'request_error', businessAccepted: false, transportCompleted: false, error: { code: 'upstream_unavailable' } });
  const report = buildEffortSpeedReport(manifest, { tasks, metadataDiscovery: null });
  assert.equal(report.profiles.high.latencyMs.median, 10000); assert.equal(report.profiles.high.latencyMs.p90, 74000);
  assert.equal(report.profiles.high.latencyMs.denominator, 3); assert.equal(report.profiles.high.successOnlyLatencyMs.denominator, 1);
  assert.equal(report.profiles.high.successOnlyLatencyMs.median, 10000); assert.equal(report.profiles.xhigh.latencyMs.median, 8000);
  assert.equal(report.profiles.xhigh.successOnlyLatencyMs.p90, 11200);
  const markdown = renderEffortSpeedMarkdown(report); assert.match(markdown, /全三样本/); assert.match(markdown, /仅成功/); assert.match(markdown, /非同期/);
});
