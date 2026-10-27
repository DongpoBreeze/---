import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateMealNutrition as calculateShared, hasMealIdentityConflict, validateFrontendMealRecognition, validateMealRecognition } from '../shared/nutrition.mjs';
import { BackupError, createBackupArchive, parseBackupArchive } from '../src/backup';
import { buildMealReviewAnalysis, createEmptyMealReviewRow, createMealReviewRows, mergeReviewedQuantities, updateMealReviewRow } from '../src/meal-review';
import { estimateMealPortion } from '../src/meal-portion-reference';
import { calculateMealNutrition, nutritionDataset } from '../src/nutrition';
import { mealAnalysisSchema, mealComponentSchema } from '../src/nutrition-schema';
import { emptyData, type DatabaseNutritionSource, type MealAnalysis, type MealComponent, type ModelNutritionEstimate, type NutrientRanges } from '../src/types';

const now = '2026-10-20T03:00:00.000Z';
const ranges: NutrientRanges = {
  calories: { min: 120, max: 160 }, protein: { min: 10, max: 14 }, carbs: { min: 20, max: 30 }, fat: { min: 4, max: 8 },
};
const editedRanges: NutrientRanges = {
  calories: { min: 200, max: 240 }, protein: { min: 15, max: 18 }, carbs: { min: 25, max: 35 }, fat: { min: 6, max: 10 },
};
const estimate: NonNullable<ModelNutritionEstimate> = {
  basisGrams: 100, method: 'typical_recipe', per100g: ranges, recipeBasis: '按通常成品配方估计。',
  assumptions: ['油量未知。'], confidence: 0.75,
};
const rawComponent = (changes: Record<string, unknown> = {}) => ({
  foodId: null, label: '鸡肉烩菜', cookingMethod: '炖', confidence: 0.9, recommendedShare: 1, uncertainty: [], nutritionEstimate: estimate, ...changes,
});
const rawRecognition = (components = [rawComponent()]) => ({ foodName: '午餐', components, unresolved: [], assumptions: [], advice: '填写实际食用量。' });
const analysis = (components = [rawComponent()]): MealAnalysis => calculateShared(rawRecognition(components), nutritionDataset, {
  mode: 'ai-per100g-v3', provenance: { model: 'configured/vision-model', reasoningEffort: 'max', createdAt: now },
});
const nutrientDraft = (values: NutrientRanges) => Object.fromEntries(Object.entries(values).map(([key, value]) =>
  [key, { min: String(value.min), max: String(value.max) }])) as ReturnType<typeof createEmptyMealReviewRow>['nutrients'];
const recalculated = (base: MealAnalysis, components: MealComponent[]) => calculateMealNutrition({ ...base, components }, undefined, 'ai-per100g-v3');
const storedUsda: DatabaseNutritionSource = Object.freeze({ provider: 'usda-fdc', dataset: 'Saved USDA dataset v0', fdcId: '123',
  sourceUrl: 'https://fdc.nal.usda.gov/food-details/123/nutrients', preparation: '蒸煮',
  per100g: { calories: 200, protein: 10, carbs: 25, fat: 7 } });
const storedCategory: DatabaseNutritionSource = Object.freeze({ provider: 'local-category', dataset: 'Saved category ranges v0',
  categoryId: 'grain', per100gRange: ranges });
const storedMeal = (components: MealComponent[], overrides: Partial<MealAnalysis> = {}): MealAnalysis => ({
  status: 'unknown', foodName: '旧营养记录', calories: null, protein: null, carbs: null, fat: null,
  assumptions: ['保存的每 100 g 快照。'], advice: '填写实际食用量。', unresolved: [], components, ...overrides,
});

test('review rows expose effective references and retain actual user quantities without reading photo grams', () => {
  const base = analysis([rawComponent({ label: '原菜' }), rawComponent({ label: '人工菜' }), rawComponent({ label: '明确未知' }), rawComponent({ label: '过期菜' })]);
  const components = base.components!.map((component, index) => ({ ...component, userQuantity: { amount: 250, unit: 'g' as const },
    ...(index === 1 ? { userNutritionPer100g: editedRanges } : index === 2 ? { userNutritionPer100g: null }
      : index === 3 ? { nutritionReferenceStale: true } : {}) }));
  const rows = createMealReviewRows({ ...base, components });
  assert.deepEqual(rows[0].nutrients, nutrientDraft(ranges));
  assert.deepEqual(rows[1].nutrients, nutrientDraft(editedRanges));
  assert.equal(rows[2].nutrients.calories.min, '');
  assert.equal(rows[3].nutrients.protein.max, '');
  assert.equal(rows[0].quantity, '250');
  assert.equal(rows[0].quantityUnit, 'g');
  assert.equal(rows[0].nutritionEdited, false);
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length);
  const photoOnly = createMealReviewRows({ ...base, components: [{ ...base.components![0], grams: { min: 100, max: 200 } }] });
  assert.equal(photoOnly[0].quantity, '');
});

test('quantity-only confirmation scales locally and preserves the original source without inventing a local nutrition edit', () => {
  const base = analysis();
  const original = base.components![0];
  const row = updateMealReviewRow(createMealReviewRows(base)[0], { quantity: '250' });
  const result = buildMealReviewAnalysis(base, [row]);
  assert.deepEqual(result.calories, { min: 300, max: 400 });
  assert.deepEqual(result.protein, { min: 25, max: 35 });
  assert.strictEqual(result.components![0].source, original.source);
  assert.equal(Object.hasOwn(result.components![0], 'userNutritionPer100g'), false);
  assert.equal(original.userQuantity, null);
  assert.equal(row.nutritionEdited, false);
  mealAnalysisSchema.parse(result);
});

