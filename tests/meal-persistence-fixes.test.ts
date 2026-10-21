import assert from 'node:assert/strict';
import test from 'node:test';
import { adaptFrontendMealRecognition, calculateMealNutrition as calculateShared } from '../shared/nutrition.mjs';
import { createBackupArchive, parseBackupArchive, validateFormDrafts } from '../src/backup';
import { mealCalories, summaryMarkdown } from '../src/domain';
import { createMealAnalysisDraft, mealAnalysisDraftSchema, prepareMealAnalysisForSave, restoreMealFormDraft, type MealAnalysisDraft } from '../src/meal-analysis-draft';
import { nutritionFieldsFromAnalysis } from '../src/meal-nutrition-fields';
import { buildMealReviewAnalysis, createMealReviewRows, mergeReviewedQuantities, updateMealReviewRow } from '../src/meal-review';
import { nutritionDataset } from '../src/nutrition';
import { mealAnalysisSchema } from '../src/nutrition-schema';
import { emptyData, type MealAnalysis, type MealRecord, type NutrientRanges } from '../src/types';
import type { PhotoAnalysisResult } from '../src/ui/app-types';
import { mealFormHarness } from './helpers/meal-form-harness';

const now = '2026-10-21T03:00:00.000Z';
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a90sAAAAASUVORK5CYII=';
const ranges = (calories = 200): NutrientRanges => ({
  calories: { min: calories, max: calories }, protein: { min: 10, max: 10 },
  carbs: { min: 20, max: 20 }, fat: { min: 5, max: 5 },
});
const dish = (label = '熟米饭', calories = 200, cookingMethod = '蒸煮', uncertainty: string[] = []) => ({
  label, cookingMethod, confidence: 0.95,
  nutritionEstimate: { method: 'typical_recipe' as const, per100g: ranges(calories), recipeBasis: '每 100 g 成品的典型配方。', assumptions: ['未加额外油。'], confidence: 0.9 },
  uncertainty,
});
const raw = (dishes = [dish()]): PhotoAnalysisResult => ({ model: 'mock/model', createdAt: now, stageCount: 1,
  analysis: mealAnalysisSchema.parse(calculateShared(adaptFrontendMealRecognition({ components: dishes, uncertainty: [] }), nutritionDataset,
    { mode: 'ai-per100g-v3', provenance: { model: 'mock/model', reasoningEffort: 'max', createdAt: now } })),
});
const meal = (analysis?: MealAnalysis): MealRecord => {
  const source = raw();
  const current = analysis ?? buildMealReviewAnalysis(source.analysis, [updateMealReviewRow(createMealReviewRows(source.analysis)[0], { quantity: '250' })]);
  return { id: 'saved-meal', type: 'meal', createdAt: now, occurredAt: now, mealType: '午餐', foodName: '熟米饭', foodNameSource: 'analysis',
    portion: '', note: '原备注', source: 'photo', imageUri: image, beforeImageUris: [image], estimateStatus: 'unknown', revision: 1,
    analyses: [{ id: 'raw-original', sourceVersion: 1, ...source }, { id: 'confirmed-original', sourceVersion: 1, model: 'local/meal-review', createdAt: now, analysis: current }] };
};
const withPhotos = () => new Map<string, unknown>([['meal-new', { imageUri: image, beforeImageUris: [image] }]]);
const editedQuantity = async (h: ReturnType<typeof mealFormHarness>, quantity: string, index = 0) => h.act(() => h.review().onChange(h.review().rows[index].id, { quantity }));
const openReview = async (h: ReturnType<typeof mealFormHarness>) => h.act(() => h.get('Pressable', (props) => props.testID === 'meal-edit-portions').onPress());
const editNutritionInputs = async (h: ReturnType<typeof mealFormHarness>) =>
  h.act(() => h.get('Pressable', (props) => props.testID === 'meal-edit-nutrients').onPress());
const confirmedRecord = (saved: ReturnType<typeof mealFormHarness>['saved'][number]): MealRecord => ({
  ...saved.meal, id: 'saved-from-form', type: 'meal', createdAt: now, revision: 1,
  analyses: saved.analysis ? [...(saved.analysis.history ?? []), saved.analysis].map(({ history: _history, ...version }: any, index) => ({ id: `version-${index}`, sourceVersion: 1, ...version })) : [],
});

