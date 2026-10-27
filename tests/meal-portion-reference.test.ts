import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateMealPortion, hasIncompleteMealRecognition } from '../src/meal-portion-reference';
import { applyEstimatedMealQuantities, buildMealReviewAnalysis, createMealReviewRows, updateMealReviewRow } from '../src/meal-review';
import type { MealAnalysis, MealComponent, MealRecord, NutrientRange, NutrientRanges, Profile } from '../src/types';

const nutrients = (min = 120, max = 160): NutrientRanges => ({
  calories: { min, max }, protein: { min: 3, max: 8 }, carbs: { min: 10, max: 25 }, fat: { min: 1, max: 7 },
});
const dish = (overrides: Partial<MealComponent> = {}): MealComponent => ({
  foodId: null, label: '鸡肉烩饭', grams: null, recommendedShare: 1, uncertainty: [],
  source: { provider: 'model', basisGrams: 100, method: 'typical_recipe', per100gRange: nutrients(),
    recipeBasis: '通常成品配方', assumptions: ['油量未知'], confidence: 0.8,
    model: 'configured/model', generatedAt: '2026-10-20T00:00:00.000Z' },
  ...overrides,
});
const meal = (components: MealComponent[] = [dish()], changes: Partial<MealAnalysis> = {}): MealAnalysis => ({
  status: 'unknown', foodName: '午餐', calories: null, protein: null, carbs: null, fat: null,
  assumptions: [], advice: '按实际情况调整。', components, ...changes,
});
const ready = (profile: Profile = { calorieTarget: 2000 }, mealType: MealRecord['mealType'] = '午餐', analysis: MealAnalysis = meal()) => {
  const result = estimateMealPortion(profile, mealType, analysis);
  assert.equal(result.status, 'ready', result.reason);
  assert.ok(result.dailyCalories && result.mealCalories && result.totalGrams);
  assert.equal(result.reason, undefined);
  return result;
};
const unavailable = (profile: Profile, analysis: MealAnalysis | null, pattern: RegExp) => {
  const result = estimateMealPortion(profile, '午餐', analysis);
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason ?? '', pattern);
  assert.equal(result.totalGrams, null);
  assert.deepEqual(result.dishes, []);
  return result;
};

test('valid body weight scales the general adult product interval when height is unavailable', () => {
  const result = ready({ weightKg: 70 });
  assert.deepEqual(result.dailyCalories, { min: 1750, max: 2450 });
  assert.deepEqual(result.mealCalories, { min: 612, max: 858 });
  assert.deepEqual(result.totalGrams, { min: 382, max: 715 });
  assert.equal(result.weightKg, 70);
  assert.equal(result.basis, 'body-weight');
  const assumptions = result.assumptions.join(' ');
  assert.match(assumptions, /25–35 kcal\/kg\/day/);
  assert.match(assumptions, /尚无有效身高.*体重 70 kg/);
  assert.match(assumptions, /一般成人.*不代表照片重量或称重实测/);
  const withHeight = ready({ heightCm: 170, weightKg: 70 });
  assert.deepEqual(withHeight.dailyCalories, { min: 1629, max: 2282 });
  assert.deepEqual(withHeight.mealCalories, { min: 570, max: 799 });
  assert.deepEqual(withHeight.totalGrams, { min: 356, max: 666 });
  assert.equal(withHeight.basis, 'body-size');
  assert.equal(withHeight.weightKg, 70, "the returned weight remains the user's actual profile value");
  assert.match(withHeight.assumptions.join(' '), /身高 170 cm 与体重 70 kg（BMI 24\.2）.*BMI 22.*25%/);
  assert.deepEqual(ready({ heightCm: 230, weightKg: 70 }).dailyCalories, result.dailyCalories,
    'height outside the supported range falls back to the explicit weight-only estimate');
  assert.deepEqual(ready({ weightKg: 60 }).dailyCalories, { min: 1500, max: 2100 });
  assert.deepEqual(ready({ weightKg: 90 }).dailyCalories, { min: 2250, max: 3150 });
});

