import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RealMealTestLedger, REAL_MEAL_LIMITS } from './real-meal-test-ledger.mjs';
import { discoverMealImages, runBatch, runLiveBatch, selectValidationMeals } from './batch-real-food-image.mjs';

async function fixture(count = 3) {
  const root = await mkdtemp(join(tmpdir(), 'batch-real-'));
  for (let i = 0; i < count; i += 1) { const dir = join(root, `meal-${i}`); await mkdir(dir); await writeFile(join(dir, 'photo.jpg'), 'fixture'); }
  return root;
}

test('batch accepts first pass and performs adaptive review, writing anonymous reports', async () => {
  const input = await fixture(1); const output = await mkdtemp(join(tmpdir(), 'batch-out-'));
  try {
    const calls = [];
    const result = await runBatch({ inputDir: input, outputDir: output, ledger: new RealMealTestLedger(':memory:'), callMeal: async (request) => { calls.push(request.stage); return request.stage === 'whole' ? { lowConfidence: true, analysis: { ingredients: [] } } : { analysis: { ingredients: [{ name: 'egg' }] } }; } });
    assert.deepEqual(calls, ['whole', 'crop_review']); assert.equal(result.summary.statusCounts.accepted, 1);
    const report = JSON.parse(await readFile(join(output, 'meal-0.json'), 'utf8'));
    assert.equal(report.mealId, 'meal-0'); assert.equal(report.attempts.length, 2); assert.equal(report.imagePath, undefined);
  } finally { await rm(input, { recursive: true, force: true }); await rm(output, { recursive: true, force: true }); }
});

test('batch classifies timeout/schema failures and continues subsequent meals', async () => {
  const input = await fixture(3); const output = await mkdtemp(join(tmpdir(), 'batch-out-'));
  try {
    const result = await runBatch({ inputDir: input, outputDir: output, ledger: new RealMealTestLedger(':memory:'), callMeal: async ({ mealId }) => { if (mealId.endsWith('-0')) throw Object.assign(new Error('upstream timeout'), { code: 'upstream_timeout' }); if (mealId.endsWith('-1')) throw Object.assign(new Error('invalid schema'), { code: 'invalid_model_response' }); return { analysis: {} }; } });
    assert.equal(result.reports.length, 3); assert.deepEqual(result.reports.map((r) => r.status), ['timeout', 'schema_error', 'accepted']);
  } finally { await rm(input, { recursive: true, force: true }); await rm(output, { recursive: true, force: true }); }
});

test('ledger budget rejection is reported and does not stop later meals', async () => {
  const input = await fixture(2); const output = await mkdtemp(join(tmpdir(), 'batch-out-')); const ledger = new RealMealTestLedger(':memory:');
  try {
    for (let i = 0; i < REAL_MEAL_LIMITS.reviewMeals; i += 1) {
      for (const stage of ['whole', 'crop_review', 'final_merge']) {
        const attempt = ledger.reserve({ mealId: `pre-${i}`, validationRunId: 'budget-round', stage, model: 'gpt-6.1-sol', reasoningEffort: 'max', resultVersion: 2 });
        ledger.finish(attempt.attemptId, { elapsedMs: 1, httpStatus: 200, providerCompleted: true, resultAccepted: true, outcome: 'accepted' });
      }
    }
    const result = await runBatch({ inputDir: input, outputDir: output, ledger, runId: 'budget-round', callMeal: async () => ({ analysis: {} }) });
    assert.equal(result.reports.every((r) => r.status === 'budget_rejected'), true);
  } finally { await rm(input, { recursive: true, force: true }); await rm(output, { recursive: true, force: true }); }
});

