#!/usr/bin/env node
// Offline only. No API clients, credentials, network calls, or image loading.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = new Set(['real-evaluation-template', 'real-evaluation', 'synthetic-fixture']);
const ACCEPTANCE_THRESHOLDS = Object.freeze({ primaryIngredientRecall: 0.8, calorieIntervalCoverage: 0.8, unableToEstimateRate: 0.2, requestsPerMeal: 3, totalRequests: 75, sampleCount: 50 });
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNonnegative = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const hasName = (value) => typeof value === 'string' && value.trim().length > 0;
const normalize = (value) => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
const rate = (numerator, denominator) => denominator === 0 ? null : numerator / denominator;
const skip = (list, mealId, reasons) => { if (reasons.length) list.push({ mealId, reasons }); };

function majorIngredients(truth, mealId, issues) {
  if (!Array.isArray(truth?.ingredients) || truth.ingredients.length === 0) return null;
  const names = new Map();
  for (const ingredient of truth.ingredients) {
    if (!isRecord(ingredient) || !hasName(ingredient.name) || typeof ingredient.major !== 'boolean'
      || (ingredient.aliases !== undefined && (!Array.isArray(ingredient.aliases) || !ingredient.aliases.every(hasName)))) {
      issues.push({ mealId, field: 'groundTruth.ingredients', reason: 'invalid-ingredient-name-major-or-aliases' });
      return null;
    }
    if (ingredient.major) {
      const name = normalize(ingredient.name);
      const accepted = names.get(name) ?? new Set([name]);
      for (const alias of ingredient.aliases ?? []) accepted.add(normalize(alias));
      names.set(name, accepted);
    }
  }
  return names.size ? [...names.values()] : null;
}

function predictedIngredients(prediction, mealId, issues) {
  if (!Array.isArray(prediction?.ingredients)) return null;
  const names = new Set();
  for (const ingredient of prediction.ingredients) {
    if (!isRecord(ingredient) || !hasName(ingredient.name)) {
      issues.push({ mealId, field: 'prediction.ingredients', reason: 'invalid-ingredient-name' });
      return null;
    }
    names.add(normalize(ingredient.name));
  }
  return names;
}

function inspectLedger(ledger, mealId, issues) {
  if (!isRecord(ledger)) return { complete: false, lowerBound: null, latencyMs: null, reasons: ['missing-request-ledger'] };
  const total = isCount(ledger.totalRequests) ? ledger.totalRequests : null;
  const reasons = [];
  if (ledger.totalRequests == null) reasons.push('missing-total-requests');
  else if (total === null) issues.push({ mealId, field: 'requestLedger.totalRequests', reason: 'expected-nonnegative-safe-integer' });
  let stageSum = 0;
  let stagesValid = Array.isArray(ledger.stages);
  if (!stagesValid) reasons.push('missing-stage-ledger');
  for (const stage of Array.isArray(ledger.stages) ? ledger.stages : []) {
    if (isRecord(stage) && isCount(stage.requestCount)) stageSum += stage.requestCount;
    if (!isRecord(stage) || !hasName(stage.stage) || !isCount(stage.requestCount)
      || (stage.latencyMs != null && !isNonnegative(stage.latencyMs))) {
      stagesValid = false;
      issues.push({ mealId, field: 'requestLedger.stages', reason: 'invalid-stage-name-request-count-or-latency' });
    }
  }
  if (!Number.isSafeInteger(stageSum)) {
    stagesValid = false;
    issues.push({ mealId, field: 'requestLedger.stages', reason: 'stage-request-sum-out-of-range' });
  }
  if (total !== null && stagesValid && total !== stageSum) {
    issues.push({ mealId, field: 'requestLedger.totalRequests', reason: 'total-does-not-equal-stage-sum', totalRequests: total, stageSum });
  }
  const complete = total !== null && stagesValid && total === stageSum;
  if (!complete && reasons.length === 0) reasons.push('invalid-or-inconsistent-request-ledger');
  const lowerBound = total !== null || (Array.isArray(ledger.stages) && ledger.stages.length > 0)
    ? Math.max(total ?? 0, stageSum) : null;
  let latencyMs = null;
  if (isNonnegative(ledger.totalLatencyMs)) latencyMs = ledger.totalLatencyMs;
  else if (ledger.totalLatencyMs == null) reasons.push('missing-total-latency');
  else issues.push({ mealId, field: 'requestLedger.totalLatencyMs', reason: 'expected-nonnegative-finite-milliseconds' });
  return { complete, lowerBound, latencyMs, reasons };
}

