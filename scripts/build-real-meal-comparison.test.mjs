import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nutritionDataset } from '../server/nutrition.mjs';
import { calculateMealNutrition } from '../shared/nutrition.mjs';
import { buildRealMealComparison } from './build-real-meal-comparison.mjs';

const mealId = 'breakfast_01';
const acceptedAnalysis = calculateMealNutrition({
  foodName: '米饭',
  confidence: 0.8,
  components: [{
    foodId: 'rice_white_long_grain_cooked', label: '熟白米饭', userQuantity: { amount: 100, unit: 'g' },
    uncertainty: [], confidence: 0.8,
  }],
  unresolved: [], assumptions: [], advice: '数量按用户填写值计算。',
}, nutritionDataset, { mode: 'user-quantity-v2' });

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'meal-comparison-build-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('comparison takes the last accepted stage and keeps unavailable nutrition unknown', async () => {
  await fixture(async (root) => {
    const batch = join(root, 'batch');
    await mkdir(batch);
    await writeFile(join(batch, 'summary.json'), JSON.stringify({
      runId: 'fresh-run',
      ledger: { totals: { totalRequests: 44 } },
      reports: [{ mealId, status: 'timeout' }],
    }));
    await writeFile(join(batch, `${mealId}.json`), JSON.stringify({
      mealId,
      status: 'timeout',
      final: null,
      stageResults: [{ stage: 'whole', accepted: true, analysis: acceptedAnalysis }],
      attempts: [
        { stage: 'whole', status: 'accepted', resultAccepted: true, elapsedMs: 12_000, httpStatus: 200 },
        { stage: 'crop_review', status: 'timeout', resultAccepted: false, elapsedMs: 120_000, httpStatus: 200 },
      ],
    }));
    const baselinePath = join(root, 'baseline.json');
    await writeFile(baselinePath, JSON.stringify([{ mealId, accepted: true, analysis: acceptedAnalysis }]));

    const { comparison, jsonPath, markdownPath } = await buildRealMealComparison({
      batchDir: batch, baselinePath, outputDir: batch,
    });
    assert.equal(comparison.comparisons[0].current.foodName, '米饭');
    assert.deepEqual(comparison.comparisons[0].current.nutrients.calories, acceptedAnalysis.calories);
    assert.equal(comparison.comparisons[0].attempts[1].status, 'timeout');
    assert.equal(comparison.requestSummary.ledgerTotalRequests, 44);
    assert.match(await readFile(markdownPath, 'utf8'), /120\.0 秒/);
    assert.equal(JSON.parse(await readFile(jsonPath, 'utf8')).groundTruthAvailable, false);
  });
});

test('failed final merge is reported separately while the accepted review remains current', async () => {
  await fixture(async (root) => {
    const batch = join(root, 'batch'); await mkdir(batch);
    await writeFile(join(batch, 'summary.json'), JSON.stringify({ runId: 'bounded-run', ledger: { totals: { totalRequests: 51 } }, reports: [{ mealId, status: 'budget_rejected' }] }));
    await writeFile(join(batch, `${mealId}.json`), JSON.stringify({
      mealId, status: 'budget_rejected', error: { kind: 'budget_rejected', code: 'diagnostic_request_limit' },
      stageResults: [
        { stage: 'whole', accepted: true, analysis: acceptedAnalysis },
        { stage: 'crop_review', accepted: true, analysis: acceptedAnalysis },
      ],
      attempts: [
        { stage: 'whole', status: 'accepted', resultAccepted: true, elapsedMs: 80_000, httpStatus: 200 },
        { stage: 'crop_review', status: 'accepted', resultAccepted: true, elapsedMs: 25_000, httpStatus: 200 },
      ],
    }));
    const baselinePath = join(root, 'baseline.json'); await writeFile(baselinePath, '[]');
    const { comparison, markdownPath } = await buildRealMealComparison({ batchDir: batch, baselinePath, outputDir: batch });
    assert.equal(comparison.comparisons[0].current.foodName, '米饭');
    assert.deepEqual(comparison.comparisons[0].stageRejections, [{ stage: 'final_merge', kind: 'budget_rejected', code: 'diagnostic_request_limit' }]);
    assert.match(await readFile(markdownPath, 'utf8'), /阶段未发送：最终合并/);
  });
});

