import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import {
  adaptFrontendMealRecognition, calculateMealNutrition as calculateShared, frontendMealInput,
  frontendMealRecognitionSnapshot, mealRecognitionInstructions, preservesMealComponents, validateFrontendMealRecognition,
  type FrontendMealRecognition, type MealRecognition,
} from '../shared/nutrition.mjs';
import { AI_REQUEST_TIMEOUT_MS, AiProviderError, requestProvider, type AiSettings, type MealProviderDiagnostic } from '../src/ai-provider';
import { calculateMealNutrition, nutritionDataset } from '../src/nutrition';
import { mealAnalysisSchema } from '../src/nutrition-schema';
import { createBackupArchive, parseBackupArchive, validateAppData } from '../src/backup';
import { emptyData, type MealAnalysis, type MealRecord } from '../src/types';
import { callModel, modelRequest, normaliseAnalysis, normaliseRecognition } from '../server/protocol.mjs';
import { normalizeConfig } from '../server/config.mjs';

const settings: AiSettings = { baseUrl: 'https://provider.example/v1', apiKey: 'mock-key', protocol: 'responses', model: 'configured/model', reasoningEffort: 'high' };
const photo = 'data:image/jpeg;base64,/9j/AA==';
const provenance = { model: settings.model, reasoningEffort: settings.reasoningEffort, createdAt: '2026-10-18T03:00:00.000Z' };
const per100g = { calories: { min: 120, max: 160 }, protein: { min: 10, max: 14 }, carbs: { min: 20, max: 30 }, fat: { min: 4, max: 8 } };
const dish = (changes = {}): FrontendMealRecognition['components'][number] => ({
  label: '米饭', cookingMethod: '蒸煮', confidence: 0.95, recommendedShare: 1,
  nutritionEstimate: { method: 'typical_recipe', per100g, recipeBasis: '按熟米饭的典型含水量估计成品。', assumptions: ['含水量有差异。'], confidence: 0.8 },
  uncertainty: [], ...changes,
});
const wire = (components = [dish()], uncertainty: string[] = []): FrontendMealRecognition => {
  const total = components.reduce((sum, component) => sum + (component.recommendedShare ?? 1), 0);
  return { components: components.map((component) => ({ ...component, recommendedShare: (component.recommendedShare ?? 1) / total })), uncertainty };
};
const completed = (value: unknown, changes = {}) => ({ status: 'completed', model: 'untrusted/model', output: [
  { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(value) }] },
], ...changes });
const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
const sse = (events: unknown[]) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
const invalid = (error: unknown) => error instanceof AiProviderError && error.code === 'invalid_response';
function mock(t: TestContext, values: unknown[], protocol = 'responses') {
  const requests: any[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    const value = values[requests.length - 1] ?? values.at(-1);
    return jsonResponse(protocol === 'responses' ? completed(value) : { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }] });
  });
  return requests;
}
const calculate = (value = wire()) => calculateShared(adaptFrontendMealRecognition(value), nutritionDataset, { mode: 'ai-per100g-v3', provenance });

