import { hasMealIdentityConflict, resolveAiHouseholdMeasure, resolveStoredNutritionReference } from '../shared/nutrition.mjs';
import { uid } from './domain';
import { estimateMealPortion } from './meal-portion-reference';
import { calculateMealNutrition, nutritionDataset } from './nutrition';
import { parseCorrectionRange } from './nutrition-correction';
import type { MealAnalysis, MealComponent, MealHouseholdMeasure, MealRecord, NutrientRanges, Profile } from './types';

const nutrientKeys = ['calories', 'protein', 'carbs', 'fat'] as const;
const nutrientLabels = { calories: '热量', protein: '蛋白质', carbs: '碳水', fat: '脂肪' };
const decimal = /^(?:\d+(?:\.\d+)?|\.\d+)$/;

export type MealReviewRow = {
  id: string;
  component: MealComponent;
  label: string;
  cookingMethod: string;
  quantity: string;
  quantityUnit: 'g' | 'household';
  quantityOrigin?: 'estimated' | 'user';
  quantityEdited?: boolean;
  nutrients: Record<'calories' | 'protein' | 'carbs' | 'fat', { min: string; max: string }>;
  nutritionEdited: boolean;
};

type ReviewPatch = Partial<Pick<MealReviewRow, 'label' | 'cookingMethod' | 'quantity' | 'quantityUnit' | 'nutrients'>>;

function emptyNutrients(): MealReviewRow['nutrients'] {
  return { calories: { min: '', max: '' }, protein: { min: '', max: '' }, carbs: { min: '', max: '' }, fat: { min: '', max: '' } };
}

function cookingMethod(component: MealComponent): string {
  return component.cookingMethod ?? component.preparation ?? '';
}

export function createMealReviewRows(analysis: MealAnalysis, previousRows?: MealReviewRow[]): MealReviewRow[] {
  const previousGroups = new Map<string, MealReviewRow[]>();
  for (const row of previousRows ?? []) {
    const key = JSON.stringify([normalizedIdentity(row.label), normalizedIdentity(row.cookingMethod)]);
    const group = previousGroups.get(key) ?? [];
    group.push(row);
    previousGroups.set(key, group);
  }
  const nextGroups = groupIdentities(analysis.components ?? []);
  return (analysis.components ?? []).map((component) => {
    const reference = resolveStoredNutritionReference(component);
    const nutrients = reference === null ? emptyNutrients()
      : Object.fromEntries(nutrientKeys.map((key) => [key, { min: String(reference[key].min), max: String(reference[key].max) }])) as MealReviewRow['nutrients'];
    const quantityOrigin = component.userQuantity ? component.userQuantity.origin ?? 'user' : undefined;
    const row: MealReviewRow = {
      id: uid(), component: { ...component }, label: component.label, cookingMethod: cookingMethod(component),
      quantity: component.userQuantity ? String(component.userQuantity.amount) : '',
      quantityUnit: component.userQuantity?.unit ?? 'g', quantityOrigin,
      quantityEdited: component.userQuantityCleared === true || quantityOrigin === 'user', nutrients, nutritionEdited: false,
    };
    const key = identityKey(component);
    const previous = previousGroups.get(key);
    if (previous?.length === 1 && nextGroups.get(key)?.length === 1
      && !hasMealIdentityConflict(component) && !placeholderLabel(component.label)) {
      if (previous[0].quantityEdited) row.quantityEdited = true;
      if (previous[0].quantityEdited && !previous[0].quantity.trim()) {
        row.quantity = '';
        row.quantityOrigin = undefined;
      }
    }
    return row;
  });
}

export function createEmptyMealReviewRow(): MealReviewRow {
  return {
    id: uid(), component: { foodId: null, label: '', grams: null, quantitySource: 'unknown', uncertainty: [], source: null },
    label: '', cookingMethod: '', quantity: '', quantityUnit: 'g', quantityEdited: false,
    nutrients: emptyNutrients(), nutritionEdited: false,
  };
}

