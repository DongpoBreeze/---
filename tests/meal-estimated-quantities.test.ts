import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateMealNutrition as calculateShared, validateFrontendMealRecognition, validateMealRecognition } from '../shared/nutrition.mjs';
import { BackupError, createBackupArchive, parseBackupArchive } from '../src/backup';
import { estimateMealPortion } from '../src/meal-portion-reference';
import { createManualNutritionAnalysis, emptyMealNutritionFields, nutritionFieldsFromMeal, parseMealNutritionFields } from '../src/meal-nutrition-fields';
import {
  applyEstimatedMealQuantities, buildMealReviewAnalysis, createMealReviewRows, mealReviewConfirmationMessage,
  mergeReviewedQuantities, updateMealReviewRow,
} from '../src/meal-review';
import { calculateMealNutrition, nutritionDataset } from '../src/nutrition';
import { mealAnalysisSchema, mealComponentSchema } from '../src/nutrition-schema';
import { emptyData, type MealAnalysis, type MealComponent, type ModelNutritionEstimate, type NutrientRanges } from '../src/types';

const now = '2026-10-21T03:00:00.000Z';
const ranges: NutrientRanges = { calories: { min: 200, max: 200 }, protein: { min: 10, max: 10 },
  carbs: { min: 20, max: 20 }, fat: { min: 5, max: 5 } };
const estimate: NonNullable<ModelNutritionEstimate> = { basisGrams: 100, method: 'typical_recipe', per100g: ranges,
  recipeBasis: '通常成品配方，油和酱包含在内。', assumptions: [], confidence: 0.8 };
const rawDish = (changes: Record<string, unknown> = {}) => ({ foodId: null, label: '鸡肉烩菜', cookingMethod: '炖',
  confidence: 0.9, recommendedShare: 1, uncertainty: [], nutritionEstimate: estimate, ...changes });
const recognition = (components = [rawDish()]) => ({ foodName: '午餐', components, unresolved: [], assumptions: [], advice: '核实食用量。' });
const analysis = (components = [rawDish()]): MealAnalysis => calculateShared(recognition(components), nutritionDataset, {
  mode: 'ai-per100g-v3', provenance: { model: 'configured/vision-model', createdAt: now },
});
const draftNutrients = (values: NutrientRanges) => Object.fromEntries(Object.entries(values).map(([key, value]) =>
  [key, { min: String(value.min), max: String(value.max) }])) as ReturnType<typeof createMealReviewRows>[number]['nutrients'];
const defaultRows = (base: MealAnalysis) => applyEstimatedMealQuantities({}, '午餐', base, createMealReviewRows(base));

test('blank recognized dishes get integer midpoint estimates and all four totals without changing raw AI references', () => {
  const base = analysis();
  const original = structuredClone(base);
  const rows = createMealReviewRows(base);
  const rowSnapshot = structuredClone(rows);
  assert.equal(base.calories, null);
  assert.equal(rows[0].quantity, '');
  const defaults = applyEstimatedMealQuantities({}, '午餐', base, rows);
  assert.notStrictEqual(defaults, rows);
  assert.deepEqual(rows, rowSnapshot);
  assert.equal(defaults[0].id, rows[0].id);
  assert.equal(defaults[0].quantity, '315');
  assert.equal(defaults[0].quantityOrigin, 'estimated');
  assert.equal(defaults[0].quantityEdited, false);
  const result = buildMealReviewAnalysis(base, defaults);
  assert.equal(result.status, 'approximate');
  assert.deepEqual(result.calories, { min: 630, max: 630 });
  assert.deepEqual(result.protein, { min: 31.5, max: 31.5 });
  assert.deepEqual(result.carbs, { min: 63, max: 63 });
  assert.deepEqual(result.fat, { min: 15.7, max: 15.8 });
  assert.deepEqual(result.components![0].userQuantity, { amount: 315, unit: 'g', origin: 'estimated' });
  assert.equal(result.components![0].grams, null);
  assert.equal(result.components![0].quantitySource, 'unknown');
  assert.strictEqual(result.components![0].source, base.components![0].source);
  assert.equal(Object.hasOwn(result.components![0], 'userNutritionPer100g'), false);
  assert.match(result.assumptions.join(' '), /估计的数量.*未作为称重实测.*未从照片推断重量/);
  assert.deepEqual(base, original);
  mealAnalysisSchema.parse(result);
});