test('edited ranges override the saved AI snapshot while preserving model metadata and coverage', () => {
  const base = analysis();
  const originalSource = base.components![0].source;
  let row = updateMealReviewRow(createMealReviewRows(base)[0], { nutrients: nutrientDraft(editedRanges) });
  row = updateMealReviewRow(row, { quantity: '250' });
  const result = buildMealReviewAnalysis(base, [row]);
  assert.deepEqual(result.calories, { min: 500, max: 600 });
  assert.deepEqual(result.components![0].userNutritionPer100g, editedRanges);
  assert.strictEqual(result.components![0].source, originalSource);
  assert.deepEqual(originalSource?.per100gRange, ranges);
  assert.equal(result.coverage!.referenceCount, 1);
  assert.equal(result.coverage!.counted, 1);
  assert.equal(result.nutritionSource!.method, 'ai-per100g-v3');
  mealAnalysisSchema.parse(result);
});

test('an explicit unknown clears nutrition without substituting zero or falling back to the old source', () => {
  const base = analysis();
  const row = updateMealReviewRow(createMealReviewRows(base)[0], { quantity: '200', nutrients: createEmptyMealReviewRow().nutrients });
  const result = buildMealReviewAnalysis(base, [row]);
  assert.equal(result.components![0].userNutritionPer100g, null);
  assert.strictEqual(result.components![0].source, base.components![0].source);
  assert.equal(result.status, 'unknown');
  for (const key of ['calories', 'protein', 'carbs', 'fat'] as const) assert.equal(result[key], null);
  assert.equal(result.coverage!.counted, 0);
  assert.equal(result.coverage!.referenceCount, 0);
  assert.deepEqual(result.coverage!.unknownNutritionLabels, ['鸡肉烩菜']);
  assert.deepEqual(result.coverage!.missingQuantityLabels, []);
  mealAnalysisSchema.parse(result);
});

test('renaming clears nutrient drafts and invalid identity fields while a gram quantity survives', () => {
  const base = analysis([rawComponent({ foodId: 'rice_white_long_grain_cooked', category: 'grain',
    candidates: [{ foodId: 'rice_white_long_grain_cooked', label: '白米饭' }], preparation: '蒸煮',
    evidence: ['原始照片'], userQuantity: { amount: 200, unit: 'g' } })]);
  const row = updateMealReviewRow(createMealReviewRows(base)[0], { label: '油炸鸡块', cookingMethod: '炸' });
  assert.equal(row.quantity, '200');
  assert.equal(row.nutritionEdited, true);
  assert.equal(row.nutrients.calories.min, '');
  const result = buildMealReviewAnalysis(base, [row]);
  const dish = result.components![0];
  assert.equal(dish.nutritionReferenceStale, true);
  assert.equal(dish.userNutritionPer100g, null);
  assert.equal(dish.foodId, null);
  assert.equal(dish.category, undefined);
  assert.equal(dish.candidates, undefined);
  assert.equal(dish.evidence, undefined);
  assert.equal(dish.preparation, undefined);
  assert.strictEqual(dish.source, base.components![0].source);
  assert.equal(result.calories, null);
  mealAnalysisSchema.parse(result);
  const manuallyUpdated = buildMealReviewAnalysis(base, [updateMealReviewRow(row, { nutrients: nutrientDraft(editedRanges) })]);
  assert.deepEqual(manuallyUpdated.calories, { min: 400, max: 480 });
  assert.equal(manuallyUpdated.components![0].nutritionReferenceStale, true);
  assert.equal(manuallyUpdated.coverage!.referenceCount, 1);
  mealAnalysisSchema.parse(manuallyUpdated);
});

test('renaming invalidates AI dish share and estimate but preserves a manually entered or cleared quantity', () => {
  const base = analysis();
  const estimated = createMealReviewRows(base)[0];
  assert.ok(estimated.component.recommendedShare);
  const renamedEstimate = updateMealReviewRow(estimated, { label: '新菜品' });
  assert.equal(renamedEstimate.quantity, '');
  const rebuilt = buildMealReviewAnalysis(base, [renamedEstimate]);
  assert.equal(rebuilt.components![0].recommendedShare, undefined);
  assert.equal(estimateMealPortion({ calorieTarget: 2000 }, '午餐', rebuilt).status, 'unavailable');

  const entered = updateMealReviewRow({ ...estimated, quantity: '123', quantityOrigin: 'user', quantityEdited: true }, { label: '新菜品' });
  assert.equal(entered.quantity, '123');
  const cleared = updateMealReviewRow({ ...estimated, quantity: '', quantityOrigin: undefined, quantityEdited: true }, { label: '新菜品' });
  assert.equal(cleared.quantity, '');
  assert.equal(cleared.quantityEdited, true);
});

test('a cooking-method edit invalidates the reference and never reinterprets household counts as grams', () => {
  const base = analysis([rawComponent({ label: '米饭', cookingMethod: '蒸煮', foodId: 'rice_white_long_grain_cooked', userQuantity: { amount: 2, unit: 'household' } })]);
  const row = updateMealReviewRow(createMealReviewRows(base)[0], { cookingMethod: '炒' });
  assert.equal(row.quantity, '');
  assert.equal(row.quantityUnit, 'g');
  assert.equal(row.nutritionEdited, true);
  const result = buildMealReviewAnalysis(base, [row]);
  assert.equal(result.components![0].userQuantity, null);
  assert.equal(result.components![0].householdMeasure, null);
  assert.equal(result.calories, null);
});