export function updateMealReviewRow(row: MealReviewRow, patch: ReviewPatch): MealReviewRow {
  const next = { ...row, ...patch };
  const changedIdentity = next.label.trim() !== row.label.trim() || next.cookingMethod.trim() !== row.cookingMethod.trim();
  if (changedIdentity) {
    next.nutrients = emptyNutrients();
    next.nutritionEdited = true;
    // A new dish or cooking method needs a fresh whole-meal share from AI.
    // Keep an estimate only when it was explicitly adopted by the user.
    if (row.quantityOrigin === 'estimated' && !row.quantityEdited) {
      next.quantity = '';
      next.quantityOrigin = undefined;
    }
    // A count of bowls or eggs is not a gram value for the renamed dish.
    if (next.quantityUnit === 'household') {
      next.quantity = '';
      next.quantityUnit = 'g';
    }
  } else if (patch.nutrients !== undefined) {
    next.nutritionEdited = true;
  }
  if (next.quantityUnit !== row.quantityUnit && patch.quantity === undefined) next.quantity = '';
  if (patch.quantity !== undefined || patch.quantityUnit !== undefined) {
    next.quantityEdited = true;
    const text = next.quantity.trim();
    const quantity = decimal.test(text) ? Number(text) : NaN;
    next.quantityOrigin = Number.isFinite(quantity) && quantity > 0 && quantity <= 100_000 ? 'user' : undefined;
  }
  return next;
}

function parseNutrients(row: MealReviewRow): NutrientRanges | null {
  const values = nutrientKeys.map((key) => parseCorrectionRange(row.nutrients[key].min, row.nutrients[key].max,
    key === 'calories' ? 900 : 100, `${row.label.trim() || '菜品'}的每 100 g ${nutrientLabels[key]}`));
  if (values.every((value) => value === null)) return null;
  if (values.some((value) => value === null)) throw new Error('每 100 g 营养请完整填写四项区间，或全部留空表示未知。');
  const ranges = Object.fromEntries(nutrientKeys.map((key, index) => [key, values[index]])) as NutrientRanges;
  if (ranges.protein.min + ranges.carbs.min + ranges.fat.min > 100)
    throw new Error('每 100 g 蛋白质、碳水和脂肪的下界合计不能超过 100 g。');
  return ranges;
}

function parseQuantity(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const quantity = decimal.test(trimmed) ? Number(trimmed) : NaN;
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 100_000)
    throw new Error('实际食用数量请填写大于 0 且不超过 100000 的完整数字，或留空。');
  return quantity;
}

function placeholderLabel(label: string): boolean {
  const normalized = label.normalize('NFKC').replace(/[\s\p{P}\p{S}\d]+/gu, '');
  return /^(?:(?:待确认|待识别|未识别|未知|不明|无法识别|疑似)(?:的)?(?:菜品|食材|食物|餐食|饮品|饮料|食品|菜)?[一二三四五六七八九十]*)$/u.test(normalized)
    || /^(?:菜品|食物|食材|餐食|饮品|饮料)(?:待确认|待识别|未识别|未知|不明)?$/u.test(normalized)
    || /^(?:unknown|unidentified|unrecognized)(?:dish|food|ingredient|drink)?$/iu.test(normalized);
}

function omissionIssue(issue: string): boolean {
  return /遗漏|漏识别|漏掉|缺少.*(?:菜品|食材|主食|成分)|(?:还有|另有|其余|其他|整图|整餐|全图)|\b(?:missing|incomplete|additional|another|elsewhere)\b/iu.test(issue);
}

function identityIssue(issue: string): boolean {
  return hasMealIdentityConflict({ foodId: null, uncertainty: [issue] })
    || /(?:菜品|食材|食物|饮品|种类).*(?:未识别|未辨认|无法识别|无法辨认|待确认|身份不明)|(?:unidentified|unrecognized|ambiguous|uncertain).*(?:dish|food|ingredient|identity)|(?:dish|food|ingredient|identity).*(?:unidentified|unrecognized|ambiguous|uncertain|conflict)/iu.test(issue);
}

function withoutOldIdentity(component: MealComponent, confirmedName: boolean): MealComponent {
  const { category: _category, preparation: _preparation, cookingMethod: _cooking,
    estimationBasis: _basis, estimateBasis: _legacyBasis, recommendedShare: _share, ...rest } = component;
  if (!confirmedName) {
    const { candidates: _candidates, ...resolved } = rest;
    // Clearing a resolved food ID must not turn its old candidates into a new conflict.
    return { ...(hasMealIdentityConflict(component) ? rest : resolved),
      foodId: null, householdMeasure: null, nutritionReferenceStale: true };
  }
  const { candidates: _candidates, confidence: _confidence, evidence: _evidence, ...named } = rest;
  return { ...named, foodId: null, householdMeasure: null, nutritionReferenceStale: true,
    uncertainty: component.uncertainty.filter((issue) => !identityIssue(issue) || omissionIssue(issue)) };
}

