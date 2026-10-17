import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { evaluateAcceptance, evaluateMealDataset, syntheticFixture, verifySyntheticFixture } from './evaluate-meal-dataset.mjs';

const templateUrl = new URL('../data/validation/meal-ground-truth-template.json', import.meta.url);
const evaluatorPath = fileURLToPath(new URL('./evaluate-meal-dataset.mjs', import.meta.url));

// All data derived from this helper is SYNTHETIC arithmetic input, never product evidence.
function oneSyntheticMeal() {
  const fixture = syntheticFixture();
  fixture.samples = [fixture.samples[0]];
  return fixture;
}

test('inline synthetic fixture checks hand-computable metrics without claiming product accuracy', () => {
  const report = verifySyntheticFixture();
  assert.equal(report.syntheticAlgorithmCheck, 'passed');
  assert.match(report.notice, /SYNTHETIC ALGORITHM CHECK ONLY/);
  assert.equal(report.dataset.datasetType, 'synthetic-fixture');
  assert.equal(report.metrics.majorIngredientRecognition.matchedMajorIngredients, 4);
  assert.equal(report.metrics.majorIngredientRecognition.totalMajorIngredients, 5);
  assert.equal(report.metrics.majorIngredientRecognition.rate, 0.8);
  assert.equal(report.metrics.calorieIntervalCoverage.rate, 0.5);
  assert.equal(report.metrics.unableToEstimate.rate, 1 / 3);
  assert.equal(report.metrics.latency.meanMealLatencyMs, 2000 / 3);
  assert.equal(report.requestBudget.maxRequestsPerMeal, 2);
  assert.equal(report.requestBudget.totalRequests, 3);
});

test('50 real sample slots are blank and missing data cannot become a passing result', async () => {
  const template = JSON.parse(await readFile(templateUrl, 'utf8'));
  assert.equal(template.samples.length, 50);
  assert.equal(new Set(template.samples.map((sample) => sample.mealId)).size, 50);
  for (const sample of template.samples) {
    assert.equal(sample.capture.beforePhotoRef, null);
    assert.equal(sample.capture.afterPhotoRef, null);
    assert.deepEqual(sample.groundTruth.ingredients, []);
    assert.deepEqual(sample.groundTruth.cookingMethods, []);
    assert.equal(sample.groundTruth.weightsG.ediblePortion, null);
    assert.equal(sample.groundTruth.intakeRatio, null);
    assert.deepEqual(sample.sourceLabels, []);
    assert.ok(Object.values(sample.groundTruth.nutrition).every((value) => value === null));
    assert.deepEqual(sample.prediction, {
      modelVersion: null,
      ingredients: null,
      unableToEstimate: null,
      unableReason: null,
      calorieEstimateKcal: null,
      calorieIntervalKcal: null,
      notes: null,
    });
    assert.equal(sample.requestLedger.totalRequests, null);
    assert.equal(sample.requestLedger.totalLatencyMs, null);
    assert.deepEqual(sample.requestLedger.stages, []);
  }
  const report = evaluateMealDataset(template);
  assert.equal(report.evaluationStatus, 'incomplete');
  assert.equal(report.metrics.majorIngredientRecognition.rate, null);
  assert.equal(report.metrics.calorieIntervalCoverage.rate, null);
  assert.equal(report.metrics.unableToEstimate.rate, null);
  assert.equal(report.metrics.latency.meanMealLatencyMs, null);
  assert.equal(report.metrics.majorIngredientRecognition.skipped.length, 50);
  assert.equal(report.metrics.calorieIntervalCoverage.skipped.length, 50);
  assert.equal(report.requestBudget.status, 'incomplete');
  assert.equal(report.requestBudget.totalRequests, null);
  assert.equal(report.requestBudget.maxRequestsPerMeal, null);
  assert.equal(report.requestBudget.completeLedgerMeals, 0);
  assert.equal(report.acceptance.status, 'pending');
  assert.ok(Object.values(report.acceptance.criteria).every((criterion) => criterion.status === 'pending'));
});