test('production form persists confirmed quantities, explicit clears, references and full history through close, reopen, save and backup', async () => {
  const drafts = withPhotos();
  const response = raw([dish(), dish('蒸蛋', 100, '蒸')]);
  const h = mealFormHarness({ drafts, analyzeOnOpen: true, analyze: async () => response });
  await h.flush();
  await editedQuantity(h, '250');
  await editedQuantity(h, '', 1);
  await h.act(() => h.review().onConfirm());
  assert.ok(h.nodes().some((node) => node.props.testID === 'meal-nutrition-summary'));
  await editNutritionInputs(h);
  assert.equal(h.field('热量 kcal').value, '500');
  await h.act(() => h.sheet().onClose());
  assert.equal(h.closed(), true);
  const closedDraft = structuredClone(drafts.get('meal-new')) as any;
  assert.equal(closedDraft.analysisDraft.version, 1);
  assert.equal(closedDraft.analysisDraft.confirmed.analysis.components[0].userQuantity.amount, 250);
  assert.equal(closedDraft.analysisDraft.confirmed.analysis.components[1].userQuantityCleared, true);
  const reopened = mealFormHarness({ drafts, profile: { calorieTarget: 5000 } });
  await reopened.flush();
  await openReview(reopened);
  assert.equal(reopened.review().rows[0].quantity, '250');
  assert.equal(reopened.review().rows[0].quantityOrigin, 'user');
  assert.equal(reopened.review().rows[1].quantity, '');
  assert.equal(reopened.review().rows[1].quantityEdited, true);
  await editedQuantity(reopened, '300');
  await reopened.act(() => reopened.review().onConfirm());
  await editNutritionInputs(reopened);
  assert.equal(reopened.field('热量 kcal').value, '600');
  await reopened.act(() => reopened.sheet().onSave());
  assert.equal(reopened.saved.length, 1);
  assert.equal(drafts.has('meal-new'), false);
  const saved = confirmedRecord(reopened.saved[0]);
  assert.equal(saved.analyses?.at(-1)?.model, 'local/meal-review');
  assert.equal(saved.analyses?.at(-1)?.analysis.nutritionSource?.method, 'ai-per100g-v3');
  assert.equal(saved.analyses?.at(-1)?.analysis.components?.[0].userQuantity?.amount, 300);
  assert.equal(saved.analyses?.at(-1)?.analysis.components?.[1].userQuantityCleared, true);
  assert.equal(saved.analyses?.[0].analysis.components?.[0].userQuantity, null);
  assert.equal(saved.analyses?.[1].analysis.components?.[0].userQuantity?.amount, 250);
  assert.deepEqual(response.analysis, raw([dish(), dish('蒸蛋', 100, '蒸')]).analysis);
  const data = { ...emptyData(), meals: [saved] };
  const bytes = await createBackupArchive(data, [{ uri: image, kind: 'image', bytes: Buffer.from(image.split(',')[1], 'base64'), extension: 'png' }], now,
    { drafts: { 'meal-new': closedDraft } });
  const restored = await parseBackupArchive(bytes);
  assert.deepEqual(restored.data.meals[0].analyses, saved.analyses);
  const restoredDraft = restoreMealFormDraft(restored.drafts['meal-new']) as any;
  assert.equal(restoredDraft.analysisDraft.history[0].analysis.calories, null);
  assert.equal(restoredDraft.analysisDraft.confirmed.analysis.components[0].source.model, 'mock/model');
  assert.equal(restoredDraft.analysisDraft.confirmed.analysis.components[1].userQuantityCleared, true);
});

test('unconfirmed review edits survive closing and reopening without changing the effective confirmed values', async () => {
  const initial = meal();
  const drafts = new Map<string, unknown>();
  const h = mealFormHarness({ initial, drafts });
  await h.flush();
  await openReview(h);
  await editedQuantity(h, '350');
  await h.act(() => h.review().onNote('尚未确认的说明'));
  await h.act(() => h.review().onBack());
  await editNutritionInputs(h);
  assert.equal(h.field('热量 kcal').value, '500');
  await h.act(() => h.sheet().onClose());
  const reopened = mealFormHarness({ initial, drafts });
  await reopened.flush();
  await editNutritionInputs(reopened);
  assert.equal(reopened.field('热量 kcal').value, '500');
  await openReview(reopened);
  assert.equal(reopened.review().rows[0].quantity, '350');
  assert.equal(reopened.review().note, '尚未确认的说明');
  await reopened.act(() => reopened.review().onBack());
  await reopened.act(() => reopened.sheet().onSave());
  assert.equal(reopened.saved[0].analysis?.analysis.calories?.min, 500);
  assert.equal(reopened.saved[0].analysis?.analysis.components?.[0].userQuantity?.amount, 250);
  assert.ok(reopened.saved[0].analysis?.history?.some((version) => version.analysis.components?.[0].userQuantity?.amount === 350));
  assert.equal(mealCalories(initial)?.min, 500);
});

