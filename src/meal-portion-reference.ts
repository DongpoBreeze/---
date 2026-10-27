import { hasMealIdentityConflict } from '../shared/nutrition.mjs';
import { PROFILE_CALORIE_BOUNDS, profileAgeReference } from './profile-health';
import type { MealAnalysis, MealComponent, MealRecord, NutrientRange, NutrientRanges, Profile } from './types';

export type MealPortionReference = {
  status: 'ready' | 'unavailable';
  reason?: string;
  /** A fresh AI review can plausibly resolve this blocker. */
  reviewMayHelp?: boolean;
  weightKg?: number;
  basis?: 'daily-target' | 'body-size' | 'body-weight' | 'general-adult';
  dailyCalories: { min: number; max: number } | null;
  mealCalories: { min: number; max: number } | null;
  totalGrams: { min: number; max: number } | null;
  dishes: Array<{ index: number; label: string; share: number; grams: { min: number; max: number } }>;
  assumptions: string[];
};

const mealPercent: Record<MealRecord['mealType'], number> = { 早餐: 25, 午餐: 35, 晚餐: 30, 加餐: 10 };
const nutrients = ['calories', 'protein', 'carbs', 'fat'] as const;
// These are limits on this general reference, not clinical definitions of a healthy body or diet.
const weightBounds = { min: 30, max: 250 };
const targetBounds = { min: 800, max: 6000 };
const heightBounds = PROFILE_CALORIE_BOUNDS.heightCm;
const adultReferenceWeightKg = 60;
const referenceBmi = 22;
const upperReferenceBmi = 24;
const excessWeightFactor = 0.25;
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

function recommendedShares(components: MealComponent[]): number[] | null {
  const shares = components.map((component) => component.recommendedShare);
  if (shares.some((share) => typeof share !== 'number' || !Number.isFinite(share) || share <= 0 || share > 1)) return null;
  const total = shares.reduce<number>((sum, share) => sum + (share ?? 0), 0);
  if (!(total > 0) || !Number.isFinite(total)) return null;
  // The model's values are relative suggestions and may not sum to exactly 1.
  // Normalize only those returned values; there is no category-based fallback.
  return shares.map((share) => share! / total);
}