/** Ratios are in [0, 1]; null means no usable denominator, never zero accuracy or success. */
export function evaluateMealDataset(dataset) {
  if (!isRecord(dataset) || dataset.schemaVersion !== 'meal-validation.v1' || !TYPES.has(dataset.datasetType)
    || !Array.isArray(dataset.samples) || !hasName(dataset.datasetId)) {
    throw new TypeError('Expected meal-validation.v1, a supported datasetType, datasetId, and samples array.');
  }
  const ids = new Set();
  for (const sample of dataset.samples) {
    if (!isRecord(sample) || !hasName(sample.mealId) || ids.has(sample.mealId)) {
      throw new TypeError('Every sample must be an object with a unique, nonempty mealId.');
    }
    ids.add(sample.mealId);
    if (dataset.datasetType !== 'synthetic-fixture' && sample.synthetic === true) {
      throw new TypeError(`Synthetic sample ${sample.mealId} cannot enter a real evaluation dataset.`);
    }
  }
  const issues = [];
  const ingredientMetric = { matchedMajorIngredients: 0, totalMajorIngredients: 0, evaluatedMeals: 0, rate: null, skipped: [] };
  const coverageMetric = { coveredMeals: 0, evaluatedMeals: 0, rate: null, skipped: [] };
  const inabilityMetric = { unableMeals: 0, evaluatedMeals: 0, rate: null, skipped: [] };
  const latencyMetric = { meanMealLatencyMs: null, evaluatedMeals: 0, skipped: [] };
  const budget = {
    perMealLimit: 3, totalLimit: 75, status: 'incomplete', maxRequestsPerMeal: null,
    maxRequestsPerMealKnownLowerBound: null,
    totalRequests: null, knownRequestsLowerBound: 0, completeLedgerMeals: 0,
    exceededMealIds: [], missingOrInvalidLedgers: [],
  };
  let latencySum = 0;
  for (const sample of dataset.samples) {
    const { mealId } = sample;
    const prediction = isRecord(sample.prediction) ? sample.prediction : null;
    const major = majorIngredients(sample.groundTruth, mealId, issues);
    const predicted = predictedIngredients(prediction, mealId, issues);
    const ingredientReasons = [];
    if (major === null) ingredientReasons.push('missing-or-invalid-major-ingredient-truth');
    if (predicted === null) ingredientReasons.push(prediction ? 'missing-or-invalid-predicted-ingredients' : 'missing-prediction');
    if (ingredientReasons.length === 0) {
      ingredientMetric.evaluatedMeals++;
      ingredientMetric.totalMajorIngredients += major.length;
      // Unique truth names and predicted names prevent duplicate rows from inflating recall.
      // Match each predicted label at most once even when human-approved alias sets overlap.
      const assigned = new Map();
      const assign = (truthIndex, seen) => {
        for (const name of major[truthIndex]) {
          if (!predicted.has(name) || seen.has(name)) continue;
          seen.add(name);
          if (!assigned.has(name) || assign(assigned.get(name), seen)) {
            assigned.set(name, truthIndex);
            return true;
          }
        }
        return false;
      };
      for (let i = 0; i < major.length; i++) if (assign(i, new Set())) ingredientMetric.matchedMajorIngredients++;
    }
    skip(ingredientMetric.skipped, mealId, ingredientReasons);

    const inabilityKnown = prediction !== null && typeof prediction.unableToEstimate === 'boolean';
    if (inabilityKnown) {
      inabilityMetric.evaluatedMeals++;
      if (prediction.unableToEstimate) inabilityMetric.unableMeals++;
    } else {
      skip(inabilityMetric.skipped, mealId, [prediction ? 'missing-or-invalid-inability-status' : 'missing-prediction']);
      if (prediction?.unableToEstimate != null) issues.push({ mealId, field: 'prediction.unableToEstimate', reason: 'expected-boolean' });
    }

    const kcal = sample.groundTruth?.nutrition?.caloriesKcal;
    const interval = prediction?.calorieIntervalKcal;
    const truthKnown = isNonnegative(kcal);
    const intervalKnown = isRecord(interval) && isNonnegative(interval.min) && isNonnegative(interval.max) && interval.min <= interval.max;
    const coverageReasons = [];
    if (!truthKnown) {
      coverageReasons.push('missing-or-invalid-calorie-truth');
      if (kcal != null) issues.push({ mealId, field: 'groundTruth.nutrition.caloriesKcal', reason: 'expected-nonnegative-finite-kcal' });
    }
    if (!prediction) coverageReasons.push('missing-prediction');
    else if (!inabilityKnown) coverageReasons.push('missing-or-invalid-inability-status');
    else if (prediction.unableToEstimate) coverageReasons.push('model-unable-to-estimate');
    else if (!intervalKnown) coverageReasons.push('missing-or-invalid-calorie-interval');
    if (interval != null && (!intervalKnown || prediction?.unableToEstimate === true)) {
      issues.push({ mealId, field: 'prediction.calorieIntervalKcal', reason: intervalKnown ? 'interval-conflicts-with-unable-status' : 'invalid-or-reversed-interval' });
    }
    if (coverageReasons.length === 0) {
      coverageMetric.evaluatedMeals++;
      if (interval.min <= kcal && kcal <= interval.max) coverageMetric.coveredMeals++;
    }
    skip(coverageMetric.skipped, mealId, coverageReasons);

    const ledger = inspectLedger(sample.requestLedger, mealId, issues);
    if (ledger.lowerBound !== null) {
      budget.knownRequestsLowerBound += ledger.lowerBound;
      budget.maxRequestsPerMealKnownLowerBound = Math.max(budget.maxRequestsPerMealKnownLowerBound ?? 0, ledger.lowerBound);
      if (ledger.lowerBound > budget.perMealLimit) budget.exceededMealIds.push(mealId);
    }
    if (ledger.complete) budget.completeLedgerMeals++;
    else budget.missingOrInvalidLedgers.push({ mealId, reasons: ledger.reasons });
    if (ledger.complete && ledger.latencyMs !== null) {
      latencyMetric.evaluatedMeals++;
      latencySum += ledger.latencyMs;
    } else skip(latencyMetric.skipped, mealId, ledger.reasons.length ? ledger.reasons : ['invalid-latency-or-ledger']);
  }
  ingredientMetric.rate = rate(ingredientMetric.matchedMajorIngredients, ingredientMetric.totalMajorIngredients);
  coverageMetric.rate = rate(coverageMetric.coveredMeals, coverageMetric.evaluatedMeals);
  inabilityMetric.rate = rate(inabilityMetric.unableMeals, inabilityMetric.evaluatedMeals);
  latencyMetric.meanMealLatencyMs = rate(latencySum, latencyMetric.evaluatedMeals);
  const ledgerComplete = dataset.samples.length > 0 && budget.completeLedgerMeals === dataset.samples.length;
  if (ledgerComplete) {
    budget.totalRequests = budget.knownRequestsLowerBound;
    budget.maxRequestsPerMeal = budget.maxRequestsPerMealKnownLowerBound;
  }
  budget.status = budget.exceededMealIds.length || budget.knownRequestsLowerBound > budget.totalLimit
    ? 'exceeded' : ledgerComplete ? 'within-limits' : 'incomplete';
  const expectedSampleCount = dataset.datasetType === 'synthetic-fixture' ? null : 50;
  const sampleCountComplete = expectedSampleCount === null || dataset.samples.length === expectedSampleCount;
  const metricDataMissing = ingredientMetric.skipped.length > 0 || inabilityMetric.skipped.length > 0
    || coverageMetric.skipped.some((entry) => entry.reasons.some((reason) => reason !== 'model-unable-to-estimate'))
    || latencyMetric.skipped.length > 0;
  const evaluationStatus = issues.length || budget.status === 'exceeded' ? 'invalid'
    : !sampleCountComplete || metricDataMissing || budget.status === 'incomplete' ? 'incomplete' : 'completed';
  const report = {
    schemaVersion: 'meal-validation-report.v1',
    dataset: { datasetId: dataset.datasetId, datasetType: dataset.datasetType, sampleCount: dataset.samples.length, expectedSampleCount },
    evaluationStatus,
    notice: dataset.datasetType === 'synthetic-fixture'
      ? 'SYNTHETIC ALGORITHM CHECK ONLY. These numbers are not product accuracy.'
      : 'Offline statistics of supplied annotations; missing data is skipped. Plan acceptance requires complete real evaluation data.',
    metrics: { majorIngredientRecognition: ingredientMetric, calorieIntervalCoverage: coverageMetric, unableToEstimate: inabilityMetric, latency: latencyMetric },
    requestBudget: budget,
    validationIssues: issues,
  };
  report.acceptance = evaluateAcceptance(report);
  return report;
}

