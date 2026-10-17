import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createAppServer } from './index.mjs';
import { normalizeConfig, parseConfig, isConfigured, currencyMicros } from './config.mjs';
import { BudgetLedger } from './ledger.mjs';
import { GatewayError, normaliseAnalysis } from './protocol.mjs';

const accessToken = 'test-access-token';
const jpeg = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
const modelNutritionEstimate = { basisGrams: 100, method: 'typical_recipe', per100g: {
  calories: { min: 120, max: 150 }, protein: { min: 2, max: 4 }, carbs: { min: 24, max: 32 }, fat: { min: 0, max: 1 },
}, recipeBasis: '按通常熟米饭配方与含水量估计。', assumptions: ['含水量有差异。'], confidence: 0.8 };
const mealResult = {
  foodName: '米饭', components: [{ foodId: 'rice_white_long_grain_cooked', label: '熟白米饭',
    uncertainty: [], category: 'grain', confidence: 0.9, nutritionEstimate: modelNutritionEstimate }], confidence: 0.9,
  unresolved: [],
  assumptions: [], advice: '按每 100 g 参考，填写菜品数量后计算。',
};
const unknownResult = {
  foodName: '无法识别', components: [], unresolved: ['照片和份量信息不足'],
  assumptions: ['照片和份量信息不足'], advice: '补充食物名称与份量后再分析。',
};

function input(requestId = 'request-1', installationId = 'install-1', kind = 'meal', payload = { title: '面条' }) {
  return { requestId, installationId, kind, payload };
}

function config(dbPath, modelApiUrl = 'http://127.0.0.1:1/v1/chat/completions', overrides = {}) {
  return normalizeConfig({
    port: 0, host: '127.0.0.1', accessToken,
    modelApiUrl, modelApiKey: 'mock-upstream-key', modelName: 'mock-vision',
    monthlyBudgetCny: 10, fixedMonthlyCostCny: 0, nonAiMonthlyCostCny: 0, safetyReserveCny: 0,
    maxRequestCostCny: 1, dailyQuota: 10,
    upstreamTimeoutMs: 500, bodyTimeoutMs: 500,
    dbPath, ...overrides,
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

async function api(url, value, options = {}) {
  const response = await fetch(`${url}/api/analyze`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', ...options.headers },
    body: options.body ?? JSON.stringify(value),
    signal: AbortSignal.timeout(5000),
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

async function withFixture(overrides, behavior, run) {
  const directory = mkdtempSync(join(tmpdir(), 'health-gateway-'));
  const calls = [];
  let runtime;
  let upstream;
  try {
    upstream = createServer(async (request, response) => {
      try {
        let body = '';
        for await (const part of request) body += part;
        const parsed = JSON.parse(body);
        calls.push({ body: parsed, headers: request.headers });
        const action = behavior ? await behavior(parsed, calls.length) : {};
        if (action.delayMs) await delay(action.delayMs);
        if (response.destroyed) return;
        response.writeHead(action.status || 200, { 'Content-Type': 'application/json' });
        const isMeal = parsed.messages[0].content.includes('foodName');
        response.end(action.raw ?? JSON.stringify({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant',
          content: action.content ?? JSON.stringify(isMeal ? mealResult : { text: '仅根据已记录内容生成的总结。' }),
        } }] }));
      } catch {
        if (!response.headersSent && !response.destroyed) { response.writeHead(500); response.end('{}'); }
      }
    });
    const upstreamUrl = await listen(upstream);
    const gatewayConfig = config(join(directory, 'ledger.sqlite'), `${upstreamUrl}/v1/chat/completions`, overrides);
    runtime = createAppServer({ config: gatewayConfig });
    const url = await listen(runtime.server);
    await run({ url, runtime, calls, directory, gatewayConfig });
  } finally {
    try { if (runtime?.server.listening) await close(runtime.server); }
    finally {
      try { if (upstream?.listening) await close(upstream); }
      finally { rmSync(directory, { recursive: true, force: true }); }
    }
  }
}

test('configuration is fail-closed and rejects invalid pricing or unbounded settings', () => {
  const configured = {
    SERVER_ACCESS_TOKEN: accessToken, MODEL_API_URL: 'https://example.com/v1/chat/completions',
    MODEL_API_KEY: 'test-key', MODEL_NAME: 'vision',
  };
  assert.equal(isConfigured(parseConfig(configured)), false);
  assert.equal(isConfigured(parseConfig({ ...configured, MAX_REQUEST_COST_CNY: '' })), false);
  assert.equal(isConfigured(parseConfig({ ...configured, MAX_REQUEST_COST_CNY: '0.5' })), true);
  assert.throws(() => parseConfig({ MAX_REQUEST_COST_CNY: '0' }), /positive/);
  assert.throws(() => parseConfig({ MAX_REQUEST_COST_CNY: '-1' }), /Invalid/);
  assert.throws(() => parseConfig({ MONTHLY_BUDGET_CNY: 'NaN' }), /Invalid/);
  assert.throws(() => parseConfig({ MODEL_MAX_OUTPUT_TOKENS: '99999999' }), /Invalid/);
  assert.throws(() => parseConfig({ MODEL_API_URL: 'http://public.example/v1' }), /HTTPS/);
  assert.equal(currencyMicros('0.000001'), 1);
  assert.equal(currencyMicros('0.1'), 100_000);
  assert.equal(parseConfig({ MODEL_BASE_URL: 'https://example.com/v1', MAX_REQUEST_COST_CNY: '1' }).modelApiUrl,
    'https://example.com/v1/chat/completions');
});

test('unconfigured gateway reports health and returns structured 503 without secrets', async () => {
  await withFixture({ modelApiUrl: '', modelApiKey: '', modelName: '' }, null, async ({ url, calls }) => {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(5000) });
    const health = await response.json();
    assert.equal(health.configured, false);
    assert.equal(JSON.stringify(health).includes(accessToken), false);
    const result = await api(url, input());
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, 'server_not_configured');
    assert.equal(calls.length, 0);
  });
});

