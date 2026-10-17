import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createAppServer } from './index.mjs';
import { parseConfig, normalizeConfig } from './config.mjs';
import { modelRequest } from './protocol.mjs';

const unknown = { foodName: '无法识别', components: [], unresolved: ['非食物测试图'], assumptions: ['非食物测试图'], advice: '补充可靠记录。' };
const modelNutritionEstimate = { basisGrams: 100, method: 'typical_recipe', per100g: {
  calories: { min: 120, max: 150 }, protein: { min: 2, max: 4 }, carbs: { min: 24, max: 32 }, fat: { min: 0, max: 1 },
}, recipeBasis: '按通常熟米饭配方与含水量估计。', assumptions: [], confidence: 0.8 };
const output = (text) => ({ status: 'completed', output: [
  { type: 'reasoning', summary: [] },
  { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] },
] });

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(run, hooks = {}) {
  const calls = [];
  const diagnostics = [];
  let raw = output(JSON.stringify({ kind: 'meal', data: unknown }));
  let upstreamStatus = 200;
  const upstream = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const sent = JSON.parse(body);
    calls.push({ body: sent, authorization: request.headers.authorization });
    hooks.onFetch?.(sent);
    // Reproduce the provider's JSON-mode validator, which does not inspect instructions.
    const inputText = sent.input?.flatMap((item) => item.content ?? []).filter((part) => part.type === 'input_text').map((part) => part.text).join('\n') ?? '';
    const missingJson = sent.text?.format?.type === 'json_object' && !/json/i.test(inputText);
    if (hooks.handleFetch) return hooks.handleFetch({ request, response, sent, calls });
    response.writeHead(missingJson ? 400 : upstreamStatus, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(missingJson ? { error: { message: "Response input messages must contain the word 'json' in some form to use 'text.format' of type 'json_object'." } } : typeof raw === 'function' ? raw(sent, calls.length) : raw));
  });
  let gateway;
  try {
    const upstreamUrl = await listen(upstream);
    gateway = createAppServer({ config: {
      dbPath: ':memory:', port: 0, accessToken: 'mock-client-token',
      modelApiUrl: `${upstreamUrl}/v1/responses`, modelApiKey: 'mock-provider-key',
      modelApiProtocol: 'responses', modelName: 'gpt-6.1-sol', modelReasoningEffort: 'max',
      maxRequestCostCny: 1, monthlyBudgetCny: 100, safetyReserveCny: 0,
      upstreamTimeoutMs: hooks.timeoutMs ?? 2000, dailyQuota: 100,
    }, onUpstreamError: (diagnostic) => diagnostics.push(diagnostic), ...hooks });
    const url = await listen(gateway.server);
    const api = async (id, kind = 'meal', payload = {}) => {
      const response = await fetch(`${url}/api/analyze`, {
        method: 'POST', headers: { Authorization: 'Bearer mock-client-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: id, installationId: 'test-responses', kind, payload }),
      });
      return { status: response.status, body: await response.json() };
    };
    await run({ api, calls, gateway, diagnostics, setRaw: (value, status = 200) => { raw = value; upstreamStatus = status; } });
  } finally {
    for (const server of [gateway?.server, upstream]) {
      if (server?.listening) {
        await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
      }
    }
  }
}