test('estimated amounts recalculate for body weight, meal type and a valid daily target', () => {
  const base = analysis();
  const rows = defaultRows(base);
  const heavier = applyEstimatedMealQuantities({ weightKg: 90 }, '午餐', base, rows);
  assert.equal(heavier[0].quantity, '473');
  assert.equal(heavier[0].id, rows[0].id);
  const breakfast = applyEstimatedMealQuantities({ weightKg: 60 }, '早餐', base, heavier);
  assert.equal(breakfast[0].quantity, '225');
  const target = applyEstimatedMealQuantities({ calorieTarget: 2000, weightKg: 90 }, '午餐', base, breakfast);
  assert.equal(target[0].quantity, '350');
  assert.equal(target[0].quantityOrigin, 'estimated');
  const reference = estimateMealPortion({}, '午餐', base);
  assert.equal(rows[0].quantity, String(Math.round((reference.dishes[0].grams.min + reference.dishes[0].grams.max) / 2)));
});

test('AI-recommended dish shares control estimates while existing and edited user quantities retain priority', () => {
  const base = analysis([rawDish({ recommendedShare: 1 / 3 }), rawDish({ label: '蒸米饭', cookingMethod: '蒸', recommendedShare: 2 / 3 })]);
  const rows = defaultRows(base);
  assert.deepEqual(rows.map((row) => row.quantity), ['105', '210']);
  const edited = updateMealReviewRow(rows[0], { quantity: '123' });
  assert.equal(edited.quantityEdited, true);
  assert.equal(edited.quantityOrigin, 'user');
  const changed = applyEstimatedMealQuantities({ weightKg: 90 }, '午餐', base, [edited, rows[1]]);
  assert.deepEqual(changed.map((row) => row.quantity), ['123', '315']);
  assert.deepEqual(buildMealReviewAnalysis(base, changed).components!.map((component) => component.userQuantity?.origin), ['user', 'estimated']);
  const legacyUser = analysis([rawDish({ userQuantity: { amount: 127, unit: 'g' } })]);
  const restored = createMealReviewRows(legacyUser)[0];
  assert.equal(restored.quantityOrigin, 'user');
  assert.equal(restored.quantityEdited, true);
  assert.equal(applyEstimatedMealQuantities({}, '午餐', legacyUser, [restored])[0].quantity, '127');
  const compatible = { ...rows[0], quantity: '111', quantityOrigin: undefined, quantityEdited: undefined };
  assert.equal(applyEstimatedMealQuantities({}, '午餐', base, [compatible, rows[1]])[0].quantity, '111');
});

test('reopening a saved meal fills eligible blank quantities without changing saved estimates, user quantities, or explicit clears', () => {
  const base = analysis([
    rawDish({ recommendedShare: 0.7, userQuantity: { amount: 88, unit: 'g', origin: 'user' } }),
    rawDish({ label: '蒸米饭', recommendedShare: 0.3 }),
    rawDish({ label: '煎蛋', recommendedShare: 0.2, userQuantity: { amount: 65, unit: 'g', origin: 'estimated' } }),
  ]);
  const rows = createMealReviewRows(base);
  const reopened = applyEstimatedMealQuantities({ weightKg: 90 }, '午餐', base, rows, { preserveExistingEstimates: true });

  assert.equal(reopened[0].quantity, '88');
  assert.ok(Number(reopened[1].quantity) > 0);
  assert.equal(reopened[2].quantity, '65');
  assert.deepEqual(reopened.map((row) => row.quantityOrigin), ['user', 'estimated', 'estimated']);

  const cleared = updateMealReviewRow(reopened[1], { quantity: '' });
  const afterClear = applyEstimatedMealQuantities({}, '午餐', base, [reopened[0], cleared, reopened[2]], { preserveExistingEstimates: true });
  assert.equal(afterClear[1].quantity, '');
  assert.equal(afterClear[1].quantityEdited, true);
});