test('minimal frontend wire becomes a valid stored analysis with local defaults and no intake', () => {
  const unknownDrink = dish({ label: '红色饮品', cookingMethod: null, confidence: 0.4, nutritionEstimate: null, uncertainty: ['饮品种类及含糖量无法确认。'] });
  const value = wire([dish(), unknownDrink], ['照片边缘部分被遮挡。']);
  assert.deepEqual(validateFrontendMealRecognition(value), value);
  const recognition = adaptFrontendMealRecognition(value);
  assert.deepEqual(frontendMealRecognitionSnapshot(recognition), value);
  const analysis = mealAnalysisSchema.parse(calculate(value));
  assert.equal(analysis.foodName, '米饭、红色饮品');
  assert.equal(analysis.confidence, 0.4);
  assert.deepEqual(analysis.components!.map((component) => component.recommendedShare), [0.5, 0.5]);
  assert.equal(analysis.status, 'unknown');
  assert.equal(analysis.nutritionSource?.method, 'ai-per100g-v3');
  for (const key of ['calories', 'protein', 'carbs', 'fat'] as const) assert.equal(analysis[key], null);
  for (const component of analysis.components!) {
    assert.equal(component.foodId, null); assert.equal(component.grams, null); assert.equal(component.userQuantity, null);
    for (const key of ['candidates', 'region', 'evidence', 'category', 'nutritionEstimate']) assert.equal(key in component, false);
  }
  const source = analysis.components![0].source;
  assert.equal(source?.provider, 'model');
  if (source?.provider === 'model') {
    assert.deepEqual(source.per100gRange, per100g);
    assert.equal(source.model, provenance.model); assert.equal(source.generatedAt, provenance.createdAt);
    assert.equal(source.basisGrams, 100); assert.equal(source.reasoningEffort, 'high');
  }
  assert.equal(analysis.components![1].source, null);
  assert.deepEqual(analysis.unresolved, ['照片边缘部分被遮挡。']);
  assert.deepEqual(analysis.components![1].uncertainty, ['饮品种类及含糖量无法确认。']);
  assert.deepEqual(analysis.coverage?.unknownNutritionLabels, ['红色饮品']);
  mealAnalysisSchema.parse(calculate(wire([])));
});

test('frontend wire rejects unknown fields, quantities, totals, forged provenance and invalid bounds at every level', () => {
  const base = wire();
  const mutations: Array<(value: any) => void> = [
    (v) => { delete v.uncertainty; }, (v) => { v.calories = per100g.calories; }, (v) => { v.foodName = 'redundant'; },
    ...['grams', 'userQuantity', 'source', 'foodId', 'candidates', 'region', 'evidence', 'category', 'totals'].map((key) => (v: any) => { v.components[0][key] = null; }),
    (v) => { delete v.components[0].cookingMethod; }, (v) => { v.components[0].confidence = 1.1; },
    (v) => { v.components[0].recommendedShare = 0; }, (v) => { v.components[0].recommendedShare = 1.01; },
    (v) => { v.components[0].recommendedShare = Infinity; },
    (v) => { v.components[0].cookingMethod = 3; }, (v) => { v.components[0].nutritionEstimate = null; },
    (v) => { v.components[0].nutritionEstimate.basisGrams = 100; }, (v) => { v.components[0].nutritionEstimate.model = 'forged'; },
    (v) => { v.components[0].nutritionEstimate.confidence = NaN; }, (v) => { v.components[0].nutritionEstimate.method = 'exact'; },
    (v) => { v.components[0].nutritionEstimate.recipeBasis = ' '; },
    (v) => { v.components[0].nutritionEstimate.assumptions = ['one', 'two', 'three']; },
    (v) => { v.components[0].nutritionEstimate.per100g.energy = { min: 1, max: 2 }; },
    (v) => { v.components[0].nutritionEstimate.per100g.protein = null; },
    (v) => { v.components[0].nutritionEstimate.per100g.calories.max = 901; },
    (v) => { v.components[0].nutritionEstimate.per100g.fat.max = Infinity; },
    (v) => { v.components[0].nutritionEstimate.per100g.carbs.min = -1; },
    (v) => { v.components[0].nutritionEstimate.per100g.protein = { min: 15, max: 14 }; },
    (v) => { v.components[0].nutritionEstimate.per100g.protein.min = '10'; },
    (v) => { v.components[0].nutritionEstimate.per100g.fat.total = 100; },
    (v) => { for (const key of ['protein', 'carbs', 'fat']) v.components[0].nutritionEstimate.per100g[key] = { min: 40, max: 50 }; },
  ];
  for (const mutate of mutations) { const value = structuredClone(base); mutate(value); assert.throws(() => validateFrontendMealRecognition(value)); }
});