/** Compare a completed real 50-meal evaluation with the plan thresholds. Synthetic values stay pending. */
export function evaluateAcceptance(report) {
  const { dataset, metrics, requestBudget, validationIssues = [] } = report;
  const realDataset = dataset?.datasetType === 'real-evaluation';
  const fullDataset = realDataset && dataset.sampleCount === ACCEPTANCE_THRESHOLDS.sampleCount;
  const datasetPendingReason = !realDataset ? 'requires-real-evaluation-dataset'
    : !fullDataset ? 'requires-exactly-50-real-meals' : null;
  const fractionKnown = (value) => Number.isFinite(value) && value >= 0 && value <= 1;
  const compare = (complete, observed, operator, boundary, missingReason) => {
    const reason = datasetPendingReason ?? (!complete ? missingReason : null);
    return {
      status: reason ? 'pending' : (operator === '>=' ? observed >= boundary : observed <= boundary) ? 'passed' : 'failed',
      ...(reason ? { reason } : {}), operator, threshold: boundary, observed: observed ?? null,
    };
  };
  const ingredient = metrics?.majorIngredientRecognition;
  const calories = metrics?.calorieIntervalCoverage;
  const unable = metrics?.unableToEstimate;
  const ingredientComplete = fullDataset && Array.isArray(ingredient?.skipped) && ingredient.skipped.length === 0
    && ingredient.evaluatedMeals === ACCEPTANCE_THRESHOLDS.sampleCount && fractionKnown(ingredient.rate);
  const unableComplete = fullDataset && Array.isArray(unable?.skipped) && unable.skipped.length === 0
    && unable.evaluatedMeals === ACCEPTANCE_THRESHOLDS.sampleCount && fractionKnown(unable.rate);
  const unableCount = unableComplete ? unable.unableMeals : null;
  const coverageSkipsAreExpectedAbstentions = Array.isArray(calories?.skipped) && calories.skipped.every((entry) =>
    Array.isArray(entry?.reasons) && entry.reasons.length === 1 && entry.reasons[0] === 'model-unable-to-estimate');
  const calorieComplete = fullDataset && unableComplete && calories?.skipped?.length === unableCount
    && coverageSkipsAreExpectedAbstentions && calories.evaluatedMeals + unableCount === ACCEPTANCE_THRESHOLDS.sampleCount
    && fractionKnown(calories.rate);
  const budgetComplete = fullDataset && requestBudget?.completeLedgerMeals === ACCEPTANCE_THRESHOLDS.sampleCount
    && isCount(requestBudget.totalRequests) && isCount(requestBudget.maxRequestsPerMeal)
    && ['within-limits', 'exceeded'].includes(requestBudget.status);
  const budgetPendingReason = datasetPendingReason ?? (!budgetComplete ? 'request-ledger-incomplete-or-invalid' : null);
  const criteria = {
    primaryIngredientRecall: compare(ingredientComplete, ingredient?.rate, '>=', ACCEPTANCE_THRESHOLDS.primaryIngredientRecall, 'major-ingredient-truth-or-prediction-incomplete'),
    calorieIntervalCoverage: compare(calorieComplete, calories?.rate, '>=', ACCEPTANCE_THRESHOLDS.calorieIntervalCoverage, 'calorie-truth-or-eligible-prediction-incomplete'),
    unableToEstimateRate: compare(unableComplete, unable?.rate, '<=', ACCEPTANCE_THRESHOLDS.unableToEstimateRate, 'prediction-inability-status-incomplete'),
    requestBudget: {
      status: budgetPendingReason ? 'pending'
        : requestBudget.maxRequestsPerMeal <= ACCEPTANCE_THRESHOLDS.requestsPerMeal && requestBudget.totalRequests <= ACCEPTANCE_THRESHOLDS.totalRequests ? 'passed' : 'failed',
      ...(budgetPendingReason ? { reason: budgetPendingReason } : {}),
      perMealLimit: ACCEPTANCE_THRESHOLDS.requestsPerMeal,
      totalLimit: ACCEPTANCE_THRESHOLDS.totalRequests,
      maxRequestsPerMeal: requestBudget?.maxRequestsPerMeal ?? null,
      totalRequests: requestBudget?.totalRequests ?? null,
    },
  };
  const statuses = Object.values(criteria).map((criterion) => criterion.status);
  return {
    status: statuses.includes('failed') ? 'failed' : validationIssues.length || !statuses.every((status) => status === 'passed') ? 'pending' : 'passed',
    thresholds: ACCEPTANCE_THRESHOLDS,
    criteria,
    note: realDataset ? 'Acceptance is based only on complete real-evaluation data; missing inputs or validation issues remain pending.'
      : 'Synthetic and blank-template datasets are not product acceptance evidence; every criterion remains pending.',
    dataQualityIssues: validationIssues.length,
  };
}