test('unit changes clear the existing number without marking nutrition edited', () => {
  const base = analysis([rawComponent({ label: '米饭', foodId: 'rice_white_long_grain_cooked', userQuantity: { amount: 200, unit: 'g' } })]);
  const row = updateMealReviewRow(createMealReviewRows(base)[0], { quantityUnit: 'household' });
  assert.equal(row.quantity, '');
  assert.equal(row.nutritionEdited, false);
  const household = buildMealReviewAnalysis(base, [updateMealReviewRow(row, { quantity: '0.5' })]);
  assert.deepEqual(household.calories, { min: 60, max: 80 });
  assert.equal(updateMealReviewRow(row, { quantityUnit: 'g' }).quantity, '');
  const unavailable = updateMealReviewRow(createMealReviewRows(analysis())[0], { quantityUnit: 'household', quantity: '1' });
  assert.throws(() => buildMealReviewAnalysis(analysis(), [unavailable]), /本地份数换算/);
});

test('adding and removing rows recalculates totals and new dishes do not forge a model source', () => {
  const base = analysis();
  let added = updateMealReviewRow(createEmptyMealReviewRow(), { label: '自填蒸蛋', cookingMethod: '蒸' });
  added = updateMealReviewRow(added, { quantity: '100', nutrients: nutrientDraft(editedRanges) });
  const original = updateMealReviewRow(createMealReviewRows(base)[0], { quantity: '100' });
  const combined = buildMealReviewAnalysis(base, [original, added]);
  assert.deepEqual(combined.calories, { min: 320, max: 400 });
  assert.equal(combined.components![1].source, null);
  assert.deepEqual(combined.components![1].userNutritionPer100g, editedRanges);
  assert.equal(combined.coverage!.counted, 2);
  assert.equal(combined.coverage!.referenceCount, 2);
  assert.equal(combined.foodName, '鸡肉烩菜、自填蒸蛋');
  mealAnalysisSchema.parse(combined);
  const removed = buildMealReviewAnalysis(base, [added]);
  assert.equal(removed.components!.length, 1);
  assert.deepEqual(removed.calories, editedRanges.calories);
  const unknown = buildMealReviewAnalysis(base, [updateMealReviewRow(createEmptyMealReviewRow(), { label: '未知饮料', quantity: '100' })]);
  assert.equal(unknown.calories, null);
  assert.equal(unknown.components![0].source, null);
  assert.equal(unknown.components![0].userNutritionPer100g, null);
  assert.equal(unknown.coverage!.referenceCount, 0);
  mealAnalysisSchema.parse(unknown);
});

test('review validation rejects empty names, oversize inputs and invalid quantities', () => {
  const base = analysis();
  const row = createMealReviewRows(base)[0];
  assert.throws(() => buildMealReviewAnalysis(base, []), /1 至 20/);
  assert.throws(() => buildMealReviewAnalysis(base, Array.from({ length: 21 }, () => row)), /1 至 20/);
  for (const label of ['', '  ', '菜'.repeat(301)]) assert.throws(() => buildMealReviewAnalysis(base, [{ ...row, label }]), /名称/);
  assert.throws(() => buildMealReviewAnalysis(base, [{ ...row, cookingMethod: '蒸'.repeat(501) }]), /做法/);
  for (const quantity of ['0', '-1', 'NaN', 'Infinity', '1e3', '1x', '100000.1'])
    assert.throws(() => buildMealReviewAnalysis(base, [{ ...row, quantity }]), /数量/);
  assert.equal(buildMealReviewAnalysis(base, [{ ...row, quantity: ' ' }]).components![0].userQuantity, null);
});

test('review validation rejects partial, reversed, nonnumeric and out-of-range nutrition instead of clamping', () => {
  const base = analysis();
  const row = createMealReviewRows(base)[0];
  const invalid = [
    { ...nutrientDraft(ranges), calories: { min: '', max: '160' } },
    { ...nutrientDraft(ranges), protein: { min: '', max: '' } },
    { ...nutrientDraft(ranges), calories: { min: '200', max: '100' } },
    { ...nutrientDraft(ranges), calories: { min: '-1', max: '100' } },
    { ...nutrientDraft(ranges), calories: { min: 'NaN', max: '100' } },
    { ...nutrientDraft(ranges), calories: { min: '1', max: 'Infinity' } },
    { ...nutrientDraft(ranges), calories: { min: '900', max: '901' } },
    { ...nutrientDraft(ranges), fat: { min: '1', max: '101' } },
    { calories: { min: '800', max: '900' }, protein: { min: '40', max: '50' }, carbs: { min: '40', max: '50' }, fat: { min: '30', max: '40' } },
  ];
  for (const nutrients of invalid) assert.throws(() => buildMealReviewAnalysis(base, [updateMealReviewRow(row, { nutrients })]));
  const zero = nutrientDraft({ calories: { min: 0, max: 0 }, protein: { min: 0, max: 0 }, carbs: { min: 0, max: 0 }, fat: { min: 0, max: 0 } });
  const water = buildMealReviewAnalysis(base, [updateMealReviewRow(row, { nutrients: zero, quantity: '100' })]);
  assert.deepEqual(water.calories, { min: 0, max: 0 });
  assert.equal(water.coverage!.counted, 1);
});

test('manual references work with null and stale sources; an explicit unknown and stale fallback remain excluded', () => {
  const base = analysis();
  const component = base.components![0];
  const result = recalculated(base, [
    { ...component, label: '无模型来源', source: null, userNutritionPer100g: editedRanges, userQuantity: { amount: 100, unit: 'g' } },
    { ...component, label: '旧来源已改菜', nutritionReferenceStale: true, userNutritionPer100g: editedRanges, userQuantity: { amount: 100, unit: 'g' } },
    { ...component, label: '人工未知', userNutritionPer100g: null, userQuantity: { amount: 100, unit: 'g' } },
    { ...component, label: '过期旧参考', nutritionReferenceStale: true, userQuantity: { amount: 100, unit: 'g' } },
  ]);
  assert.deepEqual(result.calories, { min: 400, max: 480 });
  assert.equal(result.coverage!.referenceCount, 2);
  assert.equal(result.coverage!.counted, 2);
  assert.deepEqual(result.coverage!.unknownNutritionLabels, ['人工未知', '过期旧参考']);
  assert.deepEqual(result.coverage!.missingQuantityLabels, []);
  mealAnalysisSchema.parse(result);
  assert.equal(mealAnalysisSchema.safeParse({ ...result, coverage: { ...result.coverage, referenceCount: 4 } }).success, false);
});