test('Responses config validates protocol, effort and endpoint construction', () => {
  const config = parseConfig({ MODEL_BASE_URL: 'https://example.com/v1', MODEL_API_PROTOCOL: 'responses', MODEL_REASONING_EFFORT: 'max' });
  assert.equal(config.modelApiUrl, 'https://example.com/v1/responses');
  assert.equal(config.modelReasoningEffort, 'max');
  assert.equal(normalizeConfig({}).upstreamTimeoutMs, 180_000);
  assert.equal(normalizeConfig({ upstreamTimeoutMs: 180_000 }).upstreamTimeoutMs, 180_000);
  assert.equal(parseConfig({ UPSTREAM_TIMEOUT_MS: '180000' }).upstreamTimeoutMs, 180_000);
  assert.throws(() => normalizeConfig({ upstreamTimeoutMs: 180_001 }), /Invalid UPSTREAM_TIMEOUT_MS/);
  assert.equal(parseConfig({ MODEL_BASE_URL: 'https://example.com/v1/responses/', MODEL_API_PROTOCOL: 'responses' }).modelApiUrl, 'https://example.com/v1/responses');
  assert.throws(() => normalizeConfig({ modelApiProtocol: 'invalid' }), /MODEL_API_PROTOCOL/);
  assert.throws(() => normalizeConfig({ modelReasoningEffort: 'automatic' }), /MODEL_REASONING_EFFORT/);
});

test('Responses image input, max reasoning and structured output complete through the gateway', async () => {
  await fixture(async ({ api, calls }) => {
    const photo = 'data:image/png;base64,iVBORw0KGgo=';
    const result = await api('visual', 'meal', { photos: [photo], photoRoles: ['before'], portion: '未知' });
    assert.equal(result.status, 200);
    assert.equal(result.body.analysis.status, 'unknown');
    for (const key of ['calories', 'protein', 'carbs', 'fat']) assert.equal(result.body.analysis[key], null);
    assert.deepEqual(result.body.analysis.components, []);
    assert.equal(result.body.model, 'gpt-6.1-sol');
    assert.equal(result.body.stageCount, 1);
    const sent = calls[0].body;
    assert.equal(sent.model, 'gpt-6.1-sol');
    assert.deepEqual(sent.reasoning, { effort: 'max' });
    assert.equal(sent.max_output_tokens, 8192);
    assert.equal(sent.store, false);
    assert.equal(sent.stream, false);
    assert.deepEqual(sent.text, { format: { type: 'json_object' } });
    assert.deepEqual(sent.input[0].content[1], { type: 'input_image', image_url: photo, detail: 'low' });
    assert.equal(sent.input[0].content[0].text.startsWith('JSON record:\n'), true);
    assert.deepEqual(JSON.parse(sent.input[0].content[0].text.slice('JSON record:\n'.length)).data.photoRoles, ['before']);
    assert.equal(sent.instructions.includes('foodName'), true);
    assert.equal(sent.instructions.includes('rice_white_long_grain_cooked'), true);
    assert.equal(sent.instructions.includes('mushroom_enoki_raw'), true);
    for (const field of ['messages', 'temperature', 'max_tokens', 'response_format', 'reasoning_effort']) assert.equal(field in sent, false);
    assert.equal(calls[0].authorization, 'Bearer mock-provider-key');
  });
});