test('height and weight together change the meal recommendation through the BMI reference weight', () => {
  const shorter = ready({ heightCm: 170, weightKg: 70 });
  const taller = ready({ heightCm: 190, weightKg: 70 });
  assert.deepEqual(taller.dailyCalories, { min: 1750, max: 2450 });
  assert.equal(taller.basis, 'body-size');
  assert.notDeepEqual(shorter.totalGrams, taller.totalGrams);
  assert.match(shorter.assumptions.join(' '), /BMI 高于 24.*BMI 22.*差值的 25%/);
  assert.match(taller.assumptions.join(' '), /BMI 不高于 24，按实际体重估算/);

  const heavier = ready({ heightCm: 170, weightKg: 100 });
  assert.deepEqual(heavier.dailyCalories, { min: 1817, max: 2544 });
  assert.match(heavier.assumptions.join(' '), /折算估算体重约 72\.7 kg/);
});

test('an absent valid weight uses a visible 60 kg general adult fallback even with height alone', () => {
  for (const profile of [{}, { heightCm: 170 }, { heightCm: Infinity }]) {
    const result = ready(profile);
    assert.equal(result.basis, 'general-adult');
    assert.equal(result.weightKg, 60);
    assert.deepEqual(result.dailyCalories, { min: 1500, max: 2100 });
    assert.deepEqual(result.mealCalories, { min: 525, max: 735 });
    assert.match(result.assumptions.join(' '), /尚无有效体重.*一般成人 60 kg/);
  }
});

test('unknown age retains the existing adult portion arithmetic and adult sex or age do not personalize it', () => {
  for (const profile of [{}, { weightKg: 70 }, { calorieTarget: 2000 }]) {
    const previous = ready(profile);
    assert.match(previous.assumptions.join(' '), /年龄未填写 · 成人参考/);
    for (const ageYears of [18, 30, 64]) for (const sex of ['male', 'female'] as const) {
      const current = ready({ ...profile, sex, ageYears });
      assert.deepEqual(current.dailyCalories, previous.dailyCalories);
      assert.deepEqual(current.totalGrams, previous.totalGrams);
      assert.deepEqual(current.dishes, previous.dishes);
      assert.match(current.assumptions.join(' '), /年龄仅用于判断适用范围/);
    }
  }
});

test('minor, older-adult and invalid age block adult portions before any target, body-weight or 60 kg fallback', () => {
  for (const ageYears of [1, 17, 65, 120, 0, -1, 17.5, 121, NaN, Infinity, '18', null]) {
    for (const facts of [{}, { weightKg: 70 }, { calorieTarget: 2000, weightKg: 70 }]) {
      const profile = { ...facts, ageYears } as unknown as Profile;
      const result = unavailable(profile, meal(), /未成年|老年|年龄/);
      assert.equal(result.dailyCalories, null);
      assert.equal(result.mealCalories, null);
      assert.equal(result.weightKg, undefined);
      assert.equal(result.basis, undefined);
      assert.match(result.reason!, /逐菜填写食用量/);
    }
  }
});

test('inapplicable age never fills new dish quantities and leaves saved or manual quantities and local nutrition usable', () => {
  const analysis = freezeDeep(meal([dish(), dish({ label: '原已填写菜', userQuantity: { amount: 125, unit: 'g', origin: 'user' } })], {
    advice: '按实际情况填写食用量。', unresolved: [],
  }));
  const original = structuredClone(analysis);
  for (const ageYears of [17, 65, NaN]) {
    const rows = createMealReviewRows(analysis);
    const blocked = applyEstimatedMealQuantities({ ageYears, calorieTarget: 2100 }, '午餐', analysis, rows);
    assert.equal(blocked[0].quantity, '');
    assert.equal(blocked[1].quantity, '125');
    const filled = [updateMealReviewRow(blocked[0], { quantity: '100' }), blocked[1]];
    const local = buildMealReviewAnalysis(analysis, filled);
    assert.equal(local.components![0].userQuantity!.amount, 100);
    assert.equal(local.components![0].userQuantity!.origin, 'user');
    assert.equal(local.components![1].userQuantity!.amount, 125);
    assert.deepEqual(local.calories, { min: 270, max: 360 });
    assert.deepEqual(analysis, original);
  }
});