function hasDuplicateDishIdentities(components: MealComponent[]): boolean {
  const identities = new Set<string>();
  for (const component of components) {
    const label = component.label.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
    const method = (component.cookingMethod ?? component.preparation ?? '').normalize('NFKC')
      .toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
    const identity = JSON.stringify([label, method]);
    if (!label || identities.has(identity)) return true;
    identities.add(identity);
  }
  return false;
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
  let calculationWeightKg: number | undefined;
  let basis: MealPortionReference['basis'];
  const unavailable = (reason: string): MealPortionReference => ({
    status: 'unavailable', reason, dailyCalories, mealCalories, totalGrams: null, dishes: [], assumptions, weightKg, basis,
  });

  const age = profileAgeReference(profile.ageYears);
  if (!age.adultApplicable)
    return unavailable(`${age.reason} 暂不自动生成成人备餐量，仍可按实际情况逐菜填写食用量。`);
  assumptions.push(`${age.label}；年龄仅用于判断适用范围，活动量未作个人化测算。`);

  if (within(profile.calorieTarget, targetBounds)) {
    basis = 'daily-target';
    dailyCalories = outward(profile.calorieTarget, profile.calorieTarget);
    assumptions.push('采用已填写的每日热量目标；未根据健康、减脂或增肌目标额外调整热量。');
  } else {
    if (profile.calorieTarget !== undefined)
      assumptions.push('已填写的每日热量目标不在本参考的有效范围（800–6000 kcal），未采用该数值。');
    if (within(profile.weightKg, weightBounds)) {
      weightKg = profile.weightKg;
      calculationWeightKg = weightKg;
      if (within(profile.heightCm, heightBounds)) {
        const heightM = profile.heightCm / 100;
        const bmi = weightKg / (heightM * heightM);
        const referenceWeightKg = referenceBmi * heightM * heightM;
        basis = 'body-size';
        if (bmi > upperReferenceBmi) {
          calculationWeightKg = referenceWeightKg + (weightKg - referenceWeightKg) * excessWeightFactor;
          assumptions.push(`采用身高 ${profile.heightCm} cm 与体重 ${weightKg} kg（BMI ${bmi.toFixed(1)}）；BMI 高于 24 时以 BMI 22 对应体重为基准，仅计入实际体重与基准差值的 25%，折算估算体重约 ${calculationWeightKg.toFixed(1)} kg。`);
        } else {
          assumptions.push(`采用身高 ${profile.heightCm} cm 与体重 ${weightKg} kg（BMI ${bmi.toFixed(1)}）；BMI 不高于 24，按实际体重估算。`);
        }
      } else {
        basis = 'body-weight';
        assumptions.push(profile.heightCm === undefined
          ? `尚无有效身高，采用已填写的体重 ${weightKg} kg 估算；填写有效身高后可按 BMI 调整。`
          : `身高不在本参考有效范围（${heightBounds.min}–${heightBounds.max} cm），未用于 BMI 调整；按已填写的体重 ${weightKg} kg 估算。`);
      }
    } else {
      weightKg = adultReferenceWeightKg;
      calculationWeightKg = adultReferenceWeightKg;
      basis = 'general-adult';
      assumptions.push(profile.weightKg === undefined
        ? '尚无有效体重，采用一般成人 60 kg 基准估计；填写体重后可按比例调整。'
        : '已填写的体重不在本参考的有效范围（30–250 kg），未采用异常数值，改用一般成人 60 kg 基准估计。');
    }
    dailyCalories = outward(25 * calculationWeightKg!, 35 * calculationWeightKg!);
    assumptions.push(basis === 'body-size'
      ? '按 25–35 kcal/kg/day 的产品参考区间乘以以上估算体重；BMI 校正规则只用于一般份量估计，不是医学处方。'
      : '按 25–35 kcal/kg/day 的产品参考区间估计每日热量。');
  }

  const percent = mealPercent[mealType];
  if (percent === undefined) return unavailable('餐次未知，请先选择早餐、午餐、晚餐或加餐。');
  mealCalories = outward(dailyCalories.min * percent / 100, dailyCalories.max * percent / 100);
  assumptions.push(`参考分配为早餐 25%、午餐 35%、晚餐 30%、加餐 10%；本餐按${mealType} ${percent}% 换算。`);

  const components = analysis?.components;
  if (!analysis || !components?.length) return unavailable('请先补充本餐完整菜品及每 100 g 营养参考，才能换算备餐克数。');
  if (components.length > 20 || components.some((component) => !component.label.trim()) || incompleteMeal(analysis, components))
    return { ...unavailable('当前菜品有遗漏或记录不完整，请补充完整菜品后再换算；不能把缺少的菜品按零热量处理。'), reviewMayHelp: true };
  if (hasDuplicateDishIdentities(components))
    return { ...unavailable('检测到名称和做法重复的菜品，请先核对是否重复识别，再估算食用量。'), reviewMayHelp: true };

  const references: NutrientRanges[] = [];
  for (const component of components) {
    if (hasMealIdentityConflict(component)) return { ...unavailable(`${component.label}的菜品身份尚未确认，请先确认菜名和做法。`), reviewMayHelp: true };
    if (component.userNutritionPer100g === undefined && component.nutritionReferenceStale)
      return { ...unavailable(`${component.label}的旧营养参考已失效，请补充新的每 100 g 营养参考。`), reviewMayHelp: true };
    const reference = effectiveReference(component);
    if (!reference) return { ...unavailable(`${component.label}的每 100 g 营养未知或不完整，请先确认热量、蛋白质、碳水和脂肪；不能按零热量处理。`), reviewMayHelp: true };
    references.push(reference);
  }

  const shares = recommendedShares(components);
  if (!shares) return { ...unavailable('AI未给出完整的本餐菜品份额建议，请重新分析；也可以手动填写各菜食用量。'), reviewMayHelp: true };
  const density = references.reduce((result, reference, index) => ({
    min: result.min + reference.calories.min * shares[index],
    max: result.max + reference.calories.max * shares[index],
  }), { min: 0, max: 0 });
  assumptions.push('各菜相对食用量份额由 AI 根据本次识别到的完整菜品组合、烹调方式和餐次估计，再归一化后换算克数；不代表照片重量、实际摄入或医学处方。');
  if (density.min < minimumEnergyDensity) return unavailable('当前组合的热量密度下界低于 50 kcal/100 g，无法可靠换算整餐克数；请核对菜品营养参考，或手动填写各菜食用量。');
  const totalGrams = outward(mealCalories.min / density.max * 100, mealCalories.max / density.min * 100);
  if (!Number.isFinite(totalGrams.max) || totalGrams.max > maximumMealGrams)
    return unavailable('按本次菜品组合换算的总量上限超过 2000 g，无法给出合理的整餐克数；请确认菜品和热量目标，或手动填写各菜食用量。');
  assumptions.push('热量与克数区间均向外取整；默认填写各菜区间中点整数克，用户输入或清空的数量始终优先。');
  return { status: 'ready', dailyCalories, mealCalories, totalGrams, weightKg, basis,
    dishes: components.map((component, index) => ({ index, label: component.label, share: shares[index],
      grams: outward(totalGrams.min * shares[index], totalGrams.max * shares[index]) })), assumptions };
}