test('gateway reviews uncertain recognition sequentially, preserves original photo roles and caps calls at three', async () => {
  const cropRegion = { x: 0.2, y: 0.25, width: 0.25, height: 0.3 };
  const recognition = (label, foodId, confidence) => ({ foodName: '测试餐食', components: [{
    foodId, label, uncertainty: [], confidence, nutritionEstimate: modelNutritionEstimate,
    category: null, candidates: [], evidence: [], region: cropRegion,
  }], unresolved: [], assumptions: [], advice: '请按实际记录补充。', confidence });
  const responses = [
    recognition('米饭', 'rice_white_long_grain_cooked', 0.4),
    recognition('面条', 'soba_cooked', 0.5),
    recognition('米饭', 'rice_white_long_grain_cooked', 0.95),
  ];
  const crop = 'data:image/jpeg;base64,/9j/AA==';
  let cropCalls = 0;
  await fixture(async ({ api, calls, setRaw }) => {
    setRaw((_sent, callNumber) => output(JSON.stringify({ kind: 'meal', data: responses[callNumber - 1] })));
    const result = await api('review-three-stages', 'meal', { photos: ['data:image/png;base64,iVBORw0KGgo='], photoRoles: ['before'], portion: '未知' });
    assert.equal(result.status, 200);
    assert.equal(result.body.stageCount, 3);
    assert.equal(calls.length, 3);
    const firstRecord = JSON.parse(calls[0].body.input[0].content[0].text.slice('JSON record:\n'.length));
    const reviewRecord = JSON.parse(calls[1].body.input[0].content[0].text.slice('JSON record:\n'.length));
    const mergeRecord = JSON.parse(calls[2].body.input[0].content[0].text.slice('JSON record:\n'.length));
    assert.deepEqual(firstRecord.data.photoRoles, ['before']);
    assert.equal(reviewRecord.reviewContext.stage, 'crop_review');
    assert.deepEqual(reviewRecord.reviewContext.reviewIndices, [0]);
    assert.deepEqual(reviewRecord.reviewContext.reviewRegions, [cropRegion]);
    assert.deepEqual(reviewRecord.data.photoRoles, ['review_crop_1']);
    assert.deepEqual(reviewRecord.data.reviewPhotoRoles, ['before']);
    assert.equal(mergeRecord.reviewContext.stage, 'final_merge');
    assert.equal(mergeRecord.reviewContext.previousAnalysis.components[0].label, '米饭');
    assert.equal(mergeRecord.reviewContext.reviewAnalysis.components[0].label, '面条');
    assert.deepEqual(calls.map(({ body }) => body.input[0].content.filter((part) => part.type === 'input_image').length), [1, 1, 0]);
    assert.deepEqual(calls.slice(0, 2).map(({ body }) => body.input[0].content.find((part) => part.type === 'input_image').detail), ['low', 'high']);
    assert.equal(cropCalls, 1);
  }, { createCrops: async ({ regions, stage }) => {
    cropCalls += 1;
    assert.equal(stage, 'crop_review');
    assert.deepEqual(regions, [cropRegion]);
    return [crop];
  } });
});

test('failed review returns the validated first analysis without retrying', async () => {
  const first = { foodName: '米饭', components: [{ foodId: 'rice_white_long_grain_cooked', label: '米饭',
    uncertainty: ['身份待确认'], confidence: 0.4, category: 'grain', candidates: [], evidence: [],
    region: { x: 0.2, y: 0.2, width: 0.3, height: 0.3 }, nutritionEstimate: modelNutritionEstimate }],
    unresolved: ['身份待确认'], assumptions: [], advice: '请补充记录。', confidence: 0.4 };
  const attempts = [];
  await fixture(async ({ api, calls, setRaw }) => {
    setRaw((_sent, callNumber) => callNumber === 1
      ? output(JSON.stringify({ kind: 'meal', data: first }))
      : output(JSON.stringify({ kind: 'meal', data: { ...first, calories: { min: 200, max: 200 } } })));
    const result = await api('review-failure-preserves-first', 'meal', { photos: ['data:image/png;base64,iVBORw0KGgo='] });
    assert.equal(result.status, 200);
    assert.equal(result.body.stageCount, 2);
    assert.equal(result.body.analysis.foodName, '米饭');
    assert.equal(result.body.analysis.components[0].label, '米饭');
    assert.equal(calls.length, 2);
    assert.deepEqual(attempts.map((attempt) => attempt.outcome), ['accepted', 'format_error']);
  }, {
    createCrops: async () => ['data:image/jpeg;base64,/9j/AA=='],
    onUpstreamAttemptResult: (attempt) => attempts.push(attempt),
  });
});