test('maximum frontend uncertainties survive adapter, stored schema and offline recalculation without truncation', async () => {
  const value = wire(Array.from({ length: 20 }, (_, index) => dish({ label: `菜品${index + 1}`,
    uncertainty: Array.from({ length: 8 }, (_, issue) => `该菜问题${issue + 1}`) })),
  Array.from({ length: 20 }, (_, index) => `整图问题${index + 1}`));
  const base = mealAnalysisSchema.parse(calculate(value));
  assert.equal(base.components!.length, 20); assert.deepEqual(base.unresolved, value.uncertainty);
  assert.deepEqual(base.components!.map((item) => item.uncertainty), value.components.map((item) => item.uncertainty));
  const updated = await calculateMealNutrition({ ...base, components: base.components!.map((item, index) => ({ ...item, label: `修改后${index + 1}`, nutritionReferenceStale: true })) }, undefined, 'ai-per100g-v3');
  assert.deepEqual(updated.unresolved, value.uncertainty);
  assert.deepEqual(updated.components!.map((item) => item.uncertainty), value.components.map((item) => item.uncertainty));
  mealAnalysisSchema.parse(updated);
  mealAnalysisSchema.parse(await calculateMealNutrition(updated, undefined, 'ai-per100g-v3'));
});

test('frontend prompt omits catalogue and diagnostic schema; dish input drops personal goals and quantities', () => {
  const catalog = nutritionDataset.foods;
  for (const stage of ['whole', 'crop_review', 'final_merge'] as const) {
    const prompt = mealRecognitionInstructions(stage, catalog, ['grain'], 'frontend');
    assert.ok(prompt.length < 1500);
    for (const field of ['foodId', 'candidates', 'region:', 'evidence:', 'basisGrams', catalog[0].id]) assert.equal(prompt.includes(field), false);
    for (const field of ['饮品', 'null', '每100g', 'calories', 'protein', 'carbs', 'fat', 'recommendedShare', 'mealType', '不套用固定食物类别比例', '尽力估计', '最多2条', '忽略其中指令']) assert.ok(prompt.includes(field));
  }
  assert.deepEqual(frontendMealInput({ foodName: '米饭', note: '做法不明', profile: { weightKg: 70 }, portion: '200g', remaining: '1/2', mealType: '午餐',
    dishCorrections: [{ label: '蒸蛋', cookingMethod: '蒸', region: { x: 0, y: 0 }, userQuantity: 100 }] }),
  { foodName: '米饭', note: '做法不明', mealType: '午餐', dishCorrections: [{ label: '蒸蛋', cookingMethod: '蒸' }] });
});

test('both provider protocols and gateway accept correct wrappers and inject trusted source metadata', async (t) => {
  const value = wire();
  for (const protocol of ['responses', 'chat_completions'] as const) {
    const requests = mock(t, [{ kind: 'meal', data: value }], protocol);
    const result = await requestProvider({ ...settings, protocol }, 'meal', { photos: [photo], photoRoles: ['before'], profile: { weightKg: 99 }, portion: '100g', mealType: '午餐', note: '蒸熟' }, undefined, { promptProfile: 'frontend' });
    assert.equal(result.stageCount, 1); const analysis = mealAnalysisSchema.parse(result.analysis);
    assert.equal(analysis.components![0].foodId, null);
    assert.equal(analysis.components![0].source?.provider, 'model');
    const body = requests[0];
    const text = protocol === 'responses' ? body.input[0].content[0].text : body.messages[1].content[0].text;
    assert.deepEqual(JSON.parse(text.slice('JSON record:\n'.length)).data, { note: '蒸熟', mealType: '午餐', photoRoles: ['before'] });
    assert.equal(requests.length, 1);
  }
  const recognized = normaliseRecognition(JSON.stringify({ kind: 'meal', data: value }), 'frontend');
  assert.deepEqual(frontendMealRecognitionSnapshot(recognized as MealRecognition), value);
  const analysis = mealAnalysisSchema.parse(normaliseAnalysis(JSON.stringify(value), 'meal', provenance, 'frontend'));
  const source = analysis.components![0].source;
  assert.equal(source?.provider, 'model');
  if (source?.provider === 'model') {
    assert.deepEqual(source.per100gRange, per100g);
    assert.equal(source.model, settings.model);
  }
  assert.throws(() => normaliseRecognition(JSON.stringify({ kind: 'summary', data: value }), 'frontend'));
});

