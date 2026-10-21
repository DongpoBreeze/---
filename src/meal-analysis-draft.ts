import { z } from 'zod';
import { mealAnalysisSchema, mealComponentSchema } from './nutrition-schema';
import { buildMealReviewAnalysis, type MealReviewRow } from './meal-review';
import { createManualNutritionAnalysis, exactNutritionEstimate, nutritionFieldsFromAnalysis, parseMealNutritionFields, type MealNutritionFields } from './meal-nutrition-fields';
import type { MealRecord } from './types';
import type { PhotoAnalysisResult, PhotoAnalysisSnapshot } from './ui/app-types';

export type MealAnalysisDraft = {
  version: 1;
  /** The record against which this form was opened, not a new input revision. */
  base?: { id: string; revision: number };
  confirmed: PhotoAnalysisSnapshot | null;
  history: PhotoAnalysisSnapshot[];
  preserveEstimatedQuantities: boolean;
  review: {
    result: PhotoAnalysisSnapshot;
    rows: MealReviewRow[];
    note: string;
    mainNote: string;
    status: string;
    pending: boolean;
  } | null;
};

const string = z.string();
const timestamp = z.iso.datetime({ offset: true }).refine((value) => Number.isFinite(Date.parse(value)), 'invalid timestamp');
// The legacy analysis parser supplies missing historical defaults. Require the
// actual status first so a corrupt draft cannot turn into an effective unknown.
const draftAnalysis = z.unknown().superRefine((value, ctx) => {
  if (!value || typeof value !== 'object' || !('status' in value)
    || !['approximate', 'estimated', 'unknown'].includes(String(value.status)))
    ctx.addIssue({ code: 'custom', message: 'invalid analysis status' });
}).pipe(mealAnalysisSchema);
const snapshotSchema = z.object({
  model: string.min(1).max(1000), createdAt: timestamp,
  stageCount: z.number().int().min(1).max(3).optional(), analysis: draftAnalysis,
}).strict();
const rangeText = z.object({ min: string.max(4000), max: string.max(4000) }).strict();
const rowSchema = z.object({
  id: string.min(1).max(256), component: mealComponentSchema,
  // Incomplete or invalid text remains editable; only confirmation parses it.
  label: string.max(4000), cookingMethod: string.max(4000), quantity: string.max(4000),
  quantityUnit: z.enum(['g', 'household']), quantityOrigin: z.enum(['estimated', 'user']).optional(),
  quantityEdited: z.boolean().optional(), nutritionEdited: z.boolean(),
  nutrients: z.object({ calories: rangeText, protein: rangeText, carbs: rangeText, fat: rangeText }).strict(),
}).strict();
export const mealAnalysisDraftSchema = z.object({
  version: z.literal(1),
  base: z.object({ id: string.min(1).max(256), revision: z.number().int().positive() }).strict().optional(),
  confirmed: snapshotSchema.nullable(), history: z.array(snapshotSchema),
  preserveEstimatedQuantities: z.boolean(),
  review: z.object({
    result: snapshotSchema, rows: z.array(rowSchema).max(20).refine((rows) => new Set(rows.map((row) => row.id)).size === rows.length, 'duplicate review row'),
    note: string, mainNote: string, status: string, pending: z.boolean(),
  }).strict().nullable(),
}).strict();

export function createMealAnalysisDraft(initial?: MealRecord): MealAnalysisDraft {
  return {
    version: 1,
    ...(initial ? { base: { id: initial.id, revision: initial.revision ?? 1 } } : {}),
    confirmed: null, history: [], review: null, preserveEstimatedQuantities: Boolean(initial),
  };
}

export function photoAnalysisSnapshot(result: PhotoAnalysisSnapshot): PhotoAnalysisSnapshot {
  return { model: result.model, createdAt: result.createdAt,
    ...(result.stageCount === undefined ? {} : { stageCount: result.stageCount }), analysis: result.analysis };
}

const formDraftSchema = z.object({
  occurredAt: string, mealType: z.enum(['早餐', '午餐', '晚餐', '加餐']), foodName: string,
  foodNameSource: z.enum(['analysis', 'user']).optional(), portion: string, note: string,
  imageUri: string.optional(), beforeImageUris: z.array(string), afterImageUri: string.optional(),
  remaining: string, calories: string, protein: string, carbs: string, fat: string,
  analysisDraft: mealAnalysisDraftSchema,
}).partial().passthrough();