test('an explicit valid daily target wins even without usable body data and goals do not alter energy', () => {
  for (const goal of ['health', 'fat-loss', 'muscle-gain'] as const) {
    const result = ready({ goal, calorieTarget: 2000, heightCm: Infinity, weightKg: -5 });
    assert.deepEqual(result.dailyCalories, { min: 2000, max: 2000 });
    assert.deepEqual(result.mealCalories, { min: 700, max: 700 });
    assert.deepEqual(result.totalGrams, { min: 437, max: 584 });
    assert.match(result.assumptions.join(' '), /已填写的每日热量目标/);
    assert.equal(result.basis, 'daily-target');
    assert.equal(result.weightKg, undefined);
    assert.doesNotMatch(result.assumptions.join(' '), /Mifflin-St Jeor/);
  }
  assert.deepEqual(ready({ calorieTarget: 2000 }).totalGrams, ready({ calorieTarget: 2000, heightCm: 190, weightKg: 100 }).totalGrams);
});

test('each meal type uses its reference share of daily calories', () => {
  for (const [mealType, calories] of [['早餐', 500], ['午餐', 700], ['晚餐', 600], ['加餐', 200]] as const) {
    const result = ready({ calorieTarget: 2000 }, mealType);
    assert.deepEqual(result.mealCalories, { min: calories, max: calories });
    assert.match(result.assumptions.join(' '), /早餐 25%.*午餐 35%.*晚餐 30%.*加餐 10%/);
  }
  assert.equal(estimateMealPortion({ calorieTarget: 2000 }, '宵夜' as MealRecord['mealType'], meal()).status, 'unavailable');
});

test('AI-proposed shares are normalized and used instead of local food-role rules', () => {
  const result = ready({ calorieTarget: 2000 }, '午餐', meal([
    dish({ label: '意面', recommendedShare: 0.6667, userNutritionPer100g: nutrients(100, 140) }),
    dish({ label: '沙拉', recommendedShare: 0.3333, userNutritionPer100g: nutrients(200, 260) }),
  ]));
  // Relative AI shares normalize to 2:1. Weighted density is 133.33–180
  // kcal/100 g, so the meal is 388–525 g overall.
  assert.deepEqual(result.totalGrams, { min: 388, max: 526 });
  assert.deepEqual(result.dishes, [
    { index: 0, label: '意面', share: 0.6667 / 1, grams: { min: 258, max: 351 } },
    { index: 1, label: '沙拉', share: 0.3333 / 1, grams: { min: 129, max: 176 } },
  ]);
  assert.match(result.assumptions.join(' '), /各菜相对食用量份额由 AI.*本次识别到的完整菜品组合/);
  const denser = ready({ calorieTarget: 2000 }, '午餐', meal([dish({ userNutritionPer100g: nutrients(300, 400) })]));
  assert.deepEqual(denser.totalGrams, { min: 175, max: 234 });
});

test('duplicate identified dishes block automatic portions to avoid counting one dish twice', () => {
  const result = estimateMealPortion({ calorieTarget: 2000 }, '午餐', meal([
    dish({ label: '熟米饭', cookingMethod: '蒸煮', recommendedShare: 0.5 }),
    dish({ label: ' 熟 米饭 ', cookingMethod: ' 蒸煮 ', recommendedShare: 0.5 }),
  ]));
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reviewMayHelp, true);
  assert.match(result.reason ?? '', /重复/);
  assert.deepEqual(result.dishes, []);
  assert.equal(estimateMealPortion({ calorieTarget: 2000 }, '午餐', meal([
    dish({ label: '鱼', cookingMethod: '蒸', recommendedShare: 0.5 }),
    dish({ label: '鱼', cookingMethod: '煎', recommendedShare: 0.5 }),
  ])).status, 'ready');
});

