import { expect, type Locator, type Page, type Route } from '@playwright/test';

export const MOCK_AI_URL = 'https://provider.example/v1';
export const MOCK_AI_KEY = 'mock-key';
export const MOCK_AI_MODEL = 'mock-model';

/** Explicit v3 model output. Live provider fixtures must supply this field or null. */
export function mockNutritionEstimate(overrides: {
  method?: 'typical_recipe' | 'category';
  per100g?: { calories: { min: number; max: number }; protein: { min: number; max: number }; carbs: { min: number; max: number }; fat: { min: number; max: number } };
  recipeBasis?: string;
  assumptions?: string[];
  confidence?: number;
} = {}) {
  return {
    basisGrams: 100,
    method: 'typical_recipe' as 'typical_recipe' | 'category',
    per100g: {
      calories: { min: 130, max: 130 }, protein: { min: 2.7, max: 2.7 },
      carbs: { min: 28.2, max: 28.2 }, fat: { min: 0.3, max: 0.3 },
    },
    recipeBasis: '按熟白米饭的典型配方估算每 100 g 可食用成品。',
    assumptions: ['按煮熟后的可食用部分，不含额外油和酱料。'],
    confidence: 0.82,
    ...overrides,
  };
}

export type ProviderRequest = {
  url: string;
  method: string;
  authorization: string | undefined;
  body: Record<string, any> | null;
  record?: {
    kind: 'meal' | 'summary';
    data: Record<string, any>;
    reviewContext?: { stage?: string; [key: string]: unknown };
  };
};

type ProviderOptions = {
  models?: Record<string, unknown>[];
  details?: Record<string, Record<string, unknown>>;
  onModels?: (route: Route, request: ProviderRequest) => Promise<void>;
  onModel?: (route: Route, request: ProviderRequest, id: string) => Promise<void>;
  onResponse?: (route: Route, request: ProviderRequest) => Promise<void>;
};

export async function fulfillProviderJson(route: Route, value: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, content-type, accept',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    },
    body: JSON.stringify(value),
  });
}

export async function fulfillProviderResponse(route: Route, value: unknown) {
  // Keep older UI fixtures concise while exercising the current wire contract.
  // Callers that need to test the contract explicitly can pass an already
  // wrapped `{ kind, data }` value; all other fixture payloads are inferred as
  // meal data unless they only contain a summary `text` field.
  let wrapped = value && typeof value === 'object' &&
    ('kind' in value) && ('data' in value)
    ? value
    : value && typeof value === 'object' && 'text' in value && !('components' in value)
      ? { kind: 'summary', data: value }
      : { kind: 'meal', data: value };
  // The current photo UI uses the intentionally small frontend wire shape.
  // Migrate legacy fixtures in one place so older behavioural tests continue
  // to exercise the same production parser without asserting hidden fields.
  if (wrapped.kind === 'meal' && wrapped.data && typeof wrapped.data === 'object'
    && Array.isArray((wrapped.data as any).components)) {
    const data: any = wrapped.data;
    const components = data.components.map((component: any) => {
      const estimate = component.nutritionEstimate;
      const nutritionEstimate = estimate === null || estimate === undefined ? null : {
        method: estimate.method ?? 'typical_recipe',
        per100g: estimate.per100g,
        recipeBasis: estimate.recipeBasis ?? '按典型配方估算每 100 g 营养。',
        assumptions: (estimate.assumptions ?? []).slice(0, 2),
        confidence: estimate.confidence ?? 0.5,
      };
      return {
        label: component.label,
        cookingMethod: component.cookingMethod ?? component.preparation ?? null,
        confidence: component.confidence ?? 0.5,
        // Older UI fixtures predate model-proposed shares. Keep those fixtures
        // valid while allowing targeted tests to supply uneven AI estimates.
        recommendedShare: typeof component.recommendedShare === 'number'
          ? component.recommendedShare : 1 / data.components.length,
        nutritionEstimate,
        uncertainty: component.uncertainty ?? (nutritionEstimate ? [] : ['营养信息未知。']),
      };
    });
    wrapped = { kind: 'meal', data: { components, uncertainty: data.uncertainty ?? data.unresolved ?? [] } };
  }
  await fulfillProviderJson(route, {
    id: 'mock-response', object: 'response', status: 'completed',
    output: [{
      id: 'mock-message', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: JSON.stringify(wrapped), annotations: [] }],
    }],
  });
}

export async function installMockAiProvider(page: Page, options: ProviderOptions = {}) {
  const requests: ProviderRequest[] = [];
  const legacyRequests: string[] = [];
  await page.route('**/api/analyze**', async (route) => {
    legacyRequests.push(route.request().url());
    await route.abort();
  });
  await page.route('https://provider.example/**', async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      await fulfillProviderJson(route, {});
      return;
    }
    const body = request.postData() ? request.postDataJSON() : null;
    const captured: ProviderRequest = {
      url: request.url(), method: request.method(),
      authorization: request.headers().authorization, body,
    };
    const chatContent = body?.messages?.find((item: any) => item.role === 'user')?.content;
    const inputText = (Array.isArray(body?.input) ? body.input.flatMap((item: any) => item.content ?? []) : [])
      .find((item: any) => item.type === 'input_text')?.text
      ?? (typeof chatContent === 'string' ? chatContent
        : Array.isArray(chatContent) ? chatContent.find((item: any) => item.type === 'text')?.text : undefined);
    if (typeof inputText === 'string' && inputText.startsWith('JSON record:\n'))
      captured.record = JSON.parse(inputText.slice('JSON record:\n'.length));
    requests.push(captured);
    const pathname = new URL(captured.url).pathname;
    if (pathname.endsWith('/models')) {
      if (options.onModels) await options.onModels(route, captured);
      else await fulfillProviderJson(route, { object: 'list', data: options.models ?? [
        { id: MOCK_AI_MODEL, supported_reasoning_efforts: ['low', 'high'] },
      ] });
      return;
    }
    if (pathname.includes('/models/')) {
      const id = decodeURIComponent(pathname.slice(pathname.indexOf('/models/') + '/models/'.length));
      if (options.onModel) await options.onModel(route, captured, id);
      else await fulfillProviderJson(route, options.details?.[id] ?? { id });
      return;
    }
    if ((pathname.endsWith('/responses') || pathname.endsWith('/chat/completions')) && options.onResponse) {
      await options.onResponse(route, captured);
      return;
    }
    await fulfillProviderJson(route, { error: 'Unexpected mock endpoint' }, 404);
  });
  return {
    requests,
    legacyRequests,
    responses: () => requests.filter((request) => request.record),
  };
}

export async function openAiSettings(page: Page): Promise<Locator> {
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  await page.getByText('AI 服务设置', { exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('API 地址', { exact: true })).toBeVisible();
  return dialog;
}

export async function saveAiSettingsUi(page: Page) {
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

export async function configureMockAi(page: Page, model = MOCK_AI_MODEL, effort = 'high') {
  const dialog = await openAiSettings(page);
  await dialog.getByLabel('API 地址', { exact: true }).fill(MOCK_AI_URL);
  await dialog.getByLabel('API Key', { exact: true }).fill(MOCK_AI_KEY);
  await dialog.getByText('获取模型列表', { exact: true }).click();
  await dialog.getByRole('radio', { name: `模型 ${model}`, exact: true }).click();
  await dialog.getByRole('radio', { name: `推理强度 ${effort || '服务默认'}`, exact: true }).click();
  await saveAiSettingsUi(page);
  await page.getByRole('tab', { name: '今天', exact: true }).click();
}