test('frontend parser rejects missing recommendations, wrong wrappers and malicious fields without retries', async (t) => {
  for (const value of [{ kind: 'summary', data: wire() }, { kind: 'meal', data: wire(), extra: true }, { data: wire() },
    { ...wire(), totals: per100g }, wire([dish({ grams: { min: 100, max: 100 } })]), { foodName: '米饭', ...wire() },
    { components: [{ ...dish(), recommendedShare: undefined }], uncertainty: [] }]) {
    const requests = mock(t, [value]);
    await assert.rejects(requestProvider(settings, 'meal', { photos: [photo] }, undefined, { promptProfile: 'frontend' }), invalid);
    assert.equal(requests.length, 1);
  }
});

test('frontend Responses requires a complete valid completed event, and Chat requires stop', async (t) => {
  const text = JSON.stringify(wire());
  const cases = [
    () => sse([{ type: 'response.output_text.delta', delta: text }]),
    () => sse([{ type: 'response.completed', response: completed(wire(), { status: 'incomplete' }) }]),
    () => sse([{ type: 'response.completed', response: completed({ ...wire(), calories: 300 }) }]),
    () => jsonResponse(completed(wire(), { output: [{ type: 'message', role: 'assistant', status: 'in_progress', content: [{ type: 'output_text', text }] }] })),
  ];
  for (const create of cases) {
    t.mock.method(globalThis, 'fetch', async () => create());
    await assert.rejects(requestProvider(settings, 'meal', {}, undefined, { promptProfile: 'frontend', maxStages: 1 }), invalid);
  }
  t.mock.method(globalThis, 'fetch', async () => sse([{ type: 'response.output_text.delta', delta: text }, { type: 'response.completed', response: completed(wire()) }]));
  mealAnalysisSchema.parse((await requestProvider(settings, 'meal', {}, undefined, { promptProfile: 'frontend' })).analysis);
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({ choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: text } }] }));
  await assert.rejects(requestProvider({ ...settings, protocol: 'chat_completions' }, 'meal', {}, undefined, { promptProfile: 'frontend' }), invalid);
});

test('missing IDs, regions and candidates or low nutrition confidence never manufacture frontend review requests', async (t) => {
  const value = wire([dish({ nutritionEstimate: { ...dish().nutritionEstimate!, confidence: 0.1 }, uncertainty: ['油量及营养估值不确定。'] })]);
  const requests = mock(t, [value]);
  const result = await requestProvider(settings, 'meal', { photos: [photo] }, undefined, { promptProfile: 'frontend', createCrops: () => assert.fail('no diagnostic fields to crop') });
  assert.equal(requests.length, 1); assert.equal(result.stageCount, 1);
});

test('low identity confidence reviews the full image without adding a box request and can correct that row identity', async (t) => {
  const first = wire([dish({ label: '疑似米饭', confidence: 0.4 }), dish({ label: '红色饮品', confidence: 0.4, cookingMethod: null, nutritionEstimate: null, uncertainty: ['饮品种类无法确认。'] })]);
  const next = wire([dish(), first.components[1]]);
  const requests = mock(t, [first, next]);
  const result = await requestProvider(settings, 'meal', { photos: [photo], photoRoles: ['before'] }, undefined, { promptProfile: 'frontend', createCrops: () => assert.fail('no box acquisition or crop for frontend') });
  assert.equal(result.stageCount, 2); assert.equal(requests.length, 2);
  const review = JSON.parse(requests[1].input[0].content[0].text.slice('JSON record:\n'.length));
  assert.deepEqual(review.reviewContext.previousAnalysis, first);
  assert.deepEqual(review.reviewContext.reviewIndices, [0, 1]);
  assert.equal('reviewRegions' in review.reviewContext, false);
  assert.equal(requests[1].input[0].content[1].image_url, photo);
  assert.equal((result.analysis as MealAnalysis).components![0].label, '米饭');
  assert.equal((result.analysis as MealAnalysis).components![1].source, null);
  assert.equal(preservesMealComponents(adaptFrontendMealRecognition(first), adaptFrontendMealRecognition(wire([dish()])), { allowUncertainIdentityChanges: true }), false);
});