test('meal analysis uses bounded visual chat input and stores no sensitive result on disk', async () => {
  await withFixture({}, null, async ({ url, runtime, calls, gatewayConfig }) => {
    const value = input('photo-request', 'install-photo', 'meal', { title: 'PRIVATE_FOOD_TITLE_93', photos: [jpeg] });
    const result = await api(url, value);
    assert.equal(result.status, 200);
    assert.equal(result.body.analysis.status, 'unknown');
    assert.equal(result.body.analysis.calories, null);
    assert.equal(result.body.analysis.coverage.counted, 0);
    assert.deepEqual(result.body.analysis.coverage.missingQuantityLabels, ['熟白米饭']);
    assert.equal(result.body.analysis.components[0].source.provider, 'model');
    assert.deepEqual(result.body.analysis.components[0].source.per100gRange, modelNutritionEstimate.per100g);
    assert.equal(result.body.analysis.nutritionSource.method, 'ai-per100g-v3');
    assert.equal(result.body.analysis.coverage.referenceCount, 1);
    assert.deepEqual(result.body.analysis.components[0].householdMeasure, { label: '半碗熟米饭', grams: 100, approximate: true });
    assert.equal(result.body.model, 'mock-vision');
    assert.equal(typeof result.body.createdAt, 'string');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.max_tokens, 8192);
    assert.equal(calls[0].body.stream, false);
    assert.equal(calls[0].body.messages[1].content[1].image_url.url, jpeg);
    assert.equal(calls[0].headers.authorization, 'Bearer mock-upstream-key');
    const rows = runtime.ledger.db.prepare('SELECT * FROM request_ledger').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].cost_micros, 1_000_000);
    assert.equal('response_json' in rows[0], false);
    runtime.ledger.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const disk = readFileSync(gatewayConfig.dbPath).toString('utf8');
    assert.equal(disk.includes('PRIVATE_FOOD_TITLE_93'), false);
    assert.equal(disk.includes(mealResult.advice), false);
  });
});

test('same content replay is cached and a changed payload cannot reuse its idempotency key', async () => {
  await withFixture({}, null, async ({ url, calls }) => {
    const value = input('cached');
    const first = await api(url, value);
    const second = await api(url, value);
    assert.equal(second.status, 200);
    assert.deepEqual(second.body, first.body);
    const conflict = await api(url, { ...value, payload: { title: 'different' } });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'request_id_conflict');
    assert.equal(calls.length, 1);
  });
});