test('AI can recommend different Chinese meal shares from each dish identity', () => {
  const point = nutrients(200, 200);
  const result = ready({ calorieTarget: 2000 }, '午餐', meal([
    dish({ label: '饭', recommendedShare: 0.4, userNutritionPer100g: point }),
    dish({ label: '青椒炒五花肉', recommendedShare: 0.2, userNutritionPer100g: point }),
    dish({ label: '腌萝卜配菜', recommendedShare: 0.3, userNutritionPer100g: point }),
    dish({ label: '卤鸡蛋', recommendedShare: 0.1, userNutritionPer100g: point }),
  ]));
  assert.deepEqual(result.totalGrams, { min: 350, max: 351 });
  assert.deepEqual(result.dishes.map((item) => item.grams), [
    { min: 139, max: 141 }, { min: 69, max: 71 },
    { min: 104, max: 106 }, { min: 34, max: 36 },
  ]);
});

test('low-confidence AI shares still yield an editable estimate; missing shares never get a local fallback', () => {
  const uncertain = dish({ recommendedShare: 0.6, confidence: 0.2, uncertainty: ['份量组合把握较低，按常见搭配尽力估计。'] });
  const other = dish({ label: '另一道菜', recommendedShare: 0.4 });
  const base = meal([uncertain, other]);
  const filled = applyEstimatedMealQuantities({ calorieTarget: 2000 }, '午餐', base, createMealReviewRows(base));
  assert.ok(filled.every((row) => Number(row.quantity) > 0));

  const missing = meal([uncertain, { ...other, recommendedShare: undefined }]);
  const unavailableResult = estimateMealPortion({ calorieTarget: 2000 }, '午餐', missing);
  assert.equal(unavailableResult.status, 'unavailable');
  assert.match(unavailableResult.reason ?? '', /AI未给出完整.*份额建议/);
  const missingRows = createMealReviewRows(missing);
  const preserved = applyEstimatedMealQuantities({ calorieTarget: 2000 }, '午餐', missing,
    [updateMealReviewRow(missingRows[0], { quantity: '120' }), missingRows[1]]);
  assert.equal(preserved[0].quantity, '120');
  assert.equal(preserved[1].quantity, '');
});

test('AI shares keep rounded nutrient and portion intervals conservative', () => {
  const result = ready({ heightCm: 172.3, weightKg: 67.4 }, '早餐', meal([
    dish({ label: '鸡肉烩饭', userNutritionPer100g: nutrients(111.1, 155.5) }),
    dish({ label: '蒸米饭', userNutritionPer100g: nutrients(222.2, 277.7) }),
    dish({ label: '清炒青菜', userNutritionPer100g: nutrients(166.6, 199.9) }),
  ]));
  assert.ok(result.dailyCalories!.min <= 25 * 67.4);
  assert.ok(result.dailyCalories!.max >= 35 * 67.4);
  assert.ok(result.mealCalories!.min <= result.dailyCalories!.min * 0.25);
  assert.ok(result.mealCalories!.max >= result.dailyCalories!.max * 0.25);
  const minGrams = result.mealCalories!.min / ((155.5 + 277.7 + 199.9) / 3) * 100;
  const maxGrams = result.mealCalories!.max / ((111.1 + 222.2 + 166.6) / 3) * 100;
  assert.ok(result.totalGrams!.min <= minGrams);
  assert.ok(result.totalGrams!.max >= maxGrams);
  for (const item of result.dishes) {
    assert.ok(item.grams.min <= minGrams / 3);
    assert.ok(item.grams.max >= maxGrams / 3);
  }
});

test('user references override model and stale snapshots, with or without an original source', () => {
  for (const overrides of [{}, { nutritionReferenceStale: true }, { source: null }] satisfies Partial<MealComponent>[]) {
    const result = ready({ calorieTarget: 2000 }, '午餐', meal([dish({ ...overrides, userNutritionPer100g: nutrients(200, 250) })]));
    assert.deepEqual(result.totalGrams, { min: 280, max: 350 });
  }
  unavailable({ calorieTarget: 2000 }, meal([dish({ userNutritionPer100g: null })]), /营养未知或不完整/);
  unavailable({ calorieTarget: 2000 }, meal([dish({ nutritionReferenceStale: true })]), /旧营养参考已失效/);
});