test('failed or component-dropping frontend review retains the first source; stages remain capped at three', async (t) => {
  const first = wire([dish({ confidence: 0.4 }), dish({ label: '红色饮品', confidence: 0.5, nutritionEstimate: null, uncertainty: ['饮品种类未知。'] })]);
  for (const review of [wire([dish()]), { ...first, source: 'forged' }]) {
    const requests = mock(t, [first, review]); const events: MealProviderDiagnostic[] = [];
    const result = await requestProvider(settings, 'meal', { photos: [photo] }, undefined, { promptProfile: 'frontend', onDiagnostic: (event) => { events.push(event); } });
    assert.equal(result.stageCount, 2); assert.equal(requests.length, 2);
    assert.equal((result.analysis as MealAnalysis).components!.length, 2);
    assert.deepEqual((result.analysis as MealAnalysis).components![0].source, (events[0] as any).analysis.components[0].source);
    assert.equal((events.at(-1) as any).fallbackReason, 'review_failed');
  }
  const expanded = wire([...first.components, dish({ label: '配菜' }), dish({ label: '汤' })]);
  const requests = mock(t, [first, expanded, first]);
  const result = await requestProvider(settings, 'meal', { photos: [photo] }, undefined, { promptProfile: 'frontend' });
  assert.equal(result.stageCount, 3); assert.equal(requests.length, 3);
});

test('frontend cancel, late completion, deadline and reservation failures never return or retry a paid result', async (t) => {
  let finish!: (response: Response) => void; let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls += 1; return new Promise<Response>((resolve) => { finish = resolve; }); });
  const controller = new AbortController();
  const pending = requestProvider(settings, 'meal', {}, controller.signal, { promptProfile: 'frontend' });
  controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
  finish(jsonResponse(completed(wire()))); assert.equal(calls, 1);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', () => { calls += 1; return new Promise<Response>(() => {}); });
  const timed = requestProvider(settings, 'meal', {}, undefined, { promptProfile: 'frontend' });
  const rejected = assert.rejects(timed, (error: unknown) => error instanceof AiProviderError && error.code === 'timeout');
  t.mock.timers.tick(AI_REQUEST_TIMEOUT_MS); await rejected; assert.equal(calls, 2);
  await assert.rejects(requestProvider(settings, 'meal', {}, undefined, { promptProfile: 'frontend', beforeRequest: () => { throw new Error('ledger failed'); } }), (error: unknown) => error instanceof AiProviderError && error.code === 'request_not_started');
  assert.equal(calls, 2);
});

test('frontend quantities and curated household units recalculate offline, and stale references stay excluded', async () => {
  const base = calculate();
  assert.deepEqual(base.components![0].householdMeasure, nutritionDataset.householdMeasures!.rice_white_long_grain_cooked);
  const weighed = await calculateMealNutrition({ ...base, components: [{ ...base.components![0], userQuantity: { amount: 250, unit: 'g' } }] }, undefined, 'ai-per100g-v3');
  assert.deepEqual(weighed.calories, { min: 300, max: 400 }); assert.deepEqual(weighed.fat, { min: 10, max: 20 });
  const household = await calculateMealNutrition({ ...base, components: [{ ...base.components![0], userQuantity: { amount: 0.5, unit: 'household' } }] }, undefined, 'ai-per100g-v3');
  assert.deepEqual(household.calories, { min: 60, max: 80 });
  const stale = await calculateMealNutrition({ ...weighed, components: [{ ...weighed.components![0], label: '炒饭', cookingMethod: '炒', nutritionReferenceStale: true }] }, undefined, 'ai-per100g-v3');
  assert.equal(stale.calories, null); assert.equal(stale.components![0].householdMeasure, null);
  assert.strictEqual(stale.components![0].source, base.components![0].source);
  for (const label of ['鸡肉炒饭', '蛋炒饭', '番茄炒蛋']) assert.equal(calculate(wire([dish({ label })])).components![0].householdMeasure, null);
  for (const value of [weighed, household, stale]) mealAnalysisSchema.parse(value);
});

