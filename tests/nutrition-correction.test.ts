import assert from 'node:assert/strict';
import test from 'node:test';
import { appendNutritionCorrection, createCorrectionSaveGate, fractionToPercent, parseCorrectionRange } from '../src/nutrition-correction';
import { calculateMealNutrition, catalogFoods, nutritionDataset, searchCatalogFoods } from '../src/nutrition';
import { createBackupArchive, parseBackupArchive } from '../src/backup';
import { emptyData, type AnalysisVersion, type MealRecord } from '../src/types';
import { migrateMealAnalysis } from '../src/nutrition-schema';

test('correction bounds require complete, ordered decimal pairs', () => {
  assert.equal(parseCorrectionRange('', ' ', 100, '比例'), null);
  assert.deepEqual(parseCorrectionRange(' 80 ', '120', 100_000, '重量'), { min: 80, max: 120 });
  for (const pair of [['80', ''], ['', '80'], ['-', '80'], ['-1', '80'], ['80', '70'], ['80', '101'], ['Infinity', '90'], ['100-', '100'], ['  ', '100']]) {
    assert.throws(() => parseCorrectionRange(pair[0], pair[1], 100, '比例'));
  }
  assert.equal(fractionToPercent({ min: 0.5, max: 0.75 }), '50～75%');
});

test('fraction display preserves decimal percentage bounds', () => {
  assert.equal(fractionToPercent({ min: 0.3333, max: 0.6666 }), '33.33～66.66%');
  assert.equal(fractionToPercent({ min: 0, max: 0 }), '0%');
});

test('expanded USDA aliases are searchable for local corrections', () => {
  const matches = searchCatalogFoods('烤红薯');
  assert.equal(matches.some((food) => food.id === 'sweet_potato_baked'), true);
  assert.equal(searchCatalogFoods('  烤红薯  ').length > 0, true);
});

test('correction save gate rejects synchronous duplicates and can retry after failure', () => {
  const gate = createCorrectionSaveGate();
  const first = gate.begin();
  assert.equal(first, 1);
  assert.equal(gate.begin(), null);
  assert.ok(first !== null && gate.isCurrent(first));
  gate.finish(first!);
  const retry = gate.begin();
  assert.equal(retry, 2);
  gate.finish(retry!);
  const stale = gate.begin();
  assert.equal(stale, 3);
  gate.invalidate();
  assert.equal(gate.isCurrent(stale!), false);
  assert.equal(gate.begin(), 5);
});

test('local correction computes known ingredients and keeps incomplete intake unknown', async () => {
  const rice = catalogFoods().find((food) => food.id === 'rice_white_long_grain_cooked');
  assert.ok(rice);
  const component = {
    foodId: rice.id, label: rice.label, grams: { min: 200, max: 200 },
    quantitySource: 'user' as const, consumedFraction: { min: 0.5, max: 0.5 }, uncertainty: [],
  };
  const base = { status: 'unknown' as const, foodName: '米饭', calories: null, protein: null,
    carbs: null, fat: null, components: [component], unresolved: [], assumptions: [], advice: '营养参考。' };
  const complete = await calculateMealNutrition(base);
  assert.equal(complete.status, 'estimated');
  assert.deepEqual(complete.calories, { min: 130, max: 130 });
  assert.equal(complete.components?.[0].source?.fdcId, rice.fdcId);
  const incomplete = await calculateMealNutrition({ ...base, unresolved: ['酱料未核实'] });
  assert.equal(incomplete.status, 'unknown');
  for (const key of ['calories', 'protein', 'carbs', 'fat'] as const) assert.equal(incomplete[key], null);
  assert.deepEqual(incomplete.components?.[0].source, complete.components?.[0].source);
});

