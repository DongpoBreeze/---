import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { parseBackupArchive } from '../src/backup';
import { configureMockAi, fulfillProviderResponse, installMockAiProvider, MOCK_AI_KEY, MOCK_AI_MODEL } from './helpers/mock-ai-provider';

test('local nutrition correction keeps unknown analysis and portable history', async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  const interceptedKinds: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('dialog', (dialog) => { void dialog.accept(); });
  const provider = await installMockAiProvider(page, {
    onResponse: async (route, request) => {
      interceptedKinds.push(request.record!.kind);
      await fulfillProviderResponse(route, {
        foodName: '模拟未知餐食',
        confidence: 0.92,
        components: [{
          foodId: 'rice_white_long_grain_cooked', label: '熟白米饭', category: 'grain', confidence: 0.92,
          candidates: [{ foodId: 'rice_white_long_grain_cooked', label: '熟白米饭', category: 'grain', confidence: 0.92 }],
          evidence: [{ kind: 'visual', text: '可见一份熟白米饭。' }], region: { x: 0.2, y: 0.2, width: 0.5, height: 0.5 }, uncertainty: [],
        }],
        unresolved: [], assumptions: ['照片不用于推断菜品重量或食用数量。'], advice: '每道菜数量由用户填写。',
      });
    },
  });
  await page.goto('/');
  await page.getByRole('tab', { name: '我的', exact: true }).click();
  await page.getByText('删除本机数据', { exact: true }).click();
  await expect(page.getByText('尚未配置', { exact: true })).toBeVisible();
  await configureMockAi(page);
  await page.getByRole('tab', { name: '今天', exact: true }).click();
  await page.getByText('记饮食', { exact: true }).click();
  await page.getByLabel('食物名称', { exact: true }).fill('校正测试餐');
  await page.getByLabel('份量或参考物（可选）', { exact: true }).fill('原始记录：一碗米饭');
  await page.getByLabel('剩余量（可选）', { exact: true }).fill('原始记录：剩约一半');
  await page.getByLabel('备注（可选）', { exact: true }).fill('保留原始输入校正验收');
  await page.getByText('保存', { exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('tab', { name: '记录', exact: true }).click();
  await page.getByLabel('请求饮食分析', { exact: true }).click();
  await expect(page.getByText('这餐的分析已保存为独立版本。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /校正测试餐 午餐/ }).click();
  await expect(page.getByText('饮食分析', { exact: true })).toBeVisible();
  await expect(page.getByText('待填写菜品数量', { exact: true })).toBeVisible();
  await expect(page.getByText(/每 100 g：130 kcal/)).toBeVisible();
  await expect(page.getByText(/参考份量：半碗熟米饭 ≈ 100 g/)).toBeVisible();
  await page.getByRole('button', { name: '填写菜品数量', exact: true }).click();
  await expect(page.getByLabel('食材 1 数量', { exact: true })).toBeVisible();
  await page.getByLabel('食材 1 数量', { exact: true }).fill('200');
  await page.getByLabel('我已确认所有食物、油和酱料均已列出', { exact: true }).click();
  await page.getByLabel('保存营养校正', { exact: true }).click();
  await expect(page.getByLabel('保存营养校正', { exact: true })).toHaveCount(0);
  await expect(page.getByText('当前分析', { exact: true })).toBeVisible();
  await expect(page.getByText(/热量.*260 kcal/)).toBeVisible();
  await expect(page.getByText('查看 1 个历史分析', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('corrected-nutrition.png'), fullPage: true });
  // The correction sheet closes after committing, while the parent meal editor
  // remains open so the user can inspect the new analysis before leaving.
  await page.getByLabel('关闭', { exact: true }).click();
  await page.reload();
  await page.getByRole('tab', { name: '记录', exact: true }).click();
  await page.getByText('校正测试餐', { exact: true }).click();
  await expect(page.getByRole('button', { name: '填写菜品数量', exact: true })).toBeVisible();
  await page.getByRole('dialog').getByLabel('关闭', { exact: true }).click();
  await expect(page.getByText('编辑饮食', { exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: '我的', exact: true }).click();
  const downloadEvent = page.waitForEvent('download');
  await page.getByText('导出完整备份', { exact: true }).click();
  const download = await downloadEvent;
  await download.saveAs(testInfo.outputPath('nutrition-before-restore.zip'));
  const backupBytes = await readFile(testInfo.outputPath('nutrition-before-restore.zip'));
  const backup = await parseBackupArchive(new Uint8Array(backupBytes));
  expect(backup.data.meals).toHaveLength(1);
  const originalMeal = backup.data.meals[0];
  expect(originalMeal).toMatchObject({
    foodName: '校正测试餐', portion: '原始记录：一碗米饭', remaining: '原始记录：剩约一半',
    note: '保留原始输入校正验收', revision: 1, source: 'manual', estimateStatus: 'unknown',
  });
  const analyses = originalMeal.analyses ?? [];
  expect(analyses).toHaveLength(2);
  expect(analyses[0].model).toBe(MOCK_AI_MODEL);
  expect(analyses[0].analysis).toMatchObject({
    status: 'unknown', calories: null, protein: null, carbs: null, fat: null,
    components: [{ label: '熟白米饭', grams: null, userQuantity: null, source: { provider: 'usda-fdc', fdcId: '168878' } }],
    unresolved: [], assumptions: ['照片不用于推断菜品重量或食用数量。'],
    nutritionSource: { provider: 'usda-fdc', coverage: 'incomplete', method: 'user-quantity-v2' },
  });
  expect(analyses[1].model).toBe('local/usda-user-quantity-v2');
  expect(analyses[1].id).not.toBe(analyses[0].id);
  expect(analyses.map((analysis) => analysis.sourceVersion)).toEqual([1, 1]);
  expect(analyses[1].analysis).toMatchObject({
    status: 'estimated', calories: { min: 260, max: 260 }, unresolved: [],
    components: [{
      foodId: 'rice_white_long_grain_cooked', label: '熟白米饭', grams: null, userQuantity: { amount: 200, unit: 'g' },
      uncertainty: [], source: { provider: 'usda-fdc', fdcId: '168878' },
    }],
    nutritionSource: { provider: 'usda-fdc', coverage: 'complete' },
  });

  await page.getByText('删除本机数据', { exact: true }).click();
  await page.getByRole('tab', { name: '记录', exact: true }).click();
  await expect(page.getByText('校正测试餐', { exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: '我的', exact: true }).click();

  for (let index = 0; index < 2; index += 1) {
    const restored = page.waitForEvent('dialog', {
      predicate: (dialog) => dialog.message().includes('恢复完成'),
    });
    const picker = page.waitForEvent('filechooser');
    await page.getByText('恢复备份', { exact: true }).click();
    await (await picker).setFiles({
      name: 'nutrition-correction-backup.zip',
      mimeType: 'application/zip',
      buffer: backupBytes,
    });
    await restored;
  }

  await page.getByRole('tab', { name: '记录', exact: true }).click();
  await expect(page.getByText('校正测试餐', { exact: true })).toHaveCount(1);
  await page.getByText('校正测试餐', { exact: true }).click();
  await expect(page.getByText(/热量.*260 kcal/)).toBeVisible();
  await expect(page.getByText('查看 1 个历史分析', { exact: true })).toBeVisible();
  await expect(page.getByText(/营养来源：USDA 食品数据库/)).toBeVisible();
  await page.getByRole('dialog').getByLabel('关闭', { exact: true }).click();
  await page.reload();
  await page.getByRole('tab', { name: '记录', exact: true }).click();
  await page.getByText('校正测试餐', { exact: true }).click();
  await expect(page.getByText(/热量.*260 kcal/)).toBeVisible();
  await expect(page.getByText('查看 1 个历史分析', { exact: true })).toBeVisible();
  await page.getByText('查看 1 个历史分析', { exact: true }).click();
  await expect(page.getByText('历史分析 · 输入版本 1', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '查看估算依据', exact: true }).last().click();
  await expect(page.getByText(/菜品：熟白米饭 · 尚未填写数量/)).toBeVisible();
  await expect(page.getByText(/未计入（未填数量）：熟白米饭/)).toBeVisible();
  await page.getByText(/未计入（未填数量）：熟白米饭/).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('restored-nutrition-history.png'), fullPage: true });
  await page.getByRole('dialog').getByLabel('关闭', { exact: true }).click();
  await page.getByRole('tab', { name: '我的', exact: true }).click();
  const restoredDownloadEvent = page.waitForEvent('download');
  await page.getByText('导出完整备份', { exact: true }).click();
  const restoredDownload = await restoredDownloadEvent;
  await restoredDownload.saveAs(testInfo.outputPath('nutrition-after-restore.zip'));
  const restoredBackup = await parseBackupArchive(new Uint8Array(await readFile(testInfo.outputPath('nutrition-after-restore.zip'))));
  expect(restoredBackup.data.meals).toEqual([originalMeal]);
  expect(interceptedKinds).toEqual(['meal']);
  expect(provider.responses()[0].body).toMatchObject({ model: MOCK_AI_MODEL, reasoning: { effort: 'high' } });
  expect(provider.responses()[0].authorization).toBe(`Bearer ${MOCK_AI_KEY}`);
  expect(provider.legacyRequests).toEqual([]);
  expect(JSON.stringify(backup)).not.toContain(MOCK_AI_KEY);
  expect(JSON.stringify(restoredBackup)).not.toContain(MOCK_AI_KEY);
  expect(pageErrors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});
