import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateMealNutrition } from '../shared/nutrition.mjs';
import { createBackupArchive, parseBackupArchive } from '../src/backup';
import { localDate, mealCalories, summaryMarkdown } from '../src/domain';
import {
  createManualNutritionAnalysis, emptyMealNutritionFields, equalMealNutritionRanges, exactNutritionEstimate,
  nutritionFieldsFromAnalysis, nutritionFieldsFromMeal, parseMealNutritionFields, type MealNutritionFields,
} from '../src/meal-nutrition-fields';
import { mealAnalysisSchema } from '../src/nutrition-schema';
import { emptyData, type AnalysisVersion, type MealAnalysis, type MealRecord, type NutrientRanges } from '../src/types';

const now = '2026-10-20T04:00:00.000Z';
const nutrientKeys = ['calories', 'protein', 'carbs', 'fat'] as const;
const fields: MealNutritionFields = { calories: '650', protein: '40.25', carbs: '80', fat: '18.5' };
const manualRanges: NutrientRanges = {
  calories: { min: 1000.123456, max: 1400.987654 }, protein: { min: 110, max: 125.5 },
  carbs: { min: 150, max: 175 }, fat: { min: 105, max: 115 },
};

function aiAnalysis(quantified = true): MealAnalysis {
  return mealAnalysisSchema.parse(calculateMealNutrition({
    foodName: '鸡肉烩菜', components: [{
      foodId: null, label: '鸡肉烩菜', uncertainty: ['油量无法从照片确认。'],
      userQuantity: quantified ? { amount: 250, unit: 'g' } : null,
      nutritionEstimate: {
        basisGrams: 100, method: 'typical_recipe',
        per100g: { calories: { min: 120, max: 160 }, protein: { min: 8, max: 12 },
          carbs: { min: 20, max: 25 }, fat: { min: 4, max: 8 } },
        recipeBasis: '按鸡肉、蔬菜与少量酱汁的典型成品配方估计，油已计入。',
        assumptions: ['油量包含在区间内。'], confidence: 0.75,
      },
    }], unresolved: [], assumptions: [], advice: '填写实际食用数量。',
  }, undefined, { mode: 'ai-per100g-v3', provenance: { model: 'configured/vision-model', reasoningEffort: 'max', createdAt: now } }));
}

function version(id: string, analysis: MealAnalysis, sourceVersion = 1): AnalysisVersion {
  return { id, model: analysis.nutritionSource?.provider === 'manual' ? 'local/manual-total-v1' : 'configured/vision-model',
    createdAt: now, sourceVersion, analysis };
}

function meal(changes: Partial<MealRecord> = {}): MealRecord {
  return { id: 'meal', type: 'meal', createdAt: now, occurredAt: now, mealType: '午餐', foodName: '鸡肉烩菜',
    portion: '', note: '', source: 'photo', estimateStatus: 'unknown', revision: 1, ...changes };
}

test('empty totals remain unknown while explicit zeros and complete decimal ranges are retained', () => {
  assert.equal(parseMealNutritionFields(emptyMealNutritionFields()), null);
  assert.equal(parseMealNutritionFields({ calories: ' ', protein: '\t', carbs: '\n', fat: '' }), null);
  assert.deepEqual(parseMealNutritionFields({ calories: ' 0 ', protein: ' .25 ', carbs: '1.125', fat: '000.50' }), {
    calories: { min: 0, max: 0 }, protein: { min: 0.25, max: 0.25 }, carbs: { min: 1.125, max: 1.125 }, fat: { min: 0.5, max: 0.5 },
  });
  assert.deepEqual(parseMealNutritionFields({ calories: ' 1000.125 ～ 2000.875 ', protein: '100.5 ~ 200.25',
    carbs: '300 - 400', fat: '150.75-150.75' }), {
    calories: { min: 1000.125, max: 2000.875 }, protein: { min: 100.5, max: 200.25 },
    carbs: { min: 300, max: 400 }, fat: { min: 150.75, max: 150.75 },
  });
});

test('whole-meal values are not constrained by per-100g nutrient limits', () => {
  assert.deepEqual(parseMealNutritionFields({ calories: '1000.123456～1400.987654', protein: '110～125.5',
    carbs: '150～175', fat: '105～115' }), manualRanges);
});

