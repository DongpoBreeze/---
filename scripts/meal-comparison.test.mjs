import test from 'node:test';
import assert from 'node:assert/strict';
import { nutritionDataset } from '../server/nutrition.mjs';
import { calculateMealNutrition } from '../shared/nutrition.mjs';
import { createMealComparison, renderMealComparisonMarkdown, summarizeMealAnalysis } from './meal-comparison.mjs';

const analysis = (changes = {}) => calculateMealNutrition({
  foodName: '米饭和鸡蛋',
  confidence: 0.8,
  components: [
    { foodId: 'rice_white_long_grain_cooked', label: '熟米饭', userQuantity: { amount: 100, unit: 'g' }, uncertainty: [], confidence: 0.9 },
    { foodId: null, label: '蛋类', category: 'egg', userQuantity: null, uncertainty: ['无法确认种类'], candidates: [{ foodId: 'egg_hard_boiled', label: '熟鸡蛋', confidence: 0.65 }] },
  ],
  unresolved: ['蛋类数量未知。'],
  assumptions: ['营养按用户填写数量计算。'],
  advice: '测试',
  ...changes,
}, nutritionDataset, { mode: 'user-quantity-v2' });

const aiAnalysis = () => calculateMealNutrition({
  foodName: '番茄炒蛋', confidence: 0.8,
  components: [{ foodId: null, label: '番茄炒蛋', uncertainty: [], nutritionEstimate: {
    basisGrams: 100, method: 'typical_recipe', recipeBasis: '番茄与鸡蛋约 2:1，少量烹调油。',
    assumptions: ['常见家常炒制，油量存在差异。'], confidence: 0.7,
    per100g: { calories: { min: 100, max: 160 }, protein: { min: 5, max: 8 }, carbs: { min: 3, max: 7 }, fat: { min: 6, max: 11 } },
  } }], unresolved: [], assumptions: [], advice: '填写实际数量后计算摄入。',
}, nutritionDataset, { mode: 'ai-per100g-v3', provenance: { model: 'gpt-6.1-sol', reasoningEffort: 'max', createdAt: '2026-10-17T01:02:03.000Z' } });

test('summaries preserve local nutrient intervals, components, scope and uncertainty', () => {
  const result = summarizeMealAnalysis(analysis());
  assert.deepEqual(result.nutrients.calories, { min: 130, max: 130 });
  assert.deepEqual(result.nutrients.protein, { min: 2.6, max: 2.7 });
  assert.equal(result.status, 'approximate');
  assert.equal(result.nutritionSource.method, 'user-quantity-v2');
  assert.equal(result.components[1].candidates[0].foodId, 'egg_hard_boiled');
  assert.deepEqual(result.components[1].uncertainty, ['无法确认种类']);
  assert.ok(result.unresolved.includes('蛋类数量未知。'));
  assert.ok(result.assumptions.length);
});

test('null and non-local nutrients remain unknown and raw model totals are ignored', () => {
  const notLocal = { status: 'estimated', calories: { min: 10, max: 20 }, protein: { min: 1, max: 2 }, components: [] };
  assert.deepEqual(summarizeMealAnalysis(notLocal).nutrients, { calories: null, protein: null, carbs: null, fat: null });
  const localWithNull = summarizeMealAnalysis({ ...analysis(), protein: null });
  assert.equal(localWithNull.nutrients.protein, null);
});

test('failed report wrappers do not contribute an analysis', () => {
  const raw = analysis();
  assert.equal(summarizeMealAnalysis({ status: 'timeout', analysis: raw }), null);
  assert.equal(summarizeMealAnalysis({ status: 'failed', components: raw.components }), null);
  assert.ok(summarizeMealAnalysis({ status: 'accepted', analysis: raw }));
});

test('comparison distinguishes no prior accepted result and reports attempt status and timing', () => {
  const comparison = createMealComparison({
    mealId: 'breakfast_01',
    previous: null,
    current: { status: 'accepted', analysis: analysis() },
    attempts: [
      { stage: 'whole', status: 'timeout', elapsedMs: 55000, httpStatus: 200, providerCompleted: false, resultAccepted: false },
      { stage: 'whole', status: 'accepted', elapsedMs: 21850, httpStatus: 200, providerCompleted: true, resultAccepted: true },
    ],
  });
  assert.equal(comparison.previous, null);
  assert.equal(comparison.previousLabel, '此前无已接受结果');
  const markdown = renderMealComparisonMarkdown({ runId: 'run-1', model: 'test-model', reasoningEffort: 'max', comparisons: [comparison] });
  assert.match(markdown, /此前无已接受结果，无法建立营养基线/);
  assert.match(markdown, /热量 \| 130 kcal/);
  assert.match(markdown, /蛋白质 \| 2.6–2.7 g/);
  assert.match(markdown, /碳水化合物 \| 28.2 g/);
  assert.match(markdown, /脂肪 \| 0.2–0.3 g/);
  assert.match(markdown, /用户填写 100 g/);
  assert.match(markdown, /每 100 g/);
  assert.match(markdown, /整图：超时，55.0 秒，HTTP 200/);
  assert.match(markdown, /整图：已接受，21.9 秒，HTTP 200，结果已接受/);
  assert.match(markdown, /熟米饭（rice_white_long_grain_cooked）/);
  assert.match(markdown, /候选：熟鸡蛋（egg_hard_boiled）/);
});

