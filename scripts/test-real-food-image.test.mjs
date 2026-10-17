import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalCropper, parseOptions, finalizeRealFoodReport, createOfflineQuantityCheck, redactRawResponse, REAL_FOOD_RESULT_VERSION } from './test-real-food-image.mjs';
import { syntheticImage } from './synthetic-image.mjs';
import { calculateMealNutrition } from '../shared/nutrition.mjs';

function referenceAnalysis() {
  return calculateMealNutrition({ foodName: '家常炒菜', confidence: 0.8,
    components: [{ foodId: null, label: '家常炒菜', uncertainty: [], nutritionEstimate: {
      basisGrams: 100, method: 'typical_recipe', recipeBasis: '常见蔬菜和鸡蛋配方。', assumptions: ['油量和原料比例有差异。'], confidence: 0.7,
      per100g: { calories: { min: 160, max: 240 }, protein: { min: 5, max: 9 }, carbs: { min: 8, max: 14 }, fat: { min: 10, max: 18 } },
    } }], unresolved: [], assumptions: [], advice: '数量待填写。',
  }, undefined, { mode: 'ai-per100g-v3', provenance: { model: 'gpt-6.1-sol', reasoningEffort: 'max', createdAt: '2026-10-17T01:02:03.000Z' } });
}

const completedAttempt = (changes = {}) => ({ attemptId: 1, stage: 'whole', model: 'gpt-6.1-sol', reasoningEffort: 'max', resultVersion: 3,
  status: 'accepted', elapsedMs: 45_000, httpStatus: 200, providerCompleted: true, resultAccepted: true,
  usage: { input_tokens: 100, output_tokens: 200, total_tokens: 300 }, errorCode: null, ...changes });
const acceptedStage = (analysis = referenceAnalysis(), changes = {}) => ({ attemptId: 1, stage: 'whole', status: 'accepted', accepted: true, resultAccepted: true, analysis, ...changes });
const inputReport = (changes = {}) => ({ schemaVersion: 'real-food-image-report.v4', resultVersion: REAL_FOOD_RESULT_VERSION,
  result: { status: 200, analysis: referenceAnalysis(), stageCount: 1, requestCount: 1 },
  requestAttempts: [completedAttempt()], stageResults: [acceptedStage()], ...changes });

test('real-photo diagnostics default to the 180-second stage timeout and allow explicit bounds', () => {
  assert.equal(parseOptions(['node', 'test-real-food-image.mjs', '--live']).timeoutMs, 180_000);
  assert.equal(parseOptions(['node', 'test-real-food-image.mjs', '--live', '--timeout-ms=120000']).timeoutMs, 120_000);
  const options = parseOptions(['node', 'test-real-food-image.mjs', '--live', '--stream', '--timeout-ms=180000', '--image-detail=low', '--app-copy']);
  assert.equal(options.stream, true);
  assert.equal(options.imageDetail, 'low');
  assert.equal(options.actualAppCopy, true);
  assert.equal(parseOptions(['node', 'test-real-food-image.mjs', '--live']).stream, true);
  assert.equal(parseOptions(['node', 'test-real-food-image.mjs', '--live']).imageDetail, 'low');
  assert.throws(() => parseOptions(['node', 'test-real-food-image.mjs']), /--live/);
  assert.throws(() => parseOptions(['node', 'test-real-food-image.mjs', '--live', '--ledger-path=:memory:']), /two existing/);
  assert.throws(() => parseOptions(['node', 'test-real-food-image.mjs', '--live', '--ledger-path=artifacts/new-ledger.sqlite']), /two existing/);
  assert.throws(() => parseOptions(['node', 'test-real-food-image.mjs', '--live', '--stream', '--no-stream']), /streaming mode/);
});

test('Playwright cropper emits a bounded JPEG slice for the supplied normalized region', async () => {
  const cropper = createLocalCropper();
  try {
    const source = syntheticImage();
    const crops = await cropper.createCrops({
      input: { payload: { photos: [source] } },
      regions: [{ x: 0.1, y: 0.2, width: 0.5, height: 0.4 }],
      stage: 'crop_review',
    });
    assert.equal(crops.length, 1);
    assert.match(crops[0], /^data:image\/jpeg;base64,/);
    assert.notEqual(crops[0], source);
    assert.equal(Buffer.from(crops[0].slice(crops[0].indexOf(',') + 1), 'base64').subarray(0, 3).toString('hex'), 'ffd8ff');
    assert.deepEqual(cropper.history[0].sourcePixels, { x: 7, y: 20, width: 77, height: 62 });
    assert.equal(cropper.history[0].region.x, 0.1);
    assert.equal(cropper.history[0].stage, 'crop_review');
  } finally { await cropper.close(); }
});

