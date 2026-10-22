import { expect, type Locator, type Page } from '@playwright/test';

/**
 * The meal form's four nutrition inputs. Once an analysis is confirmed the form
 * shows a read-only summary and the inputs sit behind “修改营养值”; reopening a
 * saved meal starts on the summary again. This opens the editor when needed.
 * Retries because draft hydration can swap the inputs for the summary after
 * the first render.
 */
export async function nutritionInput(page: Page, label: string): Promise<Locator> {
  const field = page.getByLabel(label, { exact: true });
  const edit = page.getByRole('button', { name: '修改营养值', exact: true });
  await expect(async () => {
    if (!(await field.isVisible()) && await edit.isVisible()) await edit.click();
    await expect(field).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 10_000 });
  return field;
}