test('installation and request ids with colons cannot collide in the result cache', async () => {
  await withFixture({}, (_, count) => ({ content: JSON.stringify({ text: `private-summary-${count}` }) }), async ({ url, calls }) => {
    const a = input('c', 'a:b', 'summary', {});
    const b = input('b:c', 'a', 'summary', {});
    const first = await api(url, a);
    const second = await api(url, b);
    const replay = await api(url, a);
    assert.equal(first.body.analysis.text, 'private-summary-1');
    assert.equal(second.body.analysis.text, 'private-summary-2');
    assert.deepEqual(replay.body, first.body);
    assert.equal(calls.length, 2);
  });
});

test('expired successful results do not trigger another paid model call', async () => {
  await withFixture({ resultCacheTtlMs: 50 }, null, async ({ url, calls }) => {
    const value = input('expire');
    assert.equal((await api(url, value)).status, 200);
    await delay(80);
    const expired = await api(url, value);
    assert.equal(expired.status, 410);
    assert.equal(expired.body.error.code, 'result_expired');
    assert.equal(calls.length, 1);
  });
});

test('rejects authentication, malformed JSON, photo types, body size, and content type before billing', async () => {
  await withFixture({ maxBodyBytes: 1024 }, null, async ({ url, calls, runtime }) => {
    assert.equal((await api(url, input(), { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await api(url, input(), { body: '{' })).body.error.code, 'invalid_json');
    assert.equal((await api(url, input(), { headers: { 'Content-Type': 'text/plain' } })).status, 415);
    assert.equal((await api(url, input('bad-photo', 'i', 'meal', { photos: ['https://example.com/x.jpg'] }))).status, 400);
    assert.equal((await api(url, input('bad-magic', 'i', 'meal', { photos: ['data:image/jpeg;base64,AAAA'] }))).status, 400);
    assert.equal((await api(url, input('large', 'i', 'meal', { text: 'x'.repeat(2000) }))).status, 413);
    assert.equal((await api(url, input('summary-photo', 'i', 'summary', { photos: [jpeg] }))).status, 400);
    assert.equal(calls.length, 0);
    assert.equal(runtime.ledger.db.prepare('SELECT COUNT(*) AS n FROM request_ledger').get().n, 0);
  });
});

test('new recognition allows per-100g estimates while strict model schema rejects forged totals and sources', () => {
  const unknown = normaliseAnalysis(JSON.stringify(unknownResult));
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.calories, null);
  assert.deepEqual(unknown.components, []);
  const change = (values) => ({ ...mealResult, components: [{ ...mealResult.components[0], ...values }] });
  for (const invalid of [
    { ...mealResult, calories: { min: -1, max: 10 } },
    { ...mealResult, calories: { min: 450, max: 650 } },
    { ...mealResult, nutritionSource: { provider: 'usda-fdc' } },
    change({ grams: { min: 20, max: 10 } }),
    change({ consumedFraction: { min: '0', max: '1' } }),
    change({ consumedFraction: { min: 0, max: 2 } }),
    change({ foodId: 'not_in_the_catalog' }),
    change({ grams: null }),
    change({ source: { provider: 'usda-fdc', fdcId: 'invented' } }),
    { ...mealResult, rawPrompt: 'extra' },
    { ...unknownResult, components: [{ foodId: null }] },
  ]) assert.throws(() => normaliseAnalysis(JSON.stringify(invalid)), GatewayError);
  assert.throws(() => normaliseAnalysis('plausible prose'), GatewayError);
  assert.throws(() => normaliseAnalysis(JSON.stringify({ text: 'summary', calories: null }), 'summary'), GatewayError);
  assert.deepEqual(normaliseAnalysis('{"text":"summary"}', 'summary'), { text: 'summary' });
});

test('unknown ingredients survive the gateway while no intake is claimed without user quantities', async () => {
  const recognition = { ...mealResult, components: [...mealResult.components,
    { foodId: null, label: '不确定的豆皮或其他配料', uncertainty: ['身份不明'], nutritionEstimate: null }],
    unresolved: ['身份不明'] };
  await withFixture({}, () => ({ content: JSON.stringify(recognition) }), async ({ url }) => {
    const result = await api(url, input('incomplete-photo'));
    assert.equal(result.status, 200);
    assert.equal(result.body.analysis.status, 'unknown');
    for (const key of ['calories', 'protein', 'carbs', 'fat']) assert.equal(result.body.analysis[key], null);
    assert.equal(result.body.analysis.components.length, 2);
    assert.equal(result.body.analysis.components[1].foodId, null);
    assert.deepEqual(result.body.analysis.coverage.unknownNutritionLabels, ['不确定的豆皮或其他配料']);
  });
});

test('preparation uncertainty preserves confirmed identity while leaving nutrition quantity empty', async () => {
  const recognition = { ...mealResult, components: [{ ...mealResult.components[0], foodId: 'lotus_root_boiled',
    label: '藕片（煮熟或炒熟）', uncertainty: ['可见藕片，但具体烹调方式不明'] }] };
  await withFixture({}, () => ({ content: JSON.stringify(recognition) }), async ({ url, calls }) => {
    const value = input('disputed-preparation');
    const result = await api(url, value);
    assert.equal(result.status, 200);
    assert.equal(result.body.analysis.status, 'unknown');
    for (const key of ['calories', 'protein', 'carbs', 'fat']) assert.equal(result.body.analysis[key], null);
    assert.equal(result.body.analysis.components[0].foodId, 'lotus_root_boiled');
    assert.equal(result.body.analysis.components[0].source.provider, 'model');
    assert.equal(result.body.analysis.components[0].userQuantity, null);
    assert.deepEqual(result.body.analysis.components[0].uncertainty, recognition.components[0].uncertainty);
    assert.deepEqual((await api(url, value)).body, result.body);
    assert.equal(calls.length, 1);
  });
});

test('failed model responses retain conservative debit and terminal idempotency', async () => {
  await withFixture({ monthlyBudgetCny: 1 }, () => ({ content: JSON.stringify({ ...mealResult, calories: { min: -10, max: 20 } }) }), async ({ url, calls, runtime }) => {
    const value = input('invalid-result');
    const result = await api(url, value);
    assert.equal(result.status, 502);
    assert.equal(result.body.error.code, 'invalid_model_response');
    const replay = await api(url, value);
    assert.equal(replay.status, 502);
    assert.equal(replay.body.error.code, 'invalid_model_response');
    const next = await api(url, input('second-attempt'));
    assert.equal(next.status, 429);
    assert.equal(next.body.error.code, 'monthly_budget_exhausted');
    assert.equal(calls.length, 1);
    const row = runtime.ledger.db.prepare('SELECT * FROM request_ledger').get();
    assert.equal(row.status, 'failed');
    assert.equal(row.cost_micros, 1_000_000);
  });
});

test('upstream HTTP errors and timeouts also keep the full debit', async () => {
  await withFixture({}, (_, count) => count === 1 ? { status: 500 } : { delayMs: 150 }, async ({ url, calls, runtime }) => {
    const first = await api(url, input('http-error'));
    assert.equal(first.status, 502);
    runtime.config.upstreamTimeoutMs = 50;
    const timeout = await api(url, input('timeout'));
    assert.equal(timeout.status, 504);
    assert.equal(timeout.body.error.code, 'upstream_timeout');
    assert.equal(calls.length, 2);
    const count = runtime.ledger.db.prepare('SELECT SUM(cost_micros) AS n FROM request_ledger').get().n;
    assert.equal(count, 2_000_000);
  });
});

test('concurrent reservations cannot exceed the remaining total monthly budget', async () => {
  await withFixture({ monthlyBudgetCny: 5, fixedMonthlyCostCny: 2, nonAiMonthlyCostCny: 1, safetyReserveCny: 1 }, () => ({ delayMs: 80 }), async ({ url, calls, runtime }) => {
    assert.equal(runtime.config.aiBudgetMicros, 1_000_000);
    const responses = await Promise.all([
      api(url, input('parallel-a', 'installation-a')),
      api(url, input('parallel-b', 'installation-b')),
      api(url, input('parallel-c', 'installation-c')),
    ]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 429, 429]);
    assert.equal(calls.length, 1);
    assert.equal(runtime.ledger.db.prepare('SELECT SUM(cost_micros) AS n FROM request_ledger').get().n, 1_000_000);
  });
});