test('cropper rejects unrelated stages without launching a browser', async () => {
  const cropper = createLocalCropper();
  try {
    await assert.rejects(cropper.createCrops({ regions: [], stage: 'whole' }), /only available for crop review/);
    assert.deepEqual(cropper.history, []);
  } finally { await cropper.close(); }
});

test('a completed and accepted reference-only response succeeds with unknown intake and preserves each nutrient range', () => {
  const source = inputReport();
  const before = structuredClone(source);
  const report = finalizeRealFoodReport(source);
  assert.equal(report.validation.completed, true);
  assert.equal(report.validation.accepted, true);
  assert.equal(report.validation.nutritionFeatureSucceeded, true);
  assert.equal(report.validation.unknownIntakeWithUsefulReference, true);
  assert.equal(report.validation.referenceCount, 1);
  assert.equal(report.validation.usefulReferenceCount, 1);
  assert.equal(report.validation.counted, 0);
  assert.equal(report.validation.intakeComplete, false);
  assert.equal(report.result.analysis.calories, null);
  assert.equal(report.stageAssessments[0].model, 'gpt-6.1-sol');
  assert.equal(report.stageAssessments[0].reasoningEffort, 'max');
  assert.equal(report.stageAssessments[0].completed, true);
  assert.equal(report.stageAssessments[0].accepted, true);
  assert.deepEqual(report.stageAssessments[0].usage, { input_tokens: 100, output_tokens: 200, total_tokens: 300 });
  assert.deepEqual(report.nutritionReference.components[0].reference.nutrients, source.stageResults[0].analysis.components[0].source.per100gRange);
  assert.equal(report.nutritionReference.components[0].userQuantity, null);
  assert.equal(report.nutritionReference.components[0].reference.method, 'typical_recipe');
  assert.deepEqual(report.nutritionReference.components[0].reference.assumptions, ['油量和原料比例有差异。']);
  assert.equal(report.offlineQuantityCheck.passed, true);
  assert.deepEqual(source, before);
});

test('complete transport with invalid business output stays distinct from an incomplete transport', () => {
  for (const [status, providerCompleted, errorCode] of [['format_error', true, 'invalid_model_response'], ['timeout', false, 'upstream_timeout']]) {
    const report = finalizeRealFoodReport(inputReport({
      result: { status: 502, analysis: null, errorCode }, stageResults: [],
      requestAttempts: [completedAttempt({ status, providerCompleted, resultAccepted: false, errorCode })],
    }));
    assert.equal(report.validation.completed, providerCompleted, status);
    assert.equal(report.validation.accepted, false, status);
    assert.equal(report.validation.hasUsefulNutritionReference, false, status);
    assert.equal(report.validation.nutritionFeatureSucceeded, false, status);
    assert.equal(report.stageAssessments[0].completed, providerCompleted, status);
    assert.equal(report.stageAssessments[0].accepted, false, status);
    assert.equal(report.stageAssessments[0].errorCode, errorCode);
    assert.equal(report.firstAcceptedResult, null);
  }
});

test('an incomplete, unsuccessful HTTP or older-version stage cannot pass the new feature check even with useful-looking analysis', () => {
  for (const change of [{ providerCompleted: false }, { resultAccepted: false }, { httpStatus: 500 }, { httpStatus: null }, { resultVersion: 2 }]) {
    const report = finalizeRealFoodReport(inputReport({ requestAttempts: [completedAttempt(change)] }));
    assert.equal(report.validation.nutritionFeatureSucceeded, false, JSON.stringify(change));
  }
});

test('a reference cannot pass with model provenance that disagrees with the recorded request', () => {
  const analysis = referenceAnalysis();
  analysis.components[0].source.model = 'different-model';
  const report = finalizeRealFoodReport(inputReport({ result: { status: 200, analysis }, stageResults: [acceptedStage(analysis)] }));
  assert.equal(report.validation.hasUsefulNutritionReference, true);
  assert.equal(report.stageAssessments[0].provenanceConsistent, false);
  assert.equal(report.validation.nutritionFeatureSucceeded, false);
});

test('an accepted all-unknown response or a source missing one nutrient cannot count as successful nutrition estimation', () => {
  for (const missing of ['unknown', 'calories', 'protein', 'carbs', 'fat']) {
    const analysis = referenceAnalysis();
    if (missing === 'unknown') { analysis.components[0].source = null; analysis.coverage.referenceCount = 0; }
    else delete analysis.components[0].source.per100gRange[missing];
    const report = finalizeRealFoodReport(inputReport({ result: { status: 200, analysis }, stageResults: [acceptedStage(analysis)] }));
    assert.equal(report.validation.completed, true, missing);
    assert.equal(report.validation.accepted, true, missing);
    assert.equal(report.validation.hasUsefulNutritionReference, false, missing);
    assert.equal(report.validation.nutritionFeatureSucceeded, false, missing);
    assert.equal(report.offlineQuantityCheck, null, missing);
  }
});

