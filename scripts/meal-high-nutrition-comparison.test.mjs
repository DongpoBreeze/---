import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { requestProvider } from '../src/ai-provider.ts';
import { DIRECT_INSTRUCTIONS, DIRECT_USER_TEXT, validateDirect } from './meal-ab-core.mjs';
import { sha256 } from './meal-latency-core.mjs';
import { assertArtifactsHaveNoSecret } from './meal-latency-capture.mjs';
import { RealMealTestLedger } from './real-meal-test-ledger.mjs';
import { acceptedRecord, completedEnvelope, fakeProvider, ranges, sse, withTemporaryDirectory, syntheticTrialHistory } from './meal-latency-test-helpers.mjs';
import { HIGH_NUTRITION_CONFIG, HIGH_NUTRITION_INPUTS, highNutritionLedgerOptions, highNutritionSchedule,
  prepareHighNutritionComparison, verifyHighNutritionFreeze, verifyHighNutritionArtifacts, runHighNutritionComparison,
  buildHighNutritionComparison, renderHighNutritionHtml, renderHighNutritionMarkdown } from './meal-high-nutrition-comparison.mjs';

const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const optionsFor = async (directory) => {
  const history = await syntheticTrialHistory(directory);
  return { ...history, sourceOutputDir: history.effortOutputDir, runId: 'offline-high-nutrition', outputDir: join(directory, 'nutrition') };
};
const direct = () => ({ components: [{ label: '熟玉米段', evidence: ['黄色籽粒可见'], uncertainty: ['品种不明'],
  per100g: structuredClone(ranges), recipeBasis: '按通常熟制玉米粒的含水量估计', assumptions: ['排除玉米芯；未加油糖'] }], uncertainty: ['不能确定烹调方式'] });
function mockSupplier(t, content = direct) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(init?.method, 'POST'); const body = JSON.parse(init.body); calls.push({ url: String(url), body });
    const value = content(calls.length), usage = { input_tokens: 22, output_tokens: 33, total_tokens: 55,
      input_tokens_details: { cached_tokens: 5 }, output_tokens_details: { reasoning_tokens: 12 } };
    const envelope = { ...completedEnvelope(value, usage), model: 'supplier-reported-model', reasoning: { effort: 'high' } };
    return new Response(sse({ type: 'response.created', response: { model: envelope.model, reasoning: envelope.reasoning } })
      + sse({ type: 'response.output_text.delta', delta: JSON.stringify(value) })
      + sse({ type: 'response.completed', response: envelope }), { headers: { 'Content-Type': 'text/event-stream' } });
  }); return calls;
}

test('offline preparation preserves the exact three historical high records, JPEGs, concise prompt and timeout', async (t) => {
  await withTemporaryDirectory(async (directory) => {
    let calls = 0; t.mock.method(globalThis, 'fetch', () => { calls += 1; throw new Error('Preparation must stay offline'); });
    const opts = await optionsFor(directory), { outputDir, manifest } = await prepareHighNutritionComparison(opts);
    assert.equal(calls, 0); assert.deepEqual(manifest.config, HIGH_NUTRITION_CONFIG);
    assert.equal(manifest.budget.cap, 3); assert.equal(manifest.budget.historicalLedgersUsed, false);
    assert.deepEqual(manifest.schedule.map((task) => task.mealId), opts.highInputs.map((row) => row.mealId));
    const reused = await json(join(outputDir, 'reused-project.json'));
    assert.deepEqual(reused.tasks.map((row) => row.status), ['accepted', 'accepted', 'timeout']);
    assert.deepEqual(reused.tasks.map((row) => row.elapsedMs), opts.highInputs.map((row) => row.elapsedMs));
    assert.equal(reused.tasks[2].analysis, null); assert.equal(reused.tasks[2].recognition, null);
    for (const expected of opts.highInputs) {
      const bytes = await readFile(join(outputDir, `photos/${expected.mealId}.jpg`));
      assert.equal(sha256(bytes), expected.sha256); assert.equal(bytes.length, expected.bytes);
    }
    const prompts = await json(join(outputDir, 'prompts.json'));
    assert.equal(prompts.direct.instructions, DIRECT_INSTRUCTIONS); assert.equal(prompts.direct.userText, DIRECT_USER_TEXT);
    assert.equal(prompts.projectConcise.instructionsSha256, opts.offlineFixture.conciseSha);
    assert.equal(manifest.evidence, 'synthetic_offline_fixture_not_real_experiment');
    assert.equal(manifest.reuseProvenance.historicalProviderSourceSha256, manifest.sourceFingerprints.find((row) => row.path === 'src/ai-provider.ts').sha256);
    assert.equal((await verifyHighNutritionFreeze(opts)).manifestSha256, manifest.manifestSha256);
    assert.deepEqual((await verifyHighNutritionArtifacts(opts)).reservedRequests, 0);
    const report = await json(join(outputDir, 'comparison.json'));
    assert.equal(report.meals[2].project.available, false); assert.deepEqual(report.meals[2].project.components, []);
  });
});

