import { z } from 'zod';

const text = (limit: number) => z.string().trim().min(1).max(limit);
const nonnegative = z.number().finite().nonnegative();
const positive = z.number().finite().positive();
const bounds = (maximum = Infinity) => z.object({ min: nonnegative.max(maximum), max: nonnegative.max(maximum) })
  .strict().refine((value) => value.max >= value.min, 'range is reversed');
const nutrientRange = bounds();
const fraction = bounds(1);
const nutrients = z.object({ calories: nonnegative.nullable(), protein: nonnegative.nullable(), carbs: nonnegative.nullable(), fat: nonnegative.nullable() }).strict();
const confidence = z.number().finite().min(0).max(1);
const candidate = z.object({
  foodId: text(128).nullable(), label: text(300), confidence: confidence.optional(), category: text(128).nullable().optional(),
}).strict();
const evidence = z.union([
  text(1000),
  z.object({ kind: z.enum(['visual', 'user', 'photo', 'database', 'inference', 'unknown']), text: text(1000), confidence: confidence.optional() }).strict(),
]);
const region = z.object({ x: nonnegative.max(1), y: nonnegative.max(1), width: nonnegative.max(1), height: nonnegative.max(1) }).strict()
  .refine((value) => value.x + value.width <= 1 && value.y + value.height <= 1, 'region is outside image');
const estimationBasis = z.union([z.enum(['user_weight', 'visual_portion', 'photo_serving', 'consumed_intake', 'usda_exact', 'category_range', 'unknown']), z.array(z.enum(['user_weight', 'visual_portion', 'photo_serving', 'consumed_intake', 'usda_exact', 'category_range', 'unknown'])).max(8)]);
const source = z.object({
  provider: z.enum(['usda-fdc', 'local-category']), fdcId: text(64).optional(), dataset: text(200), categoryId: text(128).optional(),
  sourceUrl: z.url().max(2000).optional(), description: text(1000).optional(),
  preparation: text(500).optional(), per100g: nutrients.optional(),
  per100gRange: z.object({ calories: nutrientRange, protein: nutrientRange, carbs: nutrientRange, fat: nutrientRange }).strict().optional(),
  householdMeasure: z.object({ label: text(100), grams: positive.max(100_000), approximate: z.boolean() }).strict().optional(),
}).strict().nullable().optional();

const householdMeasure = z.object({ label: text(100), grams: positive.max(100_000), approximate: z.boolean() }).strict();
const userQuantity = z.object({ amount: positive.max(100_000), unit: z.enum(['g', 'household']) }).strict();

export const mealComponentSchema = z.object({
  foodId: text(128).nullable(), label: text(300), grams: bounds(100_000).nullable(),
  userQuantity: userQuantity.nullable().optional(), householdMeasure: householdMeasure.nullable().optional(),
  quantitySource: z.enum(['user', 'visual', 'unknown']).optional(),
  consumedFraction: fraction.nullable().optional(),
  eatenFraction: fraction.nullable().optional(), edibleFraction: fraction.nullable().optional(),
  category: text(128).nullable().optional(),
  preparation: text(500).optional(), cookingMethod: text(500).optional(),
  confidence: confidence.optional(), candidates: z.array(candidate).max(20).optional(), evidence: z.array(evidence).max(40).optional(),
  region: region.nullable().optional(), estimationBasis: z.union([estimationBasis, text(500)]).optional(), estimateBasis: z.union([estimationBasis, text(500)]).optional(),
  uncertainty: z.array(text(500)).max(40), source,
}).strict().superRefine((value, ctx) => {
  if (value.quantitySource !== undefined && (value.grams === null) !== (value.quantitySource === 'unknown')) {
    ctx.addIssue({ code: 'custom', message: 'weight and quantity source disagree' });
  }
});