test('local category ranges produce approximate nutrients and preserve component evidence', async () => {
  const result = await calculateMealNutrition({
    status: 'unknown', foodName: '米饭', calories: null, protein: null, carbs: null, fat: null,
    estimateScope: 'consumed_intake', assumptions: [], advice: '补充重量。', unresolved: [],
    components: [{ foodId: null, label: '米饭', category: null, grams: { min: 100, max: 120 },
      quantitySource: 'visual', consumedFraction: { min: 0.5, max: 0.75 }, uncertainty: [],
      evidence: [{ kind: 'photo', text: '盘中可见米饭', confidence: 0.9 }],
    }],
  });
  assert.equal(result.status, 'approximate');
  assert.deepEqual(result.calories, { min: 50, max: 135 });
  assert.deepEqual(result.protein, { min: 1, max: 3.6 });
  assert.deepEqual(result.coverage, { matched: 1, total: 1, unknownLabels: [] });
  assert.equal(result.nutritionSource?.provider, 'local-category');
  assert.equal(result.components?.[0].source?.categoryId, 'grain');
  assert.deepEqual(result.components?.[0].evidence, [{ kind: 'photo', text: '盘中可见米饭', confidence: 0.9 }]);
});

test('new photo analysis exposes per-100g references but ignores legacy visual grams until user input', async () => {
  const result = await calculateMealNutrition({
    status: 'unknown', foodName: '米饭和鸡肉', calories: null, protein: null, carbs: null, fat: null,
    assumptions: [], advice: '填写各道菜数量后计算。', unresolved: [],
    components: [{ foodId: 'rice_white_long_grain_cooked', label: '熟米饭', grams: { min: 180, max: 220 },
      quantitySource: 'visual', consumedFraction: null, userQuantity: null, uncertainty: [] }],
  }, nutritionDataset, 'user-quantity-v2');
  assert.equal(result.status, 'unknown');
  assert.equal(result.components?.[0].grams, null);
  assert.equal(result.components?.[0].source?.provider, 'usda-fdc');
  assert.deepEqual(result.components?.[0].source?.per100g, { calories: 130, protein: 2.69, carbs: 28.2, fat: 0.28 });
  assert.deepEqual(result.components?.[0].householdMeasure, { label: '半碗熟米饭', grams: 100, approximate: true });
  assert.deepEqual(result.coverage?.missingQuantityLabels, ['熟米饭']);
  assert.equal(result.calories, null);
});

test('user grams and household portions produce local subtotals while unknown portions stay excluded', async () => {
  const result = await calculateMealNutrition({
    status: 'unknown', foodName: '米饭和配菜', calories: null, protein: null, carbs: null, fat: null,
    assumptions: [], advice: '按填写数量计算。', unresolved: [],
    components: [
      { foodId: 'rice_white_long_grain_cooked', label: '熟米饭', grams: null, quantitySource: 'unknown',
        userQuantity: { amount: 0.5, unit: 'household' }, uncertainty: [] },
      { foodId: 'chicken_roasted', label: '烤鸡肉', grams: null, quantitySource: 'unknown',
        userQuantity: null, uncertainty: [] },
    ],
  }, nutritionDataset, 'user-quantity-v2');
  assert.equal(result.status, 'approximate');
  assert.deepEqual(result.calories, { min: 65, max: 65 });
  assert.deepEqual(result.coverage?.missingQuantityLabels, ['烤鸡肉']);
  assert.deepEqual(result.coverage?.unknownNutritionLabels, []);
  assert.equal(result.coverage?.counted, 1);
  assert.equal(result.components?.[0].userQuantity?.unit, 'household');
  assert.equal(result.nutritionSource?.method, 'user-quantity-v2');
});

test('known dish categories keep broad reference ranges despite preparation uncertainty', async () => {
  const result = await calculateMealNutrition({
    status: 'unknown', foodName: '肉类主菜', calories: null, protein: null, carbs: null, fat: null,
    assumptions: [], advice: '近似参考。', unresolved: [],
    components: [{ foodId: null, label: '肉类主菜', category: 'meat', grams: null, quantitySource: 'unknown',
      userQuantity: { amount: 100, unit: 'g' }, uncertainty: ['烹调方式不确定'] }],
  }, nutritionDataset, 'user-quantity-v2');
  assert.equal(result.status, 'approximate');
  assert.deepEqual(result.components?.[0].source?.per100gRange?.calories, { min: 100, max: 250 });
  assert.deepEqual(result.calories, { min: 100, max: 250 });
});

