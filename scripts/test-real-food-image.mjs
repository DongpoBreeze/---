#!/usr/bin/env node
// Real-image diagnostic; never prepares product settings or reuses the app ledger.
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { basename, join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import { readLocalCodexProvider, LOCAL_MODEL, LOCAL_REASONING } from '../server/local-codex.mjs';
import { parseConfig } from '../server/config.mjs';
import { GatewayError, callModel, modelRequest } from '../server/protocol.mjs';
import { calculateMealNutrition } from '../shared/nutrition.mjs';
import { summarizeMealAnalysis } from './meal-comparison.mjs';
import { RealMealTestLedger, REAL_MEAL_LIMITS, REAL_MEAL_LEDGER_PATHS, isExistingRealMealLedgerPath } from './real-meal-test-ledger.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export const DEFAULT_IMAGE = 'C:\\Users\\14360\\.codex\\attachments\\b1448d7b-6357-4c30-94a9-a8a9ebd08c21\\image-1.png';
export const REAL_FOOD_RESULT_VERSION = 3;
const MAX_REAL_MODEL_CALLS = REAL_MEAL_LIMITS.totalRequests;
const DEFAULT_LEDGER_PATH = REAL_MEAL_LEDGER_PATHS[0];
const NUTRIENTS = ['calories', 'protein', 'carbs', 'fat'];
const getArg = (name, argv) => argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const safeHash = (value) => createHash('sha256').update(value).digest('hex');

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

function cleanUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const usage = {};
  for (const key of ['input_tokens', 'output_tokens', 'total_tokens', 'cached_input_tokens', 'reasoning_tokens']) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) usage[key] = value[key];
  }
  return Object.keys(usage).length ? usage : null;
}

function extractUsage(body) {
  try {
    const raw = JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : String(body));
    return cleanUsage(raw?.usage ?? raw?.response?.usage ?? raw?.choices?.[0]?.usage);
  } catch { return null; }
}

export function parseOptions(argv = process.argv) {
  const timeoutMs = Number(getArg('timeout-ms', argv) ?? 180_000);
  const imageDetail = getArg('image-detail', argv) ?? 'low';
  const approximateCopy = argv.includes('--approximate-copy');
  const actualAppCopy = argv.includes('--app-copy');
  const plannedMeals = Number(getArg('planned-meals', argv) ?? 50);
  const ledgerPath = getArg('ledger-path', argv) ?? DEFAULT_LEDGER_PATH;
  if (!argv.includes('--live')) throw new Error('Use --live to authorize the real request.');
  if (approximateCopy && actualAppCopy) throw new Error('Choose one copy mode.');
  if (argv.includes('--stream') && argv.includes('--no-stream')) throw new Error('Choose one streaming mode.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) throw new Error('Invalid timeout.');
  if (imageDetail !== undefined && !['low', 'high', 'auto'].includes(imageDetail)) throw new Error('Invalid image detail.');
  if (!Number.isInteger(plannedMeals) || plannedMeals < 1 || plannedMeals > 50) throw new Error('Invalid planned meal count.');
  if (!isExistingRealMealLedgerPath(ledgerPath)) throw new Error('Live diagnostics must use one of the two existing shared-budget real-meal ledgers.');
  return {
    imagePath: getArg('image', argv) ?? DEFAULT_IMAGE, timeoutMs, approximateCopy, actualAppCopy,
    stream: !argv.includes('--no-stream'), imageDetail, mealId: getArg('meal-id', argv), plannedMeals,
    validationRunId: getArg('run-id', argv), writeStandaloneReport: !argv.includes('--no-standalone-report'),
    ledgerPath,
    configPath: getArg('codex-config', argv),
  };
}

async function loadPhoto(options) {
  const bytes = await readFile(options.imagePath);
  const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (!isJpeg && !isPng) throw new Error('The supplied file is not a supported JPEG or PNG.');
  const mime = isJpeg ? 'image/jpeg' : 'image/png';
  let photo = `data:${mime};base64,${bytes.toString('base64')}`;
  let transmittedBytes = bytes.length; let transmittedDimensions = null; let transmittedMime = mime;
  let transmittedSha256 = safeHash(bytes); let transform = { method: 'none', parity: 'original-input' }; let appPayload;
  if (options.actualAppCopy) {
    const capture = JSON.parse(await readFile(join(root, 'artifacts/real-food-app-copy.json'), 'utf8'));
    const copy = await readFile(join(root, 'artifacts/real-food-app-copy.jpg'));
    if (capture.original.sha256 !== safeHash(bytes) || capture.transmitted.sha256 !== safeHash(copy)) throw new Error('App capture does not match the referenced photo.');
    photo = `data:image/jpeg;base64,${copy.toString('base64')}`; transmittedBytes = copy.length; transmittedDimensions = capture.transmitted.dimensions;
    transmittedMime = 'image/jpeg'; transmittedSha256 = safeHash(copy); transform = capture.transform; appPayload = capture.payload;
  }
  if (options.approximateCopy) {
    const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, args: ['--no-proxy-server'] });
    try {
      const page = await browser.newPage();
      const transformed = await page.evaluate(async (source) => {
        const blob = await (await fetch(source)).blob(); const url = URL.createObjectURL(blob);
        try {
          const image = new Image(); image.src = url; await image.decode(); const scale = Math.min(1, 1200 / image.naturalWidth);
          const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
          canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
          return { output: canvas.toDataURL('image/jpeg', 0.75), width: canvas.width, height: canvas.height };
        } finally { URL.revokeObjectURL(url); }
      }, photo);
      photo = transformed.output; transmittedMime = 'image/jpeg'; transmittedBytes = Buffer.byteLength(photo.slice(photo.indexOf(',') + 1), 'base64');
      transmittedDimensions = { width: transformed.width, height: transformed.height }; transmittedSha256 = safeHash(Buffer.from(photo.slice(photo.indexOf(',') + 1), 'base64'));
      transform = { method: 'browser-canvas-drawImage', quality: 0.75, maxWidth: 1200, parity: 'approximate-only', note: 'Expo ImageManipulator native algorithm was not invoked.' };
    } finally { await browser.close(); }
  }
  return { bytes, mime, photo, transmittedBytes, transmittedDimensions, transmittedMime, transmittedSha256, transform, appPayload };
}

