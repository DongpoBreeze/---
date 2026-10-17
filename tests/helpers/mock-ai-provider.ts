import { expect, type Locator, type Page, type Route } from '@playwright/test';

export const MOCK_AI_URL = 'https://provider.example/v1';
export const MOCK_AI_KEY = 'mock-key';
export const MOCK_AI_MODEL = 'mock-model';

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
  await fulfillProviderJson(route, {
    id: 'mock-response', object: 'response', status: 'completed',
    output: [{
      id: 'mock-message', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: JSON.stringify(value), annotations: [] }],
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
    const inputText = body?.input?.flatMap((item: any) => item.content ?? [])
      .find((item: any) => item.type === 'input_text')?.text;
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
      await fulfillProviderJson(route, options.details?.[id] ?? { id });
      return;
    }
    if (pathname.endsWith('/responses') && options.onResponse) {
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
  await page.getByRole('tab', { name: '我的', exact: true }).click();
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
