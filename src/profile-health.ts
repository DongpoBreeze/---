import type { Goal, Profile } from './types';

export type BmiStatus = '偏瘦' | '正常' | '超重' | '肥胖';
export type CalorieTargetMode = 'recommended' | 'manual';
export type ProfileAgeGroup = 'unknown' | 'minor' | 'adult' | 'older-adult' | 'invalid';
export type ProfileAgeReference = {
  group: ProfileAgeGroup;
  label: string;
  adultApplicable: boolean;
  reason: string | null;
};
export type ProfileHealthReference = {
  age: ProfileAgeReference;
  bmi: number | null;
  bmiStatus: BmiStatus | null;
  bodyReason: string | null;
  normalWeightKg: { min: number; max: number } | null;
  weight: {
    targetKg: number | null;
    targetBmi: number | null;
    targetStatus: BmiStatus | null;
    detail: string;
  };
  calories: {
    target: number | null;
    detail: string;
    formula: string | null;
  };
};

// Product reference limits, not definitions of a healthy body or clinical cutoffs.
export const PROFILE_BODY_BOUNDS = { heightCm: { min: 100, max: 250 }, weightKg: { min: 20, max: 300 } };
export const PROFILE_CALORIE_BOUNDS = {
  heightCm: { min: 140, max: 210 }, weightKg: { min: 40, max: 120 },
  bmi: { min: 16, maxExclusive: 35 }, calories: { min: 1200, max: 3000 },
};
export const BMI_SCALE = { min: 14, max: 36, boundaries: [18.5, 24, 28] as const };

function within(value: unknown, bounds: { min: number; max: number }): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= bounds.min && value <= bounds.max;
}

export function bmiStatus(bmi: number): BmiStatus | null {
  if (!Number.isFinite(bmi) || bmi <= 0) return null;
  return bmi < 18.5 ? '偏瘦' : bmi < 24 ? '正常' : bmi < 28 ? '超重' : '肥胖';
}

/** Keep rounded labels on the same side of each classification boundary as the raw BMI. */
export function formatBmiDisplay(bmi: number): string {
  if (bmiStatus(bmi) === null) return '—';
  const rounded = bmi.toFixed(1);
  const crossedBoundary = BMI_SCALE.boundaries.find((boundary) => bmi < boundary && Number(rounded) >= boundary);
  if (crossedBoundary === undefined) return rounded;
  for (const precision of [2, 3]) {
    const detailed = bmi.toFixed(precision);
    if (Number(detailed) < crossedBoundary) return detailed;
  }
  return `<${crossedBoundary}`;
}

/** Finite marker ratio; preserve the actual BMI in its accompanying text. */
export function bmiMarkerRatio(bmi: number): number | null {
  if (!Number.isFinite(bmi) || bmi <= 0) return null;
  return Math.max(0, Math.min(1, (bmi - BMI_SCALE.min) / (BMI_SCALE.max - BMI_SCALE.min)));
}

/** Equal-width category bands are a display aid; each boundary stays at its own band edge. */
export function bmiSegmentMarkerRatio(bmi: number): number | null {
  if (bmiStatus(bmi) === null) return null;
  const stops = [BMI_SCALE.min, ...BMI_SCALE.boundaries, BMI_SCALE.max];
  if (bmi <= stops[0]) return 0;
  if (bmi >= stops[stops.length - 1]) return 1;
  const index = stops.findIndex((end, position) => position > 0 && bmi < end) - 1;
  return (index + (bmi - stops[index]) / (stops[index + 1] - stops[index])) / 4;
}

/** Display-only kg boundaries for the existing Chinese adult BMI categories. */
export function bmiWeightBreakpoints(heightCm: unknown): [number, number, number] | null {
  if (!within(heightCm, PROFILE_BODY_BOUNDS.heightCm)) return null;
  const squareMetres = (heightCm / 100) ** 2;
  return BMI_SCALE.boundaries.map((boundary) => boundary * squareMetres) as [number, number, number];
}

/** Decimal form input only; invalid input stays invalid instead of becoming an absent field. */
export function profileInputNumber(value: string): number | undefined {
  const text = value.trim();
  if (!text) return undefined;
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text) ? Number(text) : NaN;
}

/** Product applicability groups, not clinical thresholds or a diagnosis. */
export function profileAgeGroup(ageYears: unknown): ProfileAgeGroup {
  if (ageYears === undefined) return 'unknown';
  if (typeof ageYears !== 'number' || !Number.isFinite(ageYears) || !Number.isInteger(ageYears)
    || ageYears < 1 || ageYears > 120) return 'invalid';
  return ageYears < 18 ? 'minor' : ageYears < 65 ? 'adult' : 'older-adult';
}