test('partial totals retain supplied values while missing optional nutrients stay null', () => {
  const complete = parseMealNutritionFields(fields)!;
  for (const key of nutrientKeys) {
    assert.deepEqual(parseMealNutritionFields({ ...fields, [key]: '' }), { ...complete, [key]: null });
    assert.deepEqual(parseMealNutritionFields({ ...fields, [key]: ' ' }), { ...complete, [key]: null });
  }
  assert.deepEqual(parseMealNutritionFields({ ...emptyMealNutritionFields(), calories: '350～450' }), {
    calories: { min: 350, max: 450 }, protein: null, carbs: null, fat: null,
  });
  assert.deepEqual(parseMealNutritionFields({ ...emptyMealNutritionFields(), fat: '0' }), {
    calories: null, protein: null, carbs: null, fat: { min: 0, max: 0 },
  });
});

test('malformed supplied totals cannot silently become unknown or truncated numbers', () => {
  for (const key of nutrientKeys) {
    for (const invalid of ['NaN', 'Infinity', '-Infinity', '-1', '-0', '+1', '1e3', '1E-3', '1.', '.',
      '1～', '～2', '1--2', '1-2-3', '2～1', '1 ~ -2', '1,000', '100 kcal', '0x10', '1_000', '1 / 2',
      '1 to 2', '1 2', '1～NaN', '9'.repeat(400)]) {
      assert.throws(() => parseMealNutritionFields({ ...fields, [key]: invalid }), `${key}: ${invalid}`);
    }
  }
});

test('editable analysis values preserve all recorded precision and null stays blank', () => {
  const base = aiAnalysis();
  const analysis: MealAnalysis = { ...base, calories: { min: 123.45678901234567, max: 987.6543210987654 },
    protein: { min: 0.123456789012345, max: 0.123456789012345 }, carbs: null, fat: { min: 0, max: 0 } };
  assert.deepEqual(nutritionFieldsFromAnalysis(analysis), {
    calories: '123.45678901234567～987.6543210987654', protein: '0.123456789012345', carbs: '', fat: '0',
  });
  assert.deepEqual(nutritionFieldsFromAnalysis(), emptyMealNutritionFields());
  assert.deepEqual(nutritionFieldsFromAnalysis(aiAnalysis(false)), emptyMealNutritionFields());
});

test('editing very small or large stored numbers round-trips without exponent notation or rounding', () => {
  const ranges: NutrientRanges = { calories: { min: 1e21, max: 1.2345678901234568e25 },
    protein: { min: 1e-7, max: 1.2345678901234567e-7 }, carbs: { min: Number.MIN_VALUE, max: 1e-8 },
    fat: { min: Number.MAX_VALUE, max: Number.MAX_VALUE } };
  const displayed = nutritionFieldsFromAnalysis({ ...aiAnalysis(), ...ranges });
  assert.equal(displayed.calories.startsWith('1000000000000000000000～'), true);
  assert.equal(displayed.protein, '0.0000001～0.00000012345678901234566');
  for (const value of Object.values(displayed)) assert.doesNotMatch(value, /[eE]/);
  assert.deepEqual(parseMealNutritionFields(displayed), ranges);
});

test('an active legacy manual estimate takes precedence even when a record has AI history and a photo', () => {
  const estimate = { calories: 650.12345, protein: 40.25, carbs: 80, fat: 0 };
  const record = meal({ estimate, estimateStatus: 'estimated', analyses: [version('ai', aiAnalysis())] });
  assert.deepEqual(nutritionFieldsFromMeal(record), { calories: '650.12345', protein: '40.25', carbs: '80', fat: '0' });
  assert.deepEqual(nutritionFieldsFromMeal({ ...record, estimateStatus: 'unknown' }), nutritionFieldsFromAnalysis(record.analyses![0].analysis));
});