test('discovery descends breakfast/dinner folders, identifies meal directories, and rejects duplicate ids', async () => {
  const root = await mkdtemp(join(tmpdir(), 'meal-discovery-'));
  try {
    for (const [group, meal] of [['breakfast', 'oatmeal'], ['dinner', 'salad']]) {
      const folder = join(root, group, meal); await mkdir(folder, { recursive: true }); await writeFile(join(folder, 'plate.PNG'), 'photo');
    }
    const found = await discoverMealImages({ inputDir: root });
    assert.deepEqual(found.map(({ mealId }) => mealId), ['breakfast_oatmeal', 'dinner_salad']);
    const collision = join(root, 'collision'); await mkdir(join(collision, 'same'), { recursive: true });
    await writeFile(join(collision, 'same', 'photo.jpg'), 'photo');
    await writeFile(join(collision, 'same', 'meal.jpeg'), 'photo');
    await assert.rejects(discoverMealImages({ inputDir: collision }), /exactly one supported image/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('validation cohort selects the first five meals from each group in natural order', () => {
  const meals = ['breakfast_10', 'breakfast_02', 'breakfast_01', 'breakfast_03', 'breakfast_04', 'breakfast_05', 'breakfast_06',
    'dinner_08', 'dinner_05', 'dinner_01', 'dinner_04', 'dinner_03', 'dinner_02', 'dinner_06']
    .map((mealId) => ({ mealId, imagePath: `${mealId}.jpg` }));
  assert.deepEqual(selectValidationMeals(meals).map((meal) => meal.mealId), [
    'breakfast_01', 'breakfast_02', 'breakfast_03', 'breakfast_04', 'breakfast_05',
    'dinner_01', 'dinner_02', 'dinner_03', 'dinner_04', 'dinner_05',
  ]);
});

test('live batch calls one single-meal runner per meal, continues failure, and summarizes its ledger once', async () => {
  const output = await mkdtemp(join(tmpdir(), 'batch-live-out-'));
  const meals = [{ mealId: 'breakfast_a', imagePath: 'private/path-a.jpg' }, { mealId: 'dinner_b', imagePath: 'private/path-b.jpg' }];
  let calls = 0;
  try {
    const result = await runLiveBatch({ meals, outputDir: output, runMeal: async ({ mealId }) => {
      calls += 1;
      if (mealId === 'breakfast_a') throw Object.assign(new Error('model timed out'), { code: 'upstream_timeout' });
      return { result: { status: 200, analysis: { ingredients: [] } }, requestAttempts: [{ stage: 'whole', status: 'accepted', httpStatus: 200, elapsedMs: 30 }] };
    }, getLedgerTotals: () => ({ totalRequests: calls, firstPassMeals: calls, reviewedMeals: 0 }) });
    assert.equal(calls, 2); assert.deepEqual(result.reports.map((r) => r.status), ['timeout', 'accepted']);
    assert.equal(result.summary.ledger.totals.totalRequests, 2);
    const json = await readFile(join(output, 'breakfast_a.json'), 'utf8');
    assert.equal(json.includes('private/path-a.jpg'), false);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('live batch retains accepted whole-image analysis when a later review times out', async () => {
  const output = await mkdtemp(join(tmpdir(), 'batch-live-out-'));
  const meals = [{ mealId: 'breakfast_a', imagePath: 'private/path-a.jpg' }];
  const accepted = { status: 'approximate', foodName: '米饭和鸡肉', calories: { min: 500, max: 800 } };
  try {
    const result = await runLiveBatch({ meals, outputDir: output, runMeal: async () => ({
      result: { status: 504, errorCode: 'upstream_timeout', analysis: null },
      stageResults: [{ stage: 'whole', attemptId: 41, status: 'accepted', accepted: true, analysis: accepted }],
      requestAttempts: [
        { stage: 'whole', attemptId: 41, status: 'accepted', resultAccepted: true, elapsedMs: 49_000, httpStatus: 200 },
        { stage: 'crop_review', attemptId: 42, status: 'request_error', resultAccepted: false, elapsedMs: 120_000, httpStatus: 200 },
      ],
    }), getLedgerTotals: () => ({ totalRequests: 41, firstPassMeals: 31, reviewedMeals: 8 }) });
    assert.equal(result.reports[0].status, 'timeout');
    assert.deepEqual(result.reports[0].final, accepted);
    assert.equal(result.reports[0].stageResults.length, 1);
    assert.equal(result.reports[0].attempts.length, 2);
    const saved = JSON.parse(await readFile(join(output, 'breakfast_a.json'), 'utf8'));
    assert.deepEqual(saved.final, accepted);
    assert.equal(saved.attempts[1].status, 'request_error');
  } finally { await rm(output, { recursive: true, force: true }); }
});