test('three serial direct/high requests enforce frozen prompts, image bytes, 90 seconds, one stage, independent cap and no-resend resume', async (t) => {
  await withTemporaryDirectory(async (directory) => {
    const opts = await optionsFor(directory), { outputDir, manifest } = await prepareHighNutritionComparison(opts), calls = mockSupplier(t), deadlines = [];
    const report = await runHighNutritionComparison({ ...opts, live: true, requestProvider: (...args) => {
      deadlines.push({ timeoutMs: args[4].timeoutMs, contract: args[4].contract, maxStages: args[4].maxStages }); return requestProvider(...args);
    } });
    assert.equal(calls.length, 3); assert.equal(report.ledger.reservedRequests, 3); assert.equal(report.ledger.recordedDispatches, 3);
    assert.equal(report.ledger.metadataRequests, 0); assert.equal(report.summary.direct.completeAndValid, 3);
    assert.deepEqual(deadlines, Array.from({ length: 3 }, () => ({ timeoutMs: 90000, contract: 'direct', maxStages: 1 })));
    for (const [index, call] of calls.entries()) {
      const body = call.body;
      assert.deepEqual(Object.keys(body).sort(), ['model', 'instructions', 'input', 'reasoning', 'max_output_tokens', 'store', 'stream', 'text'].sort());
      assert.equal(body.model, 'gpt-6.1-sol'); assert.deepEqual(body.reasoning, { effort: 'high' });
      assert.equal(body.stream, true); assert.equal(body.max_output_tokens, 8192); assert.equal(body.store, false);
      assert.equal(body.instructions, DIRECT_INSTRUCTIONS); assert.equal(body.input[0].content[0].text, DIRECT_USER_TEXT);
      assert.equal(body.input[0].content[1].detail, 'low'); assert.equal(body.input[0].content.length, 2);
      assert.equal(sha256(Buffer.from(body.input[0].content[1].image_url.split(',')[1], 'base64')), opts.highInputs[index].sha256);
    }
    assert.ok(report.meals.every((meal) => meal.direct.supplierEcho.model === 'supplier-reported-model'
      && meal.direct.supplierEcho.reasoningEffort === 'high' && meal.direct.usage.reasoning_tokens === 12 && meal.direct.usage.cached_input_tokens === 5));
    const ledger = new RealMealTestLedger(join(outputDir, 'requests.sqlite'), highNutritionLedgerOptions(manifest.runId));
    try { assert.equal(ledger.scope.length, 1); assert.throws(() => ledger.reserve({ mealId: 'extra', validationRunId: 'extra', stage: 'whole', model: 'gpt-6.1-sol', reasoningEffort: 'high' }), /3-request/); }
    finally { ledger.close(); }
    await runHighNutritionComparison({ ...opts, live: true, resume: true }); assert.equal(calls.length, 3);
    assert.equal((await verifyHighNutritionArtifacts(opts)).validDirectMeals, 3); await assertArtifactsHaveNoSecret(outputDir, fakeProvider.key);
  });
});

