import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateMealNutrition as calculateShared, validateMealRecognition, validateModelNutritionEstimate } from '../shared/nutrition.mjs';
import { calculateMealNutrition, nutritionDataset } from '../src/nutrition';
import { mealAnalysisSchema, modelNutritionEstimateSchema } from '../src/nutrition-schema';
import { mealPhotoAutofill, mealPhotoEstimateText } from '../src/meal-photo-autofill';
import type { MealAnalysis, ModelNutritionEstimate, ModelNutritionSource, NutrientRanges } from '../src/types';

const provenance = { model: 'configured/model', reasoningEffort: 'max', createdAt: '2026-10-17T03:00:00.000Z' };
const per100g: NutrientRanges = {
  calories: { min: 120, max: 160 }, protein: { min: 10, max: 14 }, carbs: { min: 20, max: 30 }, fat: { min: 4, max: 8 },
};
const estimate = (changes = {}): NonNullable<ModelNutritionEstimate> => ({
  basisGrams: 100, method: 'typical_recipe', per100g, recipeBasis: '按成品鸡肉、蔬菜和少量酱汁的典型配方估计，油计入该菜。',
  assumptions: ['烹调油用量无法从照片确认，已包含在区间中。'], confidence: 0.75, ...changes,
});
const component = (changes = {}) => ({ foodId: null, label: '鸡肉烩菜', uncertainty: [], confidence: 0.9,
  nutritionEstimate: estimate(), ...changes });
const recognition = (components = [component()]) => ({ foodName: '鸡肉烩菜', components, unresolved: [], assumptions: [], advice: '填写实际食用数量。', confidence: 0.9 });
const calculate = (components = [component()]) => calculateShared(recognition(components), nutritionDataset, { mode: 'ai-per100g-v3', provenance });
const parse = (analysis: MealAnalysis) => mealAnalysisSchema.parse(analysis);
const sourceOf = (analysis: MealAnalysis, index = 0): ModelNutritionSource => {
  const source = analysis.components?.[index].source;
  assert.equal(source?.provider, 'model');
  return source as ModelNutritionSource;
};

test('AI reference works without any database ID and persists one snapshot with trusted request provenance', () => {
  const result = calculate();
  const source = sourceOf(result);
  assert.deepEqual(source.per100gRange, per100g);
  assert.equal(source.method, 'typical_recipe');
  assert.equal(source.model, provenance.model);
  assert.equal(source.reasoningEffort, provenance.reasoningEffort);
  assert.equal(source.generatedAt, provenance.createdAt);
  assert.equal(source.recipeBasis, estimate().recipeBasis);
  assert.deepEqual(source.assumptions, estimate().assumptions);
  assert.equal('nutritionEstimate' in result.components![0], false);
  assert.equal(result.components![0].foodId, null);
  assert.equal(result.components![0].grams, null);
  assert.equal(result.components![0].userQuantity, null);
  assert.equal(result.status, 'unknown');
  for (const key of ['calories', 'protein', 'carbs', 'fat'] as const) assert.equal(result[key], null);
  assert.deepEqual(result.coverage, { matched: 1, total: 1, counted: 0, referenceCount: 1,
    unknownLabels: [], unknownNutritionLabels: [], missingQuantityLabels: ['鸡肉烩菜'] });
  assert.equal(parse(result).estimateScope, undefined);
  assert.equal(mealPhotoAutofill(result).portion, '');
  assert.match(mealPhotoEstimateText(result), /每 100 g AI 营养参考/);
});