test('daily quota counts in-flight work, duplicates do not consume another slot', async () => {
  let started;
  const startSignal = new Promise((resolve) => { started = resolve; });
  await withFixture({ dailyQuota: 1 }, () => { started(); return { delayMs: 80 }; }, async ({ url, calls }) => {
    const value = input('in-flight');
    const first = api(url, value);
    await startSignal;
    try {
      const duplicate = await api(url, value);
      assert.equal(duplicate.status, 409);
      assert.equal(duplicate.body.error.code, 'request_in_progress');
      const next = await api(url, input('quota-bypass'));
      assert.equal(next.status, 429);
      assert.equal(next.body.error.code, 'daily_quota_exhausted');
    } finally { await first; }
    assert.equal((await api(url, value)).status, 200);
    assert.equal(calls.length, 1);
  });
});

test('installation concurrency is limited independently from quota', async () => {
  let started;
  const startSignal = new Promise((resolve) => { started = resolve; });
  await withFixture({}, () => { started(); return { delayMs: 80 }; }, async ({ url, calls }) => {
    const first = api(url, input('parallel-one'));
    await startSignal;
    try {
      const second = await api(url, input('parallel-two'));
      assert.equal(second.status, 429);
      assert.equal(second.body.error.code, 'concurrency_limit');
    } finally { await first; }
    assert.equal(calls.length, 1);
  });
});

