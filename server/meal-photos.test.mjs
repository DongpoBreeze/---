import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeConfig } from './config.mjs';
import { callModel, GatewayError, modelRequest, validateRequest } from './protocol.mjs';

const photo = 'data:image/png;base64,iVBORw0KGgo=';
const crop = 'data:image/jpeg;base64,/9j/AA==';
const settings = (changes = {}) => normalizeConfig({ modelApiUrl: 'https://provider.example/v1/responses', modelApiProtocol: 'responses',
  modelApiKey: 'mock-key', modelName: 'configured/model', modelReasoningEffort: 'max', upstreamTimeoutMs: 2000, ...changes });
const input = (payload) => ({ requestId: 'multi-before', installationId: 'test-installation', kind: 'meal', payload });
const estimate = { basisGrams: 100, method: 'typical_recipe', per100g: {
  calories: { min: 120, max: 150 }, protein: { min: 2, max: 4 }, carbs: { min: 24, max: 32 }, fat: { min: 0, max: 1 },
}, recipeBasis: '通常熟米饭的含水量与配方。', assumptions: [], confidence: 0.8 };
const meal = (confidence) => ({ foodName: '米饭', components: [{ foodId: 'rice_white_long_grain_cooked', label: '米饭', confidence,
  category: 'grain', candidates: [], evidence: [], uncertainty: [], region: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, nutritionEstimate: estimate }],
unresolved: [], assumptions: [], advice: '按实际食用数量记录。', confidence });
const completed = (value) => ({ status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });

test('gateway source limit defaults to four, accepts old lower limits and rejects a fifth before upstream work', () => {
  assert.equal(settings().maxPhotos, 4);
  assert.equal(settings({ maxPhotos: 2 }).maxPhotos, 2);
  assert.throws(() => settings({ maxPhotos: 5 }), /MAX_PHOTOS/);
  const valid = input({ photos: Array(4).fill(photo), photoRoles: ['before', 'before', 'before', 'after'] });
  assert.strictEqual(validateRequest(valid, settings()), valid);
  for (const payload of [
    { photos: Array(5).fill(photo) }, { photos: [photo], photoRoles: [] }, { photos: [photo], photoRoles: [null] },
    { photos: [photo], photoRoles: [''] }, { photos: [photo], photoRoles: 'before' },
  ]) assert.throws(() => validateRequest(input(payload), settings()), (error) => error instanceof GatewayError && error.code === 'invalid_request');
  assert.throws(() => validateRequest(valid, settings({ maxPhotos: 2 })), GatewayError);
});

test('gateway encodes four same-meal sources and their roles for both provider protocols', () => {
  const payload = { photos: Array(4).fill(photo), photoRoles: ['before', 'before', 'before', 'after'] };
  for (const protocol of ['responses', 'chat_completions']) {
    const request = modelRequest(input(payload), settings({ modelApiProtocol: protocol }));
    const content = protocol === 'responses' ? request.input[0].content : request.messages[1].content;
    const record = JSON.parse(content[0].text.replace(/^JSON record:\n/, ''));
    assert.deepEqual(record.data.photoRoles, payload.photoRoles); assert.equal(content.length, 5);
    assert.match(protocol === 'responses' ? request.instructions : request.messages[0].content, /同一份食物重复出现时只列为一道菜/);
    assert.equal(request.model, 'configured/model');
    assert.equal(protocol === 'responses' ? request.reasoning.effort : request.reasoning_effort, 'max');
  }
});

test('unindexed multi-view regions review the same original group without calling a crop generator', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return new Response(JSON.stringify(completed(meal(requests.length === 1 ? 0.4 : 0.95))), { headers: { 'Content-Type': 'application/json' } });
  });
  const payload = { photos: Array(4).fill(photo), photoRoles: ['before', 'before', 'before', 'after'] };
  const result = await callModel(input(payload), settings(), new AbortController().signal,
    undefined, undefined, undefined, undefined, undefined, async () => assert.fail('ambiguous image regions must retain original views'));
  assert.equal(result.stageCount, 2); assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.deepEqual(request.input[0].content.slice(1).map((part) => part.image_url), payload.photos);
    const record = JSON.parse(request.input[0].content[0].text.slice('JSON record:\n'.length));
    assert.deepEqual(record.data.photoRoles, payload.photoRoles);
  }
  assert.equal(requests[1].input[0].content[1].detail, 'high');
  assert.equal(result.analysis.components.length, 1); assert.equal(result.analysis.components[0].grams, null);
  assert.equal(result.analysis.components[0].userQuantity, null); assert.equal(result.analysis.calories, null);
});

test('legacy before/after pairs retain targeted review and cancellation never starts a multi-photo request', async (t) => {
  const requests = [];
  let cropCalls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return new Response(JSON.stringify(completed(meal(requests.length === 1 ? 0.4 : 0.95))), { headers: { 'Content-Type': 'application/json' } });
  });
  const result = await callModel(input({ photos: [photo, photo], photoRoles: ['before', 'after'] }), settings(), new AbortController().signal,
    undefined, undefined, undefined, undefined, undefined, async () => { cropCalls += 1; return [crop]; });
  assert.equal(result.stageCount, 2); assert.equal(cropCalls, 1);
  assert.deepEqual(requests[1].input[0].content.slice(1).map((part) => part.image_url), [crop]);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(callModel(input({ photos: [photo, photo], photoRoles: ['before', 'before'] }), settings(), controller.signal),
    (error) => error instanceof GatewayError && error.code === 'request_cancelled');
  assert.equal(requests.length, 2);
});