test('persisted nutrition timestamps accept ISO offsets and reject invalid calendar dates', () => {
  const base = calculate();
  const source = sourceOf(base);
  const withOffset: MealAnalysis = { ...base, nutritionSource: { ...base.nutritionSource!, calculatedAt: '2026-10-17T11:00:00+08:00' },
    components: [{ ...base.components![0], source: { ...source, generatedAt: '2026-10-17T11:00:00+08:00' } }] };
  parse(withOffset);
  assert.equal(mealAnalysisSchema.safeParse({ ...withOffset, nutritionSource: { ...withOffset.nutritionSource, calculatedAt: '2026-02-30T11:00:00+08:00' } }).success, false);
  assert.equal(mealAnalysisSchema.safeParse({ ...withOffset, components: [{ ...withOffset.components![0], source: { ...source, generatedAt: '2026-10-17T11:00:00' } }] }).success, false);
});

test('category estimates are supplied by the model and never replaced by local category ranges', () => {
  const result = calculate([component({ label: '肉类主菜', category: 'meat', nutritionEstimate: estimate({ method: 'category' }) })]);
  assert.equal(sourceOf(result).method, 'category');
  assert.deepEqual(sourceOf(result).per100gRange, per100g);
  assert.notDeepEqual(sourceOf(result).per100gRange, nutritionDataset.categories.meat);
});

test('250 g scales every nutrient by exactly 2.5 and complete AI intake remains approximate', async () => {
  const base = calculate();
  const result = await calculateMealNutrition({ ...base, components: [{ ...base.components![0], userQuantity: { amount: 250, unit: 'g' } }] }, undefined, 'ai-per100g-v3');
  assert.deepEqual(result.calories, { min: 300, max: 400 });
  assert.deepEqual(result.protein, { min: 25, max: 35 });
  assert.deepEqual(result.carbs, { min: 50, max: 75 });
  assert.deepEqual(result.fat, { min: 10, max: 20 });
  assert.equal(result.status, 'approximate');
  assert.equal(result.coverage!.counted, 1);
  assert.equal(result.coverage!.referenceCount, 1);
  assert.equal(result.nutritionSource!.coverage, 'complete');
  parse(result);
});

test('stored AI reference and provenance stay frozen when the database and calculation settings change', async () => {
  const base = calculate([component({ foodId: 'rice_white_long_grain_cooked' })]);
  const source = Object.freeze(sourceOf(base));
  const changedDataset = { ...nutritionDataset, foods: nutritionDataset.foods.map((food) => ({ ...food,
    per100g: { calories: 899, protein: 99, carbs: 99, fat: 99 } })), categories: {} };
  const result = await calculateMealNutrition({ ...base, components: [{ ...base.components![0], source, userQuantity: { amount: 250, unit: 'g' } }] },
    changedDataset, 'ai-per100g-v3', { provenance: { model: 'other/model', createdAt: '2026-10-18T00:00:00.000Z' } });
  assert.strictEqual(result.components![0].source, source);
  assert.deepEqual(result.calories, { min: 300, max: 400 });
  assert.equal(sourceOf(result).model, provenance.model);
  assert.equal(sourceOf(result).generatedAt, provenance.createdAt);
  parse(result);
});

test('subtotal excludes empty and unknown references, supports all filled rows, and removes cleared quantities immediately', async () => {
  const base = calculate([component(), component({ label: '第二道菜' }), component({ label: '未知菜品', nutritionEstimate: null, uncertainty: ['没有可辨识的配方或类别。'] })]);
  const first = await calculateMealNutrition({ ...base, components: base.components!.map((item, index) => ({ ...item,
    userQuantity: index === 1 ? null : { amount: 100, unit: 'g' as const } })) }, undefined, 'ai-per100g-v3');
  assert.deepEqual(first.calories, per100g.calories);
  assert.equal(first.coverage!.counted, 1);
  assert.equal(first.coverage!.referenceCount, 2);
  assert.deepEqual(first.coverage!.missingQuantityLabels, ['第二道菜']);
  assert.deepEqual(first.coverage!.unknownNutritionLabels, ['未知菜品']);
  parse(first);
  const allKnown = await calculateMealNutrition({ ...first, components: first.components!.slice(0, 2).map((item) => ({ ...item, userQuantity: { amount: 100, unit: 'g' } })) }, undefined, 'ai-per100g-v3');
  assert.deepEqual(allKnown.calories, { min: 240, max: 320 });
  assert.equal(allKnown.status, 'approximate');
  assert.equal(allKnown.nutritionSource!.coverage, 'complete');
  parse(allKnown);
  const cleared = await calculateMealNutrition({ ...allKnown, components: allKnown.components!.map((item) => ({ ...item, userQuantity: null })) }, undefined, 'ai-per100g-v3');
  assert.equal(cleared.calories, null);
  assert.equal(cleared.status, 'unknown');
  assert.equal(cleared.coverage!.counted, 0);
  assert.equal(cleared.coverage!.referenceCount, 2);
  assert.equal(cleared.assumptions.some((item) => item.includes('当前仅汇总')), false);
  parse(cleared);
});

