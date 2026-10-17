import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { parseBackupArchive } from '../src/backup';
import { configureMockAi, fulfillProviderResponse, installMockAiProvider, MOCK_AI_KEY, MOCK_AI_MODEL, MOCK_AI_URL } from './helpers/mock-ai-provider';

test('AI versions preserve source input and reject responses after record changes', async ({ page }, testInfo) => {
  page.on('dialog', (dialog) => { void dialog.accept(); });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let delayed = false;
  let release: (() => Promise<void>) | undefined;
  let latestInput: { kind: string; payload: { summary?: string; profile: object } };
  const interceptedKinds: string[] = [];
  const provider = await installMockAiProvider(page, {
    onResponse: async (route, request) => {
      latestInput = { kind: request.record!.kind, payload: request.record!.data as { summary?: string; profile: object } };
      interceptedKinds.push(latestInput.kind);
      const content = latestInput.kind === 'meal'
        ? { foodName: '模拟识别餐食', components: [{ foodId: null, label: '未知酱料', grams: null, quantitySource: 'unknown', consumedFraction: null, uncertainty: ['重量和食用比例未知'] }], unresolved: ['未知酱料尚未匹配'], assumptions: ['仅测试输出'], advice: '模拟饮食反馈' }
        : { text: delayed ? '过期测试总结' : '模拟综合总结' };
      const respond = () => fulfillProviderResponse(route, content);
      if (delayed) release = respond;
      else await respond();
    },
  });
  await page.goto('/');
  await configureMockAi(page);
  await page.getByText('记饮食', { exact: true }).click();
  await page.getByLabel('食物名称', { exact: true }).fill('原始餐食');
  await page.getByText('保存', { exact: true }).click();
  await expect(page.getByLabel('食物名称', { exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: '记录', exact: true }).click();
  await page.getByLabel('请求饮食分析', { exact: true }).click();
  await expect(page.getByText('这餐的分析已保存为独立版本。', { exact: true })).toBeVisible();
  await expect(page.getByText('原始餐食', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '今天', exact: true }).click();
  await page.getByText('请求 AI 综合分析', { exact: true }).click();
  await expect(page.getByText('AI 总结已保存为独立版本。', { exact: true })).toBeVisible();
  expect(latestInput!.kind).toBe('summary');
  expect(latestInput!.payload.summary).toContain('原始餐食');
  await page.screenshot({ path: testInfo.outputPath('ai-summary.png'), fullPage: true });
  await page.getByLabel('打开我的资料', { exact: true }).click();
  await page.getByText('增肌', { exact: true }).click();
  await page.getByText('保存', { exact: true }).click();
  await expect(page.getByText('目标与资料', { exact: true })).toHaveCount(0);
  delayed = true;
  await page.getByText('请求 AI 综合分析', { exact: true }).click();
  await expect.poll(() => Boolean(release)).toBe(true);
  expect(latestInput!.payload.profile).toMatchObject({ goal: 'muscle-gain' });
  await page.getByText('记饮食', { exact: true }).click();
  await page.getByLabel('食物名称', { exact: true }).fill('新增晚餐');
  await page.getByText('保存', { exact: true }).click();
  await expect(page.getByLabel('食物名称', { exact: true })).toHaveCount(0);
  await release!();
  await expect(page.getByText('记录在分析期间发生变化，请重新发起分析。', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '我的', exact: true }).click();
  const downloadEvent = page.waitForEvent('download');
  await page.getByText('导出完整备份', { exact: true }).click();
  const download = await downloadEvent;
  const backup = await parseBackupArchive(new Uint8Array(await readFile((await download.path())!)));
  expect(backup.data.meals[1].foodName).toBe('原始餐食');
  expect(backup.data.meals[1].analyses?.[0].model).toBe(MOCK_AI_MODEL);
  const summaries = backup.data.summaries.filter((entry) => entry.source === 'ai');
  expect(summaries).toHaveLength(1);
  expect(summaries[0].status).toBe('stale');
  expect(summaries[0].inputSnapshot?.profile).toEqual({});
  expect(summaries[0].markdown).toBe('模拟综合总结');
  expect(interceptedKinds).toEqual(['meal', 'summary', 'summary']);
  for (const request of provider.responses()) {
    expect(request.url).toBe(`${MOCK_AI_URL}/responses`);
    expect(request.authorization).toBe(`Bearer ${MOCK_AI_KEY}`);
    expect(request.body).toMatchObject({ model: MOCK_AI_MODEL, reasoning: { effort: 'high' }, store: false });
  }
  expect(provider.legacyRequests).toEqual([]);
  expect(errors).toEqual([]);
});