const nutritionSourceSchema = z.object({
  provider: z.enum(['usda-fdc', 'local-category', 'mixed', 'model', 'manual']), dataset: text(200).optional(),
  calculatedAt: z.iso.datetime().optional(), sourceUrl: z.url().max(2000).optional(),
  archiveSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  license: z.literal('CC0-1.0').optional(), method: text(200).optional(),
  coverage: z.enum(['complete', 'incomplete']).optional(),
}).strict();

const mealAnalysisObjectSchema = z.object({
  status: z.enum(['approximate', 'estimated', 'unknown']), confidence: confidence.optional(),
  estimateScope: z.enum(['photo_serving', 'consumed_intake']).optional(),
  coverage: z.object({ matched: z.number().int().nonnegative(), total: z.number().int().nonnegative(), unknownLabels: z.array(text(500)).max(100),
    counted: z.number().int().nonnegative().optional(), missingQuantityLabels: z.array(text(500)).max(100).optional(),
    unknownNutritionLabels: z.array(text(500)).max(100).optional() }).strict().refine((value) => value.matched <= value.total && (value.counted === undefined || value.counted <= value.total), 'coverage counts exceed total').optional(),
  foodName: text(500),
  calories: nutrientRange.nullable(), protein: nutrientRange.nullable(),
  carbs: nutrientRange.nullable(), fat: nutrientRange.nullable(),
  assumptions: z.array(text(1000)).max(80), advice: text(4000),
  components: z.array(mealComponentSchema).max(20).optional(),
  nutritionSource: nutritionSourceSchema.optional(), unresolved: z.array(text(1000)).max(100).optional(),
}).strict().superRefine((value, ctx) => {
  const totals = [value.calories, value.protein, value.carbs, value.fat];
  if (value.status === 'unknown' && totals.some((item) => item !== null)) {
    ctx.addIssue({ code: 'custom', message: 'unknown nutrition must have null totals' });
  }
  if (value.nutritionSource?.method === 'user-quantity-v2') {
    const provenance = value.nutritionSource;
    const hasUsda = provenance.provider === 'usda-fdc' || provenance.provider === 'mixed';
    const coverage = value.coverage;
    if (!['usda-fdc', 'local-category', 'mixed'].includes(provenance.provider) || !provenance.dataset
      || (hasUsda && (!provenance.sourceUrl || !provenance.archiveSha256 || !provenance.license)) || !provenance.coverage
      || !value.components || !value.unresolved || !coverage || coverage.counted === undefined
      || !coverage.missingQuantityLabels || !coverage.unknownNutritionLabels) {
      ctx.addIssue({ code: 'custom', message: 'user-quantity calculation provenance is incomplete' });
      return;
    }
    if (value.status === 'estimated' && (provenance.coverage !== 'complete' || coverage.counted !== coverage.total
      || coverage.missingQuantityLabels.length || coverage.unknownNutritionLabels.length || totals.some((item) => item === null))) {
      ctx.addIssue({ code: 'custom', message: 'complete user-quantity calculation has incomplete coverage' });
    }
    if (value.status === 'approximate' && (!totals.some((item) => item !== null) || coverage.counted === 0)) {
      ctx.addIssue({ code: 'custom', message: 'partial user-quantity calculation has no counted nutrients' });
    }
    if (value.status === 'unknown' && coverage.counted !== 0) {
      ctx.addIssue({ code: 'custom', message: 'unknown user-quantity calculation cannot include quantities' });
    }
    if (new Set([...coverage.missingQuantityLabels, ...coverage.unknownNutritionLabels]).size > coverage.total) {
      ctx.addIssue({ code: 'custom', message: 'user-quantity coverage labels exceed component count' });
    }
    for (const component of value.components) {
      if (component.userQuantity?.unit === 'household' && !component.householdMeasure) {
        ctx.addIssue({ code: 'custom', message: 'household quantity requires a local conversion' });
      }
    }
    return;
  }
  if (value.nutritionSource?.method !== 'ingredient-weight-v1') return;
  const provenance = value.nutritionSource;
  const hasUsda = provenance.provider === 'usda-fdc' || provenance.provider === 'mixed';
  if (!['usda-fdc', 'local-category', 'mixed'].includes(provenance.provider) || !provenance.dataset
    || (hasUsda && (!provenance.sourceUrl || !provenance.archiveSha256 || !provenance.license)) || !provenance.coverage
    || !value.components || !value.unresolved || !value.coverage) {
    ctx.addIssue({ code: 'custom', message: 'ingredient calculation provenance is incomplete' });
  }
  if (value.status === 'estimated' && provenance.coverage !== 'complete') {
    ctx.addIssue({ code: 'custom', message: 'nutrition status and coverage disagree' });
  }
  for (const component of value.components ?? []) {
    if (component.quantitySource === undefined || (value.estimateScope === 'consumed_intake' && component.consumedFraction === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'ingredient calculation fields are missing' });
    }
  }
  const hasCompleteReference = (component: z.infer<typeof mealComponentSchema>) => {
    const reference = component.source;
    if (!reference) return false;
    if (reference.provider === 'local-category') return Boolean(reference.per100gRange);
    return Boolean(reference.per100g && Object.values(reference.per100g).every((amount) => amount !== null));
  };
  if (value.status === 'approximate' && (!totals.some((item) => item !== null) || !value.components?.length
    || !value.coverage || value.coverage.total !== value.components.length || value.coverage.matched > value.coverage.total
    || !value.components.some((item) => item.grams && (value.estimateScope !== 'consumed_intake' || item.consumedFraction)
      && item.source && hasCompleteReference(item)))) {
    ctx.addIssue({ code: 'custom', message: 'approximate calculation has unresolved ingredients' });
  }
  if (value.status === 'unknown') return;
  if (value.status === 'estimated' && (totals.some((item) => item === null) || !value.components?.length || value.unresolved?.length
    || value.coverage?.matched !== value.coverage?.total || value.coverage?.unknownLabels.length !== 0
    || value.components.some((item) => !item.foodId || !item.grams || (value.estimateScope === 'consumed_intake' && !item.consumedFraction)
      || item.source?.provider !== 'usda-fdc' || !item.source.per100g || Object.values(item.source.per100g).some((amount) => amount === null)
      || item.source.dataset !== provenance.dataset))) {
    ctx.addIssue({ code: 'custom', message: 'complete calculation has unresolved ingredients' });
  }
});

