import type { AnalysisVersion, MealRecord, NutrientRange } from './types';

const decimal = /^(?:\d+(?:\.\d+)?|\.\d+)$/;

/**
 * A synchronous gate for the correction save operation. React state updates
 * are asynchronous, so a second press in the same event turn must be rejected
 * before the component has rendered its `saving` state.
 */
export function createCorrectionSaveGate() {
  let active: number | null = null;
  let next = 0;
  return {
    begin(): number | null {
      if (active !== null) return null;
      active = ++next;
      return active;
    },
    isCurrent(token: number): boolean {
      return active === token;
    },
    finish(token: number): void {
      if (active === token) active = null;
    },
    invalidate(): void {
      active = null;
      next += 1;
    },
  };
}

export function parseCorrectionRange(
  lowerText: string,
  upperText: string,
  maximum: number,
  label: string,
): NutrientRange | null {
  const lower = lowerText.trim();
  const upper = upperText.trim();
  if (!lower && !upper) return null;
  if (!lower || !upper) throw new Error(`${label}请填写上下界，或两项都留空。`);
  if (!decimal.test(lower) || !decimal.test(upper))
    throw new Error(`${label}只能填写完整的非负数字。`);
  const min = Number(lower);
  const max = Number(upper);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max || max > maximum)
    throw new Error(`${label}上下界无效，请检查数值顺序和范围。`);
  return { min, max };
}

export function fractionToPercent(value: NutrientRange | null | undefined): string {
  if (!value) return '未知';
  const percent = (fraction: number) => Number((fraction * 100).toFixed(2));
  const min = percent(value.min);
  const max = percent(value.max);
  return min === max ? `${min}%` : `${min}～${max}%`;
}

export function appendNutritionCorrection(
  meal: MealRecord | undefined,
  revision: number,
  baseAnalysisId: string,
  version: AnalysisVersion,
): MealRecord {
  if (!meal || (meal.revision ?? 1) !== revision)
    throw new Error('这条饮食记录已修改，请重新打开校正。');
  const latest = meal.analyses?.filter((item) => item.sourceVersion === revision).at(-1);
  if (latest?.id !== baseAnalysisId)
    throw new Error('分析版本已更新，请重新打开校正。');
  return { ...meal, analyses: [...(meal.analyses ?? []), version] };
}