test('a later timeout preserves the first accepted reference, while later stage success is never inferred', () => {
  const first = acceptedStage();
  const report = finalizeRealFoodReport(inputReport({
    result: { status: 504, analysis: first.analysis, errorCode: 'upstream_timeout' }, stageResults: [first],
    requestAttempts: [completedAttempt(), completedAttempt({ attemptId: 2, stage: 'crop_review', status: 'timeout',
      providerCompleted: false, resultAccepted: false, elapsedMs: 180_000, errorCode: 'upstream_timeout' })],
  }));
  assert.deepEqual(report.firstAcceptedResult.analysis, first.analysis);
  assert.deepEqual(report.latestAcceptedResult.analysis, first.analysis);
  assert.equal(report.stageAssessments[0].nutritionFeatureSucceeded, true);
  assert.equal(report.stageAssessments[1].nutritionFeatureSucceeded, false);
  assert.equal(report.validation.hasPreservedAcceptedResult, true);
  assert.equal(report.validation.hasUsefulNutritionReference, true);
  assert.equal(report.validation.workflowCompleted, false);
  assert.equal(report.validation.allStagesSucceeded, false);
  assert.equal(report.validation.nutritionFeatureSucceeded, false);
});

test('final-merge timeout returns the first analysis instead of promoting an abandoned review reference', () => {
  const first = referenceAnalysis();
  first.components[0].source = null;
  first.coverage.referenceCount = 0;
  first.coverage.matched = 0;
  first.coverage.unknownNutritionLabels = ['家常炒菜'];
  const review = referenceAnalysis();
  const report = finalizeRealFoodReport(inputReport({
    result: { status: 200, analysis: first, stageCount: 3, requestCount: 3, returnedStage: 'whole', returnedAttemptId: 1 },
    stageResults: [
      acceptedStage(first),
      acceptedStage(review, { attemptId: 2, stage: 'crop_review' }),
    ],
    requestAttempts: [
      completedAttempt(),
      completedAttempt({ attemptId: 2, stage: 'crop_review' }),
      completedAttempt({ attemptId: 3, stage: 'final_merge', status: 'timeout', providerCompleted: false,
        resultAccepted: false, elapsedMs: 180_000, httpStatus: 200, errorCode: 'upstream_timeout' }),
    ],
  }));
  assert.equal(report.latestAcceptedResult.stage, 'crop_review');
  assert.equal(report.latestAcceptedResult.hasUsefulNutritionReference, true);
  assert.equal(report.returnedStageResult.stage, 'whole');
  assert.equal(report.returnedStageResult.hasUsefulNutritionReference, false);
  assert.equal(report.validation.returnedStage, 'whole');
  assert.equal(report.validation.returnedAttemptId, 1);
  assert.equal(report.validation.hasPreservedAcceptedResult, true);
  assert.equal(report.validation.hasUsefulNutritionReference, false);
  assert.equal(report.validation.referenceCount, 0);
  assert.equal(report.validation.nutritionFeatureSucceeded, false);
  assert.equal(report.offlineQuantityCheck, null);
  assert.equal(report.stageAssessments[1].nutritionFeatureSucceeded, true);
  assert.equal(report.stageAssessments[2].nutritionFeatureSucceeded, false);
});

test('the offline 250g check applies only a hypothetical quantity and never fills original intake', () => {
  const analysis = referenceAnalysis();
  const before = structuredClone(analysis);
  const result = createOfflineQuantityCheck(analysis);
  assert.equal(result.syntheticOnly, true);
  assert.equal(result.changesOriginalAnalysis, false);
  assert.equal(result.passed, true);
  assert.deepEqual(result.nutrients, { calories: { min: 400, max: 600 }, protein: { min: 12.5, max: 22.5 }, carbs: { min: 20, max: 35 }, fat: { min: 25, max: 45 } });
  assert.deepEqual(analysis, before);
  assert.equal(analysis.components[0].userQuantity, null);
  assert.equal(analysis.calories, null);
});

test('raw diagnostics remove credentials, endpoint URLs, authorization and image payloads', () => {
  const output = redactRawResponse('key=fixture-test-secret Bearer temporary-token https://example.invalid/v1/responses data:image/png;base64,aGVsbG8=', 'fixture-test-secret');
  assert.equal(output.includes('fixture-test-secret'), false);
  assert.equal(output.includes('temporary-token'), false);
  assert.equal(output.includes('example.invalid'), false);
  assert.equal(output.includes('aGVsbG8='), false);
  assert.match(output, /REDACTED_CREDENTIAL/);
  assert.match(output, /REDACTED_URL/);
});