test('explicitly cleared quantities and changed units never acquire another default', () => {
  const base = analysis();
  const row = defaultRows(base)[0];
  for (const cleared of [updateMealReviewRow(row, { quantity: '' }), updateMealReviewRow(row, { quantityUnit: 'household' })]) {
    assert.equal(cleared.quantity, '');
    assert.equal(cleared.quantityEdited, true);
    assert.equal(cleared.quantityOrigin, undefined);
    const unchanged = applyEstimatedMealQuantities({ calorieTarget: 2500 }, '午餐', base, [cleared]);
    assert.equal(unchanged[0].quantity, '');
    const saved = buildMealReviewAnalysis(base, unchanged);
    assert.equal(saved.components![0].userQuantity, null);
    assert.equal(saved.components![0].userQuantityCleared, true);
    assert.equal(saved.calories, null);
    assert.equal(saved.status, 'unknown');
    assert.equal(defaultRows(saved)[0].quantity, '');
    mealAnalysisSchema.parse(saved);
  }
});

test('a saved explicit clear survives reopening and a later valid entry removes the exclusion marker', () => {
  const base = analysis();
  const cleared = buildMealReviewAnalysis(base, [updateMealReviewRow(defaultRows(base)[0], { quantity: ' ' })]);
  const reopened = createMealReviewRows(cleared);
  assert.equal(reopened[0].quantityEdited, true);
  assert.equal(applyEstimatedMealQuantities({}, '午餐', cleared, reopened)[0].quantity, '');
  const entered = buildMealReviewAnalysis(cleared, [updateMealReviewRow(reopened[0], { quantity: '75' })]);
  assert.equal(Object.hasOwn(entered.components![0], 'userQuantityCleared'), false);
  assert.deepEqual(entered.components![0].userQuantity, { amount: 75, unit: 'g', origin: 'user' });
  assert.doesNotMatch(entered.assumptions.join(' '), /估计的数量/);
});

test('temporary invalid quantity and nutrient edits remain exactly as typed when estimates cannot be built', () => {
  const base = analysis();
  const row = defaultRows(base)[0];
  const invalidQuantity = updateMealReviewRow(row, { quantity: '12.' });
  const incompleteNutrition = updateMealReviewRow(row, { nutrients: { ...row.nutrients, protein: { min: '', max: '' } } });
  for (const invalid of [invalidQuantity, incompleteNutrition]) {
    const before = structuredClone(invalid);
    assert.deepEqual(applyEstimatedMealQuantities({ weightKg: 90 }, '晚餐', base, [invalid]), [before]);
    assert.deepEqual(invalid, before);
    assert.throws(() => buildMealReviewAnalysis(base, [invalid]));
  }
});

test('unknown nutrition, unresolved identity, stale references and omissions cannot produce default grams', () => {
  const variants = [
    analysis([rawDish({ nutritionEstimate: null, uncertainty: ['配方未知。'] })]),
    analysis([rawDish({ uncertainty: ['菜品身份待确认。'] })]),
    analysis([rawDish({ nutritionReferenceStale: true })]),
    analysis([rawDish(), rawDish({ label: '未知饮料', nutritionEstimate: null, uncertainty: ['营养未知。'] })]),
    { ...analysis(), unresolved: ['还有一道主食未识别。'] },
  ];
  for (const base of variants) {
    const rows = createMealReviewRows(base);
    assert.deepEqual(applyEstimatedMealQuantities({}, '午餐', base, rows), rows);
    assert.ok(rows.every((row) => row.quantity === ''));
  }
  const base = analysis();
  const changed = updateMealReviewRow(defaultRows(base)[0], { label: '油炸鸡块', cookingMethod: '炸' });
  const unchanged = applyEstimatedMealQuantities({}, '午餐', base, [changed]);
  const stale = buildMealReviewAnalysis(base, unchanged);
  assert.equal(stale.calories, null);
  assert.equal(stale.components![0].nutritionReferenceStale, true);
  assert.equal(stale.components![0].userNutritionPer100g, null);
  assert.strictEqual(stale.components![0].source, base.components![0].source);
});

