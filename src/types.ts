export type Goal = 'health' | 'fat-loss' | 'muscle-gain';

export type NutrientRange = { min: number; max: number };
export type NutrientValues = { calories: number | null; protein: number | null; carbs: number | null; fat: number | null };
export type MealCandidate = {
  foodId: string | null;
  label: string;
  confidence?: number;
  category?: string | null;
};
export type MealEvidence = string | {
  kind: 'visual' | 'user' | 'photo' | 'database' | 'inference' | 'unknown';
  text: string;
  confidence?: number;
};
export type MealRegion = { x: number; y: number; width: number; height: number };
export type MealEstimationBasis = string;
export type MealUserQuantity = { amount: number; unit: 'g' | 'household' };
export type MealHouseholdMeasure = { label: string; grams: number; approximate: boolean };
export type MealComponent = {
  foodId: string | null;
  label: string;
  grams: NutrientRange | null;
  /** User-entered amount for new analyses. Legacy photo-derived grams remain readable separately. */
  userQuantity?: MealUserQuantity | null;
  /** Locally curated household equivalent; never inferred from the photo. */
  householdMeasure?: MealHouseholdMeasure | null;
  eatenFraction?: NutrientRange | null;
  edibleFraction?: NutrientRange | null;
  quantitySource?: 'user' | 'visual' | 'unknown';
  consumedFraction?: NutrientRange | null;
  confidence?: number;
  category?: string | null;
  preparation?: string;
  cookingMethod?: string;
  candidates?: MealCandidate[];
  evidence?: MealEvidence[];
  region?: MealRegion | null;
  estimationBasis?: MealEstimationBasis | MealEstimationBasis[];
  /** Legacy spelling retained for imported records. */
  estimateBasis?: MealEstimationBasis | MealEstimationBasis[];
  uncertainty: string[];
  source?: {
    provider: 'usda-fdc' | 'local-category';
    fdcId?: string;
    dataset: string;
    categoryId?: string;
    sourceUrl?: string;
    description?: string;
    preparation?: string;
    householdMeasure?: MealHouseholdMeasure;
    per100g?: NutrientValues;
    per100gRange?: { calories: NutrientRange; protein: NutrientRange; carbs: NutrientRange; fat: NutrientRange };
  } | null;
};
export type NutritionSource = {
  provider: 'usda-fdc' | 'local-category' | 'mixed' | 'model' | 'manual';
  dataset?: string;
  calculatedAt?: string;
  sourceUrl?: string;
  archiveSha256?: string;
  license?: 'CC0-1.0';
  method?: string;
  coverage?: 'complete' | 'incomplete';
};
export type MealCoverage = {
  matched: number;
  total: number;
  unknownLabels: string[];
  counted?: number;
  missingQuantityLabels?: string[];
  unknownNutritionLabels?: string[];
};
export type MealAnalysis = {
  status: 'approximate' | 'estimated' | 'unknown';
  /** Added in v2; omitted by legacy analyses and filled by migration/defaults. */
  confidence?: number;
  estimateScope?: 'photo_serving' | 'consumed_intake';
  coverage?: MealCoverage;
  foodName: string;
  calories: NutrientRange | null;
  protein: NutrientRange | null;
  carbs: NutrientRange | null;
  fat: NutrientRange | null;
  assumptions: string[];
  advice: string;
  components?: MealComponent[];
  nutritionSource?: NutritionSource;
  unresolved?: string[];
};
export type AnalysisVersion = { id: string; model: string; createdAt: string; sourceVersion: number; stageCount?: number; analysis: MealAnalysis };

export type MealRecord = {
  id: string;
  type: 'meal';
  createdAt: string;
  occurredAt: string;
  mealType: '早餐' | '午餐' | '晚餐' | '加餐';
  foodName: string;
  portion: string;
  note: string;
  imageUri?: string;
  imageBase64?: string;
  afterImageUri?: string;
  remaining?: string;
  revision?: number;
  updatedAt?: string;
  timezone?: string;
  revisions?: Omit<MealRecord, 'revisions'>[];
  analyses?: AnalysisVersion[];
  source: 'manual' | 'photo' | 'ai';
  estimate?: { calories: number; protein: number; carbs: number; fat: number };
  estimateStatus: 'estimated' | 'unknown';
};

export type ExerciseSet = { reps: number; weight: number; unit: 'kg' | 'lb'; isWarmup?: boolean };

export type TrainingRecord = {
  id: string;
  type: 'training';
  createdAt: string;
  occurredAt: string;
  exercise: string;
  sets: ExerciseSet[];
  note: string;
  pain: 'yes' | 'no' | 'unknown';
  controlled: 'yes' | 'no' | 'unknown';
  rir: '0' | '1' | '2' | '3' | '4+' | 'unknown';
  videoUri?: string;
  mode?: 'strength' | 'cardio';
  durationMinutes?: number;
  targetSets?: number;
  targetMin?: number;
  targetMax?: number;
  increment?: number;
  weightBasis?: 'total' | 'per-hand' | 'bodyweight';
  updatedAt?: string;
  timezone?: string;
};

export type SleepRecord = {
  id: string;
  type: 'sleep';
  createdAt: string;
  occurredAt: string;
  fellAsleepAt: string;
  wokeAt: string;
  awakeMinutes: number | null;
  quality: 1 | 2 | 3 | 4 | 5;
  note: string;
  updatedAt?: string;
  timezone?: string;
};

export type DailySummary = {
  id: string;
  date: string;
  markdown: string;
  sourceVersion: number;
  status: 'current' | 'stale';
  createdAt: string;
  source?: 'local' | 'ai';
  model?: string;
  sourceRecordIds?: string[];
  inputSnapshot?: {
    date: string;
    profile: Profile;
    summary: string;
    recordVersions: { id: string; version: string }[];
  };
};

export type Profile = { goal?: Goal; heightCm?: number; weightKg?: number; calorieTarget?: number };

export type AppData = {
  version: 1;
  profile: Profile;
  meals: MealRecord[];
  trainings: TrainingRecord[];
  sleeps: SleepRecord[];
  summaries: DailySummary[];
  sourceVersion: number;
  drafts?: { meal?: Partial<MealRecord>; training?: Partial<TrainingRecord>; sleep?: Partial<SleepRecord> };
};

export const emptyData = (): AppData => ({
  version: 1,
  profile: {},
  meals: [],
  trainings: [],
  sleeps: [],
  summaries: [],
  sourceVersion: 0,
});