test('missing truth and missing prediction are reported independently and excluded from metric denominators', () => {
  const fixture = syntheticFixture();
  const missing = structuredClone(fixture.samples[0]);
  missing.mealId = 'synthetic-missing';
  missing.groundTruth = null;
  missing.prediction = null;
  missing.requestLedger = null;
  fixture.samples.push(missing);
  const report = evaluateMealDataset(fixture);
  assert.equal(report.metrics.majorIngredientRecognition.rate, 4 / 5);
  assert.equal(report.metrics.calorieIntervalCoverage.rate, 1 / 2);
  assert.deepEqual(report.metrics.majorIngredientRecognition.skipped[0].reasons,
    ['missing-or-invalid-major-ingredient-truth', 'missing-prediction']);
  assert.ok(report.metrics.calorieIntervalCoverage.skipped.at(-1).reasons.includes('missing-or-invalid-calorie-truth'));
  assert.equal(report.metrics.unableToEstimate.evaluatedMeals, 3);
  assert.equal(report.requestBudget.totalRequests, null);
  assert.equal(report.requestBudget.knownRequestsLowerBound, 3);
  assert.equal(report.requestBudget.status, 'incomplete');
  assert.equal(report.metrics.latency.evaluatedMeals, 3);
  assert.equal(report.evaluationStatus, 'incomplete');
});

test('ingredient matching deduplicates rows, normalizes text, and uses one predicted name at most once', () => {
  const fixture = oneSyntheticMeal();
  fixture.samples[0].groundTruth.ingredients = [
    { name: 'rice', major: true }, { name: ' RICE ', major: true },
    { name: 'chicken', major: true, aliases: ['shared'] },
    { name: 'tofu', major: true, aliases: ['shared'] },
  ];
  fixture.samples[0].prediction.ingredients = [{ name: 'ＲＩＣＥ' }, { name: 'shared' }, { name: 'shared' }];
  const metric = evaluateMealDataset(fixture).metrics.majorIngredientRecognition;
  assert.equal(metric.totalMajorIngredients, 3);
  assert.equal(metric.matchedMajorIngredients, 2);
  assert.equal(metric.rate, 2 / 3);
  fixture.samples[0].prediction.ingredients = [];
  const emptyPrediction = evaluateMealDataset(fixture).metrics.majorIngredientRecognition;
  assert.equal(emptyPrediction.rate, 0);
  assert.equal(emptyPrediction.evaluatedMeals, 1);
});

test('calorie interval endpoints are inclusive; invalid ranges and missing inability state are never accepted', () => {
  const fixture = oneSyntheticMeal();
  fixture.samples[0].prediction.calorieIntervalKcal = { min: 500, max: 500 };
  assert.equal(evaluateMealDataset(fixture).metrics.calorieIntervalCoverage.rate, 1);
  fixture.samples[0].prediction.calorieIntervalKcal = { min: 501, max: 500 };
  let report = evaluateMealDataset(fixture);
  assert.equal(report.metrics.calorieIntervalCoverage.evaluatedMeals, 0);
  assert.equal(report.metrics.calorieIntervalCoverage.rate, null);
  assert.equal(report.evaluationStatus, 'invalid');
  fixture.samples[0].prediction.calorieIntervalKcal = { min: 0, max: 500 };
  delete fixture.samples[0].prediction.unableToEstimate;
  report = evaluateMealDataset(fixture);
  assert.equal(report.metrics.calorieIntervalCoverage.rate, null);
  assert.equal(report.metrics.unableToEstimate.rate, null);
  assert.equal(report.evaluationStatus, 'incomplete');
});

test('explicit inability is counted separately and conflicting numeric estimates are invalid', () => {
  const fixture = oneSyntheticMeal();
  fixture.samples[0].prediction.unableToEstimate = true;
  let report = evaluateMealDataset(fixture);
  assert.equal(report.metrics.unableToEstimate.rate, 1);
  assert.equal(report.metrics.calorieIntervalCoverage.rate, null);
  assert.equal(report.evaluationStatus, 'invalid');
  fixture.samples[0].prediction.calorieIntervalKcal = null;
  report = evaluateMealDataset(fixture);
  assert.equal(report.metrics.unableToEstimate.rate, 1);
  assert.deepEqual(report.validationIssues, []);
  assert.equal(report.metrics.calorieIntervalCoverage.skipped[0].reasons[0], 'model-unable-to-estimate');
});