test('saved-meal reanalysis uses fresh references and reliable quantities while the original summary remains effective until save', async () => {
  const initial = meal();
  const original = structuredClone(initial);
  const originalSummary = summaryMarkdown({ ...emptyData(), meals: [initial] }, '2026-10-21');
  const drafts = new Map<string, unknown>();
  const fresh = raw([dish('熟米饭', 300)]);
  const h = mealFormHarness({ initial, drafts, analyzeOnOpen: true, analyze: async () => fresh });
  await h.flush();
  assert.equal(h.review().rows[0].quantity, '250');
  assert.equal(h.review().preview.calories.min, 750);
  assert.equal(h.saved.length, 0);
  assert.deepEqual(initial, original);
  await h.act(() => h.review().onBack());
  await editNutritionInputs(h);
  assert.equal(h.field('热量 kcal').value, '500');
  await h.act(() => h.sheet().onClose());
  assert.equal(summaryMarkdown({ ...emptyData(), meals: [initial] }, '2026-10-21'), originalSummary);
  const reopened = mealFormHarness({ initial, drafts });
  await reopened.flush();
  await openReview(reopened);
  assert.equal(reopened.review().preview.calories.min, 750);
  await reopened.act(() => reopened.review().onConfirm());
  await editNutritionInputs(reopened);
  assert.equal(reopened.field('热量 kcal').value, '750');
  assert.equal(mealCalories(initial)?.min, 500);
  await reopened.act(() => reopened.sheet().onSave());
  assert.equal(reopened.saved[0].analysis?.analysis.calories?.min, 750);
  assert.equal(reopened.saved[0].analysis?.history?.[0].analysis.calories, null);
  assert.equal(reopened.saved[0].analysis?.history?.[0].analysis.components?.[0].source?.provider, 'model');
});

test('fresh reordered dishes preserve only unique names and methods, including estimated origins and explicit exclusions', () => {
  const source = raw([dish(), dish('蒸蛋', 100, '蒸'), dish('清炒青菜', 50, '炒')]);
  const rows = createMealReviewRows(source.analysis);
  rows[0] = updateMealReviewRow(rows[0], { quantity: '250' });
  rows[1] = { ...rows[1], quantity: '123', quantityOrigin: 'estimated' };
  rows[2] = updateMealReviewRow(rows[2], { quantity: '' });
  const previous = buildMealReviewAnalysis(source.analysis, rows);
  const fresh = raw([dish('清炒青菜', 70, '炒'), dish('蒸蛋', 130, '蒸'), dish(' 熟 米 饭 ', 300, ' 蒸煮 ')]);
  const merged = mergeReviewedQuantities(fresh.analysis, previous);
  assert.equal(merged.components?.[0].userQuantityCleared, true);
  assert.deepEqual(merged.components?.[1].userQuantity, { amount: 123, unit: 'g', origin: 'estimated' });
  assert.deepEqual(merged.components?.[2].userQuantity, { amount: 250, unit: 'g', origin: 'user' });
  assert.deepEqual(merged.components?.[2].source, fresh.analysis.components?.[2].source);
  for (const changed of [
    raw([dish('炒饭', 300, '蒸煮')]), raw([dish('熟米饭', 300, '炒')]), raw([dish(), dish()]),
    raw([dish('熟米饭', 200, '蒸煮', ['菜品身份不确定。'])]),
  ]) {
    const merged = mergeReviewedQuantities(changed.analysis, previous);
    assert.ok(merged.components?.every((component) => component.userQuantity === null && !component.userQuantityCleared));
  }
});

test('production saved-meal reanalysis never estimates unmatched renamed, duplicate or ambiguous dishes from old quantities', async () => {
  for (const response of [raw([dish('新菜名')]), raw([dish('熟米饭', 200, '炒')]), raw([dish(), dish()]),
    raw([dish('熟米饭', 200, '蒸煮', ['菜品身份不明。'])])]) {
    const h = mealFormHarness({ initial: meal(), analyzeOnOpen: true, analyze: async () => response });
    await h.flush();
    assert.ok(h.review().rows.every((row: any) => row.quantity === ''));
    assert.equal(h.saved.length, 0);
    await h.act(() => h.review().onBack());
    await editNutritionInputs(h);
    assert.equal(h.field('热量 kcal').value, '500');
    h.unmount();
  }
});

