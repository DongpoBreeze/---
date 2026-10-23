import type { MealRecord, NutrientRanges, Profile } from './types';
import { buildMealReviewAnalysis, type MealReviewRow } from './meal-review';
import { estimateMealPortion, hasIncompleteMealRecognition } from './meal-portion-reference';
import { hasMealIdentityConflict, resolveStoredNutritionReference } from '../shared/nutrition.mjs';

type ReviewAnalysis = ReturnType<typeof buildMealReviewAnalysis>;

/** Model id for analyses produced by the local review page, not by an AI request. */
export const LOCAL_REVIEW_MODEL = 'local/meal-review';

export const normalizedDishName = (value: string) => value.normalize('NFKC').replace(/\s+/gu, '').toLowerCase();

export const nutritionRows = [
  ['calories', '热量', 'kcal'], ['protein', '蛋白质', 'g'],
  ['carbs', '碳水', 'g'], ['fat', '脂肪', 'g'],
] as const;

export function nutritionEstimateText(value: NutrientRanges[keyof NutrientRanges] | null, key: typeof nutritionRows[number][0]) {
  if (!value) return { estimate: '未知', range: '' };
  const step = key === 'calories' ? 10 : 1;
  const rounded = (amount: number) => String(Math.round(amount / step) * step);
  const estimate = rounded((value.min + value.max) / 2);
  const min = rounded(value.min);
  const max = rounded(value.max);
  return { estimate: `约 ${estimate}`, range: min === max ? '' : `${min}～${max}` };
}

const uniqueByName = <T,>(items: T[] | undefined, label: (item: T) => string, name: string) =>
  (items ?? []).filter((item) => normalizedDishName(label(item)) === name);

/**
 * A targeted refresh for a renamed dish must not discard nutrition that the
 * user has explicitly entered for another, uniquely matched dish.
 */
export function keepUserNutrition(refreshed: ReviewAnalysis, reviewed: ReviewAnalysis): ReviewAnalysis {
  return { ...refreshed, components: refreshed.components?.map((component) => {
    const name = normalizedDishName(component.label);
    const previous = uniqueByName(reviewed.components, (item) => item.label, name);
    const unique = uniqueByName(refreshed.components, (item) => item.label, name).length === 1;
    const saved = previous.length === 1 && unique ? previous[0] : undefined;
    if (!saved || saved.userNutritionPer100g === undefined
      || (saved.nutritionReferenceStale && saved.userNutritionPer100g === null)) return component;
    return { ...component, userNutritionPer100g: saved.userNutritionPer100g };
  }) };
}

/**
 * A gram value or an explicit exclusion survives a refreshed cooking
 * description. Household counts still require the core measure match.
 */
export function keepEditedGrams(fresh: MealReviewRow[], previous: MealReviewRow[]): MealReviewRow[] {
  return fresh.map((row) => {
    const name = normalizedDishName(row.label);
    const matches = uniqueByName(previous, (item) => item.label, name);
    if (matches.length !== 1 || uniqueByName(fresh, (item) => item.label, name).length !== 1) return row;
    const edited = matches[0];
    if (!edited.quantityEdited || (edited.quantity.trim() && edited.quantityUnit !== 'g')) return row;
    return { ...row, quantity: edited.quantity, quantityUnit: 'g' as const,
      quantityOrigin: 'user' as const, quantityEdited: true };
  });
}

const IDENTITY_UNRESOLVED = /重复|身份(?:待确认|不明|不确定|不清|冲突|无法确认)|(?:菜品|食材|菜名|种类).*(?:无法识别|无法确认|无法辨认|待确认|不明|不确定|冲突|疑似|看不清)|无法(?:识别|辨认).*(?:菜品|食材)|duplicate|identity|(?:dish|food|ingredient).*(?:ambiguous|conflict|uncertain)/iu;

export type ReviewRefreshOutcome =
  | { kind: 'confirm' }
  | { kind: 'check'; status: string; error?: string };

/** Whether an AI refresh requested by 「确认」 can be applied without another look. */
export function reviewRefreshOutcome(reviewed: ReviewAnalysis, refreshed: ReviewAnalysis, analysis: ReviewAnalysis): ReviewRefreshOutcome {
  const names = (value: ReviewAnalysis) => (value.components ?? []).map((component) => normalizedDishName(component.label)).sort();
  const sameDishes = JSON.stringify(names(reviewed)) === JSON.stringify(names(refreshed));
  const missingNutrition = (analysis.coverage?.unknownNutritionLabels ?? []).length > 0
    || Boolean(analysis.components?.some((component) => resolveStoredNutritionReference(component) === null));
  const identityUnconfirmed = Boolean(analysis.components?.some(hasMealIdentityConflict))
    || (analysis.unresolved ?? []).some((item) => IDENTITY_UNRESOLVED.test(item));
  const incompleteRecognition = hasIncompleteMealRecognition(analysis);
  if (sameDishes && !missingNutrition && !identityUnconfirmed && !incompleteRecognition) return { kind: 'confirm' };
  const status = !sameDishes ? 'AI 复核后的菜品有变化，请核对后确认。'
    : identityUnconfirmed ? 'AI 复核后仍有菜品身份待确认，请核对。'
      : incompleteRecognition ? 'AI 复核后仍有菜品遗漏，请核对。' : '修改后的菜品营养仍待补充，请核对。';
  const error = missingNutrition ? '部分菜品仍缺少营养参考，请补充每 100 g 营养，未知项不会按零计算。'
    : identityUnconfirmed ? '菜品身份仍有不确定项，请核对名称和做法后再确认，原表格尚未更新。'
      : incompleteRecognition ? '本餐菜品仍有遗漏或记录不完整，请补全后再确认，原表格尚未更新。' : undefined;
  return { kind: 'check', status, error };
}

/** Appends the portion-reference disclosure used for estimated quantities. */
export function withPortionAssumption(analysis: ReviewAnalysis, profile: Profile, mealType: MealRecord['mealType']): ReviewAnalysis {
  if (!analysis.components?.some((component) => component.userQuantity?.origin === 'estimated')) return analysis;
  const reference = estimateMealPortion(profile, mealType, analysis);
  if (reference.status !== 'ready') return analysis;
  const prefix = '食用量参考：';
  const range = (value: { min: number; max: number } | null) => value ? `${value.min}～${value.max}` : '未知';
  const detail = `${prefix}每日 ${range(reference.dailyCalories)} kcal，${mealType} ${range(reference.mealCalories)} kcal；`
    + `整餐参考 ${range(reference.totalGrams)} g，各菜参考 ${range(reference.dishes[0]?.grams ?? null)} g，默认采用各菜区间中点整数克。`
    + reference.assumptions.join('');
  const assumptions = (analysis.assumptions ?? []).filter((item) => !item.startsWith(prefix));
  // Keep both the leading estimate disclosure and the trailing subtotal
  // disclosure when the model already used the full assumption budget.
  const retained = assumptions.length > 79 ? [assumptions[0], ...assumptions.slice(-78)] : assumptions;
  return { ...analysis, assumptions: [...retained, detail.slice(0, 1000)] };
}