/** Only a unique, explicitly named subject can resolve an old whole-analysis identity warning. */
function remainingReviewIssues(base: MealAnalysis, confirmedNames: string[]): string[] {
  const originalLabels = (base.components ?? []).map((component) => normalizedIdentity(component.label));
  const uniqueNames = [...new Set(confirmedNames.map((name) => name.normalize('NFKC').trim()))]
    .filter((name) => originalLabels.filter((label) => label === normalizedIdentity(name)).length === 1);
  return (base.unresolved ?? []).filter((issue) => {
    if (omissionIssue(issue)) return true;
    const normalized = issue.normalize('NFKC').trim();
    return !uniqueNames.some((name) => {
      const subjects = [name, `“${name}”`, `「${name}」`, `"${name}"`, `菜品“${name}”`, `食材“${name}”`];
      const subject = subjects.find((prefix) => normalized.startsWith(prefix)
        && /^(?:\s*[:：]|的|身份|种类)/u.test(normalized.slice(prefix.length)));
      if (!subject) return false;
      const detail = normalized.slice(subject.length).replace(/^\s*[:：]\s*/u, '');
      return identityIssue(detail) || identityIssue(`菜品${detail}`);
    });
  });
}

function referenceCalculationMode(analysis: MealAnalysis): 'ai-per100g-v3' | 'reference-quantity-v1' {
  return analysis.nutritionSource?.method === 'reference-quantity-v1'
    || analysis.components?.some((component) => component.source && component.source.provider !== 'model')
    ? 'reference-quantity-v1' : 'ai-per100g-v3';
}

export function buildMealReviewAnalysis(base: MealAnalysis, rows: MealReviewRow[]): MealAnalysis {
  if (rows.length < 1 || rows.length > 20) throw new Error('请保留 1 至 20 道菜品。');
  const confirmedNames: string[] = [];
  const components = rows.map((row) => {
    const label = row.label.trim();
    const method = row.cookingMethod.trim();
    if (!label || label.length > 300) throw new Error('每道菜品名称请填写 1 至 300 个字符。');
    if (method.length > 500) throw new Error(`${label}的做法不能超过 500 个字符。`);
    if (row.quantityUnit !== 'g' && row.quantityUnit !== 'household') throw new Error('请选择克数或有效的本地份数单位。');
    const nutrients = parseNutrients(row);
    const quantity = parseQuantity(row.quantity);
    const changedName = label !== row.component.label.trim();
    const changedIdentity = changedName || method !== cookingMethod(row.component).trim();
    const confirmedName = changedName && !placeholderLabel(label);
    if (confirmedName) confirmedNames.push(row.component.label);
    const { userQuantityCleared: _cleared, ...currentComponent } = changedIdentity ? withoutOldIdentity(row.component, confirmedName) : row.component;
    const component: MealComponent = {
      ...currentComponent, label,
      cookingMethod: method || undefined,
      ...(row.nutritionEdited ? { userNutritionPer100g: nutrients }
        : changedIdentity ? { userNutritionPer100g: null } : {}),
      userQuantity: quantity === null ? null : { amount: quantity, unit: row.quantityUnit, origin: row.quantityOrigin ?? 'user' },
      ...(quantity === null && (row.quantityEdited || row.component.userQuantityCleared) ? { userQuantityCleared: true } : {}),
    };
    if (placeholderLabel(label) && !hasMealIdentityConflict(component)) {
      component.uncertainty = [...component.uncertainty.slice(0, 39), '菜品身份待确认。'];
    }
    if (quantity !== null && row.quantityUnit === 'household' && !resolveAiHouseholdMeasure(nutritionDataset, component))
      throw new Error(`${label}没有可靠的本地份数换算，请填写克数。`);
    return component;
  });
  const reviewed = { ...base, components, unresolved: remainingReviewIssues(base, confirmedNames),
    foodName: components.map((component) => component.label).join('、').slice(0, 500) };
  return calculateMealNutrition(reviewed, undefined, referenceCalculationMode(reviewed));
}

/** Recompute only default quantities; incomplete drafts and explicit user edits remain intact. */
export function applyEstimatedMealQuantities(
  profile: Profile,
  mealType: MealRecord['mealType'],
  base: MealAnalysis,
  rows: MealReviewRow[],
  options: { preserveExistingEstimates?: boolean } = {},
): MealReviewRow[] {
  let reference;
  try {
    reference = estimateMealPortion(profile, mealType, buildMealReviewAnalysis(base, rows));
  } catch {
    // Live fields can be temporarily invalid while typing. Confirmation still
    // validates them; a failed estimate must never replace that original draft.
    return [...rows];
  }
  if (reference.status !== 'ready') return [...rows];
  return rows.map((row, index): MealReviewRow => {
    if (row.quantityEdited || row.quantityOrigin === 'user' || row.component.userQuantityCleared
      || (options.preserveExistingEstimates && row.quantityOrigin === 'estimated' && row.quantity.trim())
      || (row.quantity.trim() && row.quantityOrigin !== 'estimated')) return row;
    const grams = reference.dishes[index]?.grams;
    if (!grams) return row;
    return { ...row, quantity: String(Math.round((grams.min + grams.max) / 2)),
      quantityUnit: 'g', quantityOrigin: 'estimated', quantityEdited: false };
  });
}

