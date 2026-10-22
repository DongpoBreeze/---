import type { MealAnalysis, MealComponent, MealHouseholdMeasure, ModelNutritionEstimate, NutrientRange, NutrientRanges, NutritionSource } from '../src/types';
export type { ModelNutritionEstimate } from '../src/types';

/** Raw model estimates are transient; normalized analyses persist component.source. */
export type MealRecognitionComponent = Omit<MealComponent, 'grams'> & {
  grams?: NutrientRange | null;
  nutritionEstimate?: ModelNutritionEstimate;
};
export type NutritionProvenance = { model: string; reasoningEffort?: string; createdAt: string };
export type MealPromptProfile = 'current' | 'concise' | 'frontend';
export type FrontendMealRecognition = {
  components: Array<{
    label: string;
    cookingMethod: string | null;
    confidence: number;
    nutritionEstimate: Omit<NonNullable<ModelNutritionEstimate>, 'basisGrams'> | null;
    uncertainty: string[];
  }>;
  uncertainty: string[];
};
export type NutritionCalculationOptions = {
  mode?: 'legacy' | 'user-quantity-v2' | 'ai-per100g-v3' | 'reference-quantity-v1';
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
/** Strict model input excludes local quantities, origins, explicit clears and saved reference metadata. */
export function validateMealRecognition(value: unknown, options?: { strict?: boolean }): MealRecognition;
export function validateModelNutritionEstimate(value: unknown): ModelNutritionEstimate;
export function validateFrontendMealRecognition(value: unknown): FrontendMealRecognition;
export function adaptFrontendMealRecognition(value: unknown): MealRecognition;
export function frontendMealRecognitionSnapshot(value: MealRecognition): FrontendMealRecognition;
export function frontendMealInput(value: Record<string, unknown>): Record<string, unknown>;
export function mealRecognitionInstructions(stage?: 'whole' | 'crop_review' | 'final_merge', catalog?: Array<{ id: string; label: string; aliases?: string[]; preparation: string }>, categoryIds?: string[], profile?: MealPromptProfile): string;
export function hasMealIdentityConflict(component: Pick<MealComponent, 'foodId' | 'uncertainty' | 'candidates'>): boolean;
/** Resolve only a curated local conversion; stale or ambiguous identities have none. */
export function resolveAiHouseholdMeasure(dataset: NutritionDataset | undefined, component: MealComponent): MealHouseholdMeasure | null;
/** Local overrides take precedence; a missing, stale or incomplete saved snapshot is unknown. */
export function resolveStoredNutritionReference(component: Pick<MealComponent, 'source' | 'nutritionReferenceStale' | 'userNutritionPer100g'>): NutrientRanges | null;
export function storedReferenceProvider(components: MealComponent[]): NutritionSource['provider'];
export function preservesMealComponents(previous: { components?: unknown[] } | undefined, next: { components?: unknown[] } | undefined, options?: { allowUncertainIdentityChanges?: boolean }): boolean;
export function calculateMealNutrition(value: MealRecognition, dataset: NutritionDataset | undefined, options?: NutritionCalculationOptions): MealAnalysis;