test('restart retains accounting and never replays an old paid request upstream', async () => {
  await withFixture({ monthlyBudgetCny: 1 }, null, async ({ url, runtime, gatewayConfig, calls }) => {
    const value = input('persisted');
    assert.equal((await api(url, value)).status, 200);
    await close(runtime.server);
    const restarted = createAppServer({ config: gatewayConfig });
    try {
      const restartedUrl = await listen(restarted.server);
      const replay = await api(restartedUrl, value);
      assert.equal(replay.status, 410);
      const newCall = await api(restartedUrl, input('restart-bypass'));
      assert.equal(newCall.status, 429);
      assert.equal(newCall.body.error.code, 'monthly_budget_exhausted');
      assert.equal(calls.length, 1);
    } finally { await close(restarted.server); }
  });
});

test('crashed process reservations remain debited and expire into a terminal request state', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'health-gateway-crash-'));
  const settings = config(join(directory, 'ledger.sqlite'), undefined, { monthlyBudgetCny: 1 });
  const value = input('crashed');
  const source = `
    import { BudgetLedger } from ${JSON.stringify(new URL('./ledger.mjs', import.meta.url).href)};
    const ledger = new BudgetLedger(process.env.TEST_LEDGER_PATH);
    ledger.reserve(JSON.parse(process.env.TEST_INPUT), JSON.parse(process.env.TEST_CONFIG), new Date('2026-10-10T12:00:00Z'));
    process.stdout.write('READY\\n');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
    env: { ...process.env, TEST_LEDGER_PATH: settings.dbPath, TEST_INPUT: JSON.stringify(value), TEST_CONFIG: JSON.stringify(settings) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ledger;
  try {
    await Promise.race([
      once(child.stdout, 'data'),
      delay(5000).then(() => { throw new Error('Crash fixture did not start'); }),
      once(child, 'error').then(([error]) => { throw error; }),
    ]);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    ledger = new BudgetLedger(settings.dbPath);
    const replay = ledger.reserve(value, settings, new Date('2026-10-10T12:02:00Z'));
    assert.equal(replay.status, 'replay');
    assert.equal(replay.entry.status, 'failed');
    assert.equal(replay.entry.error_code, 'request_interrupted');
    assert.equal(replay.entry.cost_micros, 1_000_000);
    const newAttempt = ledger.reserve(input('crash-bypass'), settings, new Date('2026-10-10T12:02:00Z'));
    assert.equal(newAttempt.status, 'monthly_limit');
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    ledger?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('budget calendar uses configured timezone and micro-currency arithmetic stays exact', () => {
  const ledger = new BudgetLedger(':memory:');
  try {
    const settings = config(':memory:', undefined, { monthlyBudgetCny: 0.3, maxRequestCostCny: 0.1, maxConcurrentPerInstallation: 10 });
    for (let i = 0; i < 3; i++) {
      const value = input(`decimal-${i}`);
      assert.equal(ledger.reserve(value, settings, new Date('2026-10-31T16:00:00Z')).status, 'reserved');
      ledger.finish(value, 200, null);
    }
    assert.equal(ledger.reserve(input('decimal-4'), settings, new Date('2026-10-31T16:00:00Z')).status, 'monthly_limit');
    const row = ledger.db.prepare('SELECT billing_month,billing_day FROM request_ledger LIMIT 1').get();
    assert.equal(row.billing_month, '2026-11');
    assert.equal(row.billing_day, '2026-11-01');
  } finally { ledger.close(); }
});