test('request limits accept exactly 3 per meal and 75 total, and reject each overrun', () => {
  const fixture = oneSyntheticMeal();
  const first = fixture.samples[0];
  first.requestLedger = { stages: [{ stage: 'vision', requestCount: 3 }], totalRequests: 3, totalLatencyMs: 1 };
  fixture.samples = Array.from({ length: 25 }, (_, i) => ({ ...structuredClone(first), mealId: `synthetic-budget-${i}` }));
  let report = evaluateMealDataset(fixture);
  assert.equal(report.requestBudget.status, 'within-limits');
  assert.equal(report.requestBudget.totalRequests, 75);
  assert.equal(report.requestBudget.maxRequestsPerMeal, 3);
  fixture.samples.push({ ...structuredClone(first), mealId: 'synthetic-budget-26' });
  report = evaluateMealDataset(fixture);
  assert.equal(report.requestBudget.status, 'exceeded');
  assert.equal(report.requestBudget.totalRequests, 78);
  assert.equal(report.evaluationStatus, 'invalid');
  fixture.samples = [first];
  first.requestLedger.stages[0].requestCount = 4;
  first.requestLedger.totalRequests = 4;
  report = evaluateMealDataset(fixture);
  assert.deepEqual(report.requestBudget.exceededMealIds, [first.mealId]);
  assert.equal(report.requestBudget.status, 'exceeded');
});

test('stage ledger detects underreported totals and unknown ledger data never passes budgets or latency', () => {
  const fixture = oneSyntheticMeal();
  fixture.samples[0].requestLedger = { stages: [{ stage: 'vision', requestCount: 4 }], totalRequests: 1, totalLatencyMs: 123 };
  let report = evaluateMealDataset(fixture);
  assert.equal(report.requestBudget.knownRequestsLowerBound, 4);
  assert.equal(report.requestBudget.status, 'exceeded');
  assert.equal(report.requestBudget.totalRequests, null);
  assert.equal(report.metrics.latency.meanMealLatencyMs, null);
  assert.ok(report.validationIssues.some((issue) => issue.reason === 'total-does-not-equal-stage-sum'));
  fixture.samples[0].requestLedger = { stages: [], totalRequests: null, totalLatencyMs: null };
  report = evaluateMealDataset(fixture);
  assert.equal(report.requestBudget.status, 'incomplete');
  assert.equal(report.requestBudget.maxRequestsPerMeal, null);
  assert.equal(report.metrics.latency.meanMealLatencyMs, null);
});

test('incomplete sample count, duplicate IDs, and synthetic data mixed into real samples cannot pass', () => {
  const fixture = oneSyntheticMeal();
  fixture.datasetType = 'real-evaluation';
  assert.throws(() => evaluateMealDataset(fixture), /Synthetic sample/);
  delete fixture.samples[0].synthetic;
  assert.equal(evaluateMealDataset(fixture).evaluationStatus, 'incomplete');
  fixture.samples.push(structuredClone(fixture.samples[0]));
  assert.throws(() => evaluateMealDataset(fixture), /unique/);
});

