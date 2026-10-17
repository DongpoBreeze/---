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
