import type { MealAnalysis, MealComponent, NutrientRange } from './types';
import { calculateMealNutrition as calculateSharedMealNutrition } from '../shared/nutrition.mjs';

export type CatalogFood = {
  id: string;
  label: string;
  aliases?: string[];
  description: string;
  fdcId: string;
  preparation: string;
  per100g: { calories: number | null; protein: number | null; carbs: number | null; fat: number | null };
};

export type NutritionDataset = {
  provider: 'usda-fdc';
  dataset: string;
  sourceUrl: string;
  archiveSha256: string;
  license: 'CC0-1.0';
  foods: CatalogFood[];
  categories: Record<string, { calories: NutrientRange; protein: NutrientRange; carbs: NutrientRange; fat: NutrientRange }>;
  aliases: Record<string, string>;
  householdMeasures?: Record<string, { label: string; grams: number; approximate: boolean }>;
};

export type CorrectionComponent = Omit<MealComponent, 'grams' | 'consumedFraction' | 'uncertainty'> & {
  grams: NutrientRange | null;
  consumedFraction: NutrientRange | null;
  uncertainty: string[];
};

const usdaDataset: Omit<NutritionDataset, 'categories' | 'aliases'> = require('../data/nutrition/usda-sr-legacy.json');
const categoryData = require('../data/nutrition/category-ranges.json');
export const nutritionDataset: NutritionDataset = { ...usdaDataset, categories: categoryData.categories, aliases: categoryData.aliases, householdMeasures: categoryData.householdMeasures };
export const nutritionCategories = Object.entries(nutritionDataset.categories).map(([id, ranges]) => ({ id,
  per100gRange: ranges, aliases: Object.entries(nutritionDataset.aliases).filter(([, category]) => category === id).map(([alias]) => alias) }));

export function catalogFoods(): CatalogFood[] { return nutritionDataset.foods; }

export function searchCatalogFoods(query: string, limit = 8): CatalogFood[] {
  const normalized = query.normalize('NFKC').trim().toLocaleLowerCase();
  return nutritionDataset.foods.filter((food) =>
    `${food.label} ${food.aliases?.join(' ') ?? ''} ${food.description} ${food.preparation}`
      .normalize('NFKC').toLocaleLowerCase().includes(normalized)).slice(0, limit);
}

export function correctionComponent(food: CatalogFood | null, label: string): CorrectionComponent {
  return { foodId: food?.id ?? null, label: label || food?.label || '未匹配食材', grams: null, quantitySource: 'unknown', consumedFraction: null, uncertainty: food ? [] : ['食材未匹配到 USDA 目录。'] };
}

export async function calculateMealNutrition(recognition: MealAnalysis, dataset: NutritionDataset = nutritionDataset, mode: 'legacy' | 'user-quantity-v2' = 'legacy'): Promise<MealAnalysis> {
  const input = {
    foodName: recognition.foodName,
    components: (recognition.components ?? []).map(({ source: _source, eatenFraction: _eaten, edibleFraction: _edible, ...component }) => ({ ...component, quantitySource: component.quantitySource ?? 'unknown', consumedFraction: component.consumedFraction ?? null })),
    unresolved: recognition.unresolved ?? [],
    assumptions: recognition.assumptions,
    advice: recognition.advice,
    ...(recognition.estimateScope === undefined ? {} : { estimateScope: recognition.estimateScope }),
    ...(recognition.confidence === undefined ? {} : { confidence: recognition.confidence }),
  };
  return calculateSharedMealNutrition(input, dataset, { mode });
}