/** Create real local JPEG crops from normalized model regions for review calls. */
export function createLocalCropper() {
  let browser;
  let page;
  const history = [];
  const ensurePage = async () => {
    browser ??= await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, args: ['--no-proxy-server'] });
    page ??= await browser.newPage();
    return page;
  };
  return {
    createCrops: async ({ input, regions, stage }) => {
      if (stage !== 'crop_review') throw new Error('Local crops are only available for crop review.');
      if (!Array.isArray(regions) || regions.length > 4) throw new Error('Too many crop regions.');
      if (!regions.length) return [];
      const photos = input?.payload?.photos;
      if (!Array.isArray(photos) || photos.length !== 1 || typeof photos[0] !== 'string') {
        throw new Error('Local crop review currently requires exactly one source photo.');
      }
      const activePage = await ensurePage();
      const results = await activePage.evaluate(async ({ source, sourceRegions }) => {
        const image = new Image();
        image.src = source;
        await image.decode();
        const width = image.naturalWidth;
        const height = image.naturalHeight;
        if (!width || !height) throw new Error('Unable to decode source image.');
        return sourceRegions.map((region) => {
          const x = Math.min(1, Math.max(0, Number(region?.x) || 0));
          const y = Math.min(1, Math.max(0, Number(region?.y) || 0));
          const right = Math.min(1, Math.max(x, Number(region?.x) + Number(region?.width) || x));
          const bottom = Math.min(1, Math.max(y, Number(region?.y) + Number(region?.height) || y));
          const regionWidth = Math.max(0, right - x);
          const regionHeight = Math.max(0, bottom - y);
          const maxWidth = Math.max(1, Math.floor(width * 0.75));
          const maxHeight = Math.max(1, Math.floor(height * 0.75));
          const sw = Math.max(1, Math.min(maxWidth, Math.ceil(regionWidth * width * 1.2) || 1));
          const sh = Math.max(1, Math.min(maxHeight, Math.ceil(regionHeight * height * 1.2) || 1));
          const centerX = Math.round(((x + right) / 2) * width);
          const centerY = Math.round(((y + bottom) / 2) * height);
          const sx = Math.max(0, Math.min(width - sw, centerX - Math.floor(sw / 2)));
          const sy = Math.max(0, Math.min(height - sh, centerY - Math.floor(sh / 2)));
          const canvas = document.createElement('canvas');
          canvas.width = sw;
          canvas.height = sh;
          const context = canvas.getContext('2d', { alpha: false });
          if (!context) throw new Error('Unable to create crop canvas.');
          context.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
          return { photo: canvas.toDataURL('image/jpeg', 0.86), width: sw, height: sh, sourcePixels: { x: sx, y: sy, width: sw, height: sh } };
        });
      }, { source: photos[0], sourceRegions: regions });
      history.push(...results.map((crop, index) => {
        const base64 = crop.photo.slice(crop.photo.indexOf(',') + 1);
        const bytes = Buffer.from(base64, 'base64');
        return { stage, region: regions[index], width: crop.width, height: crop.height, bytes: bytes.length,
          sha256: safeHash(bytes), sourcePixels: crop.sourcePixels };
      }));
      return results.map((crop) => crop.photo);
    },
    get history() { return history.map((item) => ({ ...item, region: { ...item.region }, sourcePixels: { ...item.sourcePixels } })); },
    close: async () => { if (browser) await browser.close(); },
  };
}

