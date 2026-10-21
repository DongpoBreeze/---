import { hasMealIdentityConflict } from '../shared/nutrition.mjs';
import type { MealAnalysis, MealComponent, MealRecord, NutrientRange, NutrientRanges, Profile } from './types';

export type MealPortionReference = {
  status: 'ready' | 'unavailable';
  reason?: string;
  weightKg?: number;
  basis?: 'daily-target' | 'body-weight' | 'general-adult';
  dailyCalories: { min: number; max: number } | null;
  mealCalories: { min: number; max: number } | null;
  totalGrams: { min: number; max: number } | null;
  dishes: Array<{ index: number; label: string; grams: { min: number; max: number } }>;
  assumptions: string[];
};

const mealPercent: Record<MealRecord['mealType'], number> = { 早餐: 25, 午餐: 35, 晚餐: 30, 加餐: 10 };
const nutrients = ['calories', 'protein', 'carbs', 'fat'] as const;
// These are limits on this general reference, not clinical definitions of a healthy body or diet.
const weightBounds = { min: 30, max: 250 };
const targetBounds = { min: 800, max: 6000 };
const adultReferenceWeightKg = 60;
const minimumEnergyDensity = 50;
const maximumMealGrams = 2000;

function within(value: unknown, bounds: NutrientRange): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= bounds.min && value <= bounds.max;
}

function outward(min: number, max: number): NutrientRange {
  return { min: Math.floor(min), max: Math.ceil(max) };
}

function validRanges(value: unknown): value is NutrientRanges {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const ranges = value as Record<string, NutrientRange | null | undefined>;
  if (!nutrients.every((key) => {
    const range = ranges[key];
    return range && within(range.min, { min: 0, max: key === 'calories' ? 900 : 100 })
      && within(range.max, { min: range.min, max: key === 'calories' ? 900 : 100 });
  })) return false;
  return ranges.protein!.min + ranges.carbs!.min + ranges.fat!.min <= 100;
}

function effectiveReference(component: MealComponent): NutrientRanges | null {
  // An explicit unknown never falls back to the old snapshot. A new user reference can replace a stale one.
  if (component.userNutritionPer100g !== undefined)
    return validRanges(component.userNutritionPer100g) ? component.userNutritionPer100g : null;
  const source = component.source;
  if (component.nutritionReferenceStale || !source) return null;
  if (source.provider === 'model' && source.basisGrams !== 100) return null;
  if (source.per100gRange !== undefined) return validRanges(source.per100gRange) ? source.per100gRange : null;
  if (source.provider !== 'usda-fdc' && source.provider !== 'local-category') return null;
  const values = source.per100g;
  if (!values || !nutrients.every((key) => typeof values[key] === 'number' && Number.isFinite(values[key]))) return null;
  const reference = Object.fromEntries(nutrients.map((key) => [key, { min: values[key], max: values[key] }]));
  return validRanges(reference) ? reference : null;
}

function incompleteMeal(analysis: MealAnalysis, components: MealComponent[]): boolean {
  const coverage = analysis.coverage;
  if (coverage && (!Number.isInteger(coverage.total) || coverage.total !== components.length)) return true;
  // Aggregate counts often exclude dishes solely because actual quantities are blank. Those counts
  // must not veto a preparation reference. Named dishes absent from the component list are different.
  const labels = new Set(components.map((component) => component.label.trim()));
  if ([...(coverage?.unknownLabels ?? []), ...(coverage?.unknownNutritionLabels ?? [])]
    .some((label) => !labels.has(label.trim()))) return true;
  return (analysis.unresolved ?? []).some((issue) =>
    /遗漏|漏识别|漏掉|未识别|未辨认|无法(?:识别|辨认)|(?:菜品|食材|主食|成分).*(?:不完整|不全|身份不明)|缺少.*(?:菜品|食材|主食|成分)|(?:missing|unidentified|unrecognized|incomplete).*(?:dish|ingredient|food)|(?:dish|ingredient|food).*(?:missing|unidentified|unrecognized|incomplete)/iu.test(issue));
}

/** Recognition completeness only; quantity and recipe uncertainty are separate checks. */
export function hasIncompleteMealRecognition(analysis: MealAnalysis): boolean {
  const components = analysis.components;
  return !components?.length || components.length > 20
    || components.some((component) => !component.label.trim()) || incompleteMeal(analysis, components);
}

