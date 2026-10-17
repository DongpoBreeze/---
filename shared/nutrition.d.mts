import type { MealAnalysis, MealComponent } from '../src/types';

export type MealRecognition = {
  foodName: string;
  components: MealComponent[];
  unresolved: string[];
  assumptions: string[];
  advice: string;
  confidence?: number;
};
export type NutritionDataset = {
  provider: string;
  dataset: string;
  sourceUrl: string;
  archiveSha256: string;
  license: string;
  foods: Array<{ id: string; fdcId: string; label: string; aliases?: string[]; description: string; preparation: string;
    per100g: { calories: number | null; protein: number | null; carbs: number | null; fat: number | null } }>;
  categories?: Record<string, { calories: { min: number; max: number }; protein: { min: number; max: number }; carbs: { min: number; max: number }; fat: { min: number; max: number } }>;
  aliases?: Record<string, string>;
  householdMeasures?: Record<string, { label: string; grams: number; approximate: boolean }>;
};
export function validateMealRecognition(value: unknown, options?: { strict?: boolean }): MealRecognition;
export function hasMealIdentityConflict(component: Pick<MealComponent, 'foodId' | 'uncertainty' | 'candidates'>): boolean;
export function calculateMealNutrition(value: MealRecognition, dataset: NutritionDataset, options?: { mode?: 'legacy' | 'user-quantity-v2' }): MealAnalysis;