test('household conversion refuses conflicting identities even with a supplied food ID and a manual reference', () => {
  const base = analysis();
  const component = base.components![0];
  const result = recalculated(base, [{ ...component, label: '米饭或鸡蛋', foodId: 'rice_white_long_grain_cooked',
    candidates: [{ foodId: 'rice_white_long_grain_cooked', label: '米饭', confidence: 0.6 }, { foodId: 'egg_hard_boiled', label: '鸡蛋', confidence: 0.55 }],
    userNutritionPer100g: editedRanges, userQuantity: { amount: 1, unit: 'household' },
    householdMeasure: nutritionDataset.householdMeasures!.rice_white_long_grain_cooked }]);
  assert.equal(result.components![0].userQuantity, null);
  assert.equal(result.components![0].householdMeasure, null);
  assert.equal(result.coverage!.referenceCount, 1);
  assert.equal(result.coverage!.counted, 0);
  assert.equal(result.calories, null);
  mealAnalysisSchema.parse(result);
});

test('reordered fresh AI results inherit quantities by normalized dish and method, while keeping only their new references', () => {
  const previous = analysis([rawComponent({ label: '米饭', cookingMethod: '蒸煮', userQuantity: { amount: 200, unit: 'g' } }),
    rawComponent({ label: '鸡肉烩菜', cookingMethod: '炖', userQuantity: { amount: 150, unit: 'g' } })]);
  previous.components![0].userNutritionPer100g = editedRanges;
  const fresh = analysis([rawComponent({ label: '鸡肉烩菜', cookingMethod: '炖', nutritionEstimate: { ...estimate, per100g: editedRanges } }),
    rawComponent({ label: ' 米 饭 ', cookingMethod: ' 蒸煮 ' })]);
  const result = mergeReviewedQuantities(fresh, previous);
  assert.deepEqual(result.components!.map((item) => item.userQuantity), [{ amount: 150, unit: 'g' }, { amount: 200, unit: 'g' }]);
  assert.strictEqual(result.components![0].source, fresh.components![0].source);
  assert.strictEqual(result.components![1].source, fresh.components![1].source);
  assert.equal(result.components![1].userNutritionPer100g, undefined);
  assert.deepEqual(result.calories, { min: 540, max: 680 });
  assert.equal(fresh.components![0].userQuantity, null);
  mealAnalysisSchema.parse(result);
});

test('quantity merge skips renamed dishes, method changes, duplicate matches and ambiguous identities', () => {
  const previous = analysis([rawComponent({ userQuantity: { amount: 200, unit: 'g' } })]);
  for (const fresh of [analysis([rawComponent({ label: '鸡肉炒菜' })]), analysis([rawComponent({ cookingMethod: '炒' })]),
    analysis([rawComponent(), rawComponent()]), analysis([rawComponent({ uncertainty: ['菜品身份不确定。'] })])]) {
    const result = mergeReviewedQuantities(fresh, previous);
    assert.ok(result.components!.every((component) => component.userQuantity === null));
    assert.equal(result.calories, null);
  }
  const duplicateOld = analysis([rawComponent({ userQuantity: { amount: 100, unit: 'g' } }), rawComponent({ userQuantity: { amount: 200, unit: 'g' } })]);
  assert.equal(mergeReviewedQuantities(analysis(), duplicateOld).components![0].userQuantity, null);
});

test('household quantity merge requires the same stored and locally validated conversion on both results', () => {
  const rice = { label: '米饭', cookingMethod: '蒸煮', foodId: 'rice_white_long_grain_cooked' };
  const previous = analysis([rawComponent({ ...rice, userQuantity: { amount: 1.5, unit: 'household' } })]);
  const fresh = analysis([rawComponent(rice)]);
  const retained = mergeReviewedQuantities(fresh, previous);
  assert.deepEqual(retained.components![0].userQuantity, { amount: 1.5, unit: 'household' });
  assert.deepEqual(retained.calories, { min: 180, max: 240 });
  mealAnalysisSchema.parse(retained);
  for (const householdMeasure of [null, { label: '捏造大碗', grams: 999, approximate: false }]) {
    const tampered = { ...fresh, components: [{ ...fresh.components![0], householdMeasure }] };
    assert.equal(mergeReviewedQuantities(tampered, previous).components![0].userQuantity, null);
    const oldTampered = { ...previous, components: [{ ...previous.components![0], householdMeasure }] };
    assert.equal(mergeReviewedQuantities(fresh, oldTampered).components![0].userQuantity, null);
  }
});

test('model protocols strictly reject every form of local nutrition override but local and backup schemas validate its bounds', () => {
  for (const userNutritionPer100g of [ranges, null]) {
    assert.throws(() => validateMealRecognition(rawRecognition([rawComponent({ userNutritionPer100g })])));
    assert.throws(() => validateFrontendMealRecognition({ components: [{ label: '鸡肉烩菜', cookingMethod: '炖', confidence: 0.9,
      nutritionEstimate: null, uncertainty: ['未知配方。'], userNutritionPer100g }], uncertainty: [] }));
  }
  const base = analysis();
  for (const userNutritionPer100g of [
    { ...ranges, fat: { min: 5, max: 101 } }, { ...ranges, calories: { min: 100, max: Infinity } },
    { ...ranges, carbs: { min: 30, max: 20 } }, { ...ranges, protein: null },
    { ...ranges, protein: { min: 80, max: 80 }, carbs: { min: 30, max: 30 } },
  ]) {
    const component = { ...base.components![0], userNutritionPer100g };
    assert.equal(mealComponentSchema.safeParse(component).success, false);
    assert.throws(() => recalculated(base, [component as MealComponent]));
  }
});