test('only curated household measures supply grams and photo grams never become user intake', () => {
  const rice = calculate([component({ foodId: 'rice_white_long_grain_cooked', userQuantity: { amount: 0.5, unit: 'household' },
    householdMeasure: { label: '模型捏造的大碗', grams: 999, approximate: false }, grams: { min: 900, max: 900 }, quantitySource: 'visual' })]);
  assert.deepEqual(rice.components![0].householdMeasure, nutritionDataset.householdMeasures!.rice_white_long_grain_cooked);
  assert.deepEqual(rice.calories, { min: 60, max: 80 });
  assert.equal(rice.components![0].grams, null);
  parse(rice);
  const unknown = calculate([component({ userQuantity: { amount: 1, unit: 'household' }, householdMeasure: { label: '捏造单位', grams: 999, approximate: false } })]);
  assert.equal(unknown.components![0].householdMeasure, null);
  assert.equal(unknown.components![0].userQuantity, null);
  assert.equal(unknown.coverage!.counted, 0);
  assert.equal(unknown.calories, null);
  parse(unknown);
  const photoOnly = calculate([component({ grams: { min: 100, max: 200 }, quantitySource: 'visual' })]);
  assert.equal(photoOnly.components![0].userQuantity, null);
  assert.equal(photoOnly.calories, null);
});

test('changed dish keeps its source for audit but its stale reference is excluded from intake', async () => {
  const base = calculate();
  const result = await calculateMealNutrition({ ...base, components: [{ ...base.components![0], label: '油炸鸡块',
    cookingMethod: '油炸', nutritionReferenceStale: true, userQuantity: { amount: 250, unit: 'g' } }] }, undefined, 'ai-per100g-v3');
  assert.strictEqual(result.components![0].source, base.components![0].source);
  assert.equal(result.components![0].nutritionReferenceStale, true);
  assert.equal(result.coverage!.referenceCount, 0);
  assert.equal(result.coverage!.counted, 0);
  assert.deepEqual(result.coverage!.unknownNutritionLabels, ['油炸鸡块']);
  assert.deepEqual(result.coverage!.missingQuantityLabels, []);
  assert.equal(result.calories, null);
  parse(result);
});

test('aggregate unrounded nutrient values before rounding kcal and macro boundaries outward', () => {
  const narrow = { calories: { min: 1.11, max: 1.12 }, protein: { min: 1.11, max: 1.12 }, carbs: { min: 1.11, max: 1.12 }, fat: { min: 1.11, max: 1.12 } };
  const result = calculate([component({ nutritionEstimate: estimate({ per100g: narrow }), userQuantity: { amount: 10, unit: 'g' } }),
    component({ label: '第二道菜', nutritionEstimate: estimate({ per100g: narrow }), userQuantity: { amount: 10, unit: 'g' } })]);
  assert.deepEqual(result.calories, { min: 0, max: 1 });
  for (const key of ['protein', 'carbs', 'fat'] as const) assert.deepEqual(result[key], { min: 0.2, max: 0.3 });
  parse(result);
});