/** Hand-computable, synthetic unit fixture. Never copied into the 50 real meal slots. */
export function syntheticFixture() {
  return {
    schemaVersion: 'meal-validation.v1', datasetId: 'synthetic-algorithm-check-only', datasetType: 'synthetic-fixture',
    samples: [
      {
        mealId: 'synthetic-001', synthetic: true,
        groundTruth: { ingredients: [{ name: 'rice', major: true }, { name: 'chicken', major: true, aliases: ['chicken breast'] }, { name: 'salt', major: false }], nutrition: { caloriesKcal: 500 } },
        prediction: { ingredients: [{ name: 'rice' }, { name: ' CHICKEN BREAST ' }], unableToEstimate: false, calorieIntervalKcal: { min: 400, max: 500 } },
        requestLedger: { stages: [{ stage: 'vision', requestCount: 1, latencyMs: 400 }, { stage: 'refine', requestCount: 1, latencyMs: 600 }], totalRequests: 2, totalLatencyMs: 1200 },
      },
      {
        mealId: 'synthetic-002', synthetic: true,
        groundTruth: { ingredients: [{ name: 'broccoli', major: true }, { name: 'tofu', major: true }], nutrition: { caloriesKcal: 300 } },
        prediction: { ingredients: [{ name: 'broccoli' }, { name: 'soybeans' }], unableToEstimate: false, calorieIntervalKcal: { min: 301, max: 350 } },
        requestLedger: { stages: [{ stage: 'vision', requestCount: 1, latencyMs: 800 }], totalRequests: 1, totalLatencyMs: 800 },
      },
      {
        mealId: 'synthetic-003', synthetic: true,
        groundTruth: { ingredients: [{ name: 'tomato', major: true }], nutrition: { caloriesKcal: 100 } },
        prediction: { ingredients: [{ name: 'tomato' }], unableToEstimate: true, unableReason: 'Synthetic abstention for arithmetic check.', calorieIntervalKcal: null },
        requestLedger: { stages: [], totalRequests: 0, totalLatencyMs: 0 },
      },
    ],
  };
}