export function redactRawResponse(body, providerKey) {
  const rawText = Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
  return rawText.replaceAll(providerKey, '[REDACTED_CREDENTIAL]')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/https?:\/\/[^\s"'<>\\]+/gi, '[REDACTED_URL]')
    .replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, '[REDACTED_IMAGE]');
}

/** A hypothetical local arithmetic check; it never edits the accepted model snapshot. */
export function createOfflineQuantityCheck(analysis, grams = 250) {
  const summary = summarizeMealAnalysis(analysis);
  if (!summary?.hasUsefulNutritionReference || !Number.isFinite(grams) || grams <= 0 || grams > 100_000) return null;
  const index = summary.components.findIndex((component) => component.reference?.useful);
  const hypothetical = structuredClone(analysis);
  hypothetical.components = hypothetical.components.map((component, position) => ({ ...component,
    userQuantity: position === index ? { amount: grams, unit: 'g' } : null }));
  const calculated = calculateMealNutrition(hypothetical, undefined, { mode: 'ai-per100g-v3' });
  const reference = summary.components[index].reference;
  const expectedBeforeRounding = Object.fromEntries(NUTRIENTS.map((key) => [key, {
    min: reference.nutrients[key].min * grams / 100, max: reference.nutrients[key].max * grams / 100,
  }]));
  const passed = NUTRIENTS.every((key) => {
    const expected = expectedBeforeRounding[key]; const actual = calculated[key]; const step = key === 'calories' ? 1 : 0.1;
    return actual && actual.min <= expected.min + 1e-8 && actual.max >= expected.max - 1e-8
      && expected.min - actual.min < step + 1e-8 && actual.max - expected.max < step + 1e-8;
  });
  return { syntheticOnly: true, purpose: 'hypothetical-local-quantity-conversion', changesOriginalAnalysis: false,
    componentIndex: index, componentLabel: summary.components[index].label, userQuantity: { amount: grams, unit: 'g' },
    expectedBeforeRounding, nutrients: Object.fromEntries(NUTRIENTS.map((key) => [key, calculated[key]])),
    counted: calculated.coverage.counted, intakeComplete: calculated.nutritionSource.coverage === 'complete', passed };
}