test('meal fields isolate revisions and use the latest current result, including an explicit unknown', () => {
  const ai = aiAnalysis();
  const manual = createManualNutritionAnalysis(ai, manualRanges, '鸡肉烩菜', now);
  const cleared = createManualNutritionAnalysis(manual, null, '鸡肉烩菜', now);
  const current = version('manual', manual, 2);
  const record = meal({ revision: 2, analyses: [version('old', ai), current, version('late-old-result', ai)] });
  assert.deepEqual(nutritionFieldsFromMeal(record), nutritionFieldsFromAnalysis(manual));
  assert.deepEqual(nutritionFieldsFromMeal(meal({ revision: 2, analyses: [version('old-only', ai)] })), emptyMealNutritionFields());
  assert.deepEqual(nutritionFieldsFromMeal({ ...record, analyses: [...record.analyses!, version('cleared', cleared, 2)] }), emptyMealNutritionFields());
  assert.deepEqual(nutritionFieldsFromMeal(meal({ revision: undefined, analyses: [version('legacy-revision', ai)] })), nutritionFieldsFromAnalysis(ai));
  assert.deepEqual(nutritionFieldsFromMeal(), emptyMealNutritionFields());
});

test('manual totals preserve AI dish snapshots and pass schema despite incomplete dish coverage', () => {
  const base = aiAnalysis(false);
  const original = structuredClone(base);
  const analysis = createManualNutritionAnalysis(base, manualRanges, '手动记录的午餐', now);
  assert.equal(analysis.status, 'estimated');
  assert.equal(analysis.foodName, '手动记录的午餐');
  assert.deepEqual(analysis.calories, manualRanges.calories);
  assert.deepEqual(analysis.nutritionSource, { provider: 'manual', method: 'manual-total-v1', calculatedAt: now });
  assert.deepEqual(analysis.coverage, base.coverage);
  assert.equal(analysis.coverage?.counted, 0);
  assert.deepEqual(analysis.components, base.components);
  assert.equal(analysis.components?.[0].grams, null);
  assert.equal(analysis.components?.[0].source?.provider, 'model');
  assert.match(analysis.advice, /整餐总量/);
  assert.deepEqual(base, original);
  assert.deepEqual(mealAnalysisSchema.parse(analysis), analysis);
});

test('clearing previously quantified AI totals produces a portable explicit unknown override', () => {
  const base = aiAnalysis();
  assert.deepEqual(base.calories, { min: 300, max: 400 });
  const cleared = createManualNutritionAnalysis(base, null, base.foodName, now);
  assert.equal(cleared.status, 'unknown');
  for (const key of nutrientKeys) assert.equal(cleared[key], null);
  assert.deepEqual(cleared.components, base.components);
  assert.deepEqual(cleared.coverage, base.coverage);
  assert.equal(cleared.nutritionSource?.method, 'manual-total-v1');
  assert.deepEqual(mealAnalysisSchema.parse(cleared), cleared);
  assert.deepEqual(nutritionFieldsFromMeal(meal({ analyses: [version('ai', base), version('clear', cleared)] })), emptyMealNutritionFields());
});

test('a manual analysis works without an AI base and snapshots the supplied ranges', () => {
  const ranges = structuredClone(manualRanges);
  const before = Date.now();
  const analysis = createManualNutritionAnalysis(undefined, ranges, '午餐');
  const after = Date.now();
  assert.deepEqual(mealAnalysisSchema.parse(analysis), analysis);
  assert.equal(analysis.components, undefined);
  assert.equal(analysis.nutritionSource?.provider, 'manual');
  const createdAt = Date.parse(analysis.nutritionSource!.calculatedAt!);
  assert.ok(createdAt >= before && createdAt <= after);
  ranges.calories.min = 0;
  assert.deepEqual(analysis.calories, manualRanges.calories);
  const unknown = createManualNutritionAnalysis(undefined, null, '午餐', now);
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.components, undefined);
  for (const key of nutrientKeys) assert.equal(unknown[key], null);
});

