import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { parseBackupArchive } from '../src/backup';
import { expectPortionFormula } from './helpers/meal-estimated-portion';
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

test('餐前照片分析经过确认回填表单并作为独立版本导出', async ({ page }) => {
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

  // A complete validated response opens review before it can change the form.
  await expect(page.getByText('照片识别完成，请核对。', { exact: true })).toBeVisible();
  await expect(page.getByTestId('ai-meal-review')).toBeVisible();
  await expect(page.getByLabel('食物名称', { exact: true })).toHaveCount(0);
  const quantities = [
    Number(await page.getByLabel('菜品 1 食用量', { exact: true }).inputValue()),
    Number(await page.getByLabel('菜品 2 食用量', { exact: true }).inputValue()),
  ];
  expect(quantities[0]).toBeGreaterThan(0);
  expect(quantities[1]).toBe(quantities[0]);
  await page.getByRole('button', { name: '确认填入', exact: true }).click();
  await expect(page.getByTestId('meal-confirmation-summary')).toHaveCount(0);
  await expect(page.getByTestId('meal-edit-portions')).toBeVisible();
  await expect(page.getByText('餐前照片', { exact: true })).toBeVisible();
  await expect(page.getByText('菜品与营养', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('实际食用量（g）', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/识别到：|识别置信度|查看估算依据|配方依据：|估算假设：|识别候选：|照片区域：/)).toHaveCount(0);
  await expect(page.getByText('油和酱料尚未核实', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('食物名称', { exact: true })).toHaveValue('鸡肉、熟米饭');
  await expect(page.getByLabel('份量或参考物（可选）', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('剩余量（可选）', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('备注（可选）', { exact: true })).toHaveValue('');
  await expectPortionFormula(page, [
    { grams: quantities[0], per100g: { calories: { min: 140, max: 240 }, protein: { min: 16, max: 25 }, carbs: { min: 0, max: 8 }, fat: { min: 7, max: 18 } } },
    { grams: quantities[1], per100g: mockNutritionEstimate().per100g },
  ]);

  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.getByRole('tab', { name: '设置', exact: true }).click();
  const downloadEvent = page.waitForEvent('download');
  await page.getByText('导出完整备份', { exact: true }).click();
  const download = await downloadEvent;
  const backup = await parseBackupArchive(
    new Uint8Array(await readFile((await download.path())!)),
  );
  expect(backup.data.meals).toHaveLength(1);
  expect(backup.data.meals[0]).toMatchObject({
    foodName: '鸡肉、熟米饭',
    portion: '',
    note: '',
    estimateStatus: 'unknown',
  });
  const versions = backup.data.meals[0].analyses!;
  const aiVersion = versions.find((version) => version.model === 'mock-model');
  expect(aiVersion).toBeDefined();
  expect(aiVersion).toMatchObject({
    // The frontend protocol derives the title from dish labels; the legacy
    // fixture's foodName is not part of the actual model response.
    analysis: { foodName: '鸡肉、熟米饭', status: 'unknown', calories: null, protein: null, carbs: null, fat: null,
      components: [{ label: '鸡肉', grams: null, userQuantity: null }, { label: '熟米饭', grams: null, userQuantity: null }] },
  });
  expect(versions.at(-1)).toMatchObject({
    model: 'local/meal-review',
    analysis: { foodName: '鸡肉、熟米饭', status: 'approximate',
      components: [
        { label: '鸡肉', grams: null, userQuantity: { amount: quantities[0], unit: 'g', origin: 'estimated' } },
        { label: '熟米饭', grams: null, userQuantity: { amount: quantities[1], unit: 'g', origin: 'estimated' } },
      ] },
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

test('实时显示等待秒数，110 秒后收到完整响应仍可确认餐食回填', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => { void dialog.accept(); });
  let finishProvider: (() => Promise<void>) | undefined;
  const provider = await installMockAiProvider(page, {
    onResponse: async (route) => new Promise<void>((resolve) => {
      finishProvider = async () => {
        await fulfillProviderResponse(route, {
          foodName: '慢响应餐食', components: [{
            label: '慢响应餐食', cookingMethod: '蒸煮', confidence: 0.9,
            nutritionEstimate: mockNutritionEstimate(), uncertainty: [],
          }], unresolved: [], assumptions: [],
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

  const waitTime = page.getByTestId('analysis-wait-time');
  await expect(waitTime).toContainText('单次请求上限 120 秒');
  await page.clock.fastForward(35_000);
  await expect(waitTime).toHaveText(/已等待 3[5-7] 秒 · 单次请求上限 120 秒/);
  await page.clock.fastForward(75_000);
  await expect(waitTime).toHaveText(/已等待 11[0-2] 秒 · 单次请求上限 120 秒/);
  await expect(page.getByText('照片识别完成，请核对。', { exact: true })).toHaveCount(0);
  expect(typeof finishProvider).toBe('function');
  await finishProvider!();

  await expect(page.getByText('照片识别完成，请核对。', { exact: true })).toBeVisible();
  await expect(waitTime).toHaveCount(0);
  await expect(page.getByTestId('ai-meal-review')).toBeVisible();
  await expect(page.getByLabel('食物名称', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '确认填入', exact: true }).click();
  await expect(page.getByLabel('食物名称', { exact: true })).toHaveValue('慢响应餐食');
  expect(provider.responses()).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('取消后计时停止，新请求重新计时并在120秒超时，迟到结果不回填', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => { void dialog.accept(); });
  const finishes: Array<() => Promise<void>> = [];
  const provider = await installMockAiProvider(page, {
    onResponse: async (route) => {
      finishes.push(async () => fulfillProviderResponse(route, {
        components: [{ label: '迟到米饭', cookingMethod: '蒸煮', confidence: 0.95,
          nutritionEstimate: mockNutritionEstimate(), uncertainty: [] }], uncertainty: [],
      }));
    },
  });
  await page.goto('/');
  await configureMockAi(page);
  await page.clock.install();
  await page.getByText('记饮食', { exact: true }).click();
  await page.getByLabel('食物名称', { exact: true }).fill('保留原始输入');
  const picker = page.waitForEvent('filechooser');
  await page.getByText('选择照片', { exact: true }).click();
  await (await picker).setFiles({ name: 'timeout-meal.png', mimeType: 'image/png', buffer: png });
  await expect.poll(() => provider.responses().length).toBe(1);
  const waitTime = page.getByTestId('analysis-wait-time');
  await page.clock.fastForward(7_000);
  await expect(waitTime).toHaveText(/已等待 [7-9] 秒 · 单次请求上限 120 秒/);
  await page.getByRole('button', { name: '取消照片分析', exact: true }).click();
  await expect(waitTime).toHaveCount(0);
  await expect(page.getByText('照片分析已取消，照片和输入已保留。', { exact: true })).toBeVisible();
  await finishes[0]();
  await page.clock.fastForward(10_000);
  await expect(waitTime).toHaveCount(0);
  await expect(page.getByLabel('食物名称', { exact: true })).toHaveValue('保留原始输入');

  await page.getByRole('button', { name: '重新识别照片', exact: true }).click();
  await expect.poll(() => provider.responses().length).toBe(2);
  await expect(waitTime).toHaveText(/已等待 [0-2] 秒 · 单次请求上限 120 秒/);
  await page.clock.fastForward(119_000);
  await expect(page.getByRole('button', { name: '取消照片分析', exact: true })).toBeVisible();
  await page.clock.fastForward(1_001);
  await expect(page.getByText(/照片识别失败：服务等待超时/)).toBeVisible();
  await expect(waitTime).toHaveCount(0);
  await finishes[1]();
  await page.clock.fastForward(5_000);
  await expect(page.getByLabel('食物名称', { exact: true })).toHaveValue('保留原始输入');
  await expect(page.getByText('餐前照片', { exact: true })).toBeVisible();
  await expect(page.getByText('菜品与营养', { exact: true })).toHaveCount(0);
  expect(provider.responses()).toHaveLength(2);
  expect(errors).toEqual([]);
});