/** Keep transport, business validation and useful nutrition evidence independent. */
export function finalizeRealFoodReport(report) {
  const attempts = (report.requestAttempts ?? []).map((attempt) => ({ ...attempt,
    completed: attempt.providerCompleted === true, accepted: attempt.resultAccepted === true,
    stageSucceeded: attempt.providerCompleted === true && attempt.resultAccepted === true && attempt.status === 'accepted'
      && attempt.httpStatus >= 200 && attempt.httpStatus < 300,
  }));
  const stageResults = (report.stageResults ?? []).map((stage) => {
    const attempt = attempts.find((row) => row.attemptId === stage.attemptId && row.stage === stage.stage);
    const completed = attempt?.completed === true;
    const accepted = attempt?.accepted === true;
    const stageSucceeded = attempt?.stageSucceeded === true;
    const nutritionReference = summarizeMealAnalysis({ analysis: stage.analysis, accepted, providerCompleted: completed });
    const hasUsefulNutritionReference = nutritionReference?.hasUsefulNutritionReference === true;
    const provenanceConsistent = nutritionReference !== null && nutritionReference.components.every((component) => {
      const reference = component.reference;
      return !reference?.useful || (reference.model === attempt?.model
        && (reference.reasoningEffort === null || reference.reasoningEffort === attempt?.reasoningEffort));
    });
    return { ...stage, completed, providerCompleted: completed, accepted, resultAccepted: accepted, stageSucceeded,
      hasUsefulNutritionReference, provenanceConsistent, nutritionFeatureSucceeded: stageSucceeded && hasUsefulNutritionReference && provenanceConsistent
        && nutritionReference.referenceCoverageConsistent === true && attempt?.resultVersion === REAL_FOOD_RESULT_VERSION,
      nutritionReference };
  });
  const stageAssessments = attempts.map((attempt) => {
    const stage = stageResults.find((result) => result.attemptId === attempt.attemptId && result.stage === attempt.stage);
    return { attemptId: attempt.attemptId, stage: attempt.stage, status: attempt.status,
      model: attempt.model, reasoningEffort: attempt.reasoningEffort, resultVersion: attempt.resultVersion,
      elapsedMs: attempt.elapsedMs, httpStatus: attempt.httpStatus, usage: attempt.usage,
      errorCode: attempt.errorCode ?? null, errorName: attempt.errorName ?? null,
      completed: attempt.completed, accepted: attempt.accepted, stageSucceeded: attempt.stageSucceeded,
      hasUsefulNutritionReference: stage?.hasUsefulNutritionReference === true,
      provenanceConsistent: stage?.provenanceConsistent ?? null,
      nutritionFeatureSucceeded: stage?.nutritionFeatureSucceeded === true,
      referenceCount: stage?.nutritionReference?.coverage?.referenceCount ?? null,
      usefulReferenceCount: stage?.nutritionReference?.usefulReferenceCount ?? 0,
      intakeComplete: stage?.nutritionReference?.intakeComplete ?? false,
    };
  });
  const acceptedStages = stageResults.filter((stage) => stage.stageSucceeded);
  const firstAcceptedResult = acceptedStages[0] ?? null;
  const latestAcceptedResult = acceptedStages.at(-1) ?? null;
  const explicitReturnedAttemptId = report.result?.returnedAttemptId;
  const explicitReturnedStage = report.result?.returnedStage;
  const returnedStageResult = acceptedStages.find((stage) => explicitReturnedAttemptId !== undefined
    && stage.attemptId === explicitReturnedAttemptId)
    ?? acceptedStages.find((stage) => typeof explicitReturnedStage === 'string' && stage.stage === explicitReturnedStage)
    ?? acceptedStages.find((stage) => stage.analysis === report.result?.analysis)
    ?? acceptedStages.findLast((stage) => sameValue(stage.analysis, report.result?.analysis))
    ?? null;
  const nutritionReference = returnedStageResult?.nutritionReference ?? null;
  const workflowCompleted = report.result?.status === 200;
  return { ...report, requestAttempts: attempts, stageResults, stageAssessments, firstAcceptedResult, latestAcceptedResult,
    returnedStageResult, returnedAnalysis: report.result?.analysis ?? null, nutritionReference,
    validation: {
      workflowCompleted,
      completed: attempts.length > 0 && attempts.every((attempt) => attempt.completed),
      accepted: workflowCompleted && returnedStageResult?.accepted === true,
      hasPreservedAcceptedResult: latestAcceptedResult !== null,
      allStagesSucceeded: attempts.length > 0 && attempts.every((attempt) => attempt.stageSucceeded),
      hasUsefulNutritionReference: nutritionReference?.hasUsefulNutritionReference === true,
      nutritionFeatureSucceeded: workflowCompleted && returnedStageResult?.nutritionFeatureSucceeded === true,
      referenceCount: nutritionReference?.coverage?.referenceCount ?? null,
      usefulReferenceCount: nutritionReference?.usefulReferenceCount ?? 0,
      referenceCoverageComplete: nutritionReference?.referenceCoverageComplete ?? false,
      referenceCoverageConsistent: nutritionReference?.referenceCoverageConsistent ?? null,
      counted: nutritionReference?.coverage?.counted ?? null,
      intakeComplete: nutritionReference?.intakeComplete ?? false,
      unknownIntakeWithUsefulReference: nutritionReference?.hasUsefulNutritionReference === true
        && nutritionReference.coverage?.counted === 0 && NUTRIENTS.every((key) => nutritionReference.nutrients[key] === null),
      returnedStage: returnedStageResult?.stage ?? null,
      returnedAttemptId: returnedStageResult?.attemptId ?? null,
    },
    offlineQuantityCheck: returnedStageResult ? createOfflineQuantityCheck(returnedStageResult.analysis) : null,
  };
}