test('each review stage has its own upstream timeout window', async () => {
  const region = { x: 0.2, y: 0.25, width: 0.25, height: 0.3 };
  const recognition = (confidence) => ({ foodName: '分阶段超时测试', components: [{
    foodId: 'rice_white_long_grain_cooked', label: '米饭',
    uncertainty: confidence < 0.5 ? ['成分需要局部复核'] : [], confidence,
    category: 'grain', candidates: confidence < 0.5 ? [
      { foodId: 'rice_white_long_grain_cooked', label: '米饭', confidence: 0.4 }, { foodId: null, label: '粥', confidence: 0.3 },
    ] : [{ foodId: 'rice_white_long_grain_cooked', label: '米饭', confidence }],
    evidence: [], region, nutritionEstimate: modelNutritionEstimate,
  }], unresolved: confidence < 0.5 ? ['局部复核'] : [], assumptions: [], advice: '补充记录。', confidence });
  const crop = 'data:image/jpeg;base64,/9j/AA==';
  await fixture(async ({ api, calls }) => {
    const result = await api('independent-stage-timeouts', 'meal', { photos: ['data:image/png;base64,iVBORw0KGgo='], photoRoles: ['before'] });
    assert.equal(result.status, 200);
    assert.equal(result.body.stageCount, 2);
    assert.equal(calls.length, 2);
  }, {
    timeoutMs: 1_200,
    createCrops: async () => [crop],
    handleFetch: async ({ response, calls }) => {
      await new Promise((resolve) => setTimeout(resolve, 750));
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(output(JSON.stringify(recognition(calls.length === 1 ? 0.4 : 0.95)))));
    },
  });
});

test('low confidence remaining after targeted review does not trigger a final merge without a real conflict', async () => {
  const cropRegion = { x: 0.2, y: 0.25, width: 0.25, height: 0.3 };
  const recognition = (confidence) => ({ foodName: '测试餐食', components: [{
    foodId: 'rice_white_long_grain_cooked', label: '米饭',
    uncertainty: ['份量待确认'], confidence, category: 'grain', candidates: [], evidence: [], region: cropRegion, nutritionEstimate: modelNutritionEstimate,
  }], unresolved: ['份量不确定'], assumptions: [], advice: '请按实际记录补充。', confidence });
  const original = 'data:image/png;base64,iVBORw0KGgo=';
  const crop = 'data:image/jpeg;base64,/9j/AA==';
  const crops = [];
  await fixture(async ({ api, calls, setRaw }) => {
    setRaw((_sent, callNumber) => output(JSON.stringify(recognition(callNumber === 1 ? 0.4 : 0.5))));
    const result = await api('review-without-conflict', 'meal', { photos: [original], photoRoles: ['before'] });
    assert.equal(result.status, 200);
    assert.equal(result.body.stageCount, 2);
    assert.equal(calls.length, 2);
    const reviewImages = calls[1].body.input[0].content.filter((part) => part.type === 'input_image');
    assert.deepEqual(reviewImages.map(({ image_url }) => image_url), [crop]);
    assert.equal(reviewImages.some(({ image_url }) => image_url === original), false);
    assert.equal(crops.length, 1);
    assert.equal(crops[0].stage, 'crop_review');
    assert.deepEqual(crops[0].regions, [cropRegion]);
  }, { createCrops: async (context) => { crops.push(context); return [crop]; } });
});

test('review is skipped when no crop generator is configured', async () => {
  const region = { x: 0.2, y: 0.25, width: 0.25, height: 0.3 };
  const recognition = { foodName: '测试餐食', components: [{ foodId: null, label: '不确定食材', uncertainty: ['身份待确认'], confidence: 0.4,
    category: null, candidates: [], evidence: [], region, nutritionEstimate: null }], unresolved: ['身份不确定'],
    assumptions: [], advice: '请按实际记录补充。', confidence: 0.4 };
  await fixture(async ({ api, calls, setRaw }) => {
    setRaw(output(JSON.stringify(recognition)));
    const result = await api('no-crop-generator', 'meal', { photos: ['data:image/png;base64,iVBORw0KGgo='] });
    assert.equal(result.status, 200);
    assert.equal(result.body.stageCount, 1);
    assert.equal(calls.length, 1);
  });
});