test('user quantity analysis round-trips through backup while legacy data remains readable', async () => {
  const now = '2026-10-11T04:00:00.000Z';
  const analysis = await calculateMealNutrition({
    status: 'unknown', foodName: '熟米饭', calories: null, protein: null, carbs: null, fat: null,
    assumptions: [], advice: '按用户填写数量计算。', unresolved: [],
    components: [{ foodId: 'rice_white_long_grain_cooked', label: '熟米饭', grams: null, quantitySource: 'unknown',
      userQuantity: { amount: 100, unit: 'g' }, uncertainty: [] }],
  }, nutritionDataset, 'user-quantity-v2');
  const normalized = migrateMealAnalysis(analysis);
  assert.equal(normalized.estimateScope, undefined);
  const version: AnalysisVersion = { id: 'v2', sourceVersion: 1, createdAt: now, model: 'local/usda', analysis: normalized };
  const meal: MealRecord = { id: 'quantity-meal', type: 'meal', createdAt: now, occurredAt: now, mealType: '午餐',
    foodName: '熟米饭', portion: '', note: '', source: 'photo', estimateStatus: 'unknown', analyses: [version] };
  const parsed = await parseBackupArchive(await createBackupArchive({ ...emptyData(), meals: [meal] }, [], now));
  assert.deepEqual(parsed.data.meals[0].analyses?.[0].analysis.components?.[0].userQuantity, { amount: 100, unit: 'g' });
  assert.deepEqual(parsed.data.meals[0].analyses?.[0].analysis.components?.[0].householdMeasure, { label: '半碗熟米饭', grams: 100, approximate: true });
});

test('photo-serving scope uses the whole photographed plate; consumed intake requires a known fraction', async () => {
  const base = {
    status: 'unknown' as const, foodName: '米饭', calories: null, protein: null, carbs: null, fat: null,
    assumptions: [], advice: '记录实际份量。', unresolved: [],
    components: [{ foodId: null, label: '米饭', grams: { min: 100, max: 100 }, quantitySource: 'user' as const,
      consumedFraction: null, uncertainty: [] }],
  };
  const fullPlate = await calculateMealNutrition({ ...base, estimateScope: 'photo_serving' });
  assert.equal(fullPlate.status, 'approximate');
  assert.deepEqual(fullPlate.calories, { min: 100, max: 150 });
  assert.equal(fullPlate.estimateScope, 'photo_serving');
  const unknownIntake = await calculateMealNutrition({ ...base, estimateScope: 'consumed_intake' });
  assert.equal(unknownIntake.status, 'unknown');
  for (const key of ['calories', 'protein', 'carbs', 'fat'] as const) assert.equal(unknownIntake[key], null);
  assert.ok(unknownIntake.unresolved?.some((item) => item.includes('实际食用比例未知')));
});

test('partial estimates exclude unknown components and disclose the omitted coverage', async () => {
  const result = await calculateMealNutrition({
    status: 'unknown', foodName: '混合餐食', calories: null, protein: null, carbs: null, fat: null,
    estimateScope: 'photo_serving', assumptions: [], advice: '仅供参考。', unresolved: [],
    components: [
      { foodId: null, label: '米饭', grams: { min: 100, max: 100 }, quantitySource: 'visual',
        consumedFraction: null, uncertainty: [] },
      { foodId: null, label: '未识别配菜', grams: null, quantitySource: 'unknown',
        consumedFraction: null, uncertainty: ['成分身份和重量未确认'] },
    ],
  });
  assert.equal(result.status, 'approximate');
  assert.deepEqual(result.calories, { min: 100, max: 150 });
  assert.deepEqual(result.coverage, { matched: 1, total: 2, unknownLabels: ['未识别配菜'] });
  assert.equal(result.components?.[1].source, undefined);
  assert.ok(result.assumptions.some((item) => item.includes('缺少身份、重量或食用比例')));
  assert.equal(result.nutritionSource?.coverage, 'incomplete');
});