/** Execute one photo diagnostic. Credentials are read-only; no real API call is made without --live. */
export async function runRealFoodImage(options = parseOptions()) {
  options = { ...options, ledgerPath: options.ledgerPath ?? DEFAULT_LEDGER_PATH };
  if (!isExistingRealMealLedgerPath(options.ledgerPath)) throw new Error('Live diagnostics must use one of the two existing shared-budget real-meal ledgers.');
  const image = await loadPhoto(options);
  const provider = await readLocalCodexProvider({ configPath: options.configPath });
  const cropper = createLocalCropper();
  const config = parseConfig({
    HOST: '127.0.0.1', PORT: 0, SERVER_ACCESS_TOKEN: randomUUID().replaceAll('-', ''), MODEL_BASE_URL: provider.baseUrl,
    MODEL_API_PROTOCOL: 'responses', MODEL_API_KEY: provider.key, MODEL_NAME: LOCAL_MODEL, MODEL_REASONING_EFFORT: LOCAL_REASONING,
    MODEL_STREAM: String(Boolean(options.stream)), MODEL_MAX_OUTPUT_TOKENS: '8192', UPSTREAM_TIMEOUT_MS: String(options.timeoutMs),
    MONTHLY_BUDGET_CNY: '1000000', MAX_REQUEST_COST_CNY: '1', SAFETY_RESERVE_CNY: '0', INSTALLATION_DAILY_QUOTA: String(MAX_REAL_MODEL_CALLS),
    HEALTH_DB_PATH: ':memory:',
  });
  const mealId = options.mealId ?? `photo-${image.transmittedSha256.slice(0, 24)}`;
  const validationRunId = options.validationRunId ?? options.runId ?? randomUUID();
  const ledger = new RealMealTestLedger(options.ledgerPath);
  const runId = randomUUID(); const artifactDirectory = join(root, 'artifacts', 'real-validation', runId);
  await mkdir(artifactDirectory, { recursive: true, mode: 0o700 }); await chmod(artifactDirectory, 0o700).catch(() => {});
  const report = {
    schemaVersion: 'real-food-image-report.v4', testedAt: new Date().toISOString(), runId, imageSource: 'caller-supplied-local-photo', contentType: image.mime,
    original: { contentType: image.mime, bytes: image.bytes.length, sha256: safeHash(image.bytes) }, bytes: image.bytes.length, transmittedBytes: image.transmittedBytes,
    transmittedDimensions: image.transmittedDimensions, appCopy: options.actualAppCopy,
    copyMode: options.actualAppCopy ? 'actual-web-app' : options.approximateCopy ? 'approximate-browser-canvas' : 'original', transform: image.transform,
    transmitted: { contentType: image.transmittedMime, bytes: image.transmittedBytes, dimensions: image.transmittedDimensions, sha256: image.transmittedSha256 },
    syntheticOnly: false, automaticRetries: 0, model: LOCAL_MODEL, reasoningEffort: LOCAL_REASONING, upstreamTimeoutMs: options.timeoutMs,
    validationRunId,
    stream: options.stream, diagnosticOverrides: options.imageDetail ? { imageDetail: options.imageDetail } : {}, resultVersion: REAL_FOOD_RESULT_VERSION,
    nutritionMethod: 'ai-per100g-v3', ledgerBefore: ledger.totals(),
    maxModelCalls: MAX_REAL_MODEL_CALLS, perMealLimit: 3, reviewMealLimit: 25, mealId,
    requestAttempts: [], stageResults: [], stageRejections: [], reviewCrops: [], streamingEvents: [], streamingTerminalEvents: [],
    streamingSummary: { eventCount: 0, byType: {}, lastEventElapsedMs: null }, jsonModeInputMarker: false,
  };
  let activeAttempt; let lastProgressMs = -30_000;
  const callbacks = {
    before: ({ stage, model, reasoningEffort, resultVersion }) => {
      if (resultVersion !== REAL_FOOD_RESULT_VERSION) {
        report.stageRejections.push({ stage, kind: 'protocol_rejected', code: 'diagnostic_protocol_mismatch' });
        throw new GatewayError(500, 'diagnostic_protocol_mismatch', '诊断结果版本与当前营养协议不一致。');
      }
      try { return ledger.reserve({ mealId, stage, model, reasoningEffort, resultVersion, validationRunId }); }
      catch {
        report.stageRejections.push({ stage, kind: 'budget_rejected', code: 'diagnostic_request_limit' });
        throw new GatewayError(429, 'diagnostic_request_limit', '诊断请求额度或阶段限制已用完。');
      }
    },
    finish: (event) => {
      const attempt = report.requestAttempts.find((row) => row.attemptId === event.attemptId);
      const usage = cleanUsage(event.usage ?? attempt?.usage);
      ledger.finish(event.attemptId, { ...event, usage });
      if (attempt) Object.assign(attempt, { httpStatus: event.httpStatus, providerCompleted: event.providerCompleted,
        analysisAccepted: event.resultAccepted, completed: event.providerCompleted === true, elapsedMs: event.elapsedMs ?? attempt.elapsedMs,
        usage, status: event.outcome });
    },
    raw: async ({ attemptId, stage, body }) => {
      const name = `stage-${String(attemptId ?? stage).replace(/[^A-Za-z0-9_-]/g, '_')}-response.txt`;
      await writeFile(join(artifactDirectory, name), redactRawResponse(body, provider.key), { mode: 0o600 });
      await chmod(join(artifactDirectory, name), 0o600).catch(() => {});
      ledger.setRawArtifact(attemptId, `real-validation/${runId}/${name}`);
      const attempt = report.requestAttempts.find((row) => row.attemptId === attemptId);
      if (attempt) { attempt.rawResponseArtifact = `real-validation/${runId}/${name}`; attempt.usage ??= extractUsage(body); }
    },
    event: (event) => {
      if (event.phase === 'stage') {
        activeAttempt = { attemptId: event.attemptId, stage: event.stage, stageCount: event.stageCount, httpStatus: null,
          model: LOCAL_MODEL, reasoningEffort: LOCAL_REASONING, resultVersion: REAL_FOOD_RESULT_VERSION, providerCompleted: false, analysisAccepted: null,
          completed: false, elapsedMs: null, usage: null, status: 'in_flight' };
        report.requestAttempts.push(activeAttempt);
      } else if (event.phase === 'headers' && activeAttempt) { activeAttempt.httpStatus = event.httpStatus; activeAttempt.elapsedMs = event.elapsedMs;
      } else if (event.type === 'response.completed' && activeAttempt) { activeAttempt.providerCompleted = true; activeAttempt.elapsedMs = event.elapsedMs; activeAttempt.usage = event.usage ?? null;
      } else if (event.phase === 'event' && event.elapsedMs !== undefined && activeAttempt) activeAttempt.elapsedMs = event.elapsedMs;
      if (report.streamingEvents.length < 200) report.streamingEvents.push(event);
      if (['response.completed', 'response.failed', 'response.incomplete', 'error'].includes(event.type)) report.streamingTerminalEvents.push(event);
      const type = event.phase === 'headers' ? 'headers' : event.type;
      const stats = report.streamingSummary.byType[type] ??= { count: 0, firstElapsedMs: event.elapsedMs, lastElapsedMs: event.elapsedMs };
      stats.count++; stats.lastElapsedMs = event.elapsedMs; report.streamingSummary.eventCount++; report.streamingSummary.lastEventElapsedMs = event.elapsedMs;
      const terminalEvent = ['response.completed', 'response.failed', 'response.incomplete', 'error'].includes(event.type);
      if (!options.quiet && (event.elapsedMs - lastProgressMs >= 30_000 || terminalEvent)) {
        console.error(JSON.stringify({ phase: event.phase, type, elapsedMs: event.elapsedMs, eventCount: report.streamingSummary.eventCount })); lastProgressMs = event.elapsedMs;
      }
    },
    diagnostic: (diagnostic) => { report.upstreamError = diagnostic; },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    if (String(args[0]) !== config.modelApiUrl) return originalFetch(...args);
    if (options.imageDetail) {
      const body = JSON.parse(args[1].body);
      for (const message of body.input ?? []) for (const part of message.content ?? []) if (part.type === 'input_image') part.detail = options.imageDetail;
      args[1] = { ...args[1], body: JSON.stringify(body) };
    }
    return originalFetch(...args);
  };
  const input = { requestId: `real-food-image-${randomUUID()}`, installationId: `real-image-${randomUUID()}`, kind: 'meal', payload: {
    foodName: '', mealType: '午餐', portion: '', remaining: '', note: '', photoRoles: ['before'], profile: {}, ...image.appPayload, photos: [image.photo],
  }};
  const modelConfig = { ...config, modelStream: options.stream, upstreamTimeoutMs: options.timeoutMs, timeoutPerStage: true };
  const started = Date.now();
  try {
    const request = modelRequest(input, modelConfig);
    report.jsonModeInputMarker = /json/i.test(request.input[0].content[0].text);
    report.instructions = { characters: request.instructions.length, sha256: safeHash(request.instructions) };
    const result = await callModel(input, modelConfig, AbortSignal.timeout(options.timeoutMs * 3 + 5_000), callbacks.diagnostic, callbacks.event,
      callbacks.before, callbacks.finish, callbacks.raw, cropper.createCrops, ({ attemptId, stage, analysis }) => {
      report.stageResults.push({ attemptId, stage, status: 'accepted', accepted: true, resultAccepted: true,
        resultVersion: REAL_FOOD_RESULT_VERSION, analysis });
      });
    const returnedStage = report.stageResults.find((stage) => stage.analysis === result.analysis)
      ?? report.stageResults.findLast((stage) => sameValue(stage.analysis, result.analysis));
    report.result = { status: 200, elapsedMs: Date.now() - started, model: LOCAL_MODEL, errorCode: null, analysis: result.analysis,
      returnedStage: returnedStage?.stage ?? null, returnedAttemptId: returnedStage?.attemptId ?? null,
      reasoningEffort: LOCAL_REASONING, resultVersion: REAL_FOOD_RESULT_VERSION, stageCount: result.stageCount, requestCount: result.stageCount };
  } catch (error) {
    report.result = { status: error instanceof GatewayError ? error.status : null, model: LOCAL_MODEL, reasoningEffort: LOCAL_REASONING,
      resultVersion: REAL_FOOD_RESULT_VERSION, elapsedMs: Date.now() - started,
      errorCode: error instanceof GatewayError ? error.code : 'diagnostic_transport_failure', failureName: error.name,
      analysis: null, stageCount: error.stageCount ?? report.requestAttempts.length, requestCount: report.requestAttempts.length };
  } finally {
    globalThis.fetch = originalFetch;
    await cropper.close().catch(() => {});
    report.reviewCrops = cropper.history;
    // A callback or local failure must leave a durable failed attempt, never an
    // uncounted retry opportunity or an implicitly successful unfinished stage.
    for (const attempt of ledger.attemptsForRun(validationRunId, mealId)) {
      if (attempt.status === 'in_flight') ledger.finish(attempt.attemptId, {
        elapsedMs: Math.max(0, Date.now() - Date.parse(attempt.startedAt)), outcome: 'request_error',
        errorCode: report.result?.errorCode, errorName: report.result?.failureName,
      });
    }
    report.requestAttempts = ledger.attemptsForRun(validationRunId, mealId);
    report.ledger = { path: `artifacts/${basename(options.ledgerPath)}`,
      limits: { totalRequests: MAX_REAL_MODEL_CALLS, perMealRequests: REAL_MEAL_LIMITS.perMealRequests, reviewMeals: REAL_MEAL_LIMITS.reviewMeals }, totals: ledger.totals() };
    ledger.close();
  }
  const serialized = redactRawResponse(JSON.stringify(finalizeRealFoodReport(report), null, 2), provider.key);
  const safeReport = JSON.parse(serialized);
  if (options.writeStandaloneReport !== false) {
    await mkdir(join(root, 'artifacts'), { recursive: true });
    const output = join(root, 'artifacts', `real-food-image-${Date.now()}.json`);
    await writeFile(output, `${serialized}\n`, { flag: 'wx', mode: 0o600 }); await chmod(output, 0o600).catch(() => {});
    safeReport.report = output;
  }
  if (!options.quiet) console.log(JSON.stringify(safeReport, null, 2));
  return safeReport;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('Usage: node scripts/test-real-food-image.mjs --live --stream --timeout-ms=180000 --image-detail=low --app-copy [--run-id=<new-round-id>] [--meal-id=<id>]\nStreaming and low image detail are defaults. --app-copy verifies and uses the existing app capture for the original attachment. Both existing real-meal ledgers share the cumulative 75-request budget.');
  } else {
    runRealFoodImage().then((report) => { if (!report.validation.nutritionFeatureSucceeded) process.exitCode = 1; })
      .catch((error) => { console.error(`Real image validation failed: ${error.message}`); process.exitCode = 1; });
  }
}