test('failed stages cannot become current analysis and existing reports are not overwritten', async () => {
  await fixture(async (root) => {
    const batch = join(root, 'batch');
    await mkdir(batch);
    await writeFile(join(batch, 'summary.json'), JSON.stringify({ runId: 'empty-run', reports: [{ mealId, status: 'timeout' }] }));
    await writeFile(join(batch, `${mealId}.json`), JSON.stringify({
      mealId,
      status: 'timeout',
      final: { ...acceptedAnalysis, calories: { min: 999, max: 1000 } },
      stageResults: [],
      attempts: [{ stage: 'whole', status: 'timeout', resultAccepted: false }],
    }));
    const baselinePath = join(root, 'baseline.json');
    await writeFile(baselinePath, '[]');
    const jsonPath = join(batch, 'comparison.json');
    await writeFile(jsonPath, 'keep-me');

    await assert.rejects(buildRealMealComparison({ batchDir: batch, baselinePath }), /Refusing to overwrite/);
    assert.equal(await readFile(jsonPath, 'utf8'), 'keep-me');
  });
});

test('v3 comparisons retain useful references with empty quantities and report actual run metadata', async () => {
  await fixture(async (root) => {
    const batch = join(root, 'batch'); await mkdir(batch);
    const source = calculateMealNutrition({
      foodName: '番茄炒蛋', confidence: 0.8,
      components: [{ foodId: null, label: '番茄炒蛋', uncertainty: [], nutritionEstimate: {
        basisGrams: 100, method: 'typical_recipe', recipeBasis: '番茄、鸡蛋、少量油。', assumptions: ['典型家常配方。'], confidence: 0.7,
        per100g: { calories: { min: 100, max: 160 }, protein: { min: 5, max: 8 }, carbs: { min: 3, max: 7 }, fat: { min: 6, max: 11 } },
      } }], unresolved: [], assumptions: [], advice: '填写数量。',
    }, undefined, { mode: 'ai-per100g-v3', provenance: { model: 'gpt-6.1-sol', reasoningEffort: 'max', createdAt: '2026-10-17T01:02:03.000Z' } });
    await writeFile(join(batch, 'summary.json'), JSON.stringify({ runId: 'reference-run', upstreamTimeoutMs: 180_000,
      stream: true, imageDetail: 'low', ledger: { totals: { totalRequests: 58 } }, reports: [{ mealId, status: 'accepted' }] }));
    await writeFile(join(batch, `${mealId}.json`), JSON.stringify({ mealId, status: 'accepted',
      stageResults: [{ stage: 'whole', accepted: true, providerCompleted: true, analysis: source }],
      requestAttempts: [{ stage: 'whole', status: 'accepted', providerCompleted: true, resultAccepted: true, elapsedMs: 20_000,
        httpStatus: 200, model: 'gpt-6.1-sol', reasoningEffort: 'max', resultVersion: 3, usage: { input_tokens: 12, output_tokens: 34, total_tokens: 46 } }],
    }));
    const baselinePath = join(root, 'baseline.json'); await writeFile(baselinePath, '[]');
    const { comparison, markdownPath } = await buildRealMealComparison({ batchDir: batch, baselinePath });
    assert.equal(comparison.schemaVersion, 'real-meal-comparison.v2');
    assert.equal(comparison.timeoutMs, 180_000);
    assert.equal(comparison.scope, 'per100g_reference_and_user_quantity');
    assert.equal(comparison.requestSummary.totalRequests, 1);
    assert.equal(comparison.requestSummary.completedRequests, 1);
    assert.equal(comparison.requestSummary.successfulStages, 1);
    assert.equal(comparison.requestSummary.ledgerRemainingRequests, 17);
    assert.equal(comparison.nutritionSummary.usefulReferenceMeals, 1);
    assert.equal(comparison.nutritionSummary.referenceOnlyMeals, 1);
    assert.equal(comparison.nutritionSummary.intakeCompleteMeals, 0);
    assert.equal(comparison.comparisons[0].current.nutrients.calories, null);
    assert.equal(comparison.comparisons[0].current.components[0].userQuantity, null);
    assert.deepEqual(comparison.comparisons[0].current.components[0].reference.nutrients, source.components[0].source.per100gRange);
    assert.match(await readFile(markdownPath, 'utf8'), /实际摄入仅按用户填写数量在本地换算/);
  });
});

