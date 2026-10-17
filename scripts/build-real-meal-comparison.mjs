#!/usr/bin/env node
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMealComparison, renderMealComparisonMarkdown } from './meal-comparison.mjs';
import { LOCAL_MODEL, LOCAL_REASONING } from '../server/local-codex.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const DEFAULT_BASELINE = resolve(root, 'artifacts/real-validation-baseline-20261016.json');
const LIMITS = Object.freeze({ totalRequests: 75, perMealRequests: 3 });
const STATUS_LABELS = Object.freeze({
  accepted: '已接受', timeout: '超时', budget_rejected: '额度拒绝', schema_error: '格式错误',
  failed: '失败', upstream_error: '上游错误',
});

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isAcceptedStage(stage) {
  return isObject(stage) && stage.accepted !== false && stage.resultAccepted !== false && stage.providerCompleted !== false
    && stage.completed !== false && stage.stageSucceeded !== false
    && (stage.accepted === true || stage.resultAccepted === true || stage.status === 'accepted');
}

function stageAnalysis(stage) {
  if (!isObject(stage)) return null;
  if (isObject(stage.analysis)) return stage.analysis;
  if (isObject(stage.result?.analysis)) return stage.result.analysis;
  return null;
}

function sameValue(left, right) {
  if (left === right) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => sameValue(value, right[index]));
  }
  if (typeof left !== 'object') return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index]
    && sameValue(left[key], right[key]));
}

function acceptedCurrent(report) {
  const stageResults = Array.isArray(report.stageResults) ? report.stageResults : [];
  const acceptedStages = stageResults.filter(isAcceptedStage);
  if (report.resultAccepted === false || report.finalAccepted === false || report.validation?.accepted === false) return null;

  // A successful call can return an earlier accepted stage when a later review
  // or final merge fails. Preserve all stage history, but compare the returned
  // analysis using the explicit stage identity captured by the single-meal run.
  const returnedStage = isObject(report.returnedStageResult) && isAcceptedStage(report.returnedStageResult)
    ? report.returnedStageResult : null;
  const returnedAttemptId = report.returnedAttemptId ?? report.validation?.returnedAttemptId;
  const returnedStageName = report.returnedStage ?? report.validation?.returnedStage;
  const returnedAnalysis = report.returnedAnalysis ?? report.result?.analysis;
  const selectedStage = returnedStage
    ?? acceptedStages.find((stage) => returnedAttemptId !== undefined && stage.attemptId === returnedAttemptId)
    ?? acceptedStages.find((stage) => typeof returnedStageName === 'string' && stage.stage === returnedStageName)
    ?? acceptedStages.find((stage) => stageAnalysis(stage) === returnedAnalysis)
    ?? acceptedStages.findLast((stage) => sameValue(stageAnalysis(stage), returnedAnalysis));
  if (selectedStage) return stageAnalysis(selectedStage);

  const accepted = acceptedStages.map(stageAnalysis).filter(Boolean);
  if (accepted.length && returnedAnalysis === undefined) return accepted.at(-1);

  const attempts = Array.isArray(report.attempts) ? report.attempts : Array.isArray(report.requestAttempts) ? report.requestAttempts : [];
  const acceptedAttempt = attempts.filter(isAcceptedStage).at(-1);
  if (acceptedAttempt) {
    if (isObject(acceptedAttempt.analysis)) return acceptedAttempt.analysis;
    if (isObject(acceptedAttempt.result?.analysis)) return acceptedAttempt.result.analysis;
    if (isObject(acceptedAttempt.result)) return acceptedAttempt.result;
  }

  if ((stageResults.length || attempts.length) && !stageResults.some(isAcceptedStage) && !attempts.some(isAcceptedStage)) return null;

  if (report.resultAccepted === true || report.finalAccepted === true || report.status === 'accepted') {
    if (isObject(report.final)) return report.final;
    if (isObject(report.result?.analysis)) return report.result.analysis;
  }
  return null;
}