test('editing a per-100 g reference recalculates only estimated quantities and preserves the original snapshot', () => {
  const base = analysis();
  const oldSource = base.components![0].source;
  const denser = { ...ranges, calories: { min: 400, max: 400 } };
  const edited = updateMealReviewRow(defaultRows(base)[0], { nutrients: draftNutrients(denser) });
  const rows = applyEstimatedMealQuantities({}, '午餐', base, [edited]);
  assert.equal(rows[0].quantity, '158');
  const result = buildMealReviewAnalysis(base, rows);
  assert.deepEqual(result.components![0].userNutritionPer100g, denser);
  assert.strictEqual(result.components![0].source, oldSource);
  assert.deepEqual(oldSource?.per100gRange, ranges);
  const user = updateMealReviewRow(edited, { quantity: '100' });
  assert.equal(applyEstimatedMealQuantities({}, '午餐', base, [user])[0].quantity, '100');
});

test('legacy photo grams are kept as photo data and do not become intake or new portion recommendations', () => {
  const source = { provider: 'usda-fdc' as const, dataset: 'saved snapshot', per100g: { calories: 200, protein: 10, carbs: 20, fat: 5 } };
  const legacy: MealAnalysis = { status: 'unknown', foodName: '旧照片', calories: null, protein: null, carbs: null, fat: null,
    assumptions: [], unresolved: [], advice: '原始记录。', components: [{ foodId: null, label: '鸡肉烩菜',
      grams: { min: 3, max: 9999 }, quantitySource: 'visual', consumedFraction: { min: 0.2, max: 0.9 }, uncertainty: [], source }] };
  const rows = createMealReviewRows(legacy);
  assert.equal(rows[0].quantity, '');
  const saved = buildMealReviewAnalysis(legacy, applyEstimatedMealQuantities({}, '午餐', legacy, rows));
  assert.equal(saved.components![0].userQuantity, null);
  assert.equal(saved.calories, null);
  assert.deepEqual(legacy.components![0].grams, { min: 3, max: 9999 });
  assert.equal(legacy.components![0].quantitySource, 'visual');
  assert.equal(legacy.components![0].userQuantity, undefined);
  assert.strictEqual(saved.components![0].source, source);
});

test('AI review carries origins by unique identity and subsequent default calculation uses the fresh reference', () => {
  const base = analysis([rawDish(), rawDish({ label: '蒸蛋', cookingMethod: '蒸' })]);
  const rows = defaultRows(base);
  const previous = buildMealReviewAnalysis(base, [updateMealReviewRow(rows[0], { quantity: '75' }), rows[1]]);
  const fresh = analysis([rawDish({ label: '蒸蛋', cookingMethod: '蒸', nutritionEstimate: { ...estimate, per100g: { ...ranges, calories: { min: 400, max: 400 } } } }), rawDish()]);
  const merged = mergeReviewedQuantities(fresh, previous);
  assert.deepEqual(merged.components!.map((component) => component.userQuantity?.origin), ['estimated', 'user']);
  assert.strictEqual(merged.components![0].source, fresh.components![0].source);
  const recomputed = applyEstimatedMealQuantities({}, '午餐', merged, createMealReviewRows(merged));
  assert.equal(recomputed[0].quantity, '105');
  assert.equal(recomputed[0].quantityEdited, false);
  assert.equal(recomputed[1].quantity, '75');
  assert.equal(recomputed[1].quantityEdited, true);
  mealAnalysisSchema.parse(buildMealReviewAnalysis(merged, recomputed));
});

test('an explicit clear follows only one matching dish through AI review', () => {
  const base = analysis();
  const previous = buildMealReviewAnalysis(base, [updateMealReviewRow(defaultRows(base)[0], { quantity: '' })]);
  const merged = mergeReviewedQuantities(analysis(), previous);
  assert.equal(merged.components![0].userQuantityCleared, true);
  assert.equal(defaultRows(merged)[0].quantity, '');
  for (const fresh of [analysis([rawDish({ label: '蒸蛋' })]), analysis([rawDish({ cookingMethod: '炒' })]),
    analysis([rawDish(), rawDish()]), analysis([rawDish({ uncertainty: ['菜品身份不明。'] })])]) {
    assert.ok(mergeReviewedQuantities(fresh, previous).components!.every((component) => !component.userQuantityCleared));
  }
});

