import type { MealAnalysis } from './types';

function formatNumber(value: number) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(1)));
}

function formatRange(range: { min: number; max: number } | null | undefined, unit = '') {
  if (!range) return '';
  const value = range.min === range.max ? formatNumber(range.min) : `${formatNumber(range.min)}～${formatNumber(range.max)}`;
  return `${value}${unit}`;
}

export type MealPhotoAutofill = {
  foodName: string;
  portion: string;
};

export function mealPhotoAutofill(analysis: MealAnalysis): MealPhotoAutofill {
  const portion = '';
  return {
    foodName: analysis.foodName.trim(),
    portion,
  };
}

export function mealPhotoEstimateText(analysis: MealAnalysis) {
  if (analysis.nutritionSource?.method === 'user-quantity-v2') {
    const refs = (analysis.components ?? []).filter((item) => item.source).length;
    return refs
      ? `已提供 ${refs} 道菜的每 100 g 本地营养参考；填写各道菜数量后计算已填小计。`
      : '当前只完成菜品识别；填写菜品数量并匹配营养参考后，才会计算营养小计。';
  }
  const rows = [
    ['热量', analysis.calories, 'kcal'],
    ['蛋白质', analysis.protein, 'g'],
    ['碳水', analysis.carbs, 'g'],
    ['脂肪', analysis.fat, 'g'],
  ] as const;
  return rows.map(([label, value, unit]) => `${label} ${value ? `约 ${formatRange(value, unit)}` : '未知'}`).join(' · ');
}

export function mealPhotoConfidenceLabel(confidence: number | undefined) {
  if (confidence === undefined) return '置信度未知';
  if (confidence >= 0.8) return '高置信度';
  if (confidence >= 0.55) return '中置信度';
  return '低置信度';
}