test('estimated quantities remain frozen after confirmed drafts reopen under a different profile', async () => {
  const drafts = withPhotos();
  const h = mealFormHarness({ drafts, analyzeOnOpen: true, analyze: async () => raw() });
  await h.flush();
  const quantity = h.review().rows[0].quantity;
  assert.ok(Number(quantity) > 0);
  await h.act(() => h.review().onConfirm());
  await h.act(() => h.sheet().onClose());
  const restored = mealFormHarness({ drafts, profile: { weightKg: 120, calorieTarget: 5000 } });
  await restored.flush();
  await openReview(restored);
  assert.equal(restored.review().rows[0].quantity, quantity);
  assert.equal(restored.review().rows[0].quantityOrigin, 'estimated');
  assert.equal(restored.review().preservePortions, true);
  restored.unmount();
});

test('failure, explicit cancellation, settings changes and closed sessions cannot append late recognition or replace saved intake', async () => {
  const failed = mealFormHarness({ initial: meal(), analyzeOnOpen: true, analyze: async () => { throw new Error('mock timeout'); } });
  await failed.flush();
  await editNutritionInputs(failed);
  assert.equal(failed.field('热量 kcal').value, '500');
  assert.equal(failed.saved.length, 0);
  assert.ok(failed.nodes().some((node) => JSON.stringify(node.props.children).includes('mock timeout')));
  failed.unmount();
  for (const reason of ['cancel', 'settings', 'close'] as const) {
    let resolve!: (value: PhotoAnalysisResult) => void;
    let version = 1;
    const drafts = new Map<string, unknown>();
    const h = mealFormHarness({ initial: meal(), drafts, analyzeOnOpen: true, settingsVersion: () => version,
      analyze: () => new Promise((done) => { resolve = done; }) });
    await h.flush();
    if (reason === 'cancel') await h.act(() => h.button('取消照片分析').onPress());
    if (reason === 'settings') version += 1;
    if (reason === 'close') await h.act(() => h.sheet().onClose());
    resolve(raw([dish('不应应用的迟到菜')]))
    await h.flush();
    assert.equal(h.saved.length, 0);
    if (reason !== 'close') {
      await editNutritionInputs(h);
      assert.equal(h.field('热量 kcal').value, '500');
      await h.act(() => h.sheet().onClose());
    }
    const state = drafts.get('meal-saved-meal') as any;
    assert.equal(state.analysisDraft.history.length, 0);
    assert.equal(state.analysisDraft.review, null);
    assert.equal(h.requests[0].signal.aborted, reason !== 'settings');
  }
});

test('legacy flat drafts and backups retain the saved analysis; malformed analysis drafts and stale record bases fail without mutation', async () => {
  const legacy = { foodName: '旧草稿标题', calories: '500', beforeImageUris: [image] };
  assert.deepEqual(restoreMealFormDraft(legacy, meal()), legacy);
  const parsed = await parseBackupArchive(await createBackupArchive(emptyData(), [{ uri: image, kind: 'image', bytes: new Uint8Array([1, 2]), extension: 'png' }], now,
    { drafts: { 'meal-saved-meal': legacy } }));
  const h = mealFormHarness({ initial: meal(), drafts: new Map(Object.entries(parsed.drafts)) });
  await h.flush();
  assert.equal(h.field('食物名称').value, '旧草稿标题');
  await openReview(h);
  assert.equal(h.review().rows[0].quantity, '250');
  h.unmount();
  const state = createMealAnalysisDraft(meal());
  state.confirmed = raw();
  const valid = { analysisDraft: state };
  const original = JSON.stringify(valid);
  assert.equal(mealAnalysisDraftSchema.safeParse(state).success, true);
  for (const change of [
    (value: any) => { value.version = 2; },
    (value: any) => { value.confirmed.analysis.status = 'broken'; },
    (value: any) => { value.confirmed.analysis.status = 'unknown'; value.confirmed.analysis.calories = { min: 1, max: 2 }; },
    (value: any) => { value.confirmed.analysis.components[0].userQuantity = { amount: -1, unit: 'g' }; },
    (value: any) => { value.confirmed.analysis.components[0].source.per100gRange.fat.max = 101; },
  ]) {
    const invalid = structuredClone(valid);
    change(invalid.analysisDraft);
    assert.throws(() => restoreMealFormDraft(invalid, meal()), /校验失败/);
    assert.throws(() => validateFormDrafts({ 'meal-saved-meal': invalid }), /校验失败/);
  }
  assert.throws(() => restoreMealFormDraft(valid, { ...meal(), revision: 2 }), /版本已变更/);
  assert.throws(() => restoreMealFormDraft(valid), /版本已变更/);
  assert.equal(JSON.stringify(valid), original);
});