test('an interrupted durable reservation is never resent and only the two untouched images can be sent', async (t) => {
  await withTemporaryDirectory(async (directory) => {
    const opts = await optionsFor(directory), { outputDir, manifest } = await prepareHighNutritionComparison(opts);
    const ledger = new RealMealTestLedger(join(outputDir, 'requests.sqlite'), highNutritionLedgerOptions(manifest.runId));
    ledger.reserve({ ...manifest.schedule[0], stage: 'whole', model: 'gpt-6.1-sol', reasoningEffort: 'high' }); ledger.close();
    const calls = mockSupplier(t);
    await assert.rejects(runHighNutritionComparison({ ...opts, live: true }), /Prior reservations/); assert.equal(calls.length, 0);
    const report = await runHighNutritionComparison({ ...opts, live: true, resume: true });
    assert.equal(calls.length, 2); assert.equal(report.ledger.reservedRequests, 3); assert.equal(report.ledger.recordedDispatches, 2);
    assert.equal(report.meals[0].direct.status, 'interrupted'); assert.equal(report.meals[0].direct.available, false);
    assert.equal(report.meals[0].direct.elapsedMs, 90000); assert.equal(report.summary.direct.completeAndValid, 2);
    await runHighNutritionComparison({ ...opts, live: true, resume: true }); assert.equal(calls.length, 2);
  });
});

test('reservation, raw archive, ledger finish and result persistence failures stop all subsequent sends', async (t) => {
  const calls = mockSupplier(t);
  await withTemporaryDirectory(async (directory) => {
    for (const mode of ['reserve', 'raw', 'finish', 'results']) {
      const opts = await optionsFor(join(directory, mode)), { outputDir } = await prepareHighNutritionComparison(opts), before = calls.length;
      const inject = mode === 'raw' ? { artifactWrite: async (path, bytes, settings) => { if (path.endsWith('.sse')) throw new Error('Offline raw failure'); return writeFile(path, bytes, settings); } }
        : mode === 'results' ? { resultsWrite: async () => { throw new Error('Offline results failure'); } }
          : { ledgerFactory: (path, settings) => { const ledger = new RealMealTestLedger(path, settings); ledger[mode] = () => { throw new Error('Offline ledger failure'); }; return ledger; } };
      await assert.rejects(runHighNutritionComparison({ ...opts, live: true, ...inject }), /[Ff]urther requests stopped/);
      assert.equal(calls.length - before, ['reserve', 'results'].includes(mode) ? 0 : 1);
      assert.ok(await json(join(outputDir, 'fatal-stop.json')));
      await assert.rejects(runHighNutritionComparison({ ...opts, live: true, resume: true }), /prior persistence or guard failure/);
      assert.equal(calls.length - before, ['reserve', 'results'].includes(mode) ? 0 : 1);
    }
  });
});