/** Version-1 records omit these fields. Supply stable defaults during backup,
 * history and API parsing so the app can consume one normalized analysis shape. */
export const mealAnalysisSchema = z.preprocess((value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const input = value as Record<string, unknown>;
  const components = Array.isArray(input.components) ? input.components : [];
  const unknownLabels = components.flatMap((component) => {
    if (!component || typeof component !== 'object') return ['未标注食材'];
    const item = component as Record<string, any>;
    return item.foodId || item.category || item.source?.provider === 'local-category' ? [] : [typeof item.label === 'string' ? item.label : '未标注食材'];
  });
  const matched = components.length - unknownLabels.length;
  const status = input.status === 'approximate' || input.status === 'estimated' || input.status === 'unknown' ? input.status : 'unknown';
  return {
    ...input,
    confidence: input.confidence ?? (status === 'estimated' ? 1 : status === 'approximate' ? 0.5 : 0),
    ...((input.nutritionSource && typeof input.nutritionSource === 'object' && !Array.isArray(input.nutritionSource)
      && (input.nutritionSource as Record<string, unknown>).method === 'user-quantity-v2') ? {} : { estimateScope: input.estimateScope ?? 'consumed_intake' }),
    coverage: input.coverage ?? { matched, total: components.length, unknownLabels: [...new Set(unknownLabels)] },
  };
}, mealAnalysisObjectSchema);

/** Fill fields introduced after the original analysis format. This deliberately keeps
 * legacy status and nutrient fields unchanged while making the new contract explicit. */
export function migrateMealAnalysis(value: unknown): z.infer<typeof mealAnalysisSchema> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid meal analysis.');
  return mealAnalysisSchema.parse(value);
}

export const withMealAnalysisDefaults = migrateMealAnalysis;