test('renderer prints unknown nutrient cells instead of filling them with a subtotal', () => {
  const current = { ...summarizeMealAnalysis(analysis()), nutrients: { calories: null, protein: null, carbs: null, fat: null } };
  const comparison = createMealComparison({ mealId: 'dinner_01', current });
  const markdown = renderMealComparisonMarkdown({ comparisons: [comparison], requestSummary: { totalRequests: 2, statusCounts: { timeout: 1, accepted: 1 } } });
  assert.match(markdown, /热量 \| 未知/);
  assert.match(markdown, /蛋白质 \| 未知/);
  assert.match(markdown, /请求数：2/);
  assert.match(markdown, /超时 1、已接受 1/);
});

test('current analysis absence is stated separately from a missing historical baseline', () => {
  const comparison = createMealComparison({ mealId: 'dinner_02', previous: null, current: null });
  const markdown = renderMealComparisonMarkdown({ comparisons: [comparison] });
  assert.match(markdown, /此前无已接受结果，无法建立营养基线/);
  assert.match(markdown, /本次没有已接受的分析结果/);
});

test('batch status and locally rejected stages remain distinct from completed model attempts', () => {
  const comparison = createMealComparison({
    mealId: 'dinner_05', current: analysis(), batchStatus: 'budget_rejected',
    batchError: { code: 'diagnostic_request_limit' },
    stageRejections: [{ stage: 'final_merge', kind: 'budget_rejected', code: 'diagnostic_request_limit' }],
    attempts: [{ stage: 'whole', status: 'accepted', elapsedMs: 80_000, httpStatus: 200, resultAccepted: true }],
  });
  const markdown = renderMealComparisonMarkdown({ comparisons: [comparison] });
  assert.match(markdown, /本轮流程状态：请求额度拒绝（diagnostic_request_limit）/);
  assert.match(markdown, /阶段未发送：最终合并，请求额度拒绝（diagnostic_request_limit）/);
  assert.match(markdown, /整图：已接受，80\.0 秒，HTTP 200，结果已接受/);
});

test('unknown intake still exposes all four useful AI reference ranges and their provenance', () => {
  const raw = aiAnalysis();
  const result = summarizeMealAnalysis(raw);
  assert.equal(raw.status, 'unknown');
  assert.deepEqual(result.nutrients, { calories: null, protein: null, carbs: null, fat: null });
  assert.equal(result.hasUsefulNutritionReference, true);
  assert.equal(result.usefulReferenceCount, 1);
  assert.equal(result.coverage.referenceCount, 1);
  assert.equal(result.coverage.counted, 0);
  assert.equal(result.intakeComplete, false);
  assert.equal(result.referenceCoverageConsistent, true);
  assert.equal(result.components[0].userQuantity, null);
  assert.deepEqual(result.components[0].reference.nutrients, raw.components[0].source.per100gRange);
  assert.equal(result.components[0].reference.method, 'typical_recipe');
  assert.equal(result.components[0].reference.model, 'gpt-6.1-sol');
  assert.equal(result.components[0].reference.reasoningEffort, 'max');
  assert.equal(result.components[0].reference.generatedAt, '2026-10-17T01:02:03.000Z');
  const markdown = renderMealComparisonMarkdown({ comparisons: [createMealComparison({ mealId: 'reference-only', current: raw })] });
  assert.match(markdown, /数量未填写/);
  assert.match(markdown, /方法：典型配方/);
  assert.match(markdown, /配方依据：番茄与鸡蛋/);
  assert.match(markdown, /参考假设：常见家常炒制/);
  assert.match(markdown, /营养参考覆盖：1\/1 道菜；四项有效参考：1 道；有用营养参考：是/);
  assert.match(markdown, /摄入完整：否/);
});

test('missing nutrients, stale sources and unknown sources cannot become useful AI references', () => {
  for (const change of ['missing-fat', 'scalar-protein', 'stale', 'unknown']) {
    const raw = aiAnalysis();
    if (change === 'missing-fat') delete raw.components[0].source.per100gRange.fat;
    if (change === 'scalar-protein') raw.components[0].source.per100gRange.protein = 6;
    if (change === 'stale') raw.components[0].nutritionReferenceStale = true;
    if (change === 'unknown') raw.components[0].source = { provider: 'unknown' };
    const result = summarizeMealAnalysis(raw);
    assert.equal(result.hasUsefulNutritionReference, false, change);
    assert.equal(result.usefulReferenceCount, 0, change);
    assert.equal(result.referenceCoverageConsistent, false, change);
  }
});