test('complete local point and range references can be used without consulting a food database', () => {
  for (const source of [
    { provider: 'usda-fdc', dataset: 'local snapshot', per100g: { calories: 200, protein: 10, carbs: 25, fat: 7 } },
    { provider: 'local-category', dataset: 'local category', per100gRange: nutrients(200, 200) },
  ] satisfies NonNullable<MealComponent['source']>[]) {
    assert.deepEqual(ready({ calorieTarget: 2000 }, '午餐', meal([dish({ source })])).totalGrams, { min: 350, max: 350 });
  }
});

test('unknown, omitted, partial and invalid per-100g nutrients never become zeros or partial meal recommendations', () => {
  const invalid: Array<Partial<MealComponent>> = [
    { source: null },
    { source: { provider: 'usda-fdc', dataset: 'partial', per100g: { calories: 200, protein: null, carbs: 25, fat: 7 } } },
    { userNutritionPer100g: { ...nutrients(), protein: undefined } as unknown as NutrientRanges },
    { userNutritionPer100g: { ...nutrients(), fat: null } as unknown as NutrientRanges },
    { userNutritionPer100g: nutrients(200, 100) },
    { userNutritionPer100g: nutrients(-1, 100) },
    { userNutritionPer100g: nutrients(100, Infinity) },
    { userNutritionPer100g: nutrients(100, NaN) },
    { userNutritionPer100g: nutrients(900, 901) },
    { userNutritionPer100g: { ...nutrients(), fat: { min: 0, max: 101 } } },
    { userNutritionPer100g: { ...nutrients(), protein: { min: 80, max: 90 }, carbs: { min: 30, max: 40 } } },
  ];
  for (const changes of invalid) {
    const result = unavailable({ calorieTarget: 2000 }, meal([dish(), dish({ ...changes, label: '未确认菜' })]), /未确认菜.*营养未知或不完整/);
    assert.deepEqual(result.mealCalories, { min: 700, max: 700 });
  }
});

test('identity conflicts veto even user nutrition while pure quantity or recipe uncertainty does not', () => {
  const conflicts: Partial<MealComponent>[] = [
    { uncertainty: ['菜品身份待确认。'] },
    { foodId: 'rice', candidates: [{ foodId: 'rice', label: '米饭', confidence: 0.6 }, { foodId: 'egg', label: '鸡蛋', confidence: 0.55 }] },
    { foodId: 'rice', candidates: [{ foodId: 'rice', label: '米饭' }, { foodId: 'egg', label: '鸡蛋' }] },
    { foodId: 'rice', candidates: [{ foodId: 'egg', label: '鸡蛋', confidence: 0.95 }, { foodId: 'rice', label: '米饭', confidence: 0.1 }] },
  ];
  for (const conflict of conflicts)
    unavailable({ calorieTarget: 2000 }, meal([dish({ ...conflict, userNutritionPer100g: nutrients() })]), /身份尚未确认/);
  ready({ calorieTarget: 2000 }, '午餐', meal([dish({ uncertainty: ['照片没有比例尺，重量未知。', '烹调油用量未知。'] })], {
    unresolved: ['重量未知。', '实际食用比例未知。'],
  }));
});

