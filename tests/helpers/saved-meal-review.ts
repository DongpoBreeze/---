import { expect, type Page } from '@playwright/test';

/** Complete the explicit saved-record review before asserting committed data. */
export async function confirmAndSaveMealReview(page: Page, options: {
  clearQuantities?: boolean;
  foodName?: string;
} = {}) {
  const review = page.getByTestId('ai-meal-review');
  await expect(review).toBeVisible();
  if (options.clearQuantities) {
    const quantities = review.getByLabel(/^菜品 \d+ 食用(?:量|份数)$/);
    for (const field of await quantities.all()) await field.fill('');
  }
  await review.getByRole('button', { name: '确认填入', exact: true }).click();
  await expect(review).toHaveCount(0);
  const form = page.getByRole('dialog');
  if (options.foodName !== undefined) {
    await form.getByLabel('食物名称', { exact: true }).fill(options.foodName);
  }
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(form).toHaveCount(0);
}