test('review rows restore in-flight explicit clears only for unique confirmed name and method matches', () => {
  const base = analysis();
  const cleared = updateMealReviewRow(defaultRows(base)[0], { quantity: '' });
  const fresh = analysis([rawDish({ label: ' 鸡 肉 烩 菜 ', cookingMethod: ' 炖 ' })]);
  const restored = createMealReviewRows(fresh, [cleared]);
  assert.equal(restored[0].quantityEdited, true);
  assert.equal(applyEstimatedMealQuantities({}, '午餐', fresh, restored)[0].quantity, '');
  const methodChanged = createMealReviewRows(analysis([rawDish({ cookingMethod: '炒' })]), [cleared]);
  assert.equal(methodChanged[0].quantityEdited, false);
  const duplicateBefore = createMealReviewRows(base, [cleared, { ...cleared, id: 'another' }]);
  assert.equal(duplicateBefore[0].quantityEdited, false);
  const duplicateAfter = createMealReviewRows(analysis([rawDish(), rawDish()]), [cleared]);
  assert.ok(duplicateAfter.every((row) => row.quantityEdited === false));
  const uncertain = createMealReviewRows(analysis([rawDish({ uncertainty: ['菜品身份不明。'] })]), [cleared]);
  assert.equal(uncertain[0].quantityEdited, false);
});

test('previous rows cannot restore rejected household digits after a conversion changes', () => {
  const rice = { label: '米饭', cookingMethod: '蒸煮', foodId: 'rice_white_long_grain_cooked' };
  const base = analysis([rawDish(rice)]);
  const rows = [updateMealReviewRow(createMealReviewRows(base)[0], { quantity: '2', quantityUnit: 'household' })];
  const previous = buildMealReviewAnalysis(base, rows);
  const fresh = analysis([rawDish(rice)]);
  fresh.components![0].householdMeasure = { label: '错误大碗', grams: 999, approximate: false };
  const merged = mergeReviewedQuantities(fresh, previous);
  assert.equal(merged.components![0].userQuantity, null);
  const restored = createMealReviewRows(merged, rows);
  assert.equal(restored[0].quantity, '');
  assert.equal(restored[0].quantityEdited, true);
  assert.equal(applyEstimatedMealQuantities({}, '午餐', merged, restored)[0].quantity, '');
});

test('local validators preserve optional quantity origins and clears while strict AI formats reject them', () => {
  const base = analysis();
  for (const origin of [undefined, 'estimated', 'user'] as const) {
    const quantity = { amount: 100, unit: 'g' as const, ...(origin === undefined ? {} : { origin }) };
    const local = validateMealRecognition({ ...base, components: [{ ...base.components![0], userQuantity: quantity }] }, { strict: false });
    assert.deepEqual(local.components[0].userQuantity, quantity);
    mealComponentSchema.parse(local.components[0]);
  }
  for (const changes of [
    { userQuantity: { amount: 100, unit: 'g', origin: 'photo' } },
    { userQuantity: { amount: 100, unit: 'g', unexpected: true } },
    { userQuantityCleared: 'yes' },
    { userQuantity: { amount: 100, unit: 'g' }, userQuantityCleared: true },
  ]) {
    const component = { ...base.components![0], ...changes };
    assert.throws(() => validateMealRecognition({ ...base, components: [component] }, { strict: false }));
    assert.equal(mealComponentSchema.safeParse(component).success, false);
  }
  for (const changes of [{ userQuantity: { amount: 100, unit: 'g', origin: 'estimated' } }, { userQuantityCleared: true }]) {
    assert.throws(() => validateMealRecognition(recognition([rawDish(changes)])));
    assert.throws(() => validateFrontendMealRecognition({ components: [{ label: '鸡肉烩菜', cookingMethod: '炖', confidence: 0.9,
      nutritionEstimate: null, uncertainty: ['营养未知。'], ...changes }], uncertainty: [] }));
  }
});

