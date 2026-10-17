import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeConfig } from './config.mjs';
import { callModel, decideMealReview, GatewayError, normaliseAnalysis, normaliseRecognition } from './protocol.mjs';

const photo = 'data:image/png;base64,iVBORw0KGgo=';
const crop = 'data:image/jpeg;base64,/9j/AA==';
const region = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
const per100g = { calories: { min: 160, max: 230 }, protein: { min: 10, max: 18 }, carbs: { min: 8, max: 16 }, fat: { min: 6, max: 14 } };
const estimate = (changes = {}) => ({ basisGrams: 100, method: 'typical_recipe', per100g,
  recipeBasis: '成品肉菜的通常配方，油、酱与配料已包含在该菜中。', assumptions: ['油量未知，已扩宽范围。'], confidence: 0.7, ...changes });
const component = (changes = {}) => ({ foodId: null, label: '家常肉菜', uncertainty: [], confidence: 0.95,
  category: 'meat', candidates: [], evidence: [], region, nutritionEstimate: estimate(), ...changes });
const meal = (changes = {}, componentChanges = {}) => ({ foodName: '家常肉菜', components: [component(componentChanges)],
  unresolved: [], assumptions: [], advice: '填写实际食用量后计算。', confidence: 0.95, ...changes });
const completed = (value) => ({ model: 'untrusted-returned-model', status: 'completed', output: [{ type: 'message', role: 'assistant',
  status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });
const config = (changes = {}) => normalizeConfig({ modelApiUrl: 'https://mock.example/v1/responses', modelApiProtocol: 'responses',
  modelApiKey: 'mock-key', modelName: 'configured/vision-model', modelReasoningEffort: 'max', upstreamTimeoutMs: 2000, ...changes });

function harness(t, values, options = {}) {
  const requests = [], attempts = [], events = [], stages = [], reservations = [];
  const controller = options.controller ?? new AbortController();
  const settings = config(options.config);
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    if (init.signal.aborted) throw new DOMException('aborted', 'AbortError');
    requests.push(JSON.parse(init.body));
    const value = values[requests.length - 1] ?? values.at(-1);
    const envelope = options.envelope ? options.envelope(value) : settings.modelApiProtocol === 'responses' ? completed(value)
      : { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }] };
    return new Response(settings.modelStream ? `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: envelope })}\n\n`
      : JSON.stringify(envelope), { headers: { 'Content-Type': settings.modelStream ? 'text/event-stream' : 'application/json' } });
  });
  const pending = callModel({ requestId: 'v3-request', installationId: 'test-installation', kind: 'meal', payload: options.payload ?? {} },
    settings, controller.signal, undefined, (event) => events.push(event),
    (reservation) => { reservations.push(reservation); return options.reserve?.(reservation) ?? { attemptId: reservations.length }; },
    (attempt) => attempts.push(attempt), undefined, options.createCrops,
    (stage) => stages.push(stage));
  return { pending, requests, attempts, events, stages, reservations, settings };
}

test('gateway accepts wrapped AI estimates without database IDs and injects actual request provenance', async (t) => {
  const dishCorrections = [{ label: '家常肉菜', cookingMethod: '清炖', region }];
  const h = harness(t, [{ kind: 'meal', data: meal({}, { nutritionEstimate: estimate({ method: 'category' }) }) }], { payload: { dishCorrections } });
  const result = await h.pending;
  const analysis = result.analysis;
  const source = analysis.components[0].source;
  assert.equal(result.stageCount, 1);
  assert.equal(source.provider, 'model');
  assert.equal(source.method, 'category');
  assert.deepEqual(source.per100gRange, per100g);
  assert.equal(source.model, h.settings.modelName);
  assert.equal(source.reasoningEffort, h.settings.modelReasoningEffort);
  assert.equal(Number.isFinite(Date.parse(source.generatedAt)), true);
  assert.equal(analysis.components[0].foodId, null);
  assert.equal(analysis.components[0].userQuantity, null);
  assert.equal(analysis.calories, null);
  assert.equal(analysis.status, 'unknown');
  assert.equal(analysis.coverage.referenceCount, 1);
  assert.equal(analysis.coverage.counted, 0);
  assert.equal(analysis.nutritionSource.method, 'ai-per100g-v3');
  assert.equal(h.attempts[0].providerCompleted, true);
  assert.equal(h.attempts[0].resultAccepted, true);
  assert.equal(h.reservations[0].resultVersion, 3);
  assert.equal(h.attempts[0].resultVersion, 3);
  assert.equal(h.stages[0].resultVersion, 3);
  assert.equal(h.events.every((event) => event.resultVersion === 3), true);
  assert.strictEqual(analysis, h.stages[0].analysis);
  const record = JSON.parse(h.requests[0].input[0].content[0].text.slice('JSON record:\n'.length));
  assert.deepEqual(record.data.dishCorrections, dishCorrections);
});