test('backup retains original AI provenance, manual totals and an explicit clearing version', async () => {
  const ai = aiAnalysis();
  const manual = createManualNutritionAnalysis(ai, manualRanges, ai.foodName, now);
  const cleared = createManualNutritionAnalysis(manual, null, ai.foodName, now);
  const original = meal({ id: 'manual', analyses: [version('original-ai', ai), version('manual-total', manual)] });
  const clearedMeal = meal({ id: 'cleared', analyses: [...original.analyses!, version('cleared-total', cleared)] });
  const parsed = await parseBackupArchive(await createBackupArchive({ ...emptyData(), meals: [original, clearedMeal] }, [], now));
  assert.deepEqual(parsed.data.meals, [original, clearedMeal]);
  const restoredManual = parsed.data.meals[0].analyses!.at(-1)!.analysis;
  const restoredCleared = parsed.data.meals[1].analyses!.at(-1)!.analysis;
  assert.deepEqual(restoredManual.components?.[0].source, ai.components?.[0].source);
  assert.deepEqual(restoredCleared.components?.[0].source, ai.components?.[0].source);
  assert.deepEqual(nutritionFieldsFromMeal(parsed.data.meals[0]), nutritionFieldsFromAnalysis(manual));
  assert.deepEqual(nutritionFieldsFromMeal(parsed.data.meals[1]), emptyMealNutritionFields());
  assert.deepEqual(mealCalories(parsed.data.meals[0]), manualRanges.calories);
  assert.equal(mealCalories(parsed.data.meals[1]), null);
});

test('calorie aggregation uses a whole-meal manual version independently of dish quantities', () => {
  const ai = aiAnalysis(false);
  const manual = createManualNutritionAnalysis(ai, manualRanges, ai.foodName, now);
  const record = meal({ analyses: [version('reference-only', ai), version('whole-meal-manual', manual)] });
  assert.deepEqual(mealCalories(record), manualRanges.calories);
  assert.equal(mealCalories({ ...record, revision: 2 }), null);
});

test('partial manual totals survive backup, reopening and calorie aggregation without filling gaps', async () => {
  for (const supplied of [{ calories: '350～450' }, { protein: '20.5', fat: '0' }]) {
    const entered = { ...emptyMealNutritionFields(), ...supplied };
    const ranges = parseMealNutritionFields(entered)!;
    const analysis = createManualNutritionAnalysis(undefined, ranges, '手动午餐', now);
    assert.equal(analysis.status, 'estimated');
    assert.deepEqual(exactNutritionEstimate(ranges), undefined);
    const record = meal({ source: 'manual', analyses: [version('partial-manual', analysis)] });
    const parsed = await parseBackupArchive(await createBackupArchive({ ...emptyData(), meals: [record] }, [], now));
    assert.deepEqual(parsed.data.meals[0], record);
    assert.deepEqual(nutritionFieldsFromMeal(parsed.data.meals[0]), entered);
    assert.deepEqual(mealCalories(parsed.data.meals[0]), ranges.calories);
    const summary = summaryMarkdown(parsed.data, localDate(now));
    assert.match(summary, /午餐：鸡肉烩菜/);
    assert.doesNotMatch(summary, /剩余：|备注：|未知|未填写|数量记录完整或无已识别菜品/);
    for (const key of nutrientKeys) assert.deepEqual(analysis[key], ranges[key]);
    assert.match(analysis.advice, /仅汇总已填写项目/);
  }
});

test('range equality compares numeric bounds, and exact estimates never collapse uncertainty', () => {
  const ranges = parseMealNutritionFields(fields)!;
  assert.equal(equalMealNutritionRanges(ranges, parseMealNutritionFields({ ...fields, calories: '650～650' })), true);
  assert.equal(equalMealNutritionRanges(ranges, { ...ranges, fat: { min: 18.5, max: 18.51 } }), false);
  assert.equal(equalMealNutritionRanges(null, null), true);
  assert.equal(equalMealNutritionRanges(null, ranges), false);
  assert.equal(equalMealNutritionRanges(ranges, null), false);
  assert.equal(equalMealNutritionRanges({ ...ranges, fat: null }, { ...ranges, fat: null }), true);
  assert.equal(equalMealNutritionRanges({ ...ranges, fat: null }, ranges), false);
  assert.equal(equalMealNutritionRanges(ranges, { ...ranges, fat: null }), false);
  assert.deepEqual(exactNutritionEstimate(ranges), { calories: 650, protein: 40.25, carbs: 80, fat: 18.5 });
  assert.equal(exactNutritionEstimate({ ...ranges, protein: { min: 40.25, max: 40.3 } }), undefined);
  assert.equal(exactNutritionEstimate(manualRanges), undefined);
  assert.equal(exactNutritionEstimate(null), undefined);
  assert.equal(exactNutritionEstimate({ ...ranges, fat: null }), undefined);
});
