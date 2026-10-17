import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { parseBackupArchive } from '../src/backup';
import {
  configureMockAi,
  fulfillProviderResponse,
  installMockAiProvider,
  mockNutritionEstimate,
} from './helpers/mock-ai-provider';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a90sAAAAASUVORK5CYII=',
  'base64',
);

test('餐前照片分析自动回填表单并作为独立版本导出', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => { void dialog.accept(); });
  const provider = await installMockAiProvider(page, {
    onResponse: async (route) => fulfillProviderResponse(route, {
      foodName: '鸡肉米饭餐盘',
      confidence: 0.52,
      components: [
        {
          foodId: null,
          label: '鸡肉',
          category: 'meat',
          confidence: 0.45,
          nutritionEstimate: mockNutritionEstimate({
            method: 'category', confidence: 0.48,
            per100g: { calories: { min: 140, max: 240 }, protein: { min: 16, max: 25 }, carbs: { min: 0, max: 8 }, fat: { min: 7, max: 18 } },
            recipeBasis: '具体部位与做法不确定，按熟鸡肉菜品类别提供宽范围。',
            assumptions: ['烹调油和酱汁可能使脂肪、热量升高。'],
          }),
          candidates: [
            { foodId: 'chicken_roasted', label: '烤鸡肉', category: 'meat', confidence: 0.45 },
            { foodId: 'chicken_breast_raw', label: '生鸡胸肉', category: 'meat', confidence: 0.4 },
          ],
          evidence: [{ kind: 'visual', text: '餐盘中央可见鸡肉状主菜。' }],
          region: { x: 0.2, y: 0.2, width: 0.4, height: 0.4 },
          uncertainty: ['烹调油和具体部位未知'],
        },
        {
          foodId: 'rice_white_long_grain_cooked',
          label: '熟米饭',
          confidence: 0.86,
          category: 'grain',
          nutritionEstimate: mockNutritionEstimate(),
          candidates: [{ foodId: 'rice_white_long_grain_cooked', label: '熟白米饭', category: 'grain', confidence: 0.86 }],
          evidence: [{ kind: 'visual', text: '照片右侧可见熟米饭。' }],
          region: { x: 0.6, y: 0.2, width: 0.3, height: 0.5 },
          uncertainty: [],
        },
      ],
      unresolved: ['油和酱料尚未核实'],
      assumptions: ['照片不用于推断重量或实际食用量。'],
      advice: '按每道菜的营养参考填写实际数量。',
    }),
  });

  await page.goto('/');
  await configureMockAi(page);
  await page.getByText('记饮食', { exact: true }).click();

  const picker = page.waitForEvent('filechooser');
  await page.getByText('选择照片', { exact: true }).click();
  await (await picker).setFiles({ name: 'meal.png', mimeType: 'image/png', buffer: png });

  await expect(page.getByText('餐前照片', { exact: true })).toBeVisible();
  // A successful upload test requires the complete validated analysis to reach the form.
  await expect(page.getByText('照片识别完成，请核对。', { exact: true })).toBeVisible();
  await expect(page.getByText('识别到：鸡肉、熟米饭', { exact: true })).toBeVisible();
  await expect(page.getByText(/已提供 2 道菜的每 100 g AI 营养参考/)).toBeVisible();
  await expect(page.getByText('来源：AI按类别近似估算', { exact: true })).toBeVisible();
  await expect(page.getByText('来源：AI按典型配方估算', { exact: true })).toBeVisible();
  await expect(page.getByText(/每 100 g 可食用成品：热量 .*蛋白质 .*碳水 .*脂肪/)).toHaveCount(2);
  await expect(page.getByText('查看估算依据', { exact: true })).toBeVisible();
  await expect(page.getByText('油和酱料尚未核实', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '查看估算依据', exact: true }).click();
  await expect(page.getByText('待确认：油和酱料尚未核实', { exact: true })).toBeVisible();
  await expect(page.getByText(/每 100 g 可食用成品：热量 .*蛋白质 .*碳水 .*脂肪/).first()).toBeVisible();
  await expect(page.getByText(/本地家用换算：半碗熟米饭 ≈ 100 g/)).toBeVisible();
  await expect(page.getByLabel('食物名称', { exact: true })).toHaveValue('鸡肉米饭餐盘');
  await expect(page.getByLabel('份量或参考物（可选）', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('备注（可选）', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('热量 kcal', { exact: true })).toHaveValue('');

  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.getByRole('tab', { name: '我的', exact: true }).click();
  const downloadEvent = page.waitForEvent('download');
  await page.getByText('导出完整备份', { exact: true }).click();
  const download = await downloadEvent;
  const backup = await parseBackupArchive(
    new Uint8Array(await readFile((await download.path())!)),
  );
  expect(backup.data.meals).toHaveLength(1);
  expect(backup.data.meals[0]).toMatchObject({
    foodName: '鸡肉米饭餐盘',
    portion: '',
    note: '',
    estimateStatus: 'unknown',
  });
  expect(backup.data.meals[0].analyses?.[0]).toMatchObject({
    model: 'mock-model',
    analysis: { foodName: '鸡肉米饭餐盘', status: 'unknown', calories: null, protein: null, carbs: null, fat: null,
      components: [{ label: '鸡肉', grams: null, userQuantity: null }, { label: '熟米饭', grams: null, userQuantity: null }] },
  });
  const requests = provider.responses();
  expect(requests).toHaveLength(2);
  expect(requests[0].body?.input[0].content.filter((part: { type: string }) => part.type === 'input_image'))
    .toMatchObject([{ detail: 'low' }]);
  expect(requests[1].record?.reviewContext?.stage).toBe('crop_review');
  for (const request of requests) {
    expect(request.body).toMatchObject({ stream: true, model: 'mock-model', reasoning: { effort: 'high' } });
  }
  expect(requests[0].body).toMatchObject({ max_output_tokens: 8192 });
  expect(requests[0].record?.data.photoRoles).toEqual(['before']);
  expect(errors).toEqual([]);
});

test('80 秒后收到的完整响应仍保持等待并完成餐食回填', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => { void dialog.accept(); });
  let finishProvider: (() => Promise<void>) | undefined;
  const provider = await installMockAiProvider(page, {
    onResponse: async (route) => new Promise<void>((resolve) => {
      finishProvider = async () => {
        await fulfillProviderResponse(route, {
          foodName: '慢响应餐食', components: [], unresolved: [], assumptions: [],
          advice: '完整响应后再确认。', confidence: 0.9,
        });
        resolve();
      };
    }),
  });

  await page.goto('/');
  await configureMockAi(page);
  await page.clock.install();
  await page.getByText('记饮食', { exact: true }).click();
  const picker = page.waitForEvent('filechooser');
  await page.getByText('选择照片', { exact: true }).click();
  await (await picker).setFiles({ name: 'slow-meal.png', mimeType: 'image/png', buffer: png });
  await expect.poll(() => provider.responses().length).toBe(1);

  await page.clock.fastForward(80_000);
  await expect(page.getByText('照片分析已等待 30 秒，仍在处理中。', { exact: true })).toBeVisible();
  await expect(page.getByText('照片识别完成，请核对。', { exact: true })).toHaveCount(0);
  expect(typeof finishProvider).toBe('function');
  await finishProvider!();

  await expect(page.getByText('照片识别完成，请核对。', { exact: true })).toBeVisible();
  await expect(page.getByLabel('食物名称', { exact: true })).toHaveValue('慢响应餐食');
  expect(provider.responses()).toHaveLength(1);
  expect(errors).toEqual([]);
});