test('missing component records and unresolved dishes block the full meal while missing actual quantities do not', () => {
  const components = [dish()];
  for (const changes of [
    { coverage: { matched: 1, total: 2, unknownLabels: [] } },
    { coverage: { matched: 1, total: 1, unknownLabels: ['漏掉的主食'] } },
    { coverage: { matched: 1, total: 1, unknownLabels: [], unknownNutritionLabels: ['未记录的汤'] } },
    { unresolved: ['还有一道菜未识别。'] },
    { unresolved: ['菜品有遗漏。'] },
    { unresolved: ['主食不完整。'] },
    { unresolved: ['Unidentified food behind the bowl.'] },
  ] satisfies Partial<MealAnalysis>[]) unavailable({ calorieTarget: 2000 }, meal(components, changes), /遗漏或记录不完整/);
  const noQuantities = meal(components, {
    coverage: { matched: 1, total: 1, counted: 0, referenceCount: 1, unknownLabels: [], unknownNutritionLabels: [], missingQuantityLabels: ['鸡肉烩饭'] },
    nutritionSource: { provider: 'model', method: 'ai-per100g-v3', coverage: 'incomplete' },
  });
  ready({ calorieTarget: 2000 }, '午餐', noQuantities);
  // Effective user corrections take precedence over an old aggregate coverage snapshot too.
  ready({ calorieTarget: 2000 }, '午餐', meal([dish({ source: null, userNutritionPer100g: nutrients() })], {
    coverage: { matched: 0, total: 1, unknownLabels: ['鸡肉烩饭'], unknownNutritionLabels: ['鸡肉烩饭'] },
  }));
});

test('public recognition completeness flags explicit omissions even with complete dish references and totals', () => {
  const components = [dish({ label: '米饭', userQuantity: { amount: 100, unit: 'g', origin: 'user' } }),
    dish({ label: '鸡肉烩菜', userQuantity: { amount: 100, unit: 'g', origin: 'user' } })];
  const complete = meal(components, { status: 'approximate', ...nutrients(240, 320),
    coverage: { matched: 2, total: 2, counted: 2, referenceCount: 2,
      unknownLabels: [], unknownNutritionLabels: [], missingQuantityLabels: [] } });
  assert.equal(hasIncompleteMealRecognition(complete), false);
  for (const unresolved of [['还有一道主食未识别。'], ['菜品有遗漏。'], ['Unidentified food behind the bowl.']])
    assert.equal(hasIncompleteMealRecognition({ ...complete, unresolved }), true);
  for (const coverage of [
    { ...complete.coverage!, unknownLabels: ['漏掉的汤'] },
    { ...complete.coverage!, unknownNutritionLabels: ['未记录的主食'] },
  ]) assert.equal(hasIncompleteMealRecognition({ ...complete, coverage }), true);
});

test('public recognition completeness flags absent records and counts that disagree with the dish list', () => {
  const components = [dish({ label: '米饭' }), dish({ label: '肉菜' })];
  for (const total of [0, 1, 3, 2.5]) assert.equal(hasIncompleteMealRecognition(meal(components, {
    coverage: { matched: 0, total, unknownLabels: [] },
  })), true);
  for (const incomplete of [meal([]), meal(undefined, { components: undefined }), meal([dish({ label: ' ' })]),
    meal(Array.from({ length: 21 }, (_, index) => dish({ label: `菜品 ${index + 1}` })))])
    assert.equal(hasIncompleteMealRecognition(incomplete), true);
});

test('public recognition completeness keeps a normal reference-only meal complete without actual quantities', () => {
  const components = [dish({ label: '米饭' }), dish({ label: '肉菜' })];
  const noQuantities = meal(components, {
    coverage: { matched: 2, total: 2, counted: 0, referenceCount: 2,
      unknownLabels: [], unknownNutritionLabels: [], missingQuantityLabels: ['米饭', '肉菜'] },
    nutritionSource: { provider: 'model', method: 'ai-per100g-v3', coverage: 'incomplete' },
  });
  assert.equal(hasIncompleteMealRecognition(noQuantities), false);
  assert.equal(hasIncompleteMealRecognition(meal(components)), false);
  assert.equal(hasIncompleteMealRecognition(meal(components, {
    coverage: { matched: 0, total: 2, counted: 0, unknownLabels: ['米饭', '肉菜'], unknownNutritionLabels: ['米饭', '肉菜'] },
  })), false);
});

test('public recognition completeness is read-only and oil, salt or quantity uncertainty does not imply a missing dish', () => {
  const complete = freezeDeep(meal([dish({ uncertainty: ['烹调油和盐用量未知。'] })], {
    unresolved: ['烹调油和盐用量未知。', '无法从照片确认酱汁用量。', '实际食用量尚未填写。'],
  }));
  const before = JSON.stringify(complete);
  assert.equal(hasIncompleteMealRecognition(complete), false);
  assert.equal(JSON.stringify(complete), before);
});