test('acceptance threshold comparison passes at boundaries and fails only with complete real-sized metric inputs', () => {
  // Pure threshold logic test values are synthetic aggregates; they are not observed meal data or product results.
  const mockedCompleteReport = {
    dataset: { datasetType: 'real-evaluation', sampleCount: 50 },
    metrics: {
      majorIngredientRecognition: { rate: 0.8, evaluatedMeals: 50, totalMajorIngredients: 100, skipped: [] },
      calorieIntervalCoverage: { rate: 0.8, evaluatedMeals: 40, coveredMeals: 32, skipped: Array.from({ length: 10 }, () => ({ reasons: ['model-unable-to-estimate'] })) },
      unableToEstimate: { rate: 0.2, evaluatedMeals: 50, unableMeals: 10, skipped: [] },
    },
    requestBudget: { status: 'within-limits', completeLedgerMeals: 50, maxRequestsPerMeal: 3, totalRequests: 75, maxRequestsPerMealKnownLowerBound: 3, knownRequestsLowerBound: 75 },
    validationIssues: [],
  };
  let result = evaluateAcceptance(mockedCompleteReport);
  assert.equal(result.status, 'passed');
  assert.ok(Object.values(result.criteria).every((criterion) => criterion.status === 'passed'));
  assert.match(result.note, /complete real-evaluation data/);

  mockedCompleteReport.metrics.majorIngredientRecognition.rate = 0.79;
  result = evaluateAcceptance(mockedCompleteReport);
  assert.equal(result.criteria.primaryIngredientRecall.status, 'failed');
  assert.equal(result.status, 'failed');
  mockedCompleteReport.metrics.majorIngredientRecognition.rate = 0.8;
  mockedCompleteReport.metrics.calorieIntervalCoverage.rate = 0.79;
  result = evaluateAcceptance(mockedCompleteReport);
  assert.equal(result.criteria.calorieIntervalCoverage.status, 'failed');
  mockedCompleteReport.metrics.calorieIntervalCoverage.rate = 0.8;
  mockedCompleteReport.metrics.unableToEstimate.rate = 0.21;
  result = evaluateAcceptance(mockedCompleteReport);
  assert.equal(result.criteria.unableToEstimateRate.status, 'failed');
  mockedCompleteReport.metrics.unableToEstimate.rate = 0.2;
  mockedCompleteReport.requestBudget.totalRequests = 76;
  mockedCompleteReport.requestBudget.status = 'exceeded';
  mockedCompleteReport.requestBudget.knownRequestsLowerBound = 76;
  result = evaluateAcceptance(mockedCompleteReport);
  assert.equal(result.criteria.requestBudget.status, 'failed');
});

test('incomplete metrics and budgets stay pending; real datasets with other than 50 meals cannot pass', () => {
  const emptyMetrics = evaluateAcceptance({ dataset: { datasetType: 'real-evaluation', sampleCount: 50 }, metrics: {}, requestBudget: null });
  assert.equal(emptyMetrics.status, 'pending');
  assert.ok(Object.values(emptyMetrics.criteria).every((criterion) => criterion.status === 'pending'));
  const report = {
    dataset: { datasetType: 'real-evaluation', sampleCount: 50 },
    metrics: {
      majorIngredientRecognition: { rate: null, evaluatedMeals: 0, totalMajorIngredients: 0, skipped: [{}] },
      calorieIntervalCoverage: { rate: null, evaluatedMeals: 0, coveredMeals: 0, skipped: [{}] },
      unableToEstimate: { rate: null, evaluatedMeals: 0, unableMeals: 0, skipped: [{}] },
    },
    requestBudget: { status: 'incomplete', completeLedgerMeals: 0, maxRequestsPerMeal: null, totalRequests: null, maxRequestsPerMealKnownLowerBound: 1, knownRequestsLowerBound: 1 },
    validationIssues: [],
  };
  let result = evaluateAcceptance(report);
  assert.equal(result.status, 'pending');
  assert.ok(Object.values(result.criteria).every((criterion) => criterion.status === 'pending'));
  report.requestBudget.status = 'exceeded';
  report.requestBudget.knownRequestsLowerBound = 76;
  result = evaluateAcceptance(report);
  assert.equal(result.criteria.requestBudget.status, 'pending', 'an incomplete ledger stays pending even when the raw known lower bound already flags an overrun');
  report.dataset.sampleCount = 49;
  report.metrics.majorIngredientRecognition.rate = 1;
  report.metrics.majorIngredientRecognition.evaluatedMeals = 50;
  report.metrics.majorIngredientRecognition.skipped = [];
  result = evaluateAcceptance(report);
  assert.equal(result.criteria.primaryIngredientRecall.status, 'pending');
  assert.equal(result.criteria.primaryIngredientRecall.reason, 'requires-exactly-50-real-meals');
});

test('CLI returns code 2 for an untouched template and code 0 only for synthetic algorithm assertions', () => {
  const blank = spawnSync(process.execPath, [evaluatorPath, fileURLToPath(templateUrl), '--json'], { encoding: 'utf8' });
  assert.equal(blank.status, 2, blank.stderr);
  assert.equal(JSON.parse(blank.stdout).evaluationStatus, 'incomplete');
  const fixture = spawnSync(process.execPath, [evaluatorPath, '--fixture', '--json'], { encoding: 'utf8' });
  assert.equal(fixture.status, 0, fixture.stderr);
  assert.equal(JSON.parse(fixture.stdout).syntheticAlgorithmCheck, 'passed');
});
