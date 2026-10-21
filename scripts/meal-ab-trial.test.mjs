import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runTask } from './meal-ab-trial.mjs';
import { RealMealTestLedger } from './real-meal-test-ledger.mjs';
import { sha256 } from './meal-ab-core.mjs';
import { fakeProvider, recognition, completeSse, sse, withTemporaryDirectory } from './meal-latency-test-helpers.mjs';

test('old A/B orchestration records each actual stage and retains analysis/recognition when a failed review returns the whole result', async (t) => {
  await withTemporaryDirectory(async (directory) => {
    await mkdir(join(directory, 'photos'));
    const bytes = Buffer.from([0xff, 0xd8, 0xff]); await writeFile(join(directory, 'photos/meal.jpg'), bytes);
    const manifest = { meals: [{ mealId: 'old-ab-fixture', prepared: { path: 'photos/meal.jpg', bytes: bytes.length, sha256: sha256(bytes) } }] };
    const task = { sequence: 1, mealId: 'old-ab-fixture', group: 'project', validationRunId: 'old-ab-fixture-project', maxStages: 2 };
    const whole = recognition({ confidence: 0.35 }); whole.components[0].confidence = 0.35;
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      calls += 1;
      return new Response(calls === 1 ? completeSse(whole, { input_tokens: 10, output_tokens: 8, output_tokens_details: { reasoning_tokens: 3 } })
        : sse({ type: 'response.output_text.delta', delta: '{"partial_review":' }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    });
    const ledger = new RealMealTestLedger(join(directory, 'ledger.sqlite'), { limits: { totalRequests: null, perMealRequests: 2, reviewMeals: 10, cohortMeals: 10 } });
    try {
      const result = await runTask(task, manifest, ledger, { ...fakeProvider, model: 'gpt-6.1-sol', reasoningEffort: 'max' }, null,
        { outputDirectory: directory, progressCallback: async () => {}, createCrops: async () => undefined });
      assert.equal(calls, 2); assert.equal(result.status, 'accepted'); assert.equal(result.fallbackReason, 'review_failed');
      assert.equal(result.workflowCompleted, false); assert.equal(result.returnedStage, 'whole');
      assert.equal(result.stages.length, 2); assert.equal(result.stages[0].providerCompleted, true); assert.equal(result.stages[0].accepted, true);
      assert.ok(result.stages[0].analysis); assert.deepEqual(result.stages[0].recognition, whole);
      assert.equal(result.stages[1].providerCompleted, false); assert.equal(result.stages[1].accepted, false);
      assert.equal(result.stages[1].analysis, null); assert.equal(result.stages[1].status, 'format_error');
      const rows = ledger.attempts(); assert.equal(rows[0].status, 'accepted'); assert.equal(rows[1].status, 'format_error');
      assert.equal(rows[1].providerCompleted, false); assert.equal(rows[1].resultAccepted, false);
      assert.ok(!rows.some((row) => row.status === 'in_flight'));
      const archived = JSON.parse(await readFile(join(directory, result.stages[0].stageArtifact), 'utf8'));
      assert.deepEqual(archived.recognition, whole); assert.ok(archived.analysis.components.length);
      assert.equal(archived.usage.reasoning_tokens, 3);
      const raw = await readFile(join(directory, result.stages[1].rawArtifact), 'utf8'); assert.match(raw, /partial_review/);
    } finally { ledger.close(); }
  });
});

test('old A/B mandatory beforeRequest cannot send when ledger reservation fails', async (t) => {
  await withTemporaryDirectory(async (directory) => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff]); await writeFile(join(directory, 'meal.jpg'), bytes);
    let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls += 1; throw new Error('No supplier call expected.'); });
    const result = await runTask({ mealId: 'one', group: 'direct', validationRunId: 'one-direct', maxStages: 1 },
      { meals: [{ mealId: 'one', prepared: { path: 'meal.jpg', bytes: bytes.length, sha256: sha256(bytes) } }] },
      { reserve() { throw new Error('offline reservation rejected'); } }, { ...fakeProvider, model: 'gpt-6.1-sol', reasoningEffort: 'max' }, null,
      { outputDirectory: directory, progressCallback: async () => {} });
    assert.equal(calls, 0); assert.equal(result.status, 'not_sent'); assert.equal(result.stages.length, 0);
    assert.equal(result.fatalPersistenceError, 'request_reservation_failed');
  });
});
