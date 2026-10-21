#!/usr/bin/env node
import { readdir, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, extname, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { RealMealTestLedger, REAL_MEAL_LIMITS } from './real-meal-test-ledger.mjs';
import { LOCAL_MODEL, LOCAL_REASONING } from '../server/local-codex.mjs';

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const safeId = (value) => String(value).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
const naturalOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export async function discoverMealImages(options = {}) {
  const root = resolve(options.inputDir ?? 'C:/Users/14360/Desktop/options');
  const meals = [];
  const visit = async (directory, relativeParts = []) => {
    const children = await readdir(directory, { withFileTypes: true });
    const images = children.filter((item) => item.isFile() && IMAGE_EXTENSIONS.has(extname(item.name).toLowerCase()));
    const subdirectories = children.filter((item) => item.isDirectory()).sort((a, b) => naturalOrder.compare(a.name, b.name));
    if (relativeParts.length === 1 && ['breakfast', 'dinner'].includes(relativeParts[0].toLowerCase()) && images.length) {
      throw new Error(`Meal group ${relativeParts[0]} must contain meal subfolders, not image files.`);
    }
    if (images.length) {
      if (images.length !== 1) throw new Error(`Meal folder ${[...relativeParts].join('/') || directory} must contain exactly one supported image.`);
      const folderLabel = relativeParts.join('/');
      const mealId = safeId(folderLabel);
      meals.push({ mealId, imagePath: join(directory, images[0].name) });
      return;
    }
    for (const child of subdirectories) await visit(join(directory, child.name), [...relativeParts, child.name]);
  };
  await visit(root);
  const ids = new Set();
  for (const meal of meals) {
    if (ids.has(meal.mealId)) throw new Error(`Duplicate mealId after anonymization: ${meal.mealId}`);
    ids.add(meal.mealId);
  }
  meals.sort((a, b) => naturalOrder.compare(a.mealId, b.mealId));
  return meals;
}

/** Select the five naturally earliest folders from each of the breakfast and dinner groups. */
export function selectValidationMeals(meals, { mealsPerGroup = 5 } = {}) {
  if (!Array.isArray(meals) || !Number.isSafeInteger(mealsPerGroup) || mealsPerGroup < 1) {
    throw new TypeError('Invalid validation meal selection.');
  }
  const selected = [];
  for (const group of ['breakfast', 'dinner']) {
    const candidates = meals.filter((meal) => String(meal.mealId).toLowerCase().startsWith(`${group}_`))
      .sort((a, b) => naturalOrder.compare(a.mealId, b.mealId));
    if (candidates.length < mealsPerGroup) {
      throw new Error(`Validation cohort requires at least ${mealsPerGroup} ${group} meals; found ${candidates.length}.`);
    }
    selected.push(...candidates.slice(0, mealsPerGroup));
  }
  if (selected.length !== mealsPerGroup * 2) throw new Error('Validation cohort must contain exactly the selected breakfast and dinner meals.');
  return selected;
}

async function prepareOutputDirectory(path) {
  await mkdir(dirname(path), { recursive: true });
  await mkdir(path, { recursive: true, mode: 0o700 });
  const existing = await readdir(path);
  if (existing.length) throw new Error(`Refusing to write into non-empty output directory: ${path}`);
}

function assertUniqueReportNames(meals) {
  const names = new Set();
  for (const meal of meals) {
    const name = `${safeId(meal.mealId)}.json`;
    if (names.has(name)) throw new Error(`Duplicate meal report filename: ${name}`);
    names.add(name);
  }
}

function acceptedStage(stage, attemptId, value) {
  return {
    ...(attemptId === undefined ? {} : { attemptId }), stage, status: 'accepted', accepted: true, resultAccepted: true,
    analysis: value?.analysis ?? value ?? null,
  };
}

function outcomeKind(error) {
  const code = error?.code ?? '';
  if (code === 'diagnostic_request_limit' || /capacity|limit|budget|quota/i.test(error?.message ?? '')) return 'budget_rejected';
  if (error?.name === 'TimeoutError' || code === 'upstream_timeout' || /timeout/i.test(error?.message ?? '')) return 'timeout';
  if (code === 'invalid_model_response' || /schema|JSON|invalid_model/i.test(error?.message ?? '')) return 'schema_error';
  return 'failed';
}

function redactReport(report) {
  const clone = JSON.parse(JSON.stringify(report));
  delete clone.imagePath;
  return clone;
}

/** Run a bounded batch. callMeal receives { mealId, imagePath, stage } and must return a model result. */
export async function runBatch(options = {}) {
  const meals = options.meals ?? await discoverMealImages(options);
  const ledger = options.ledger ?? new RealMealTestLedger(options.ledgerPath ?? ':memory:');
  const callMeal = options.callMeal;
  if (typeof callMeal !== 'function') throw new TypeError('runBatch requires an injected callMeal function; real network calls are never implicit.');
  assertUniqueReportNames(meals);
  const runId = options.runId ?? randomUUID();
  const outputDir = resolve(options.outputDir ?? join(process.cwd(), 'artifacts', `real-validation-batch-${runId}`));
  await prepareOutputDirectory(outputDir);
  const reports = [];
  for (const meal of meals) {
    const report = { schemaVersion: 'real-food-image-batch-report.v1', runId, validationRunId: runId, mealId: meal.mealId,
      source: 'desktop-options', attempts: [], stageResults: [], final: null, status: 'failed' };
    let first;
    try {
      const reservation = ledger.reserve({ mealId: meal.mealId, stage: 'whole', model: LOCAL_MODEL, reasoningEffort: LOCAL_REASONING, resultVersion: 2, validationRunId: runId });
      const started = Date.now();
      first = await callMeal({ ...meal, stage: 'whole', validationRunId: runId, runId });
      ledger.finish(reservation.attemptId, { elapsedMs: Date.now() - started, httpStatus: 200, providerCompleted: true, resultAccepted: true, outcome: 'accepted', usage: first?.usage });
      report.stageResults.push(acceptedStage('whole', reservation.attemptId, first));
      report.final = first?.analysis ?? first ?? null;
      const needsReview = Boolean(first?.needsReview || first?.lowConfidence || first?.conflict || first?.analysis?.needsReview);
      if (needsReview) {
        const review = ledger.reserve({ mealId: meal.mealId, stage: 'crop_review', model: LOCAL_MODEL, reasoningEffort: LOCAL_REASONING, resultVersion: 2, validationRunId: runId });
        const reviewStarted = Date.now();
        const reviewed = await callMeal({ ...meal, stage: 'crop_review', previous: first, validationRunId: runId, runId });
        ledger.finish(review.attemptId, { elapsedMs: Date.now() - reviewStarted, httpStatus: 200, providerCompleted: true, resultAccepted: true, outcome: 'accepted', usage: reviewed?.usage });
        report.stageResults.push(acceptedStage('crop_review', review.attemptId, reviewed));
        report.final = reviewed?.analysis ?? reviewed ?? report.final;
      }
      report.status = 'accepted';
    } catch (error) {
      report.status = outcomeKind(error);
      report.error = { kind: report.status, code: error?.code ?? null, message: String(error?.message ?? 'request failed').slice(0, 240) };
      const attempt = ledger.attemptsForRun(runId, meal.mealId).at(-1);
      if (attempt?.status === 'in_flight') ledger.finish(attempt.attemptId, { elapsedMs: null, outcome: 'request_error' });
    }
    report.attempts = ledger.attemptsForRun(runId, meal.mealId);
    const safe = redactReport(report);
    await writeFile(join(outputDir, `${safeId(meal.mealId)}.json`), `${JSON.stringify(safe, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    reports.push(safe);
  }
  const totals = ledger.totals();
  const summary = { schemaVersion: 'real-food-image-batch-summary.v1', runId, validationRunId: runId, mealCount: reports.length, statusCounts: Object.fromEntries(reports.reduce((m, r) => m.set(r.status, (m.get(r.status) ?? 0) + 1), new Map())), reports: reports.map(({ mealId, status, error }) => ({ mealId, status, error: error?.kind ?? null })), ledger: { limits: REAL_MEAL_LIMITS, totals } };
  await writeFile(join(outputDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  ledger.close?.();
  return { summary, reports, outputDir };
}

/** Execute each complete single-meal workflow; the per-meal runner exclusively owns ledger writes. */
export async function runLiveBatch(options = {}) {
  const meals = options.meals ?? selectValidationMeals(await discoverMealImages(options));
  if (typeof options.runMeal !== 'function') throw new TypeError('runLiveBatch requires an injected runMeal function.');
  assertUniqueReportNames(meals);
  const runId = options.runId ?? randomUUID();
  const outputDir = resolve(options.outputDir ?? join(process.cwd(), 'artifacts', `real-validation-batch-${runId}`));
  await prepareOutputDirectory(outputDir);
  const reports = [];
  for (const meal of meals) {
    let report;
    try {
      const liveReport = await options.runMeal({ ...meal, runId, validationRunId: runId });
      const stageResults = Array.isArray(liveReport?.stageResults) ? liveReport.stageResults : [];
      const attempts = Array.isArray(liveReport?.requestAttempts) ? liveReport.requestAttempts : [];
      const acceptedStage = stageResults.filter((stage) => stage?.accepted === true || stage?.resultAccepted === true || stage?.status === 'accepted').at(-1);
      report = {
        schemaVersion: 'real-food-image-batch-report.v1', runId, validationRunId: runId, mealId: meal.mealId,
        status: liveReport?.result?.status === 200 ? 'accepted' : outcomeKind({ code: liveReport?.result?.errorCode, message: liveReport?.result?.errorCode }),
        attempts,
        stageResults,
        stageRejections: Array.isArray(liveReport?.stageRejections) ? liveReport.stageRejections : [],
        final: liveReport?.result?.analysis ?? acceptedStage?.analysis ?? null,
        returnedAnalysis: liveReport?.returnedAnalysis ?? liveReport?.result?.analysis ?? null,
        returnedStage: liveReport?.validation?.returnedStage ?? liveReport?.result?.returnedStage ?? null,
        returnedAttemptId: liveReport?.validation?.returnedAttemptId ?? liveReport?.result?.returnedAttemptId ?? null,
        returnedStageResult: liveReport?.returnedStageResult ?? null,
        validation: liveReport?.validation ?? null,
        upstreamError: liveReport?.upstreamError ?? null,
        error: liveReport?.result?.errorCode ? { kind: outcomeKind({ code: liveReport.result.errorCode, message: liveReport.result.errorCode }), code: liveReport.result.errorCode } : undefined,
      };
    } catch (error) {
      report = { schemaVersion: 'real-food-image-batch-report.v1', runId, validationRunId: runId, mealId: meal.mealId, status: outcomeKind(error), attempts: [], stageResults: [], final: null,
        error: { kind: outcomeKind(error), code: error?.code ?? null, message: String(error?.message ?? 'request failed').slice(0, 240) } };
    }
    const safe = redactReport(report);
    await writeFile(join(outputDir, `${safeId(meal.mealId)}.json`), `${JSON.stringify(safe, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    reports.push(safe);
  }
  const totals = options.getLedgerTotals?.() ?? null;
  const summary = { schemaVersion: 'real-food-image-batch-summary.v1', runId, validationRunId: runId, mealCount: reports.length,
    statusCounts: Object.fromEntries(reports.reduce((m, r) => m.set(r.status, (m.get(r.status) ?? 0) + 1), new Map())),
    reports: reports.map(({ mealId, status, error }) => ({ mealId, status, error: error?.kind ?? null })),
    ledger: { limits: REAL_MEAL_LIMITS, totals } };
  await writeFile(join(outputDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return { summary, reports, outputDir };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log([
      'Usage: node scripts/batch-real-food-image.mjs --live [options]',
      '',
      'Options:',
      '  --input-dir=<path>    Meal folders (default: C:/Users/14360/Desktop/options)',
      '  --output-dir=<path>   Report directory (default: artifacts/real-validation-batch)',
      '  --run-id=<id>         Stable run ID for ledger/report association',
      '  --ledger-path=<path>  Existing experiment ledger (default: artifacts/real-meal-request-ledger-batch-20261016.sqlite)',
      '  --timeout-ms=<ms>     Per-request timeout (default: 90000; explicit diagnostics may use 180000)',
      '  --image-detail=<mode> Image detail (default: low)',
      '  --stream              Use streaming model responses (default: on)',
      '  --live                Required to send model requests',
    ].join('\n'));
  } else if (!argv.includes('--live')) {
    console.error('Batch runner requires --live; no model request was sent.');
    process.exitCode = 2;
  } else {
    const arg = (name, fallback) => argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
    const inputDir = arg('input-dir', 'C:/Users/14360/Desktop/options');
    const runId = arg('run-id', randomUUID());
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(runId)) throw new Error('Invalid run ID.');
    const outputDir = resolve(arg('output-dir', join(process.cwd(), 'artifacts', `real-meal-retest-${runId}`)));
    const ledgerPath = arg('ledger-path', join(process.cwd(), 'artifacts', 'real-meal-request-ledger-batch-20261016.sqlite'));
  const shared = { timeoutMs: Number(arg('timeout-ms', '90000')), approximateCopy: false, actualAppCopy: false,
      stream: true, imageDetail: arg('image-detail', 'low'), plannedMeals: 50, ledgerPath, quiet: true, writeStandaloneReport: false };
    import('./test-real-food-image.mjs').then(({ runRealFoodImage }) => runLiveBatch({ inputDir, outputDir, runId,
      runMeal: ({ mealId, imagePath, validationRunId }) => runRealFoodImage({ ...shared, imagePath, mealId, validationRunId }),
      getLedgerTotals: () => {
        const ledger = new RealMealTestLedger(ledgerPath);
        try { return ledger.totals(); } finally { ledger.close(); }
      },
    })).then(({ summary }) => console.log(JSON.stringify(summary, null, 2))).catch((error) => { console.error(`Batch validation failed: ${error.message}`); process.exitCode = 1; });
  }
}
