import { readFileSync } from 'node:fs';
import { calculateMealNutrition, hasMealIdentityConflict, validateMealRecognition } from '../shared/nutrition.mjs';

const usdaDataset = JSON.parse(readFileSync(new URL('../data/nutrition/usda-sr-legacy.json', import.meta.url), 'utf8'));
const categoryData = JSON.parse(readFileSync(new URL('../data/nutrition/category-ranges.json', import.meta.url), 'utf8'));
export const nutritionDataset = { ...usdaDataset, categories: categoryData.categories, aliases: categoryData.aliases, householdMeasures: categoryData.householdMeasures };
export const nutritionCatalog = nutritionDataset.foods.map(({ id, label, aliases, description, preparation }) => ({ id, label, aliases, description, preparation }));

export function analyseRecognition(value) {
  const recognition = validateMealRecognition(value);
  const allowed = new Set(nutritionCatalog.map((food) => food.id));
  if (recognition.components.some((component) => component.foodId !== null && !allowed.has(component.foodId)
    || component.candidates?.some((candidate) => candidate.foodId !== null && !allowed.has(candidate.foodId)))) {
    throw new TypeError('Unlisted nutrition candidate.');
  }
  const components = recognition.components.map((component) => {
    if (component.foodId === null || !hasMealIdentityConflict(component)) return component;
    return { ...component, foodId: null };
  });
  return calculateMealNutrition({ ...recognition, components }, nutritionDataset, { mode: 'user-quantity-v2' });
}