function stageRejections(report) {
  if (Array.isArray(report.stageRejections)) return report.stageRejections;
  if (report.status !== 'budget_rejected') return [];
  const completedStages = new Set((Array.isArray(report.stageResults) ? report.stageResults : []).map((stage) => stage?.stage));
  const nextStage = !completedStages.has('whole') ? 'whole'
    : !completedStages.has('crop_review') ? 'crop_review'
      : !completedStages.has('final_merge') ? 'final_merge' : null;
  return nextStage ? [{ stage: nextStage, kind: 'budget_rejected', code: report.error?.code ?? null }] : [];
}

async function readJson(path, label) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new Error(`Cannot read valid ${label} JSON.`); }
}

function rowsFromBaseline(value) {
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.meals) ? value.meals : [];
}

async function loadBatchReports(batchDir) {
  const summary = await readJson(resolve(batchDir, 'summary.json'), 'batch summary');
  const references = Array.isArray(summary.reports) ? summary.reports : [];
  const reports = [];
  for (const reference of references) {
    if (!isObject(reference) || typeof reference.mealId !== 'string' || !reference.mealId.trim()) continue;
    const path = resolve(batchDir, `${reference.mealId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120)}.json`);
    const report = await readJson(path, 'per-meal batch report');
    if (report.mealId !== reference.mealId) throw new Error(`Batch report identity mismatch for ${reference.mealId}.`);
    reports.push(report);
  }
  if (!reports.length) throw new Error('Batch summary contains no per-meal reports.');
  return { summary, reports };
}

function countAttempts(comparisons) {
  const attempts = comparisons.flatMap((comparison) => comparison.attempts);
  const statusCounts = {};
  for (const attempt of attempts) statusCounts[attempt.status] = (statusCounts[attempt.status] ?? 0) + 1;
  return {
    totalRequests: attempts.length,
    completedRequests: attempts.filter((attempt) => attempt.providerCompleted === true).length,
    acceptedRequests: attempts.filter((attempt) => attempt.resultAccepted).length,
    successfulStages: attempts.filter((attempt) => attempt.stageSucceeded).length,
    failedRequests: attempts.filter((attempt) => !attempt.resultAccepted).length,
    statusCounts,
  };
}