test('new protocol allows only explicit per-100g nutrient ranges and an explained null', () => {
  validateMealRecognition(recognition());
  validateMealRecognition(recognition([component({ nutritionEstimate: null, uncertainty: ['类别和配方未知。'] })]));
  assert.throws(() => validateMealRecognition(recognition([component({ nutritionEstimate: null })])));
  const { nutritionEstimate: _estimate, ...legacy } = component();
  assert.throws(() => validateMealRecognition(recognition([legacy as any])));
  validateMealRecognition(recognition([legacy as any]), { strict: false });
  for (const extra of [
    { source: { provider: 'model' } }, { userQuantity: { amount: 100, unit: 'g' } }, { grams: null },
    { householdMeasure: { label: '碗', grams: 100, approximate: true } }, { calories: 500 }, { nutritionReferenceStale: false },
    { candidates: [{ foodId: null, label: '配菜', calories: 50 }] },
    { evidence: [{ kind: 'photo', text: '可见菜品', source: 'fake' }] },
    { region: { x: 0, y: 0, width: 1, height: 1, protein: 50 } },
  ]) assert.throws(() => validateMealRecognition(recognition([component(extra)])));
  assert.throws(() => validateMealRecognition({ ...recognition(), totals: per100g }));
  assert.throws(() => validateMealRecognition(recognition([component({ nutritionEstimate: estimate({ model: 'forged provenance' }) })])));
});

test('invalid reference values fail validation rather than being clipped or converted to zero', () => {
  const invalidRanges = [
    { calories: { min: -1, max: 1 } }, { calories: { min: 901, max: 901 } }, { calories: { min: 20, max: 10 } },
    { protein: { min: 0, max: 101 } }, { carbs: { min: NaN, max: 2 } }, { fat: { min: 0, max: Infinity } },
    { protein: { min: 40, max: 40 }, carbs: { min: 40, max: 40 }, fat: { min: 21, max: 21 } },
    { protein: null }, { calories: { min: '100', max: 120 } }, { calories: { min: 100, max: 120, source: 'forged' } },
  ];
  for (const changes of invalidRanges) {
    const value = estimate({ per100g: { ...per100g, ...changes } });
    assert.throws(() => validateModelNutritionEstimate(value));
    assert.equal(modelNutritionEstimateSchema.safeParse(value).success, false);
    assert.throws(() => calculate([component({ nutritionEstimate: value })]));
  }
  for (const change of [{ basisGrams: 250 }, { method: 'database' }, { recipeBasis: '' }, { confidence: 1.1 }, { assumptions: [1] }]) {
    assert.throws(() => validateModelNutritionEstimate(estimate(change)));
  }
  assert.equal(validateModelNutritionEstimate(null), null);
});

test('new estimates require request provenance but a persisted source recalculates offline without it', () => {
  assert.throws(() => calculateShared(recognition(), nutritionDataset, { mode: 'ai-per100g-v3' }));
  const base = calculate();
  const result = calculateShared({ ...recognition(), components: base.components! }, undefined, { mode: 'ai-per100g-v3' });
  assert.deepEqual(sourceOf(result), sourceOf(base));
  parse(result);
});

test('v3 schema rejects references counted as exact intake, stale coverage and per-100g values presented as totals', () => {
  const base = calculate();
  assert.equal(mealAnalysisSchema.safeParse({ ...base, status: 'estimated' }).success, false);
  assert.equal(mealAnalysisSchema.safeParse({ ...base, calories: per100g.calories }).success, false);
  assert.equal(mealAnalysisSchema.safeParse({ ...base, components: [{ ...base.components![0], nutritionReferenceStale: true }] }).success, false);
  assert.equal(mealAnalysisSchema.safeParse({ ...base, components: [{ ...base.components![0], userQuantity: { amount: 100, unit: 'g' } }] }).success, false);
});
