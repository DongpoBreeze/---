import type { MealAnalysis, MealComponent, ModelNutritionEstimate, NutrientRange } from '../src/types';
export type { ModelNutritionEstimate } from '../src/types';

/** Raw model estimates are transient; normalized analyses persist component.source. */
export type MealRecognitionComponent = Omit<MealComponent, 'grams'> & {
  grams?: NutrientRange | null;
  nutritionEstimate?: ModelNutritionEstimate;
};
export type NutritionProvenance = { model: string; reasoningEffort?: string; createdAt: string };
export type NutritionCalculationOptions = {
  mode?: 'legacy' | 'user-quantity-v2' | 'ai-per100g-v3';
  provenance?: NutritionProvenance;
};

export type MealRecognition = {
  foodName: string;
  components: MealRecognitionComponent[];
  unresolved: string[];
  assumptions: string[];
  advice: string;
  confidence?: number;
  nutritionSource?: MealAnalysis['nutritionSource'];
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
export function validateModelNutritionEstimate(value: unknown): ModelNutritionEstimate;
export function mealRecognitionInstructions(stage?: 'whole' | 'crop_review' | 'final_merge', catalog?: Array<{ id: string; label: string; aliases?: string[]; preparation: string }>, categoryIds?: string[]): string;
export function hasMealIdentityConflict(component: Pick<MealComponent, 'foodId' | 'uncertainty' | 'candidates'>): boolean;
export function preservesMealComponents(previous: { components?: unknown[] } | undefined, next: { components?: unknown[] } | undefined): boolean;
export function calculateMealNutrition(value: MealRecognition, dataset: NutritionDataset | undefined, options?: NutritionCalculationOptions): MealAnalysis;