test('estimated gram quantities keep local database totals approximate and their source remains auditable', () => {
  const component: MealComponent = { foodId: 'rice_white_long_grain_cooked', label: '熟米饭', grams: null,
    uncertainty: [], userQuantity: { amount: 100, unit: 'g', origin: 'estimated' } };
  const input: MealAnalysis = { ...analysis(), components: [component] };
  const result = calculateMealNutrition(input, nutritionDataset, 'user-quantity-v2');
  assert.equal(result.status, 'approximate');
  assert.deepEqual(result.calories, { min: 130, max: 130 });
  assert.equal(result.components![0].userQuantity!.origin, 'estimated');
  assert.equal(result.components![0].source!.provider, 'usda-fdc');
  assert.match(result.assumptions.join(' '), /估计的数量/);
  assert.doesNotMatch(result.assumptions.join(' '), /菜品小计/);
  mealAnalysisSchema.parse(result);
  assert.equal(mealAnalysisSchema.safeParse({ ...result, status: 'estimated' }).success, false);
  const entered = calculateMealNutrition({ ...result, components: [{ ...result.components![0], userQuantity: { amount: 100, unit: 'g', origin: 'user' } }] }, nutritionDataset, 'user-quantity-v2');
  assert.equal(entered.status, 'estimated');
  assert.doesNotMatch(entered.assumptions.join(' '), /估计的数量/);
});

test('new estimated origins cannot make the legacy calculator publish exact status or change its old grams', () => {
  const input: MealAnalysis = { ...analysis(), estimateScope: 'consumed_intake', components: [{
    foodId: 'rice_white_long_grain_cooked', label: '熟米饭', grams: { min: 100, max: 100 },
    quantitySource: 'user', consumedFraction: { min: 1, max: 1 }, uncertainty: [],
    userQuantity: { amount: 250, unit: 'g', origin: 'estimated' },
  }] };
  const result = calculateMealNutrition(input, nutritionDataset, 'legacy');
  assert.equal(result.status, 'approximate');
  assert.deepEqual(result.calories, { min: 130, max: 130 });
  assert.deepEqual(result.components![0].grams, { min: 100, max: 100 });
  assert.deepEqual(result.components![0].userQuantity, { amount: 250, unit: 'g', origin: 'estimated' });
  mealAnalysisSchema.parse(result);
});

test('quantity provenance and subtotal assumptions stay inside saved schema limits for long source assumptions', () => {
  const base = { ...analysis([rawDish(), rawDish({ label: '蒸蛋', cookingMethod: '蒸' })]),
    assumptions: Array.from({ length: 80 }, (_, index) => `原始配方假设 ${index + 1}。`) };
  const rows = defaultRows(base);
  const result = buildMealReviewAnalysis(base, [rows[0], updateMealReviewRow(rows[1], { quantity: '' })]);
  assert.equal(result.assumptions.length, 80);
  assert.match(result.assumptions.join(' '), /估计的数量/);
  assert.match(result.assumptions.join(' '), /当前仅汇总.*其他菜品未计入/);
  mealAnalysisSchema.parse(result);
});

test('quantity origins, explicit clears and old missing-origin values survive backup roundtrip and replay', async () => {
  const base = analysis([rawDish(), rawDish({ label: '蒸蛋', cookingMethod: '蒸' }), rawDish({ label: '米饭', cookingMethod: '蒸煮' })]);
  const defaults = defaultRows(base);
  const saved = buildMealReviewAnalysis(base, [defaults[0], updateMealReviewRow(defaults[1], { quantity: '' }), updateMealReviewRow(defaults[2], { quantity: '50' })]);
  const old = analysis([rawDish({ userQuantity: { amount: 75, unit: 'g' } })]);
  const data = emptyData();
  data.meals.push({ id: 'estimated-meal', type: 'meal', createdAt: now, occurredAt: now, mealType: '午餐', foodName: '午餐',
    portion: '', note: '', source: 'photo', estimateStatus: 'unknown', analyses: [base, saved, old].map((item, index) => ({
      id: `analysis-${index}`, model: 'local/ai-per100g-v3', createdAt: now, sourceVersion: 1, analysis: item,
    })) });
  const restored = await parseBackupArchive(await createBackupArchive(data, [], now));
  assert.deepEqual(restored.data.meals[0].analyses!.map((version) => version.analysis), [base, saved, old]);
  const loaded = restored.data.meals[0].analyses![1].analysis;
  assert.equal(loaded.components![0].userQuantity!.origin, 'estimated');
  assert.equal(loaded.components![1].userQuantityCleared, true);
  assert.equal(loaded.components![2].userQuantity!.origin, 'user');
  assert.equal(Object.hasOwn(restored.data.meals[0].analyses![2].analysis.components![0].userQuantity!, 'origin'), false);
  const replayed = buildMealReviewAnalysis(loaded, applyEstimatedMealQuantities({}, '午餐', loaded, createMealReviewRows(loaded)));
  assert.deepEqual(replayed.calories, saved.calories);
  assert.equal(replayed.components![1].userQuantityCleared, true);
  const invalid = structuredClone(data);
  invalid.meals[0].analyses![1].analysis.components![0].userQuantity!.origin = 'photo' as 'estimated';
  await assert.rejects(createBackupArchive(invalid, [], now), (error) => error instanceof BackupError && error.code === 'invalid-data');
});