/** Old flat form drafts keep their fields and inherit the saved record analysis. */
export function restoreMealFormDraft(value: unknown, initial?: MealRecord): Record<string, unknown> {
  const parsed = formDraftSchema.safeParse(value);
  if (!parsed.success) throw new Error(`餐食草稿校验失败：${parsed.error.issues[0]?.message ?? '字段不兼容'}；原草稿未清除`);
  const base = parsed.data.analysisDraft?.base;
  if (base) {
    const current = createMealAnalysisDraft(initial).base;
    if (!current || base.id !== current.id || base.revision !== current.revision)
      throw new Error('餐食记录版本已变更，原草稿保留，请重新核对');
  } else if (parsed.data.analysisDraft && initial) {
    throw new Error('餐食草稿与原记录不匹配，原草稿保留');
  }
  return parsed.data;
}

const sameSnapshot = (left: PhotoAnalysisSnapshot | undefined, right: PhotoAnalysisSnapshot) => left !== undefined
  && left.model === right.model && left.createdAt === right.createdAt && left.stageCount === right.stageCount
  && JSON.stringify(left.analysis) === JSON.stringify(right.analysis);

/** Keep raw/pending history before the effective version; only confirmation changes intake. */
export function prepareMealAnalysisForSave(
  state: MealAnalysisDraft,
  fields: MealNutritionFields & { foodName: string },
  initial?: MealRecord,
): { result?: PhotoAnalysisResult; estimate?: MealRecord['estimate'] } {
  const latest = initial?.analyses?.filter((version) => version.sourceVersion === (initial.revision ?? 1)).at(-1);
  const source = state.confirmed ?? (latest ? photoAnalysisSnapshot(latest)
    : state.review?.pending ? photoAnalysisSnapshot(state.review.result) : undefined);
  const versions = [...state.history];
  if (state.review?.pending) {
    // The recognition snapshot is the current result for a new, unconfirmed
    // meal. Keep only the user's unconfirmed edits in history, without storing
    // a duplicate copy of that same recognition event.
    const sourceIndex = source ? versions.findIndex((version) => sameSnapshot(version, source)) : -1;
    if (sourceIndex >= 0) versions.splice(sourceIndex, 1);
    try {
      const analysis = buildMealReviewAnalysis(state.review.result.analysis, state.review.rows);
      // A pending edit is audit history, never the effective final version.
      versions.push({ model: 'local/meal-review', createdAt: new Date().toISOString(), analysis });
    } catch { /* Invalid pending text stays in the persistent draft until a successful save. */ }
  }
  if (source && !sameSnapshot(versions.at(-1), source)) versions.push(source);
  const sourceFields = source ? nutritionFieldsFromAnalysis(source.analysis) : undefined;
  const unchanged = sourceFields && (['calories', 'protein', 'carbs', 'fat'] as const)
    .every((key) => fields[key].trim() === sourceFields[key]);
  let estimate: MealRecord['estimate'];
  let hasEffectiveVersion = Boolean(source);
  if (unchanged) {
    if (!state.confirmed && initial?.estimateStatus === 'estimated' && initial.estimate
      && (['calories', 'protein', 'carbs', 'fat'] as const).every((key) => fields[key].trim() === String(initial.estimate![key])))
      estimate = initial.estimate;
  } else {
    const ranges = parseMealNutritionFields(fields);
    estimate = source ? undefined : exactNutritionEstimate(ranges);
    hasEffectiveVersion ||= ranges !== null;
    if (source || ranges) {
      const createdAt = new Date().toISOString();
      versions.push({ model: 'local/manual-nutrition', createdAt,
        analysis: createManualNutritionAnalysis(source?.analysis, ranges, fields.foodName, createdAt) });
    }
  }
  const final = hasEffectiveVersion ? versions.at(-1) : undefined;
  return { estimate, ...(final ? { result: { ...final, history: versions.slice(0, -1) } } : {}) };
}