test('failed or incompatible hydration never autosaves initial data over the original draft and permits an explicit read retry', async () => {
  const original = { beforeImageUris: [image], foodName: '不可丢失的原草稿' };
  for (const fail of ['read', 'invalid'] as const) {
    let recovered = false;
    const drafts = new Map<string, unknown>([['meal-new', structuredClone(original)]]);
    const h = mealFormHarness({ drafts, load: async () => {
      if (recovered) return original;
      if (fail === 'read') throw new Error('mock read error');
      return { ...original, analysisDraft: { version: 1, confirmed: { broken: true } } };
    } });
    await h.flush();
    await new Promise((resolve) => setTimeout(resolve, 380));
    await h.flush();
    assert.equal(h.writes.length, 0);
    assert.deepEqual(drafts.get('meal-new'), original);
    assert.match(h.get('DraftStatus').error, /读取草稿失败/);
    await h.act(() => h.sheet().onClose());
    assert.equal(h.closed(), false);
    assert.equal(h.writes.length, 0);
    recovered = true;
    await h.act(() => h.button('重试读取餐食草稿').onPress());
    assert.equal(h.field('食物名称').value, original.foodName);
    await h.act(() => h.sheet().onClose());
    assert.equal(h.closed(), true);
    assert.ok(h.writes.length > 0);
  }
});

test('manual overrides remain authoritative while history without confirmation or user values creates no effective analysis', () => {
  const initial = meal();
  const state = createMealAnalysisDraft(initial);
  state.history = [raw([dish('新菜', 300)])];
  const fields = { ...nutritionFieldsFromAnalysis(initial.analyses!.at(-1)!.analysis), foodName: initial.foodName };
  const pending = prepareMealAnalysisForSave(state, fields, initial);
  assert.equal(pending.result?.analysis.calories?.min, 500);
  assert.equal(pending.result?.analysis.components?.[0].userQuantity?.amount, 250);
  const manual = prepareMealAnalysisForSave(state, { ...fields, calories: '800', protein: '40', carbs: '60', fat: '20' }, initial);
  assert.equal(manual.result?.model, 'local/manual-nutrition');
  assert.equal(manual.result?.analysis.nutritionSource?.method, 'manual-total-v1');
  assert.equal(manual.result?.analysis.calories?.min, 800);
  assert.equal(manual.result?.analysis.components?.[0].userQuantity?.amount, 250);
  assert.equal(manual.estimate, undefined);
  const unconfirmed: MealAnalysisDraft = { ...createMealAnalysisDraft(), history: [raw()] };
  const unknown = prepareMealAnalysisForSave(unconfirmed, { calories: '', protein: '', carbs: '', fat: '', foodName: '未确认餐食' });
  assert.equal(unknown.result, undefined);
});

test('saving a new meal with an unconfirmed estimate keeps raw recognition current and estimated quantities only in audit history', async () => {
  const drafts = withPhotos();
  const recognition = raw();
  const h = mealFormHarness({ drafts, profile: { heightCm: 170, weightKg: 70, calorieTarget: 2000 },
    analyzeOnOpen: true, analyze: async () => recognition });
  await h.flush();
  assert.equal(h.review().rows[0].quantityOrigin, 'estimated');
  assert.ok(Number(h.review().rows[0].quantity) > 0);
  assert.ok(h.review().preview.calories);
  await h.act(() => h.review().onBack());
  await h.act(() => h.sheet().onSave());

  const result = h.saved[0].analysis!;
  assert.equal(result.model, recognition.model);
  assert.equal(result.analysis.calories, null);
  assert.equal(result.analysis.components?.[0].userQuantity, null);
  assert.deepEqual(result.history?.map((version) => version.model), ['local/meal-review']);
  assert.equal(result.history?.[0].analysis.components?.[0].userQuantity?.origin, 'estimated');
  assert.equal(h.saved[0].meal.estimate, undefined);
  assert.equal(h.saved[0].meal.estimateStatus, 'unknown');
  assert.equal(mealCalories(confirmedRecord(h.saved[0])), null);
});
