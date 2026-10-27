import { mealAnalysisSchema } from './nutrition-schema';
import type { MealAnalysis, MealRecord, NutrientRange } from './types';

const nutrientKeys = ['calories', 'protein', 'carbs', 'fat'] as const;
const nutrientLabels = { calories: '热量', protein: '蛋白质', carbs: '碳水', fat: '脂肪' };
const rangePattern = /^(\d+(?:\.\d+)?|\.\d+)(?:\s*[～~-]\s*(\d+(?:\.\d+)?|\.\d+))?$/;

export type MealNutritionFields = Record<'calories' | 'protein' | 'carbs' | 'fat', string>;
export type MealNutritionRanges = Record<keyof MealNutritionFields, NutrientRange | null>;

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

/** Each optional nutrient is independent; blank is unknown, never an inferred zero. */
export function parseMealNutritionFields(fields: MealNutritionFields): MealNutritionRanges | null {
  const entries = nutrientKeys.map((key) => fields[key].trim());
  if (entries.every((value) => !value)) return null;
  return Object.fromEntries(nutrientKeys.map((key, index) => {
    if (!entries[index]) return [key, null];
    const match = rangePattern.exec(entries[index]);
    const min = match ? Number(match[1]) : NaN;
    const max = match ? Number(match[2] ?? match[1]) : NaN;
    if (!Number.isFinite(min) || !Number.isFinite(max) || min > max)
      throw new Error(`${nutrientLabels[key]}请填写完整的非负数字或从小到大的区间，例如 350 或 300～400。`);
    return [key, { min, max }];
  })) as MealNutritionRanges;
}

export function equalMealNutritionRanges(left: MealNutritionRanges | null, right: MealNutritionRanges | null): boolean {
  if (left === null || right === null) return left === right;
  return nutrientKeys.every((key) => {
    const a = left[key], b = right[key];
    return a === null || b === null ? a === b : a.min === b.min && a.max === b.max;
  });
}

/** A new whole-meal override leaves all dish references and quantities available for audit. */
export function createManualNutritionAnalysis(
  base: MealAnalysis | undefined,
  ranges: MealNutritionRanges | null,
  foodName: string,
  createdAt = new Date().toISOString(),
): MealAnalysis {
  const hasValues = ranges !== null && nutrientKeys.some((key) => ranges[key] !== null);
  return mealAnalysisSchema.parse({
    ...base,
    status: hasValues ? 'estimated' : 'unknown',
    estimateScope: 'consumed_intake',
    foodName: foodName.trim() || base?.foodName || '餐食',
    ...Object.fromEntries(nutrientKeys.map((key) => [key, ranges?.[key] ? { ...ranges[key] } : null])),
    assumptions: base?.assumptions ?? [],
    advice: hasValues ? '营养为用户手动填写的整餐总量，仅汇总已填写项目；原菜品与每 100 g 参考保留供核对，未按菜品重新求和。'
      : '用户已清空整餐营养，当前摄入未知；原菜品与每 100 g 参考保留供核对。',
    nutritionSource: { provider: 'manual', method: 'manual-total-v1', calculatedAt: createdAt },
  });
}

export function exactNutritionEstimate(ranges: MealNutritionRanges | null): MealRecord['estimate'] {
  if (!ranges || nutrientKeys.some((key) => !ranges[key] || ranges[key]!.min !== ranges[key]!.max)) return undefined;
  return Object.fromEntries(nutrientKeys.map((key) => [key, ranges[key]!.min])) as NonNullable<MealRecord['estimate']>;
}