export function profileAgeValidationError(ageYears: unknown): string | null {
  if (ageYears === undefined) return null;
  if (typeof ageYears !== 'number' || !Number.isFinite(ageYears)) return '年龄需要是 1–120 的整数周岁。';
  if (!Number.isInteger(ageYears)) return '年龄需要填写整数周岁，不支持小数。';
  if (ageYears < 1 || ageYears > 120) return '年龄需要在 1–120 岁之间。';
  return null;
}

export function profileAgeReference(ageYears: unknown): ProfileAgeReference {
  const group = profileAgeGroup(ageYears);
  const labels: Record<ProfileAgeGroup, string> = {
    unknown: '年龄未填写 · 成人参考', minor: '未成年（1–17 岁）',
    adult: '成人（18–64 岁）', 'older-adult': '老年（65–120 岁）', invalid: '年龄无效 · 请核对',
  };
  const reason = group === 'minor'
    ? '未成年人的 BMI 需结合年龄、性别与生长发育解读；当前未提供儿童生长曲线或分龄建议模型。'
    : group === 'older-adult'
      ? '老年人的 BMI 与体重目标需结合身体功能和健康情况单独评估；当前未提供老年专用模型。'
      : group === 'invalid'
        ? `${profileAgeValidationError(ageYears)}核对前暂不使用普通成人分类或自动建议。`
        : null;
  return { group, label: labels[group], adultApplicable: group === 'unknown' || group === 'adult', reason };
}

function validGoal(goal: unknown): goal is Goal {
  return goal === 'health' || goal === 'fat-loss' || goal === 'muscle-gain';
}

/** Local general-adult reference. No historical record or saved profile is mutated. */
export function calculateProfileHealth(profile: Profile): ProfileHealthReference {
  const age = profileAgeReference(profile.ageYears);
  const heightValid = within(profile.heightCm, PROFILE_BODY_BOUNDS.heightCm);
  const weightValid = within(profile.weightKg, PROFILE_BODY_BOUNDS.weightKg);
  const squareMetres = heightValid ? (profile.heightCm! / 100) ** 2 : null;
  const normalWeightKg = squareMetres === null || !age.adultApplicable ? null : { min: 18.5 * squareMetres, max: 23.9 * squareMetres };
  const bmi = squareMetres !== null && weightValid ? profile.weightKg! / squareMetres : null;
  const status = bmi === null || !age.adultApplicable ? null : bmiStatus(bmi);
  const missing = profile.heightCm === undefined || profile.weightKg === undefined;
  const bodyReason = !age.adultApplicable ? age.reason : bmi !== null ? null : missing
    ? '待补充：填写有效身高和体重后计算 BMI。'
    : '待补充：请核对身高和体重；本参考支持身高 100–250 cm、体重 20–300 kg。';
  const result: ProfileHealthReference = {
    age, bmi, bmiStatus: status, bodyReason, normalWeightKg,
    weight: { targetKg: null, targetBmi: null, targetStatus: null, detail: bodyReason ?? '选择健康目标后提供阶段体重建议。' },
    calories: { target: null, detail: bodyReason ?? '待补充：选择健康目标后提供每日热量起始建议。', formula: null },
  };
  if (bmi === null || squareMetres === null || !status || !validGoal(profile.goal)) return result;

  const kg = profile.weightKg!;
  const maintainNearLowerBound = status === '正常' && profile.goal === 'fat-loss' && bmi * 0.98 < 18.5;
  if (bmi < 16 || bmi >= 40) {
    result.weight.detail = '当前 BMI 超出阶段体重自动建议范围（16 至小于 40），建议结合专业评估确定目标。';
  } else {
    let targetKg = kg;
    let detail: string;
    if (status === '偏瘦') {
      targetKg = Math.min(kg * 1.05, normalWeightKg!.min);
      detail = '目前偏瘦，先向正常下限温和增重约 5%，达到下限即可重新评估；不建议继续减重。';
    } else if (status === '正常') {
      if (profile.goal === 'fat-loss') {
        targetKg = maintainNearLowerBound ? kg : kg * 0.98;
        detail = maintainNearLowerBound
          ? '目前已接近正常体重下限，优先维持体重，不继续减量；可关注围度与力量变化。'
          : '目前处于正常范围；如仍希望减脂，可先小幅减重约 2%，并结合围度与力量评估。';
      } else if (profile.goal === 'muscle-gain') {
        targetKg = Math.max(kg, Math.min(kg * 1.02, normalWeightKg!.max));
        detail = '先配合力量训练，体重最多温和增加约 2%，到正常参考上沿后重新评估；BMI 不能区分肌肉和脂肪。';
      } else {
        detail = '目前处于正常范围，优先维持当前体重，不必追求统一的理想体重。';
      }
    } else if (profile.goal === 'muscle-gain') {
      detail = '先维持体重并关注力量与围度，不因增肌目标继续增重；BMI 不能区分肌肉和脂肪。';
    } else {
      targetKg = Math.max(kg * 0.95, normalWeightKg!.max);
      detail = '先以减重约 5% 为阶段目标，接近正常参考上沿即可重新评估；阶段目标仍可能属于超重或肥胖。';
    }
    const targetBmi = targetKg / squareMetres;
    result.weight = { targetKg, targetBmi, targetStatus: bmiStatus(targetBmi), detail };
  }

  const bounds = PROFILE_CALORIE_BOUNDS;
  if (!within(profile.heightCm, bounds.heightCm) || !within(kg, bounds.weightKg)
    || bmi < bounds.bmi.min || bmi >= bounds.bmi.maxExclusive) {
    result.calories.detail = '资料超出热量自动建议范围（身高 140–210 cm、体重 40–120 kg、BMI 16 至小于 35）；信息有限，请手动填写适合自己的目标或咨询专业人员。';
    return result;
  }
  // Existing product baseline is 25–35 kcal/kg/day. Use its midpoint and mild goal adjustments.
  const factor = status === '偏瘦' ? 1.05 : maintainNearLowerBound ? 1
    : profile.goal === 'fat-loss' ? 0.9
      : profile.goal === 'muscle-gain' && status === '正常' ? 1.05 : 1;
  const estimate = kg * 30 * factor;
  result.calories.formula = `${kg} kg × 30 kcal/kg/日${factor === 1 ? '' : ` × ${factor}`}，按 50 kcal 取整。`;
  if (!within(estimate, bounds.calories)) {
    result.calories.detail = '粗估结果超出本功能的 1200–3000 kcal/日起始参考范围，未作上下限截断；请手动设定或结合专业评估。';
    return result;
  }
  result.calories.target = Math.round(estimate / 50) * 50;
  result.calories.detail = status === '偏瘦'
    ? '目前偏瘦，采用温和增加 5% 的起始参考，不建议热量缺口。'
    : maintainNearLowerBound ? '已接近正常体重下限，采用维持起始参考，不建议继续减少热量。'
      : profile.goal === 'fat-loss' ? '在基线基础上温和减少 10%，作为可调整的起点。'
      : profile.goal === 'muscle-gain' && status === '正常' ? '在基线基础上温和增加 5%，结合训练与体重变化再调整。'
        : profile.goal === 'muscle-gain' ? '当前超重或肥胖，先采用维持参考，不额外增加增肌热量。'
          : '采用当前体重的基线作为维持起始参考，后续按实际变化调整。';
  return result;
}