test('an explicitly incomplete stage cannot be promoted by an accepted report wrapper', async () => {
  await fixture(async (root) => {
    const batch = join(root, 'batch'); await mkdir(batch);
    await writeFile(join(batch, 'summary.json'), JSON.stringify({ runId: 'incomplete-run', reports: [{ mealId, status: 'accepted' }] }));
    await writeFile(join(batch, `${mealId}.json`), JSON.stringify({ mealId, status: 'accepted', final: acceptedAnalysis,
      stageResults: [{ stage: 'whole', accepted: true, providerCompleted: false, analysis: acceptedAnalysis }],
      attempts: [{ stage: 'whole', status: 'accepted', providerCompleted: false, resultAccepted: true }],
    }));
    const baselinePath = join(root, 'baseline.json'); await writeFile(baselinePath, '[]');
    const { comparison } = await buildRealMealComparison({ batchDir: batch, baselinePath });
    assert.equal(comparison.comparisons[0].current, null);
    assert.equal(comparison.requestSummary.completedRequests, 0);
    assert.equal(comparison.requestSummary.successfulStages, 0);
    assert.equal(comparison.timeoutMs, null);
  });
});

test('comparison follows the single-meal returned stage after a final-merge fallback', async () => {
  await fixture(async (root) => {
    const batch = join(root, 'batch'); await mkdir(batch);
    const first = acceptedAnalysis;
    const review = { ...acceptedAnalysis, foodName: '复核阶段菜名' };
    const returnedStageResult = { stage: 'whole', attemptId: 1, status: 'accepted', accepted: true, resultAccepted: true,
      providerCompleted: true, completed: true, stageSucceeded: true, analysis: first };
    await writeFile(join(batch, 'summary.json'), JSON.stringify({ runId: 'fallback-run', ledger: { totals: { totalRequests: 3 } }, reports: [{ mealId, status: 'accepted' }] }));
    await writeFile(join(batch, `${mealId}.json`), JSON.stringify({
      mealId, status: 'accepted', final: first, returnedAnalysis: first, returnedStage: 'whole', returnedAttemptId: 1,
      returnedStageResult,
      validation: { accepted: true, returnedStage: 'whole', returnedAttemptId: 1 },
      stageResults: [
        returnedStageResult,
        { stage: 'crop_review', attemptId: 2, status: 'accepted', accepted: true, resultAccepted: true,
          providerCompleted: true, completed: true, stageSucceeded: true, analysis: review },
      ],
      attempts: [
        { stage: 'whole', attemptId: 1, status: 'accepted', providerCompleted: true, resultAccepted: true, stageSucceeded: true, httpStatus: 200, elapsedMs: 100 },
        { stage: 'crop_review', attemptId: 2, status: 'accepted', providerCompleted: true, resultAccepted: true, stageSucceeded: true, httpStatus: 200, elapsedMs: 200 },
        { stage: 'final_merge', attemptId: 3, status: 'timeout', providerCompleted: false, resultAccepted: false, stageSucceeded: false, httpStatus: 200, elapsedMs: 180_000 },
      ],
    }));
    const baselinePath = join(root, 'baseline.json'); await writeFile(baselinePath, '[]');
    const { comparison } = await buildRealMealComparison({ batchDir: batch, baselinePath });
    assert.equal(comparison.comparisons[0].current.foodName, '米饭');
    assert.equal(comparison.comparisons[0].currentLabel, '本次已接受结果');
    assert.equal(comparison.requestSummary.totalRequests, 3);
    assert.equal(comparison.requestSummary.acceptedRequests, 2);
    assert.equal(comparison.requestSummary.failedRequests, 1);
  });
});