test('backup roundtrip preserves user overrides, explicit unknown, source audit, and older analyses without the new field', async () => {
  const base = analysis();
  const manual = recalculated(base, [
    { ...base.components![0], label: '自填菜', nutritionReferenceStale: true, userNutritionPer100g: editedRanges, userQuantity: { amount: 200, unit: 'g' } },
    { ...base.components![0], label: '未知菜', userNutritionPer100g: null, userQuantity: { amount: 100, unit: 'g' } },
    { ...base.components![0], label: '新菜', source: null, userNutritionPer100g: ranges, userQuantity: { amount: 100, unit: 'g' } },
  ]);
  const legacy = { status: 'estimated' as const, foodName: '旧记录', calories: { min: 100, max: 200 }, protein: null,
    carbs: null, fat: null, assumptions: ['旧估计'], advice: '原记录。' };
  const data = emptyData();
  data.meals.push({ id: 'meal', type: 'meal', createdAt: now, occurredAt: now, mealType: '午餐', foodName: '午餐',
    portion: '', note: '', source: 'photo', estimateStatus: 'unknown', analyses: [legacy, base, manual].map((item, index) => ({
      id: `analysis-${index}`, model: 'configured/vision-model', createdAt: now, sourceVersion: 1, analysis: item,
    })) });
  const restored = await parseBackupArchive(await createBackupArchive(data, [], now));
  const saved = restored.data.meals[0].analyses!;
  assert.deepEqual(saved[2].analysis, manual);
  assert.deepEqual(saved[1].analysis, base);
  assert.equal(Object.hasOwn(saved[1].analysis.components![0], 'userNutritionPer100g'), false);
  assert.deepEqual(saved[0].analysis.calories, legacy.calories);
  assert.deepEqual(saved[2].analysis.components![0].source, base.components![0].source);
  assert.equal(saved[2].analysis.components![0].nutritionReferenceStale, true);
  assert.equal(saved[2].analysis.components![1].userNutritionPer100g, null);
  assert.equal(saved[2].analysis.components![2].source, null);
  const replayed = calculateMealNutrition(saved[2].analysis, undefined, 'ai-per100g-v3');
  assert.deepEqual(replayed.calories, manual.calories);
  assert.deepEqual(replayed.coverage, manual.coverage);
});

test('confirmation uses the exact saved USDA snapshot and never converts legacy photo grams into intake', () => {
  const base = storedMeal([{ foodId: 'usda:123', label: '米饭', cookingMethod: '蒸煮', grams: { min: 180, max: 220 },
    quantitySource: 'visual', consumedFraction: { min: 0.5, max: 1 }, uncertainty: [], source: storedUsda,
    candidates: [{ foodId: 'usda:123', label: '米饭' }] }]);
  const rows = createMealReviewRows(base);
  assert.deepEqual(rows[0].nutrients.calories, { min: '200', max: '200' });
  assert.equal(rows[0].quantity, '');
  const referenceOnly = buildMealReviewAnalysis(base, rows);
  assert.equal(referenceOnly.calories, null);
  assert.equal(referenceOnly.components![0].userQuantity, null);
  assert.equal(referenceOnly.components![0].grams, null);
  assert.equal(referenceOnly.coverage!.referenceCount, 1);
  assert.equal(referenceOnly.coverage!.counted, 0);
  const counted = buildMealReviewAnalysis(base, [updateMealReviewRow(rows[0], { quantity: '250' })]);
  assert.deepEqual(counted.calories, { min: 500, max: 500 });
  assert.deepEqual(counted.protein, { min: 25, max: 25 });
  assert.equal(counted.nutritionSource!.method, 'reference-quantity-v1');
  assert.equal(counted.nutritionSource!.provider, 'usda-fdc');
  assert.strictEqual(counted.components![0].source, storedUsda);
  assert.equal(counted.components![0].foodId, 'usda:123');
  assert.equal(counted.components![0].userNutritionPer100g, undefined);
  assert.deepEqual(base.components![0].grams, { min: 180, max: 220 });
  mealAnalysisSchema.parse(referenceOnly);
  mealAnalysisSchema.parse(counted);
  const datasetWithoutFoodReads = { ...nutritionDataset,
    get foods(): typeof nutritionDataset.foods { throw new Error('Snapshot calculation must not consult foods.'); },
    get categories(): typeof nutritionDataset.categories { throw new Error('Snapshot calculation must not consult categories.'); } };
  assert.deepEqual(calculateMealNutrition(counted, datasetWithoutFoodReads, 'reference-quantity-v1').calories, counted.calories);
  const updatedAgain = buildMealReviewAnalysis(counted, [updateMealReviewRow(createMealReviewRows(counted)[0], { quantity: '100' })]);
  assert.deepEqual(updatedAgain.calories, { min: 200, max: 200 });
  assert.strictEqual(updatedAgain.components![0].source, storedUsda);
});