/** Missing source on old data always preserves its existing manually entered target. */
export function initialCalorieTargetMode(profile: Profile): CalorieTargetMode {
  if (profile.calorieTargetSource) return profile.calorieTargetSource;
  return profile.calorieTarget === undefined ? 'recommended' : 'manual';
}

/** The displayed automatic value is derived on every edit; manual values never change here. */
export function effectiveCalorieTarget(profile: Profile, mode: CalorieTargetMode, manualValue: string): string {
  if (mode === 'manual') return manualValue;
  const target = calculateProfileHealth(profile).calories.target;
  return target === null ? '' : String(target);
}

export function profileFromForm(values: {
  goal: Goal | 'none'; height: string; weight: string; calories: string; calorieMode: CalorieTargetMode;
  sex?: Profile['sex'] | 'none'; age?: string;
}): Profile {
  const optional = (value: string, label: string): number | undefined => {
    const n = profileInputNumber(value);
    if (n !== undefined && (!Number.isFinite(n) || n <= 0)) throw new Error(`${label}需要是大于 0 的数字。`);
    return n;
  };
  const result: Profile = {
    goal: values.goal === 'none' ? undefined : values.goal,
    heightCm: optional(values.height, '身高'), weightKg: optional(values.weight, '体重'),
  };
  if (values.sex !== undefined && values.sex !== 'none') {
    if (values.sex !== 'male' && values.sex !== 'female') throw new Error('性别请选择暂不填写、男或女。');
    result.sex = values.sex;
  }
  const ageYears = profileInputNumber(values.age ?? '');
  const ageError = profileAgeValidationError(ageYears);
  if (ageError) throw new Error(ageError);
  if (ageYears !== undefined) result.ageYears = ageYears;
  const calories = effectiveCalorieTarget(result, values.calorieMode, values.calories);
  result.calorieTarget = optional(calories, '热量目标');
  // Do not add a source property to legacy/manual JSON. Keep auto intent even while incomplete.
  if (values.calorieMode === 'recommended') result.calorieTargetSource = 'recommended';
  else if (result.calorieTarget === undefined) result.calorieTargetSource = 'manual';
  return result;
}