/** A saved per-100 g reference is useful even when no intake can be calculated. */
export function mealReviewConfirmationMessage(analysis: MealAnalysis): string {
  const missing = analysis.coverage?.missingQuantityLabels ?? [];
  const unknown = analysis.coverage?.unknownNutritionLabels ?? [];
  const excluded = [...new Set([...missing, ...unknown])];
  const estimated = analysis.components?.some((component) => component.userQuantity?.origin === 'estimated');
  const entered = analysis.components?.some((component) => component.userQuantity && component.userQuantity.origin !== 'estimated');
  if (analysis.calories === null) {
    if (unknown.length) return `菜品已确认；营养参考未知，请补全：${unknown.join('、')}。`
      + (missing.length ? `食用量为空：${missing.join('、')}；本餐营养暂未计算。` : '');
    if (missing.length && analysis.coverage?.referenceCount === 0)
      return '菜品已确认；每 100 g 营养参考和实际食用量尚未补全。';
    if (missing.length) return '每 100 g 营养参考已保存；尚未填写实际食用量，本餐营养暂未计算。';
    return '菜品和每 100 g 营养参考已确认；暂无可计算的本餐营养。';
  }
  if (excluded.length) return estimated
    ? `已按参考估计和填写的食用量更新可计算菜品小计；未计入：${excluded.join('、')}。`
    : `已更新已填写菜品小计；未计入：${excluded.join('、')}。`;
  if (estimated) return entered
    ? '已按参考估计和填写的食用量更新本餐四项营养；估计量可按实际修改。'
    : '已按参考估计食用量更新本餐四项营养；可修改为实际食用量。';
  return '已按填写的实际食用量更新本餐营养。';
}

function normalizedIdentity(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, '');
}

function identityKey(component: MealComponent): string {
  return JSON.stringify([normalizedIdentity(component.label), normalizedIdentity(cookingMethod(component))]);
}

function groupIdentities(components: MealComponent[]): Map<string, MealComponent[]> {
  const groups = new Map<string, MealComponent[]>();
  for (const component of components) {
    const key = identityKey(component);
    const group = groups.get(key) ?? [];
    group.push(component);
    groups.set(key, group);
  }
  return groups;
}

function sameMeasure(left: MealHouseholdMeasure | null | undefined, right: MealHouseholdMeasure | null | undefined): boolean {
  return Boolean(left && right && left.label === right.label && left.grams === right.grams && left.approximate === right.approximate);
}

/** A new AI result owns its references; only unambiguous local quantities and exclusions carry over. */
export function mergeReviewedQuantities(reviewed: MealAnalysis, previous: MealAnalysis): MealAnalysis {
  const previousGroups = groupIdentities(previous.components ?? []);
  const nextGroups = groupIdentities(reviewed.components ?? []);
  const components = (reviewed.components ?? []).map((component) => {
    const key = identityKey(component);
    const matches = previousGroups.get(key);
    const old = matches?.length === 1 && nextGroups.get(key)?.length === 1 ? matches[0] : undefined;
    const quantity = old?.userQuantity;
    if (!old || hasMealIdentityConflict(old) || hasMealIdentityConflict(component)) return component;
    if (old.userQuantityCleared === true)
      return quantity ? component : { ...component, userQuantity: null, userQuantityCleared: true };
    if (!quantity || !Number.isFinite(quantity.amount) || quantity.amount <= 0 || quantity.amount > 100_000
      || (quantity.origin !== undefined && quantity.origin !== 'user' && quantity.origin !== 'estimated')) return component;
    if (quantity.unit === 'household') {
      const oldMeasure = resolveAiHouseholdMeasure(nutritionDataset, old);
      const nextMeasure = resolveAiHouseholdMeasure(nutritionDataset, component);
      if (!sameMeasure(old.householdMeasure, oldMeasure) || !sameMeasure(component.householdMeasure, nextMeasure)
        || !sameMeasure(oldMeasure, nextMeasure)) return component;
    } else if (quantity.unit !== 'g') return component;
    const { userQuantityCleared: _cleared, ...currentComponent } = component;
    return { ...currentComponent, userQuantity: { ...quantity } };
  });
  const merged = { ...reviewed, components };
  return calculateMealNutrition(merged, undefined, referenceCalculationMode(merged));
}