test('confirmation messages distinguish reference estimates, user input, partial subtotals and unknown nutrition', () => {
  const base = analysis();
  const estimated = buildMealReviewAnalysis(base, defaultRows(base));
  assert.match(mealReviewConfirmationMessage(estimated), /参考估计食用量.*四项营养/);
  assert.doesNotMatch(mealReviewConfirmationMessage(estimated), /尚未填写/);
  const user = buildMealReviewAnalysis(base, [updateMealReviewRow(defaultRows(base)[0], { quantity: '100' })]);
  assert.match(mealReviewConfirmationMessage(user), /填写的实际食用量/);
  const two = analysis([rawDish(), rawDish({ label: '蒸蛋', cookingMethod: '蒸' })]);
  const rows = defaultRows(two);
  const partial = buildMealReviewAnalysis(two, [rows[0], updateMealReviewRow(rows[1], { quantity: '' })]);
  assert.match(mealReviewConfirmationMessage(partial), /参考估计.*小计.*未计入：蒸蛋/);
  const mixed = buildMealReviewAnalysis(two, [rows[0], updateMealReviewRow(rows[1], { quantity: '100' })]);
  assert.match(mealReviewConfirmationMessage(mixed), /参考估计和填写的食用量.*四项营养/);
  const unknown = buildMealReviewAnalysis(base, [updateMealReviewRow(defaultRows(base)[0], {
    nutrients: draftNutrients(ranges), label: '新菜',
  })]);
  assert.equal(unknown.calories, null);
  assert.match(mealReviewConfirmationMessage(unknown), /营养参考未知/);
  const noCountedDishes = buildMealReviewAnalysis(two, [updateMealReviewRow(rows[0], {
    nutrients: { calories: { min: '', max: '' }, protein: { min: '', max: '' }, carbs: { min: '', max: '' }, fat: { min: '', max: '' } },
  }), updateMealReviewRow(rows[1], { quantity: '' })]);
  assert.equal(noCountedDishes.calories, null);
  assert.match(mealReviewConfirmationMessage(noCountedDishes), /营养参考未知.*鸡肉烩菜.*食用量为空：蒸蛋/);
  assert.doesNotMatch(mealReviewConfirmationMessage(noCountedDishes), /尚未填写实际食用量/);
});