test('saved local-category, USDA, model and manual references coexist without replacing their attribution', () => {
  const ai = analysis().components![0];
  const base = storedMeal([
    { foodId: null, label: '精确条目', grams: null, uncertainty: [], source: storedUsda },
    { foodId: null, label: '本地类别', grams: null, uncertainty: [], source: storedCategory },
    { ...ai, label: '模型菜' },
  ]);
  const rows = createMealReviewRows(base).map((row, index) => updateMealReviewRow(row, { quantity: index === 1 ? '50' : '100' }));
  const manual = updateMealReviewRow(updateMealReviewRow(createEmptyMealReviewRow(), { label: '人工菜' }),
    { quantity: '100', nutrients: nutrientDraft(editedRanges) });
  const result = buildMealReviewAnalysis(base, [...rows, manual]);
  assert.deepEqual(result.calories, { min: 580, max: 680 });
  assert.equal(result.nutritionSource!.provider, 'mixed');
  assert.equal(result.nutritionSource!.method, 'reference-quantity-v1');
  assert.deepEqual(result.coverage, { matched: 4, referenceCount: 4, total: 4, counted: 4,
    unknownLabels: [], unknownNutritionLabels: [], missingQuantityLabels: [] });
  for (let index = 0; index < 3; index += 1) assert.strictEqual(result.components![index].source, base.components![index].source);
  assert.equal(result.components![3].source, null);
  assert.deepEqual(result.components![3].userNutritionPer100g, editedRanges);
  mealAnalysisSchema.parse(result);
  const categoryOnly = buildMealReviewAnalysis(base, [rows[1]]);
  assert.deepEqual(categoryOnly.calories, { min: 60, max: 80 });
  assert.equal(categoryOnly.nutritionSource!.provider, 'local-category');
  assert.strictEqual(categoryOnly.components![0].source, storedCategory);
  mealAnalysisSchema.parse(categoryOnly);
});

test('local snapshot mode honors manual overrides and explicit unknown while excluding stale and partial saved sources', () => {
  const base = storedMeal([
    { foodId: null, label: '人工新参考', grams: null, uncertainty: [], source: storedUsda,
      nutritionReferenceStale: true, userNutritionPer100g: editedRanges },
    { foodId: null, label: '明确未知', grams: null, uncertainty: [], source: storedCategory, userNutritionPer100g: null },
    { foodId: null, label: '旧参考过期', grams: null, uncertainty: [], source: storedUsda, nutritionReferenceStale: true },
    { foodId: null, label: '旧参考缺蛋白质', grams: null, uncertainty: [], source: { ...storedUsda,
      per100g: { ...storedUsda.per100g!, protein: null } } },
  ]);
  const rows = createMealReviewRows(base).map((row) => updateMealReviewRow(row, { quantity: '100' }));
  const result = buildMealReviewAnalysis(base, rows);
  assert.deepEqual(result.calories, editedRanges.calories);
  assert.equal(result.nutritionSource!.provider, 'manual');
  assert.equal(result.coverage!.referenceCount, 1);
  assert.equal(result.coverage!.counted, 1);
  assert.deepEqual(result.coverage!.unknownNutritionLabels, ['明确未知', '旧参考过期', '旧参考缺蛋白质']);
  assert.equal(result.components![1].userNutritionPer100g, null);
  result.components!.forEach((component, index) => assert.strictEqual(component.source, base.components![index].source));
  mealAnalysisSchema.parse(result);
  const secondQuantityEdit = buildMealReviewAnalysis(result, createMealReviewRows(result).map((row) =>
    updateMealReviewRow(row, { quantity: '250' })));
  assert.deepEqual(secondQuantityEdit.calories, { min: 500, max: 600 });
  assert.equal(secondQuantityEdit.nutritionSource!.provider, 'manual');
  assert.deepEqual(secondQuantityEdit.components![0].userNutritionPer100g, editedRanges);
  assert.strictEqual(secondQuantityEdit.components![0].source, storedUsda);
});

test('old category snapshots support reliable local portions without requiring old confidence fields', () => {
  const measure = nutritionDataset.householdMeasures!.rice_white_long_grain_cooked;
  const base = storedMeal([{ foodId: null, label: '熟米饭', cookingMethod: '蒸煮', grams: null, uncertainty: [],
    source: { ...storedCategory, householdMeasure: measure }, userQuantity: { amount: 1.5, unit: 'household' } }]);
  const result = buildMealReviewAnalysis(base, createMealReviewRows(base));
  assert.deepEqual(result.calories, { min: 180, max: 240 });
  assert.deepEqual(result.components![0].householdMeasure, measure);
  assert.deepEqual(result.components![0].userQuantity, { amount: 1.5, unit: 'household', origin: 'user' });
  assert.equal(result.nutritionSource!.provider, 'local-category');
  mealAnalysisSchema.parse(result);
  const unreliable = storedMeal([{ ...base.components![0], source: { ...storedCategory,
    householdMeasure: { label: '旧大碗', grams: 999, approximate: true } } }]);
  assert.throws(() => buildMealReviewAnalysis(unreliable, createMealReviewRows(unreliable)), /本地份数换算/);
  const conflict = storedMeal([{ ...base.components![0], uncertainty: ['菜品身份不明。'] }]);
  assert.throws(() => buildMealReviewAnalysis(conflict, createMealReviewRows(conflict)), /本地份数换算/);
});

