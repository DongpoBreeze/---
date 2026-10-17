import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateMealNutrition, validateMealRecognition } from '../shared/nutrition.mjs';
import { analyseRecognition, nutritionDataset } from './nutrition.mjs';

const component = (changes = {}) => ({ foodId: 'rice_white_long_grain_cooked', label: '熟米饭', uncertainty: [], ...changes });
const meal = (components = [component()], changes = {}) => ({ foodName: '测试餐食', components,
  unresolved: [], assumptions: [], advice: '填写每道菜数量后计算。', ...changes });
const nullTotals = (result) => { for (const key of ['calories', 'protein', 'carbs', 'fat']) assert.equal(result[key], null); };

test('photo recognition exposes per-100g references and never estimates serving weight', () => {
  const result = analyseRecognition(meal());
  assert.equal(result.status, 'unknown');
  assert.equal(result.components[0].grams, null);
  assert.equal(result.components[0].source.provider, 'usda-fdc');
  assert.deepEqual(result.components[0].source.per100g, { calories: 130, protein: 2.69, carbs: 28.2, fat: 0.28 });
  assert.deepEqual(result.components[0].householdMeasure, { label: '半碗熟米饭', grams: 100, approximate: true });
  assert.deepEqual(result.coverage.missingQuantityLabels, ['熟米饭']);
  nullTotals(result);
});

test('user grams calculate locally and missing dishes remain outside the subtotal', () => {
  const result = calculateMealNutrition(meal([
    component({ userQuantity: { amount: 150, unit: 'g' } }),
    component({ foodId: 'chicken_roasted', label: '烤鸡肉', userQuantity: null }),
  ]), nutritionDataset, { mode: 'user-quantity-v2' });
  assert.equal(result.status, 'approximate');
  assert.equal(result.coverage.counted, 1);
  assert.deepEqual(result.coverage.missingQuantityLabels, ['烤鸡肉']);
  assert.deepEqual(result.calories, { min: 195, max: 195 });
  assert.equal(result.nutritionSource.method, 'user-quantity-v2');
});

test('local broad category references survive preparation uncertainty and are marked approximate', () => {
  const result = calculateMealNutrition(meal([component({ foodId: null, label: '肉类主菜', category: 'meat',
    userQuantity: { amount: 100, unit: 'g' }, uncertainty: ['烹调方式不确定'] })]), nutritionDataset, { mode: 'user-quantity-v2' });
  assert.equal(result.status, 'approximate');
  assert.deepEqual(result.components[0].source.per100gRange.calories, { min: 100, max: 250 });
  assert.deepEqual(result.calories, { min: 100, max: 250 });
});

test('ambiguous dish labels keep a confirmed broad category reference', () => {
  const result = calculateMealNutrition(meal([component({ foodId: null, label: '青椒或青甜椒', category: 'vegetable',
    userQuantity: { amount: 100, unit: 'g' }, uncertainty: ['具体品种无法确认'] })]), nutritionDataset, { mode: 'user-quantity-v2' });
  assert.equal(result.status, 'approximate');
  assert.equal(result.components[0].source.provider, 'local-category');
  assert.deepEqual(result.components[0].source.per100gRange.calories, { min: 20, max: 60 });
  assert.deepEqual(result.calories, { min: 20, max: 60 });
});

test('unknown dish nutrition stays visible and excluded from a partial subtotal', () => {
  const result = calculateMealNutrition(meal([
    component({ userQuantity: { amount: 100, unit: 'g' } }),
    component({ foodId: null, label: '未识别菜品', userQuantity: { amount: 80, unit: 'g' } }),
  ]), nutritionDataset, { mode: 'user-quantity-v2' });
  assert.equal(result.status, 'approximate');
  assert.equal(result.coverage.counted, 1);
  assert.deepEqual(result.coverage.unknownNutritionLabels, ['未识别菜品']);
  assert.deepEqual(result.calories, { min: 130, max: 130 });
  assert.equal(result.components[1].source, null);
});

test('unreliable household conversion is rejected and does not count toward intake', () => {
  const result = calculateMealNutrition(meal([component({ foodId: null, label: '未识别菜品', userQuantity: { amount: 1, unit: 'household' } })]), nutritionDataset, { mode: 'user-quantity-v2' });
  assert.equal(result.status, 'unknown');
  assert.equal(result.components[0].userQuantity, null);
  assert.deepEqual(result.coverage.missingQuantityLabels, ['未识别菜品']);
  assert.ok(result.unresolved.some((entry) => entry.includes('改填克数')));
});

test('model recognition schema rejects visual weights, nutrient totals, and invalid food IDs', () => {
  assert.throws(() => validateMealRecognition(meal([component({ grams: { min: 10, max: 20 } })])));
  assert.throws(() => validateMealRecognition({ ...meal(), calories: 500 }));
  assert.throws(() => analyseRecognition(meal([component({ foodId: 'not_in_catalog' })])));
});

test('ambiguous identity with close candidate scores withholds exact USDA match', () => {
  const result = analyseRecognition(meal([component({ candidates: [
    { foodId: 'rice_white_long_grain_cooked', label: '熟米饭', confidence: 0.55 },
    { foodId: 'rice_white_medium_grain_cooked', label: '中粒米饭', confidence: 0.48 },
  ] })]));
  assert.equal(result.status, 'unknown');
  assert.equal(result.components[0].foodId, null);
  assert.equal(result.components[0].source.provider, 'local-category');
  assert.deepEqual(result.components[0].source.per100gRange.calories, { min: 100, max: 150 });
});

test('preparation-specific USDA entries keep independent per-100g references', () => {
  const raw = analyseRecognition(meal([component({ foodId: 'rice_white_long_grain_raw', label: '生米' })]));
  const cooked = analyseRecognition(meal([component({ foodId: 'rice_white_long_grain_cooked', label: '熟米饭' })]));
  assert.equal(raw.components[0].source.per100g.calories, 365);
  assert.equal(cooked.components[0].source.per100g.calories, 130);
});

test('legacy ingredient-weight calculator remains available for imported records', () => {
  const result = calculateMealNutrition({
    ...meal([component({ grams: { min: 100, max: 100 }, quantitySource: 'user', consumedFraction: { min: 1, max: 1 } })]),
    estimateScope: 'photo_serving',
  }, nutritionDataset);
  assert.equal(result.status, 'estimated');
  assert.deepEqual(result.calories, { min: 130, max: 130 });
});