/** General adult quantity estimate; independent of photo weight or measured intake. */
export function estimateMealPortion(profile: Profile, mealType: MealRecord['mealType'], analysis: MealAnalysis | null): MealPortionReference {
  const assumptions = ['仅供一般成人食用量估计，克数指可食用成品，不代表照片重量或称重实测，也不保证膳食均衡。'];
  let dailyCalories: NutrientRange | null = null;
  let mealCalories: NutrientRange | null = null;
  let weightKg: number | undefined;
  let basis: MealPortionReference['basis'];
  const unavailable = (reason: string): MealPortionReference => ({
    status: 'unavailable', reason, dailyCalories, mealCalories, totalGrams: null, dishes: [], assumptions, weightKg, basis,
  });

  if (within(profile.calorieTarget, targetBounds)) {
    basis = 'daily-target';
    dailyCalories = outward(profile.calorieTarget, profile.calorieTarget);
    assumptions.push('采用已填写的每日热量目标；未根据健康、减脂或增肌目标额外调整热量。');
  } else {
    if (profile.calorieTarget !== undefined)
      assumptions.push('已填写的每日热量目标不在本参考的有效范围（800–6000 kcal），未采用该数值。');
    if (within(profile.weightKg, weightBounds)) {
      weightKg = profile.weightKg;
      basis = 'body-weight';
      assumptions.push(`采用已填写的体重 ${weightKg} kg，按一般成人 60 kg 基准同比例估计。`);
    } else {
      weightKg = adultReferenceWeightKg;
      basis = 'general-adult';
      assumptions.push(profile.weightKg === undefined
        ? '尚无有效体重，采用一般成人 60 kg 基准估计；填写体重后可按比例调整。'
        : '已填写的体重不在本参考的有效范围（30–250 kg），未采用异常数值，改用一般成人 60 kg 基准估计。');
    }
    dailyCalories = outward(25 * weightKg, 35 * weightKg);
    assumptions.push('按 25–35 kcal/kg/day 的产品参考区间估计每日热量；未据身高、年龄、性别或活动量作个人化测算。');
  }

  const percent = mealPercent[mealType];
  if (percent === undefined) return unavailable('餐次未知，请先选择早餐、午餐、晚餐或加餐。');
  mealCalories = outward(dailyCalories.min * percent / 100, dailyCalories.max * percent / 100);
  assumptions.push(`参考分配为早餐 25%、午餐 35%、晚餐 30%、加餐 10%；本餐按${mealType} ${percent}% 换算。`);

  const components = analysis?.components;
  if (!analysis || !components?.length) return unavailable('请先补充本餐完整菜品及每 100 g 营养参考，才能换算备餐克数。');
  if (components.length > 20 || components.some((component) => !component.label.trim()) || incompleteMeal(analysis, components))
    return unavailable('当前菜品有遗漏或记录不完整，请补充完整菜品后再换算；不能把缺少的菜品按零热量处理。');

  let minimumCalories = 0;
  let maximumCalories = 0;
  for (const component of components) {
    if (hasMealIdentityConflict(component)) return unavailable(`${component.label}的菜品身份尚未确认，请先确认菜名和做法。`);
    if (component.userNutritionPer100g === undefined && component.nutritionReferenceStale)
      return unavailable(`${component.label}的旧营养参考已失效，请补充新的每 100 g 营养参考。`);
    const reference = effectiveReference(component);
    if (!reference) return unavailable(`${component.label}的每 100 g 营养未知或不完整，请先确认热量、蛋白质、碳水和脂肪；不能按零热量处理。`);
    minimumCalories += reference.calories.min;
    maximumCalories += reference.calories.max;
  }

  assumptions.push('未提供各菜比例，暂按各道菜等克数混合，以各菜每 100 g 热量区间的平均值换算；改变比例会改变参考克数。');
  const density = { min: minimumCalories / components.length, max: maximumCalories / components.length };
  if (density.min < minimumEnergyDensity) return unavailable('当前组合的热量密度下界低于 50 kcal/100 g，可能只有蔬菜、汤水或缺少完整菜品，无法给出合理的整餐克数；请补充完整菜品或调整各菜比例。');
  const totalGrams = outward(mealCalories.min / density.max * 100, mealCalories.max / density.min * 100);
  if (!Number.isFinite(totalGrams.max) || totalGrams.max > maximumMealGrams)
    return unavailable('按当前菜品和等克数假设换算的总量上限超过 2000 g，无法给出合理的整餐克数；请补充完整菜品、确认热量目标或调整各菜比例。');
  const dishGrams = outward(totalGrams.min / components.length, totalGrams.max / components.length);
  assumptions.push('热量与克数区间均向外取整，保留估算范围；各菜区间也各自向外取整。');
  return { status: 'ready', dailyCalories, mealCalories, totalGrams, weightKg, basis,
    dishes: components.map((component, index) => ({ index, label: component.label, grams: { ...dishGrams } })), assumptions };
}