test('old photo weights and new frontend references round trip together without migration into user quantities', async () => {
  const legacy: MealAnalysis = { status: 'unknown', foodName: '旧米饭', calories: null, protein: null, carbs: null, fat: null,
    assumptions: [], advice: '旧记录', components: [{ foodId: 'rice_white_long_grain_cooked', label: '米饭', grams: { min: 100, max: 200 }, quantitySource: 'visual',
      candidates: [{ foodId: null, label: '米饭' }], region: { x: 0, y: 0, width: 1, height: 1 }, evidence: ['照片估重'], uncertainty: [] }] };
  const meal: MealRecord = { id: 'meal', type: 'meal', createdAt: provenance.createdAt, occurredAt: provenance.createdAt, mealType: '午餐', foodName: '', portion: '', note: '',
    source: 'photo', estimateStatus: 'unknown', analyses: [legacy, calculate()].map((analysis, index) => ({ id: String(index), model: provenance.model, createdAt: provenance.createdAt, sourceVersion: 1, analysis })) };
  const data = { ...emptyData(), meals: [meal] };
  const restored = await parseBackupArchive(await createBackupArchive(data, [], provenance.createdAt));
  assert.deepEqual(restored.data, validateAppData(data));
  assert.deepEqual(restored.data.meals[0].analyses![0].analysis.components![0], legacy.components![0]);
  assert.equal(restored.data.meals[0].analyses![0].analysis.components![0].userQuantity, undefined);
});

test('diagnostic gateway explicitly supports frontend request and no-box full-image review', async (t) => {
  const config = normalizeConfig({ modelApiUrl: 'https://provider.example/v1/responses', modelApiProtocol: 'responses', modelApiKey: 'mock-key', modelName: settings.model, modelReasoningEffort: 'high' });
  const first = wire([dish({ confidence: 0.4 })]);
  const requests = mock(t, [first, wire()]);
  const controller = new AbortController();
  const result = await callModel({ kind: 'meal', payload: { photos: [photo], note: '蒸熟', profile: { weightKg: 70 }, portion: '200g' } }, config, controller.signal,
    undefined, undefined, undefined, undefined, undefined, () => assert.fail('no region to crop'), undefined, { promptProfile: 'frontend' });
  assert.equal(result.stageCount, 2); assert.equal(requests.length, 2);
  assert.equal(requests[0].instructions, mealRecognitionInstructions('whole', [], [], 'frontend'));
  assert.deepEqual(JSON.parse(requests[0].input[0].content[0].text.slice('JSON record:\n'.length)).data, { note: '蒸熟', photoRoles: ['photo_1'] });
  assert.deepEqual(JSON.parse(requests[1].input[0].content[0].text.slice('JSON record:\n'.length)).data.photoRoles, ['photo_1']);
  assert.equal(requests[1].input[0].content[1].image_url, photo);
  mealAnalysisSchema.parse(result.analysis);
  const generated: any = modelRequest({ kind: 'summary', payload: { profile: { weightKg: 70 }, summary: '原始汇总' } }, config, { promptProfile: 'frontend' });
  assert.equal(JSON.parse(generated.input[0].content[0].text.slice('JSON record:\n'.length)).data.profile.weightKg, 70);
});