async function ensureAbsent(path) {
  try { await access(path); throw new Error(`Refusing to overwrite existing comparison artifact: ${basename(path)}.`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

/** Compare accepted snapshots without confusing per-100g references with meal intake. */
export async function buildRealMealComparison({
  batchDir,
  baselinePath = DEFAULT_BASELINE,
  outputDir = batchDir,
  model = LOCAL_MODEL,
  reasoningEffort = LOCAL_REASONING,
} = {}) {
  if (typeof batchDir !== 'string' || !batchDir.trim()) throw new TypeError('batchDir is required.');
  const resolvedBatchDir = resolve(batchDir);
  const resolvedOutputDir = resolve(outputDir);
  const baseline = rowsFromBaseline(await readJson(resolve(baselinePath), 'baseline'));
  const baselineByMeal = new Map(baseline
    .filter((row) => isObject(row) && row.accepted === true && typeof row.mealId === 'string' && isObject(row.analysis))
    .map((row) => [row.mealId, row.analysis]));
  const { summary, reports } = await loadBatchReports(resolvedBatchDir);
  const comparisons = reports.map((report) => createMealComparison({
    mealId: report.mealId,
    previous: baselineByMeal.get(report.mealId) ?? null,
    current: acceptedCurrent(report),
    attempts: Array.isArray(report.attempts) ? report.attempts : Array.isArray(report.requestAttempts) ? report.requestAttempts : [],
    batchStatus: typeof report.status === 'string' ? report.status : null,
    stageRejections: stageRejections(report),
    batchError: isObject(report.error) ? report.error : null,
  }));
  const requestSummary = countAttempts(comparisons);
  const ledgerTotal = Number.isSafeInteger(summary.ledger?.totals?.totalRequests)
    ? summary.ledger.totals.totalRequests : null;
  const runId = typeof summary.runId === 'string' && summary.runId ? summary.runId : basename(resolvedBatchDir);
  const nutritionMethods = [...new Set(comparisons.flatMap((row) => [row.previous?.nutritionSource?.method, row.current?.nutritionSource?.method]).filter(Boolean))];
  const currentAiReferences = comparisons.filter((row) => row.current?.nutritionSource?.method === 'ai-per100g-v3');
  const uniformMetadata = (values) => {
    const present = [...new Set(values.filter((value) => value !== null && value !== undefined))];
    return present.length === 1 ? present[0] : null;
  };
  const comparison = {
    schemaVersion: 'real-meal-comparison.v2',
    runId,
    testedAt: new Date().toISOString(),
    model,
    reasoningEffort,
    timeoutMs: uniformMetadata([summary.timeoutMs, summary.upstreamTimeoutMs, ...reports.flatMap((report) => [report.timeoutMs, report.upstreamTimeoutMs])]),
    stream: uniformMetadata([summary.stream, ...reports.map((report) => report.stream)]),
    imageDetail: uniformMetadata([summary.imageDetail, ...reports.map((report) => report.diagnosticOverrides?.imageDetail ?? report.imageDetail)]),
    automaticRetries: 0,
    scope: nutritionMethods.includes('ai-per100g-v3') ? 'per100g_reference_and_user_quantity'
      : nutritionMethods.includes('user-quantity-v2') ? 'user_quantity' : nutritionMethods.includes('ingredient-weight-v1') ? 'photo_serving' : 'unknown',
    nutritionMethods,
    groundTruthAvailable: false,
    nutritionSummary: {
      aiReferenceMeals: currentAiReferences.length,
      usefulReferenceMeals: currentAiReferences.filter((row) => row.current.hasUsefulNutritionReference && row.current.referenceCoverageConsistent).length,
      referenceOnlyMeals: currentAiReferences.filter((row) => row.current.hasUsefulNutritionReference && row.current.coverage?.counted === 0).length,
      intakeCompleteMeals: currentAiReferences.filter((row) => row.current.intakeComplete).length,
    },
    requestSummary: {
      ...requestSummary,
      ledgerTotalRequests: ledgerTotal,
      ledgerLimit: LIMITS.totalRequests,
      ledgerRemainingRequests: ledgerTotal === null ? null : Math.max(0, LIMITS.totalRequests - ledgerTotal),
    },
    comparisons,
  };
  const markdown = renderMealComparisonMarkdown({
    runId,
    model,
    reasoningEffort,
    comparisons,
    requestSummary: {
      ...requestSummary,
      cumulativeRequests: ledgerTotal,
      remainingRequests: ledgerTotal === null ? null : Math.max(0, LIMITS.totalRequests - ledgerTotal),
    },
  }) + '\n口径说明：ai-per100g-v3 的每 100 g 参考由 AI 按典型配方或品类范围生成；实际摄入仅按用户填写数量在本地换算，未填数量时摄入保持未知。历史结果保留各自方法与来源。照片没有称重营养真值，前后变化不能解释为准确率或营养误差。\n';

  await mkdir(resolvedOutputDir, { recursive: true });
  const jsonPath = resolve(resolvedOutputDir, 'comparison.json');
  const markdownPath = resolve(resolvedOutputDir, 'comparison.md');
  await ensureAbsent(jsonPath);
  await ensureAbsent(markdownPath);
  await writeFile(jsonPath, `${JSON.stringify(comparison, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await writeFile(markdownPath, markdown, { flag: 'wx', mode: 0o600 });
  return { comparison, jsonPath, markdownPath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name, fallback) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
  const batchDir = arg('batch-dir', undefined);
  if (!batchDir || process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('Usage: node scripts/build-real-meal-comparison.mjs --batch-dir=<independent-run-directory> [--baseline=<json>] [--output-dir=<directory>]');
    if (!batchDir) process.exitCode = process.argv.includes('--help') || process.argv.includes('-h') ? 0 : 2;
  } else {
    buildRealMealComparison({ batchDir, baselinePath: arg('baseline', DEFAULT_BASELINE), outputDir: arg('output-dir', batchDir) })
      .then(({ comparison, jsonPath, markdownPath }) => console.log(JSON.stringify({
        runId: comparison.runId,
        mealCount: comparison.comparisons.length,
        acceptedCount: comparison.comparisons.filter((row) => row.current).length,
        requestCount: comparison.requestSummary.totalRequests,
        json: jsonPath,
        markdown: markdownPath,
      }, null, 2)))
      .catch((error) => { console.error(`Comparison generation failed: ${error.message}`); process.exitCode = 1; });
  }
}