test('unresolved category conflicts stay unknown while known components publish partial ranges', async () => {
  const base = {
    status: 'unknown' as const, foodName: '混合餐食', calories: null, protein: null, carbs: null, fat: null,
    estimateScope: 'consumed_intake' as const, assumptions: [], advice: '核实食材。', unresolved: [],
  };
  const candidatesConflict = await calculateMealNutrition({ ...base, components: [{
    foodId: null, label: '豆腐', grams: { min: 100, max: 100 }, quantitySource: 'user' as const,
    consumedFraction: { min: 1, max: 1 }, uncertainty: [],
    candidates: [{ foodId: null, label: '鸡蛋', category: 'egg' }, { foodId: null, label: '豆腐', category: 'tofu' }],
  }] });
  assert.equal(candidatesConflict.status, 'unknown');
  assert.deepEqual(candidatesConflict.coverage?.unknownLabels, ['豆腐']);
  assert.equal(candidatesConflict.components?.[0].source, undefined);
  for (const key of ['calories', 'protein', 'carbs', 'fat'] as const) assert.equal(candidatesConflict[key], null);

  const incomplete = await calculateMealNutrition({ ...base, components: [
    { foodId: null, label: '米饭', grams: { min: 100, max: 100 }, quantitySource: 'user' as const,
      consumedFraction: { min: 1, max: 1 }, uncertainty: [] },
    { foodId: null, label: '未识别菜品', grams: { min: 60, max: 60 }, quantitySource: 'user' as const,
      consumedFraction: { min: 1, max: 1 }, uncertainty: [] },
  ] });
  assert.equal(incomplete.status, 'approximate');
  assert.deepEqual(incomplete.coverage, { matched: 1, total: 2, unknownLabels: ['未识别菜品'] });
  assert.deepEqual(incomplete.calories, { min: 100, max: 150 });
  assert.deepEqual(incomplete.protein, { min: 2, max: 4 });
  assert.deepEqual(incomplete.carbs, { min: 20, max: 32 });
  assert.deepEqual(incomplete.fat, { min: 0, max: 3 });
});

test('correction rejects deleted, edited, or superseded bases and retains portable history', async () => {
  const now = '2026-10-11T04:00:00.000Z';
  const original: AnalysisVersion = { id: 'base', sourceVersion: 1, createdAt: now, model: 'test/model',
    analysis: { status: 'unknown', foodName: '米饭', calories: null, protein: null, carbs: null, fat: null,
      components: [], unresolved: ['重量未知'], assumptions: [], advice: '补充重量。' } };
  const meal: MealRecord = { id: 'meal', revision: 1, type: 'meal', createdAt: now, occurredAt: now,
    mealType: '午餐', foodName: '米饭', portion: '', note: '', source: 'manual', estimateStatus: 'unknown', analyses: [original] };
  const analysis = await calculateMealNutrition({ ...original.analysis, unresolved: [], components: [{
    foodId: 'rice_white_long_grain_cooked', label: '熟米饭', grams: { min: 200, max: 200 },
    consumedFraction: { min: 0.5, max: 0.5 }, quantitySource: 'user', uncertainty: [],
  }] });
  const version = { ...original, id: 'corrected', model: 'local/usda-ingredient-weight-v1', analysis };
  assert.throws(() => appendNutritionCorrection(undefined, 1, 'base', version));
  assert.throws(() => appendNutritionCorrection({ ...meal, revision: 2 }, 1, 'base', version));
  const corrected = appendNutritionCorrection(meal, 1, 'base', version);
  assert.throws(() => appendNutritionCorrection(corrected, 1, 'base', version));
  assert.equal(meal.analyses?.length, 1);
  const data = { ...emptyData(), meals: [corrected] };
  const parsed = await parseBackupArchive(await createBackupArchive(data, [], now));
  assert.deepEqual(parsed.data.meals[0].analyses, [{ ...original, analysis: migrateMealAnalysis(original.analysis) }, version]);
});