test('request reservation runs before fetch and attempt results include format and HTTP failures', async () => {
  const order = [];
  const attempts = [];
  await fixture(async ({ api, setRaw }) => {
    setRaw(output('{"invalid":"meal result"}'));
    const formatFailure = await api('format-hook-failure', 'summary', { summary: 'test' });
    assert.equal(formatFailure.status, 502);
    assert.deepEqual(order, ['reserved', 'fetch', 'finished']);
    assert.equal(attempts[0].stage, 'whole');
    assert.equal(attempts[0].httpStatus, 200);
    assert.equal(attempts[0].providerCompleted, true);
    assert.equal(attempts[0].resultAccepted, false);
    assert.equal(attempts[0].outcome, 'format_error');
    assert.equal(attempts[0].resultVersion, 3);

    order.length = 0;
    setRaw({ error: { message: 'rate limited' } }, 429);
    const httpFailure = await api('http-hook-failure', 'summary', { summary: 'test' });
    assert.equal(httpFailure.status, 502);
    assert.deepEqual(order, ['reserved', 'fetch', 'finished']);
    assert.equal(attempts[1].httpStatus, 429);
    assert.equal(attempts[1].outcome, 'http_error');
  }, {
    onBeforeUpstreamRequest: () => { order.push('reserved'); return { attemptId: order.length + 1 }; },
    onFetch: () => order.push('fetch'),
    onUpstreamAttemptResult: (attempt) => { order.push('finished'); attempts.push(attempt); },
  });
});

test('reservation callback failure prevents any upstream fetch', async () => {
  const order = [];
  await fixture(async ({ api, calls }) => {
    const result = await api('reserve-hook-failure', 'summary', { summary: 'test' });
    assert.equal(result.status, 502);
    assert.equal(calls.length, 0);
    assert.deepEqual(order, ['reserved']);
  }, { onBeforeUpstreamRequest: () => { order.push('reserved'); throw new Error('local reservation failed'); }, onFetch: () => order.push('fetch') });
});

test('attempt callback is completed after an upstream body timeout', async () => {
  const attempts = [];
  await fixture(async ({ api }) => {
    const result = await api('body-timeout-hook', 'summary', { summary: 'test' });
    assert.equal(result.status, 504);
    assert.equal(result.body.error.code, 'upstream_timeout');
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].httpStatus, 200);
    assert.equal(attempts[0].resultAccepted, false);
    assert.equal(attempts[0].outcome, 'timeout');
  }, {
    timeoutMs: 100,
    handleFetch: ({ response }) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{'); },
    onUpstreamAttemptResult: (attempt) => attempts.push(attempt),
  });
});

test('JSON mode has an explicit marker inside input even when the provider ignores instructions', () => {
  const config = normalizeConfig({ modelApiProtocol: 'responses', modelName: 'gpt-6.1-sol', modelReasoningEffort: 'max' });
  for (const [kind, payload] of [['meal', { photos: ['data:image/png;base64,iVBORw0KGgo='], note: 'gray' }], ['summary', { summary: 'missing records' }]]) {
    const sent = modelRequest({ kind, payload }, config);
    assert.equal(sent.text.format.type, 'json_object');
    const inputText = sent.input.flatMap((item) => item.content).filter((part) => part.type === 'input_text').map((part) => part.text).join('\n');
    assert.match(inputText, /json/i);
    const data = JSON.parse(inputText.slice('JSON record:\n'.length));
    const expectedData = Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'photos'));
    if (kind === 'meal' && payload.photos?.length && !payload.photoRoles) expectedData.photoRoles = payload.photos.map((_photo, index) => `photo_${index + 1}`);
    assert.deepEqual(data, { kind, data: expectedData });
  }
});

test('Responses summary preserves terminal idempotency without another upstream call', async () => {
  await fixture(async ({ api, calls, setRaw }) => {
    setRaw(output(JSON.stringify({ text: '测试总结，训练和睡眠未记录。' })));
    const first = await api('summary', 'summary', { summary: '虚构饮食记录' });
    assert.equal(first.status, 200);
    assert.equal(first.body.analysis.text, '测试总结，训练和睡眠未记录。');
    assert.deepEqual(await api('summary', 'summary', { summary: '虚构饮食记录' }), first);
    assert.equal(calls.length, 1);
  });
});

