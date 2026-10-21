import { mealAnalysisSchema } from './nutrition-schema';
import type { MealAnalysis, MealRecord, NutrientRange, NutrientRanges } from './types';

const nutrientKeys = ['calories', 'protein', 'carbs', 'fat'] as const;
const nutrientLabels = { calories: '热量', protein: '蛋白质', carbs: '碳水', fat: '脂肪' };
const rangePattern = /^(\d+(?:\.\d+)?|\.\d+)(?:\s*[～~-]\s*(\d+(?:\.\d+)?|\.\d+))?$/;

export type MealNutritionFields = Record<'calories' | 'protein' | 'carbs' | 'fat', string>;

export function emptyMealNutritionFields(): MealNutritionFields {
  return { calories: '', protein: '', carbs: '', fat: '' };
}

/** Expand scientific notation so every displayed value can be edited and parsed again. */
function decimalText(value: number): string {
  const text = String(value);
  if (!/[eE]/.test(text)) return text;
  const [coefficient, exponent] = text.split(/[eE]/);
  const [integer, fraction = ''] = coefficient.split('.');
  const digits = integer + fraction;
  const decimalPosition = integer.length + Number(exponent);
  if (decimalPosition <= 0) return `0.${'0'.repeat(-decimalPosition)}${digits}`;
  if (decimalPosition >= digits.length) return digits + '0'.repeat(decimalPosition - digits.length);
  return `${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
}

function rangeText(range: NutrientRange | null | undefined): string {
  if (!range) return '';
  return range.min === range.max ? decimalText(range.min) : `${decimalText(range.min)}～${decimalText(range.max)}`;
}

export function nutritionFieldsFromAnalysis(analysis?: MealAnalysis): MealNutritionFields {
  return Object.fromEntries(nutrientKeys.map((key) => [key, rangeText(analysis?.[key])])) as MealNutritionFields;
}

export function nutritionFieldsFromMeal(meal?: MealRecord): MealNutritionFields {
  // estimate is the legacy manual total, including records that also have a photo.
  if (meal?.estimate && meal.estimateStatus === 'estimated') {
    const estimate = meal.estimate;
    return Object.fromEntries(nutrientKeys.map((key) => [key, decimalText(estimate[key])])) as MealNutritionFields;
  }
  const latest = meal?.analyses?.filter((version) => version.sourceVersion === (meal.revision ?? 1)).at(-1);
  return nutritionFieldsFromAnalysis(latest?.analysis);
}

/** Empty totals mean unknown; partially entered or malformed totals must be corrected before saving. */
export function parseMealNutritionFields(fields: MealNutritionFields): NutrientRanges | null {
  const entries = nutrientKeys.map((key) => fields[key].trim());
  if (entries.every((value) => !value)) return null;
  if (entries.some((value) => !value)) throw new Error('营养值请完整填写四项，或全部留空表示未知。');
  return Object.fromEntries(nutrientKeys.map((key, index) => {
    const match = rangePattern.exec(entries[index]);
    const min = match ? Number(match[1]) : NaN;
    const max = match ? Number(match[2] ?? match[1]) : NaN;
    if (!Number.isFinite(min) || !Number.isFinite(max) || min > max)
      throw new Error(`${nutrientLabels[key]}请填写完整的非负数字或从小到大的区间，例如 350 或 300～400。`);
    return [key, { min, max }];
  })) as NutrientRanges;
}

export function equalMealNutritionRanges(left: NutrientRanges | null, right: NutrientRanges | null): boolean {
  if (left === null || right === null) return left === right;
  return nutrientKeys.every((key) => left[key].min === right[key].min && left[key].max === right[key].max);
}

/** A new whole-meal override leaves all dish references and quantities available for audit. */
export function createManualNutritionAnalysis(
  base: MealAnalysis | undefined,
  ranges: NutrientRanges | null,
  foodName: string,
  createdAt = new Date().toISOString(),
): MealAnalysis {
  return mealAnalysisSchema.parse({
    ...base,
    status: ranges ? 'estimated' : 'unknown',
    estimateScope: 'consumed_intake',
    foodName: foodName.trim() || base?.foodName || '餐食',
    ...Object.fromEntries(nutrientKeys.map((key) => [key, ranges ? { ...ranges[key] } : null])),
    assumptions: base?.assumptions ?? [],
    advice: ranges ? '营养为用户手动填写的整餐总量；原菜品与每 100 g 参考保留供核对，未按菜品重新求和。'
      : '用户已清空整餐营养，当前摄入未知；原菜品与每 100 g 参考保留供核对。',
    nutritionSource: { provider: 'manual', method: 'manual-total-v1', calculatedAt: createdAt },
  });
}

export function exactNutritionEstimate(ranges: NutrientRanges | null): MealRecord['estimate'] {
  if (!ranges || nutrientKeys.some((key) => ranges[key].min !== ranges[key].max)) return undefined;
  return Object.fromEntries(nutrientKeys.map((key) => [key, ranges[key].min])) as NonNullable<MealRecord['estimate']>;
}