test('complete transport with an invalid direct schema, partial text and HTTP failures consume one attempt each without nutrition', async (t) => {
  await withTemporaryDirectory(async (directory) => {
    const opts = await optionsFor(directory), { outputDir } = await prepareHighNutritionComparison(opts); let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      calls += 1;
      if (calls === 1) {
        const value = direct(); value.components[0].per100g.extra = { min: 1, max: 2 };
        return new Response(sse({ type: 'response.completed', response: completedEnvelope(value) }), { headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (calls === 2) return new Response(sse({ type: 'response.output_text.delta', delta: 'partial text only' })
        + sse({ type: 'response.incomplete', response: { status: 'incomplete' } }), { headers: { 'Content-Type': 'text/event-stream' } });
      return Response.json({ error: { message: `unsupported ${fakeProvider.key}` } }, { status: 400 });
    });
    const report = await runHighNutritionComparison({ ...opts, live: true }); assert.equal(calls, 3);
    assert.equal(report.summary.direct.completeAndValid, 0); assert.equal(report.summary.direct.completedTransports, 1);
    assert.ok(report.meals.every((meal) => !meal.direct.available && meal.direct.components.length === 0 && meal.direct.rawArtifact));
    const ledger = new RealMealTestLedger(join(outputDir, 'requests.sqlite'), highNutritionLedgerOptions(opts.runId));
    try { assert.ok(ledger.attempts().every((row) => !row.resultAccepted)); assert.equal(ledger.attempts()[0].providerCompleted, true); }
    finally { ledger.close(); }
    await runHighNutritionComparison({ ...opts, live: true, resume: true }); assert.equal(calls, 3);
    await assertArtifactsHaveNoSecret(outputDir, fakeProvider.key);
  });
});

test('changing frozen JPEG bytes blocks all sends, and a changed direct raw archive blocks resume', async (t) => {
  await withTemporaryDirectory(async (directory) => {
    const opts = await optionsFor(directory), { outputDir } = await prepareHighNutritionComparison(opts), calls = mockSupplier(t);
    const photo = join(outputDir, `photos/${opts.highInputs[0].mealId}.jpg`), original = await readFile(photo);
    await writeFile(photo, 'changed frozen bytes');
    await assert.rejects(runHighNutritionComparison({ ...opts, live: true }), /Frozen photo/); assert.equal(calls.length, 0);
    await writeFile(photo, original); await runHighNutritionComparison({ ...opts, live: true }); assert.equal(calls.length, 3);
    await writeFile(join(outputDir, 'requests/1-whole.sse'), 'changed raw bytes');
    await assert.rejects(runHighNutritionComparison({ ...opts, live: true, resume: true }), /archive or ledger integrity/); assert.equal(calls.length, 3);
  });
});

test('all returned dishes, null references and evidence remain visible; HTML escapes content and works without external assets', async () => {
  await withTemporaryDirectory(async (directory) => {
    const opts = await optionsFor(directory), { outputDir, manifest } = await prepareHighNutritionComparison(opts);
    const reused = await json(join(outputDir, 'reused-project.json')), tasks = highNutritionSchedule(opts.runId, opts.highInputs).map((task) => {
      const result = direct(); result.components.push({ label: '<script>alert("x")</script> 第二道', evidence: ['可见第二道'],
        uncertainty: ['无法估计配方'], per100g: null, recipeBasis: null, assumptions: ['未知不能补零'] });
      validateDirect(result);
      return acceptedRecord(task, 500, { analysis: result, recognition: result });
    });
    const report = buildHighNutritionComparison(manifest, { tasks }, reused, { reservedRequests: 3, recordedDispatches: 3 });
    assert.equal(report.summary.direct.returnedComponents, 6); assert.equal(report.summary.direct.componentsWithPer100g, 3);
    assert.equal(report.meals[2].direct.components.length, 2); assert.equal(report.meals[2].project.components.length, 0);
    assert.equal(report.meals[2].direct.components[1].per100g, null);
    const markdown = renderHighNutritionMarkdown(report), document = renderHighNutritionHtml(report, Object.fromEntries(opts.highInputs.map((row) => [row.mealId, 'ZmFrZQ=='])));
    assert.match(markdown, /90 秒超时/); assert.match(markdown, /未知不能补零/); assert.match(markdown, /不能单独证明更准确/);
    assert.equal((document.match(/class="component"/g) ?? []).length, 8); assert.equal((document.match(/src="data:image\/jpeg;base64,/g) ?? []).length, 3);
    assert.doesNotMatch(document, /<script/i); assert.match(document, /&lt;script&gt;/); assert.doesNotMatch(document, /(?:src|href)="https?:\/\//);
    assert.match(document, /default-src 'none'/); assert.match(document, /配方依据/); assert.match(document, /可见依据/); assert.match(document, /无法估计配方/);
  });
});