test('reference quantity analyses roundtrip with legacy sources and strict model inputs cannot forge the local mode', async () => {
  const old = storedMeal([{ foodId: 'usda:123', label: '米饭', grams: { min: 180, max: 220 },
    quantitySource: 'visual', uncertainty: [], source: storedUsda }]);
  const reviewed = buildMealReviewAnalysis(old, [updateMealReviewRow(createMealReviewRows(old)[0], { quantity: '200' })]);
  const data = emptyData();
  data.meals.push({ id: 'stored-meal', type: 'meal', createdAt: now, occurredAt: now, mealType: '午餐', foodName: '米饭',
    portion: '', note: '', source: 'photo', estimateStatus: 'unknown', analyses: [old, reviewed].map((item, index) => ({
      id: `stored-${index}`, model: 'local/reference-quantity-v1', createdAt: now, sourceVersion: 1, analysis: item,
    })) });
  const parsed = await parseBackupArchive(await createBackupArchive(data, [], now));
  assert.deepEqual(parsed.data.meals[0].analyses![0].analysis, mealAnalysisSchema.parse(old));
  assert.deepEqual(parsed.data.meals[0].analyses![1].analysis, reviewed);
  assert.equal(parsed.data.meals[0].analyses![1].analysis.estimateScope, undefined);
  assert.equal(mealAnalysisSchema.safeParse({ ...reviewed, nutritionSource: { ...reviewed.nutritionSource, provider: 'model' } }).success, false);
  assert.equal(mealAnalysisSchema.safeParse({ ...reviewed, coverage: { ...reviewed.coverage, referenceCount: 0 } }).success, false);
  assert.equal(mealAnalysisSchema.safeParse({ ...reviewed, status: 'estimated' }).success, false);
  assert.throws(() => validateMealRecognition({ ...rawRecognition(), nutritionSource: reviewed.nutritionSource }));
  assert.throws(() => validateFrontendMealRecognition({ components: [], uncertainty: [], nutritionSource: reviewed.nutritionSource }));
  assert.throws(() => validateMealRecognition(rawRecognition([rawComponent({ foodId: 'usda:123' })])));
});

test('invalid manual snapshot ranges return a schema failure and a structured backup rejection rather than escaping safeParse', async () => {
  const reference = calculateMealNutrition(storedMeal([{ foodId: null, label: '自填菜', grams: null,
    uncertainty: [], source: null, userQuantity: null, userNutritionPer100g: null }]), undefined, 'reference-quantity-v1');
  const invalidRanges: NutrientRanges[] = [
    { ...ranges, calories: { min: -1, max: 150 } },
    { ...ranges, protein: { min: 20, max: 10 } },
    { ...ranges, fat: { min: 0, max: 101 } },
    { ...ranges, protein: { min: 80, max: 90 }, carbs: { min: 30, max: 40 } },
  ];
  for (const userNutritionPer100g of invalidRanges) {
    const invalid = { ...reference, components: [{ ...reference.components![0], userNutritionPer100g }] };
    assert.equal(mealAnalysisSchema.safeParse(invalid).success, false);
    assert.throws(() => calculateMealNutrition(invalid, undefined, 'reference-quantity-v1'), /Invalid per-100g nutrient ranges/);
    const data = emptyData();
    data.meals.push({ id: 'invalid-reference', type: 'meal', createdAt: now, occurredAt: now, mealType: '午餐', foodName: '自填菜',
      portion: '', note: '', source: 'manual', estimateStatus: 'unknown', analyses: [{
        id: 'invalid-version', model: 'local/reference-quantity-v1', createdAt: now, sourceVersion: 1, analysis: invalid,
      }] });
    await assert.rejects(createBackupArchive(data, [], now), (error) => error instanceof BackupError && error.code === 'invalid-data');
  }
});

function unknownIdentityMeal(unresolved: string[] = []): MealAnalysis {
  return { ...analysis([rawComponent({ label: '待确认菜品 1', uncertainty: ['菜品身份不明。', '烹调油用量未知。', '重量未知。'],
    candidates: [{ foodId: null, label: '鸡蛋', confidence: 0.55 }, { foodId: null, label: '豆腐', confidence: 0.5 }] })]), unresolved };
}

function explicitlyNamedReview(base: MealAnalysis): MealAnalysis {
  const renamed = updateMealReviewRow(createMealReviewRows(base)[0], { label: '凉拌豆腐', cookingMethod: '凉拌' });
  return buildMealReviewAnalysis(base, [updateMealReviewRow(renamed, { nutrients: nutrientDraft(editedRanges) })]);
}

test('an explicitly corrected dish name and complete user reference resolve old identity doubts for portion estimates', () => {
  const base = unknownIdentityMeal(['待确认菜品 1：无法识别菜品种类。']);
  assert.equal(estimateMealPortion({ calorieTarget: 2000 }, '午餐', base).status, 'unavailable');
  const reviewed = explicitlyNamedReview(base);
  assert.equal(hasMealIdentityConflict(reviewed.components![0]), false);
  assert.deepEqual(reviewed.components![0].uncertainty, ['烹调油用量未知。', '重量未知。']);
  assert.deepEqual(reviewed.unresolved, []);
  assert.strictEqual(reviewed.components![0].source, base.components![0].source);
  assert.equal(reviewed.components![0].nutritionReferenceStale, true);
  assert.deepEqual(reviewed.components![0].userNutritionPer100g, editedRanges);
  assert.equal(estimateMealPortion({ calorieTarget: 2000 }, '午餐', reviewed).status, 'unavailable');
  assert.equal(hasMealIdentityConflict(base.components![0]), true);
  assert.deepEqual(base.unresolved, ['待确认菜品 1：无法识别菜品种类。']);
  mealAnalysisSchema.parse(reviewed);
});