test('Responses incomplete, refusal, tools, nontext and invalid business output fail closed and keep reservations', async () => {
  await fixture(async ({ api, calls, setRaw, gateway }) => {
    const valid = output(JSON.stringify(unknown));
    const invalid = [
      { ...valid, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
      { ...valid, status: 'in_progress' },
      { ...valid, error: { code: 'failed' } },
      { ...valid, output: [{ ...valid.output[1], status: 'in_progress' }] },
      { ...valid, output: [{ ...valid.output[1], content: [{ type: 'refusal', refusal: 'refused' }] }] },
      { ...valid, output: [{ type: 'function_call', name: 'unexpected' }] },
      { ...valid, output: [{ ...valid.output[1], content: [{ type: 'output_audio', data: 'invalid' }] }] },
      { ...valid, output: [valid.output[0]] },
      output('{"status":"unknown"}'),
      output('{"text":"summary in meal result"}'),
      output(JSON.stringify({ kind: 'summary', data: { text: 'wrong kind' } })),
      output(JSON.stringify({ kind: 'meal', data: { ...unknown, calories: { min: 10, max: 10 } } })),
      output(JSON.stringify({ kind: 'meal', data: unknown, extra: true })),
    ];
    for (const [index, raw] of invalid.entries()) {
      setRaw(raw);
      const first = await api(`bad-${index}`);
      assert.equal(first.status, 502);
      assert.equal(first.body.error.code, 'invalid_model_response');
      assert.equal((await api(`bad-${index}`)).status, 502);
    }
    assert.equal(calls.length, invalid.length);
    const rows = gateway.ledger.db.prepare('SELECT cost_micros, status FROM request_ledger').all();
    assert.equal(rows.length, invalid.length);
    assert.equal(rows.every((row) => row.cost_micros === 1_000_000 && row.status === 'failed'), true);
  });
});

test('upstream diagnostics expose only HTTP status and fixed labels, never the original error', async () => {
  await fixture(async ({ api, diagnostics, calls, setRaw }) => {
    setRaw({ error: { message: 'Invalid input_image format PRIVATE_TEST_SECRET_73' } }, 400);
    const result = await api('diagnostic');
    assert.equal(result.status, 502);
    assert.deepEqual(diagnostics, [{ status: 400, category: 'image_rejected', fieldHints: ['input_image'] }]);
    assert.equal(JSON.stringify(result).includes('PRIVATE_TEST_SECRET_73'), false);
    await api('diagnostic');
    assert.equal(calls.length, 1);
    assert.equal(diagnostics.length, 1);
    setRaw({ error: { message: 'PRIVATE_TEST_SECRET_73'.repeat(1000) } }, 400);
    assert.equal((await api('long-diagnostic')).status, 502);
    assert.deepEqual(diagnostics[1], { status: 400, category: 'unspecified', fieldHints: [] });
  });
});

test('JSON mode validation errors are distinguished from image format errors without exposing upstream text', async () => {
  await fixture(async ({ api, diagnostics, setRaw }) => {
    setRaw({ error: { message: "Response input messages must contain the word 'json' in some form to use 'text.format' of type 'json_object'. PRIVATE_TEST_SECRET_73" } }, 400);
    const result = await api('json-marker-diagnostic');
    assert.equal(result.status, 502);
    assert.deepEqual(diagnostics, [{ status: 400, category: 'json_mode_input_missing', fieldHints: ['json_object'] }]);
    assert.equal(JSON.stringify(result).includes('PRIVATE_TEST_SECRET_73'), false);
    assert.equal(JSON.stringify(diagnostics).includes('PRIVATE_TEST_SECRET_73'), false);
  });
});