test('an explained null is accepted as unknown reference without becoming zero or a format failure', async (t) => {
  const h = harness(t, [meal({}, { nutritionEstimate: null, uncertainty: ['类别与配方无法确认。'] })]);
  const result = await h.pending;
  assert.equal(result.analysis.components[0].source, null);
  assert.equal(result.analysis.coverage.referenceCount, 0);
  assert.deepEqual(result.analysis.coverage.unknownNutritionLabels, ['家常肉菜']);
  assert.equal(result.analysis.calories, null);
  assert.equal(h.attempts[0].resultAccepted, true);
});

test('gateway rejects empty or incomplete review rows before accepting a replacement', async (t) => {
  const first = { ...meal({ confidence: 0.5 }), components: [
    component({ foodId: 'rice_white_long_grain_cooked', label: '米饭', confidence: 0.4, region }),
    component({ foodId: null, label: '鸡肉菜', confidence: 0.95, category: 'meat', region: { x: 0.65, y: 0.2, width: 0.2, height: 0.25 } }),
  ] };
  const empty = { ...first, components: [], confidence: 0.95 };
  const dropped = { ...first, components: [component({ foodId: 'rice_white_long_grain_cooked', label: '米饭', confidence: 0.95, region })], confidence: 0.95 };
  assert.equal(decideMealReview(first, empty, true)?.stage, 'final_merge');
  const h = harness(t, [first, dropped], { payload: { photos: [photo] }, createCrops: async () => [crop] });
  const result = await h.pending;
  assert.equal(result.stageCount, 2);
  assert.equal(h.requests.length, 2);
  assert.equal(result.analysis.components.length, 2);
  assert.deepEqual(h.attempts.map((item) => item.outcome), ['accepted', 'format_error']);
});

test('gateway strictly rejects missing, malicious, nonfinite and out-of-range model nutrition', async (t) => {
  const { nutritionEstimate: _estimate, ...missing } = component();
  const cases = [
    meal({ components: [missing] }), meal({}, { nutritionEstimate: null }),
    meal({}, { nutritionEstimate: estimate({ basisGrams: 250 }) }),
    meal({}, { nutritionEstimate: estimate({ model: 'forged-model', source: 'forged-database' }) }),
    meal({}, { nutritionEstimate: estimate({ per100g: { ...per100g, calories: { min: 800, max: 901 } } }) }),
    meal({}, { nutritionEstimate: estimate({ per100g: { ...per100g, protein: { min: 101, max: 101 } } }) }),
    meal({}, { nutritionEstimate: estimate({ per100g: { ...per100g, calories: { min: 20, max: 10 } } }) }),
    meal({}, { nutritionEstimate: estimate({ per100g: { ...per100g, carbs: { min: -1, max: 10 } } }) }),
    meal({}, { nutritionEstimate: estimate({ per100g: { ...per100g, protein: { min: 40, max: 50 }, carbs: { min: 40, max: 50 }, fat: { min: 21, max: 30 } } }) }),
    meal({}, { nutritionEstimate: estimate({ per100g: { ...per100g, fat: null } }) }),
    meal({}, { nutritionEstimate: estimate({ per100g: { ...per100g, fat: { min: 0, max: Infinity } } }) }),
    meal({}, { source: { provider: 'model', per100gRange: per100g } }),
    meal({}, { userQuantity: { amount: 250, unit: 'g' } }), meal({}, { grams: { min: 250, max: 250 } }),
    meal({}, { candidates: [{ foodId: null, label: '鸡肉', protein: 10 }] }),
    meal({}, { evidence: [{ kind: 'photo', text: '可见菜品', calories: 200 }] }),
    meal({ calories: { min: 500, max: 600 } }), { kind: 'summary', data: meal() },
  ];
  for (const value of cases) {
    const h = harness(t, [value]);
    await assert.rejects(h.pending, (error) => error instanceof GatewayError && error.code === 'invalid_model_response' && error.stageCount === 1);
    assert.equal(h.requests.length, 1);
    assert.equal(h.attempts[0].providerCompleted, true);
    assert.equal(h.attempts[0].resultAccepted, false);
    assert.equal(h.attempts[0].outcome, 'format_error');
    assert.equal(h.stages.length, 0);
  }
});

test('gateway does not review nutrition uncertainty, broad ranges or unknown oil', async (t) => {
  const value = meal({ unresolved: ['油量未知、配方不明，营养范围较宽。'] }, {
    uncertainty: ['油酱用量未知。'], nutritionEstimate: estimate({ confidence: 0.1, per100g: { ...per100g, calories: { min: 60, max: 600 } } }),
  });
  assert.equal(decideMealReview(value, undefined, true), null);
  const h = harness(t, [value], { payload: { photos: [photo] }, createCrops: () => assert.fail('nutrition uncertainty cannot trigger a review') });
  const result = await h.pending;
  assert.equal(result.stageCount, 1);
  assert.equal(h.requests.length, 1);
});