export function verifySyntheticFixture() {
  const report = evaluateMealDataset(syntheticFixture());
  assert.equal(report.metrics.majorIngredientRecognition.rate, 4 / 5);
  assert.equal(report.metrics.calorieIntervalCoverage.rate, 1 / 2);
  assert.equal(report.metrics.unableToEstimate.rate, 1 / 3);
  assert.equal(report.requestBudget.maxRequestsPerMeal, 2);
  assert.equal(report.requestBudget.totalRequests, 3);
  assert.equal(report.requestBudget.status, 'within-limits');
  assert.equal(report.metrics.latency.meanMealLatencyMs, 2000 / 3);
  assert.deepEqual(report.validationIssues, []);
  assert.equal(report.acceptance.status, 'pending');
  assert.ok(Object.values(report.acceptance.criteria).every((criterion) => criterion.status === 'pending'));
  return { ...report, syntheticAlgorithmCheck: 'passed' };
}

function formatRate(metric) {
  return metric.rate === null ? 'not evaluable (no denominator)' : `${(metric.rate * 100).toFixed(2)}%`;
}

function formatReport(report) {
  const m = report.metrics;
  const budget = report.requestBudget;
  return [
    report.notice,
    `Dataset: ${report.dataset.datasetId}; meals=${report.dataset.sampleCount}; status=${report.evaluationStatus}`,
    `Major ingredient recognition: ${formatRate(m.majorIngredientRecognition)} (${m.majorIngredientRecognition.matchedMajorIngredients}/${m.majorIngredientRecognition.totalMajorIngredients}); skipped meals=${m.majorIngredientRecognition.skipped.length}`,
    `Calorie interval coverage: ${formatRate(m.calorieIntervalCoverage)} (${m.calorieIntervalCoverage.coveredMeals}/${m.calorieIntervalCoverage.evaluatedMeals}); skipped meals=${m.calorieIntervalCoverage.skipped.length}`,
    `Unable to estimate: ${formatRate(m.unableToEstimate)} (${m.unableToEstimate.unableMeals}/${m.unableToEstimate.evaluatedMeals}); missing predictions/status=${m.unableToEstimate.skipped.length}`,
    `Mean meal latency: ${m.latency.meanMealLatencyMs === null ? 'not evaluable' : `${m.latency.meanMealLatencyMs.toFixed(2)} ms`}; measured meals=${m.latency.evaluatedMeals}; skipped meals=${m.latency.skipped.length}`,
    `Request budget: ${budget.status}; max per meal=${budget.maxRequestsPerMeal ?? `unknown (known at least ${budget.maxRequestsPerMealKnownLowerBound ?? 0})`}/${budget.perMealLimit}; total=${budget.totalRequests ?? 'unknown'}/${budget.totalLimit}; known lower bound=${budget.knownRequestsLowerBound}; complete ledgers=${budget.completeLedgerMeals}/${report.dataset.sampleCount}`,
    `Plan acceptance: ${report.acceptance.status}; ingredient recall ≥80%, calorie coverage ≥80%, unable-to-estimate ≤20%, requests ≤3/meal and ≤75 total.`,
    ...Object.entries(report.acceptance.criteria).map(([name, criterion]) => `  ${name}: ${criterion.status}${criterion.reason ? ` (${criterion.reason})` : ''}`),
    `Validation issues: ${report.validationIssues.length}. Use --json for meal IDs and every skipped reason.`,
    ...(report.syntheticAlgorithmCheck ? ['Synthetic fixture assertions passed; this is not product accuracy.'] : []),
  ].join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node scripts/evaluate-meal-dataset.mjs <dataset.json> [--json]\n       node scripts/evaluate-meal-dataset.mjs --fixture [--json]\nExit: 0=plan criteria passed (or synthetic assertions passed), 1=invalid/over budget/criteria failed, 2=incomplete or pending. No network requests.');
    return;
  }
  const flags = new Set(args.filter((arg) => arg.startsWith('--')));
  const paths = args.filter((arg) => !arg.startsWith('--'));
  if ([...flags].some((flag) => !['--json', '--fixture'].includes(flag)) || paths.length > 1
    || (flags.has('--fixture') ? paths.length !== 0 : paths.length !== 1)) {
    throw new TypeError('Provide one dataset path or --fixture; supported flags are --fixture, --json, --help.');
  }
  const report = flags.has('--fixture') ? verifySyntheticFixture()
    : evaluateMealDataset(JSON.parse((await readFile(resolve(paths[0]), 'utf8')).replace(/^\uFEFF/u, '')));
  console.log(flags.has('--json') ? JSON.stringify(report, null, 2) : formatReport(report));
  process.exitCode = flags.has('--fixture') ? 0
    : report.evaluationStatus === 'invalid' || report.acceptance.status === 'failed' ? 1
      : report.evaluationStatus === 'incomplete' || report.acceptance.status === 'pending' ? 2 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`Dataset evaluation failed: ${error.message}`); process.exitCode = 1; });
}