test('correcting a name keeps whole-photo omissions, unattributed conflicts and compound omission warnings', () => {
  const preserved = ['还有一道主食未识别。', '菜品身份冲突，归属不明。', '待确认菜品 1：身份不明，并且还有一道菜遗漏。'];
  const base = unknownIdentityMeal(['待确认菜品 1：菜品身份不明。', ...preserved]);
  const reviewed = explicitlyNamedReview(base);
  assert.deepEqual(reviewed.unresolved, preserved);
  const portion = estimateMealPortion({ calorieTarget: 2000 }, '午餐', reviewed);
  assert.equal(portion.status, 'unavailable');
  assert.match(portion.reason!, /遗漏|不完整/);
  const duplicate = unknownIdentityMeal(['待确认菜品 1：无法识别菜品种类。']);
  duplicate.components!.push({ ...duplicate.components![0] });
  const rows = createMealReviewRows(duplicate);
  const result = buildMealReviewAnalysis(duplicate, rows.map((row, index) => updateMealReviewRow(
    updateMealReviewRow(row, { label: index === 0 ? '凉拌豆腐' : '蒸蛋' }), { nutrients: nutrientDraft(editedRanges) })));
  assert.deepEqual(result.unresolved, duplicate.unresolved);
});

test('changing a known dish method does not reopen its resolved candidates or reuse old preparation nutrition', () => {
  for (const source of [analysis().components![0].source, storedUsda]) {
    const base = storedMeal([{ foodId: 'rice_white_long_grain_cooked', label: '米饭', cookingMethod: '蒸煮',
      grams: { min: 180, max: 220 }, quantitySource: 'visual', uncertainty: [], source,
      candidates: [{ foodId: 'rice_white_long_grain_cooked', label: '米饭', confidence: 0.95 },
        { foodId: 'egg_hard_boiled', label: '鸡蛋', confidence: 0.05 }] }]);
    assert.equal(hasMealIdentityConflict(base.components![0]), false);
    const changed = updateMealReviewRow(createMealReviewRows(base)[0], { cookingMethod: '炒' });
    const withoutReference = buildMealReviewAnalysis(base, [changed]);
    assert.equal(withoutReference.components![0].userNutritionPer100g, null);
    assert.equal(withoutReference.coverage!.referenceCount, 0);
    assert.equal(estimateMealPortion({ calorieTarget: 2000 }, '午餐', withoutReference).status, 'unavailable');
    const reviewed = buildMealReviewAnalysis(base, [updateMealReviewRow(changed, { nutrients: nutrientDraft(editedRanges) })]);
    const dish = reviewed.components![0];
    assert.equal(hasMealIdentityConflict(dish), false);
    assert.equal(estimateMealPortion({ calorieTarget: 2000 }, '午餐', reviewed).status, 'unavailable');
    assert.equal(dish.foodId, null);
    assert.equal(dish.candidates, undefined);
    assert.equal(dish.nutritionReferenceStale, true);
    assert.strictEqual(dish.source, source);
    assert.deepEqual(dish.userNutritionPer100g, editedRanges);
    assert.equal(dish.grams, null);
    assert.equal(dish.userQuantity, null);
    assert.equal(dish.householdMeasure, null);
    assert.equal(reviewed.calories, null);
    assert.equal(reviewed.coverage!.counted, 0);
    const quantified = buildMealReviewAnalysis(reviewed, [updateMealReviewRow(createMealReviewRows(reviewed)[0], { quantity: '200' })]);
    assert.deepEqual(quantified.calories, { min: 400, max: 480 });
    assert.strictEqual(quantified.components![0].source, source);
    assert.equal(base.components![0].foodId, 'rice_white_long_grain_cooked');
    assert.equal(base.components![0].candidates!.length, 2);
    assert.deepEqual(base.components![0].grams, { min: 180, max: 220 });
    mealAnalysisSchema.parse(reviewed);
    mealAnalysisSchema.parse(quantified);
  }
});

test('changing only a cooking method does not erase identity uncertainty or conflicting candidates', () => {
  const variants = [
    { uncertainty: ['菜品身份不明。'], rice: 0.95, egg: 0.05 },
    { uncertainty: [], rice: 0.6, egg: 0.55 },
    { uncertainty: [], rice: 0.05, egg: 0.95 },
  ];
  for (const variant of variants) {
    const base = analysis([rawComponent({ foodId: 'rice_white_long_grain_cooked', label: '米饭', cookingMethod: '蒸煮',
      uncertainty: variant.uncertainty,
      candidates: [{ foodId: 'rice_white_long_grain_cooked', label: '米饭', confidence: variant.rice },
        { foodId: 'egg_hard_boiled', label: '鸡蛋', confidence: variant.egg }] })]);
    assert.equal(hasMealIdentityConflict(base.components![0]), true);
    const changed = updateMealReviewRow(createMealReviewRows(base)[0], { cookingMethod: '清蒸' });
    const reviewed = buildMealReviewAnalysis(base, [updateMealReviewRow(changed, { nutrients: nutrientDraft(editedRanges) })]);
    assert.equal(hasMealIdentityConflict(reviewed.components![0]), true);
    assert.deepEqual(reviewed.components![0].candidates, base.components![0].candidates);
    assert.deepEqual(reviewed.components![0].uncertainty, variant.uncertainty);
    const portion = estimateMealPortion({ calorieTarget: 2000 }, '午餐', reviewed);
    assert.equal(portion.status, 'unavailable');
    assert.match(portion.reason!, /身份尚未确认/);
  }
});

test('renaming a dish to another placeholder never confirms its identity, even with complete manual nutrients', () => {
  for (const label of ['待确认菜品 2', '未知菜品', '菜品 1', '未知饮料', '待确认的菜品', 'Unknown dish 2']) {
    const base = analysis();
    const changed = updateMealReviewRow(createMealReviewRows(base)[0], { label });
    const reviewed = buildMealReviewAnalysis(base, [updateMealReviewRow(changed, { nutrients: nutrientDraft(editedRanges) })]);
    assert.equal(hasMealIdentityConflict(reviewed.components![0]), true, label);
    const portion = estimateMealPortion({ calorieTarget: 2000 }, '午餐', reviewed);
    assert.equal(portion.status, 'unavailable', label);
    assert.match(portion.reason!, /身份尚未确认/);
  }
});