test('absent analyses and incomplete dishes remain unavailable', () => {
  for (const analysis of [null, meal([]), meal([dish({ label: ' ' })]), meal(undefined, { components: undefined })])
    unavailable({ calorieTarget: 2000 }, analysis, /完整菜品|遗漏或记录不完整/);
});

test('invalid or extreme filled profile values are explicitly excluded from the fallback', () => {
  for (const weightKg of [0, -1, 29.9, 250.1, Infinity, NaN, '70', null]) {
    const result = ready({ heightCm: 170, weightKg } as unknown as Profile);
    assert.equal(result.basis, 'general-adult');
    assert.equal(result.weightKg, 60);
    assert.deepEqual(result.dailyCalories, { min: 1500, max: 2100 });
    assert.match(result.assumptions.join(' '), /体重不在.*30–250 kg.*未采用异常数值.*60 kg/);
  }
  for (const calorieTarget of [0, -100, 799, 6001, Infinity, NaN]) {
    const fallback = ready({ calorieTarget, weightKg: 70 });
    assert.deepEqual(fallback.dailyCalories, { min: 1750, max: 2450 });
    assert.equal(fallback.basis, 'body-weight');
    assert.match(fallback.assumptions.join(' '), /每日热量目标不在.*未采用该数值/);
    const general = ready({ calorieTarget });
    assert.equal(general.basis, 'general-adult');
    assert.deepEqual(general.dailyCalories, { min: 1500, max: 2100 });
  }
});

test('very low or zero energy density and recommendations over 2000 g are refused rather than clipped', () => {
  for (const range of [{ min: 0, max: 0 }, { min: 0, max: 150 }, { min: 20, max: 60 }, { min: 49.9, max: 70 }])
    unavailable({ calorieTarget: 2000 }, meal([dish({ label: '青菜汤', userNutritionPer100g: nutrients(range.min, range.max) })]), /热量密度.*手动填写/);
  unavailable({ calorieTarget: 6000 }, meal([dish({ userNutritionPer100g: nutrients(50, 100) })]), /超过 2000 g/);
  const boundary = ready({ calorieTarget: 4000 }, '早餐', meal([dish({ userNutritionPer100g: nutrients(50, 50) })]));
  assert.deepEqual(boundary.totalGrams, { min: 2000, max: 2000 });
});

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}

test('photo grams, actual quantities, eaten fractions and old meal totals do not participate in AI-share recommendations', () => {
  const baseline = ready();
  const profile = freezeDeep({ calorieTarget: 2000, heightCm: 170, weightKg: 70 });
  const analysis = freezeDeep(meal([dish({
    grams: { min: 3, max: 99_999 }, quantitySource: 'visual', userQuantity: { amount: 99_999, unit: 'household' },
    consumedFraction: { min: 0, max: 0.1 }, eatenFraction: { min: 0.5, max: 1 }, edibleFraction: { min: 0.1, max: 0.2 },
    householdMeasure: { label: '夸大的旧份数', grams: 99_999, approximate: true },
  })], { calories: { min: 999_999, max: 999_999 }, protein: { min: 999, max: 999 }, status: 'estimated' }));
  const before = JSON.stringify({ profile, analysis });
  const result = ready(profile, '午餐', analysis);
  assert.deepEqual(result.totalGrams, baseline.totalGrams);
  assert.deepEqual(result.dishes, baseline.dishes);
  assert.equal(JSON.stringify({ profile, analysis }), before);
  // Returned per-dish objects do not alias one another or caller-owned data.
  const two = ready(profile, '午餐', meal([dish({ label: '鸡肉烩饭' }), dish({ label: '蒸米饭' })]));
  two.dishes[0].grams.min = -1;
  assert.notEqual(two.dishes[1].grams.min, -1);
  assert.notEqual(analysis.components![0].source?.per100gRange?.calories.min, -1);
});