test('whole-meal manual overrides accept preserved default quantities without weakening calculated intake status', () => {
  const base = analysis();
  const estimated = buildMealReviewAnalysis(base, defaultRows(base));
  assert.deepEqual(estimated.components![0].userQuantity, { amount: 315, unit: 'g', origin: 'estimated' });
  assert.deepEqual(estimated.calories, { min: 630, max: 630 });
  const before = structuredClone(estimated);
  const manual = createManualNutritionAnalysis(estimated, parseMealNutritionFields({
    calories: '700', protein: '40', carbs: '80', fat: '20',
  }), estimated.foodName, now);
  assert.equal(manual.status, 'estimated');
  assert.deepEqual(manual.calories, { min: 700, max: 700 });
  assert.deepEqual(manual.protein, { min: 40, max: 40 });
  assert.deepEqual(manual.carbs, { min: 80, max: 80 });
  assert.deepEqual(manual.fat, { min: 20, max: 20 });
  assert.deepEqual(manual.nutritionSource, { provider: 'manual', method: 'manual-total-v1', calculatedAt: now });
  assert.deepEqual(manual.components, estimated.components);
  assert.deepEqual(manual.coverage, estimated.coverage);
  assert.deepEqual(estimated, before);
  mealAnalysisSchema.parse(manual);
  const locallyValidated = validateMealRecognition(manual, { strict: false });
  assert.deepEqual(locallyValidated.components[0].userQuantity, estimated.components![0].userQuantity);
  assert.strictEqual(locallyValidated.components[0].source, manual.components![0].source);
  const recalculated = calculateShared({ ...manual, components: manual.components ?? [], unresolved: manual.unresolved ?? [] },
    undefined, { mode: 'ai-per100g-v3' });
  assert.equal(recalculated.status, 'approximate');
  assert.deepEqual(recalculated.calories, { min: 630, max: 630 });
  mealAnalysisSchema.parse(recalculated);
  assert.throws(() => validateMealRecognition(manual));
  assert.equal(mealAnalysisSchema.safeParse({ ...estimated, status: 'estimated' }).success, false);
  for (const nutritionSource of [
    { provider: 'model', method: 'manual-total-v1' },
    { provider: 'manual', method: 'reference-quantity-v1' },
    { provider: 'manual', method: 'unrelated-total' },
  ]) assert.equal(mealAnalysisSchema.safeParse({ ...manual, nutritionSource }).success, false);
});

test('manual overrides and cleared whole-meal totals roundtrip without changing default quantities or AI references', async () => {
  const base = analysis();
  const estimated = buildMealReviewAnalysis(base, defaultRows(base));
  const manual = createManualNutritionAnalysis(estimated, parseMealNutritionFields({
    calories: '700', protein: '40', carbs: '80', fat: '20',
  }), estimated.foodName, now);
  const cleared = createManualNutritionAnalysis(manual, parseMealNutritionFields(emptyMealNutritionFields()), manual.foodName, now);
  assert.equal(cleared.status, 'unknown');
  for (const key of ['calories', 'protein', 'carbs', 'fat'] as const) assert.equal(cleared[key], null);
  assert.deepEqual(cleared.components, estimated.components);
  assert.deepEqual(cleared.nutritionSource, manual.nutritionSource);
  const versions = [base, estimated, manual, cleared].map((item, index) => ({
    id: `manual-override-${index}`, model: item.nutritionSource?.provider === 'manual' ? 'local/manual-total-v1' : 'configured/vision-model',
    createdAt: now, sourceVersion: 1, analysis: item,
  }));
  const data = emptyData();
  data.meals.push({ id: 'manual-override-meal', type: 'meal', createdAt: now, occurredAt: now, mealType: '午餐',
    foodName: manual.foodName, portion: '', note: '', source: 'photo', estimateStatus: 'unknown', analyses: versions });
  const restored = await parseBackupArchive(await createBackupArchive(data, [], now));
  const loaded = restored.data.meals[0];
  assert.deepEqual(loaded.analyses!.map((version) => version.analysis), [base, estimated, manual, cleared]);
  const restoredManual = loaded.analyses![2].analysis;
  const restoredCleared = loaded.analyses![3].analysis;
  assert.deepEqual(nutritionFieldsFromMeal({ ...loaded, analyses: loaded.analyses!.slice(0, 3) }), {
    calories: '700', protein: '40', carbs: '80', fat: '20',
  });
  assert.deepEqual(nutritionFieldsFromMeal(loaded), emptyMealNutritionFields());
  for (const saved of [restoredManual, restoredCleared]) {
    assert.deepEqual(saved.components![0].userQuantity, { amount: 315, unit: 'g', origin: 'estimated' });
    assert.deepEqual(saved.components![0].source, estimated.components![0].source);
    const locallyValidated = validateMealRecognition(saved, { strict: false });
    assert.equal(locallyValidated.components[0].userQuantity!.origin, 'estimated');
  }
});
