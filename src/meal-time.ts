import type { MealRecord } from "./types";

/**
 * Select the default meal slot from the user's local 24-hour clock.
 * Breakfast/lunch/dinner use common eating windows; the remaining hours are snacks.
 */
export function defaultMealTypeForHour(hour: number): MealRecord["mealType"] {
  const normalized = Number.isFinite(hour) ? Math.floor(hour) : 0;
  if (normalized >= 5 && normalized < 11) return "早餐";
  if (normalized >= 11 && normalized < 15) return "午餐";
  if (normalized >= 17 && normalized < 22) return "晚餐";
  return "加餐";
}

export function defaultMealTypeForNow(date: Date = new Date()): MealRecord["mealType"] {
  return defaultMealTypeForHour(date.getHours());
}