test('nutrition change during a review does not trigger a third stage', async (t) => {
  const first = meal({ confidence: 0.4 }, { confidence: 0.4 });
  const review = meal({ confidence: 0.4 }, { confidence: 0.4, nutritionEstimate: estimate({ per100g: { ...per100g, calories: { min: 190, max: 280 } } }) });
  const h = harness(t, [first, review], { payload: { photos: [photo] }, createCrops: async () => [crop] });
  const result = await h.pending;
  assert.equal(result.stageCount, 2);
  assert.equal(h.requests.length, 2);
  assert.deepEqual(result.analysis.components[0].source.per100gRange.calories, { min: 190, max: 280 });
});

test('a completed SSE review with invalid ranges keeps the first validated source and records its failure', async (t) => {
  const first = meal({ confidence: 0.4 }, { confidence: 0.4 });
  const invalid = meal({}, { nutritionEstimate: estimate({ per100g: { ...per100g, calories: { min: 900, max: 950 } } }) });
  const h = harness(t, [first, invalid], { config: { modelStream: true }, payload: { photos: [photo] }, createCrops: async () => [crop] });
  const result = await h.pending;
  assert.equal(result.stageCount, 2);
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.attempts.map((item) => item.outcome), ['accepted', 'format_error']);
  assert.deepEqual(h.attempts.map((item) => item.providerCompleted), [true, true]);
  assert.deepEqual(h.attempts.map((item) => item.resultAccepted), [true, false]);
  assert.equal(h.stages.length, 1);
  assert.strictEqual(result.analysis, h.stages[0].analysis);
  assert.deepEqual(result.analysis.components[0].source.per100gRange, per100g);
});

test('a denied review reservation returns the first valid result without another model call', async (t) => {
  const h = harness(t, [meal({ confidence: 0.4 }, { confidence: 0.4 })], { payload: { photos: [photo] },
    createCrops: async () => [crop], reserve: ({ stage }) => stage === 'whole' ? { attemptId: 1 } : false });
  const result = await h.pending;
  assert.equal(result.stageCount, 1);
  assert.equal(h.requests.length, 1);
  assert.equal(h.attempts.length, 1);
  assert.equal(result.analysis.coverage.referenceCount, 1);
});

test('gateway cancellation during review stays cancelled and keeps completed-stage diagnostics', async (t) => {
  const controller = new AbortController();
  const h = harness(t, [meal({ confidence: 0.4 }, { confidence: 0.4 })], { controller, payload: { photos: [photo] },
    createCrops: async () => { controller.abort(); return [crop]; } });
  await assert.rejects(h.pending, (error) => error instanceof GatewayError && error.code === 'request_cancelled' && error.stageCount === 2);
  assert.equal(h.requests.length, 1);
  assert.equal(h.stages.length, 1);
  assert.equal(h.attempts[0].outcome, 'accepted');
  assert.equal(h.attempts[1].resultAccepted, false);
});

test('gateway Chat Completions requires a full assistant stop before nutrient business validation', async (t) => {
  for (const change of [
    { finish_reason: 'length' }, { message: { role: 'user', content: JSON.stringify(meal()) } },
    { message: { role: 'assistant', content: JSON.stringify(meal()), tool_calls: [] } },
    { message: { role: 'assistant', content: JSON.stringify(meal()), refusal: 'refused' } },
  ]) {
    const h = harness(t, [meal()], { config: { modelApiProtocol: 'chat_completions' }, envelope: (value) => ({ choices: [{
      index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) }, ...change,
    }] }) });
    await assert.rejects(h.pending, (error) => error instanceof GatewayError && error.code === 'invalid_model_response');
    assert.equal(h.requests.length, 1);
    assert.equal(h.attempts[0].resultAccepted, false);
    assert.equal(h.stages.length, 0);
  }
});

test('standalone normalization keeps wrapper validation and requires explicit model provenance for new snapshots', () => {
  const provenance = { model: 'configured/model', createdAt: '2026-10-17T03:00:00.000Z' };
  const raw = JSON.stringify({ kind: 'meal', data: meal() });
  assert.equal(normaliseRecognition(raw).components[0].nutritionEstimate.method, 'typical_recipe');
  assert.throws(() => normaliseAnalysis(raw), GatewayError);
  const analysis = normaliseAnalysis(raw, 'meal', provenance);
  assert.equal(analysis.components[0].source.model, provenance.model);
  assert.equal(analysis.components[0].source.generatedAt, provenance.createdAt);
  assert.throws(() => normaliseRecognition(JSON.stringify({ kind: 'meal', data: meal(), extra: true })), GatewayError);
});
