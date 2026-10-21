#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile, appendFile, access, copyFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { requestProvider } from '../src/ai-provider.ts';
import { mealRecognitionInstructions } from '../shared/nutrition.mjs';
import { readLocalCodexProvider } from '../server/local-codex.mjs';
import { RealMealTestLedger } from './real-meal-test-ledger.mjs';
import { runObservedMealTask } from './meal-latency-capture.mjs';
import { discoverMealImages, selectValidationMeals } from './batch-real-food-image.mjs';
import { FROZEN_CONFIG, RUN_ID, DIRECT_USER_TEXT, DIRECT_INSTRUCTIONS, GROUPS, makeSchedule, sha256, validateDirect, mergeTrialResults, createRevealMap, createBlindPackage, compareTrial, renderTrialMarkdown } from './meal-ab-core.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const outputDir = resolve(root, 'artifacts/meal-ab-20261018-10-v1');
const historicalLedgers = [resolve(root, 'artifacts/real-meal-request-ledger.sqlite'), resolve(root, 'artifacts/real-meal-request-ledger-batch-20261016.sqlite')];
const configPath = join(outputDir, 'config.json');
const manifestPath = join(outputDir, 'manifest.json');
const resultsPath = join(outputDir, 'results.json');
const progressPath = join(outputDir, 'progress.jsonl');
const consolePath = join(outputDir, 'console.log');
const ledgerPath = join(outputDir, 'requests.sqlite');
const safeName = (value) => String(value).replace(/[^A-Za-z0-9_-]/g, '_');
const mimeByExtension = (extension) => extension.toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
const now = () => new Date().toISOString();

async function exists(path) { try { await access(path); return true; } catch { return false; } }
async function json(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function writeJson(path, value, flag = 'w') { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag, mode: 0o600 }); }
async function logLine(line) { const text = `${now()} ${typeof line === 'string' ? line : JSON.stringify(line)}\n`; await appendFile(consolePath, text, { mode: 0o600 }); if (!process.env.MEAL_AB_QUIET) process.stdout.write(text); }
async function progress(event) { await appendFile(progressPath, `${JSON.stringify({ at: now(), ...event })}\n`, { mode: 0o600 }); }

async function preprocessPhotos(meals) {
  const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, args: ['--no-proxy-server'] });
  try {
    const page = await browser.newPage();
    const prepared = [];
    for (const meal of meals) {
      const original = await readFile(meal.imagePath);
      const source = `data:${mimeByExtension(extname(meal.imagePath))};base64,${original.toString('base64')}`;
      const transformed = await page.evaluate(async (input) => {
        const blob = await (await fetch(input)).blob(); const url = URL.createObjectURL(blob);
        try { const image = new Image(); image.src = url; await image.decode();
          const scale = Math.min(1, 1200 / image.naturalWidth); const width = Math.max(1, Math.round(image.naturalWidth * scale));
          const height = Math.max(1, Math.round(image.naturalHeight * scale)); const canvas = document.createElement('canvas');
          canvas.width = width; canvas.height = height; const context = canvas.getContext('2d', { alpha: false });
          context.drawImage(image, 0, 0, width, height); return { data: canvas.toDataURL('image/jpeg', 0.75), width, height };
        } finally { URL.revokeObjectURL(url); }
      }, source);
      const encoded = transformed.data.slice(transformed.data.indexOf(',') + 1); const bytes = Buffer.from(encoded, 'base64');
      const relative = join('photos', `${safeName(meal.mealId)}.jpg`); const target = join(outputDir, relative);
      await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
      prepared.push({ mealId: meal.mealId, sourcePath: meal.imagePath, original: { bytes: original.length, sha256: sha256(original) },
        prepared: { path: relative, bytes: bytes.length, sha256: sha256(bytes), width: transformed.width, height: transformed.height,
          mime: 'image/jpeg', method: 'web-canvas', widthLimit: 1200, quality: 0.75 } });
    }
    return prepared;
  } finally { await browser.close(); }
}

async function frozenManifest() {
  const observations = await json(join(outputDir, 'observations.json'));
  const protocol = await json(join(outputDir, 'evaluation-protocol.json'));
  const discovered = await discoverMealImages({ inputDir: 'C:/Users/14360/Desktop/options' });
  const meals = selectValidationMeals(discovered).map((meal) => ({ mealId: meal.mealId, imagePath: meal.imagePath }));
  const observationIds = new Set(observations.samples?.map((sample) => sample.mealId) ?? []);
  if (meals.length !== 10 || meals.some((meal) => !observationIds.has(meal.mealId))) throw new Error('Frozen observation list does not match the ten selected meals.');
  const prepared = await preprocessPhotos(meals);
  const schedule = makeSchedule(meals);
  const nutritionCatalog = await json(join(root, 'data/nutrition/usda-sr-legacy.json'));
  const categoryCatalog = await json(join(root, 'data/nutrition/category-ranges.json'));
  const projectPrompt = mealRecognitionInstructions('whole', nutritionCatalog.foods, Object.keys(categoryCatalog.categories));
  const source = { observations: { path: 'observations.json', sha256: sha256(await readFile(join(outputDir, 'observations.json'))), frozenAt: observations.frozenAt },
    evaluationProtocol: { path: 'evaluation-protocol.json', sha256: sha256(await readFile(join(outputDir, 'evaluation-protocol.json'))) } };
  const manifest = { schemaVersion: 'meal-ab-manifest.v1', runId: RUN_ID, createdAt: now(), source, config: FROZEN_CONFIG,
    meals: prepared, schedule, ledger: { path: 'requests.sqlite', relatedReadOnly: historicalLedgers.map((path) => `../${path.split(/[\\/]/).pop()}`), totalRequests: null }, protocol,
    prompt: { direct: DIRECT_USER_TEXT, directSha256: sha256(DIRECT_USER_TEXT), directInstructionsSha256: sha256(DIRECT_INSTRUCTIONS), projectContract: 'src/ai-provider.ts app meal contract', projectPromptSha256: sha256(projectPrompt) } };
  manifest.manifestSha256 = sha256(JSON.stringify(manifest));
  return manifest;
}

export async function runTask(task, manifest, ledger, provider, _existing, {
  outputDirectory = outputDir, providerRequest = requestProvider, progressCallback = progress, createCrops,
} = {}) {
  const meal = manifest.meals.find((row) => row.mealId === task.mealId);
  if (!meal) throw new Error('Unknown meal in the frozen manifest.');
  const image = await readFile(join(outputDirectory, meal.prepared.path));
  if (sha256(image) !== meal.prepared.sha256 || image.length !== meal.prepared.bytes) throw new Error('Frozen image bytes changed.');
  const photo = 'data:image/jpeg;base64,' + image.toString('base64');
  const options = {
    contract: task.group === 'direct' ? 'direct' : 'app',
      createCrops: async ({ componentIndices, regions }) => {
        const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, args: ['--no-proxy-server'] });
        try { const page = await browser.newPage(); const crops = await page.evaluate(async ({ source, regions: sourceRegions }) => {
            const image = new Image(); image.src = source; await image.decode(); const width = image.naturalWidth, height = image.naturalHeight;
            return sourceRegions.slice(0, 4).map((region) => { const marginX = Math.max(region.width * 0.18, 0.035), marginY = Math.max(region.height * 0.18, 0.035);
              const x = Math.max(0, region.x - marginX), y = Math.max(0, region.y - marginY), right = Math.min(1, region.x + region.width + marginX), bottom = Math.min(1, region.y + region.height + marginY);
              const sx = Math.floor(x * width), sy = Math.floor(y * height), sw = Math.max(1, Math.min(width - sx, Math.ceil((right - x) * width))), sh = Math.max(1, Math.min(height - sy, Math.ceil((bottom - y) * height)));
              const canvas = document.createElement('canvas'); const scale = Math.min(1, 900 / sw); canvas.width = Math.max(1, Math.round(sw * scale)); canvas.height = Math.max(1, Math.round(sh * scale));
              canvas.getContext('2d').drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height); return canvas.toDataURL('image/jpeg', 0.78); });
          }, { source: photo, regions }); return { photos: crops, photoRoles: crops.map((_value, index) => `before:crop:${componentIndices[index] + 1}`) }; }
        finally { await browser.close(); }
      },
  };
  if (createCrops) options.createCrops = createCrops;
  const record = await runObservedMealTask({ task, ledger, provider, photo, artifactDir: outputDirectory,
    requestProvider: providerRequest, providerOptions: options, progress: progressCallback });
  // Stage analysis/recognition come from the per-attempt observer, not the
  // ledger view (which intentionally stores only accounting/status fields).
  return record;
}

async function prepare() {
  await mkdir(outputDir, { recursive: true, mode: 0o700 }); await mkdir(join(outputDir, 'photos'), { recursive: true }); await mkdir(join(outputDir, 'requests'), { recursive: true }); await mkdir(join(outputDir, 'blind'), { recursive: true });
  if (await exists(manifestPath)) {
    const existing = await json(manifestPath);
    if (!existing.prompt?.projectPromptSha256 || !existing.prompt?.directInstructionsSha256) {
      const nutritionCatalog = await json(join(root, 'data/nutrition/usda-sr-legacy.json')); const categoryCatalog = await json(join(root, 'data/nutrition/category-ranges.json'));
      existing.prompt = { ...existing.prompt, directInstructionsSha256: sha256(DIRECT_INSTRUCTIONS), projectPromptSha256: sha256(mealRecognitionInstructions('whole', nutritionCatalog.foods, Object.keys(categoryCatalog.categories))) };
      existing.manifestSha256 = sha256(JSON.stringify({ ...existing, manifestSha256: undefined }));
      await writeJson(manifestPath, existing);
    }
    return existing;
  }
  const manifest = await frozenManifest(); await writeJson(configPath, { ...FROZEN_CONFIG, provider: { model: 'gpt-6.1-sol', reasoningEffort: 'max', baseUrl: 'redacted-at-runtime' } }, 'wx'); await writeJson(manifestPath, manifest, 'wx');
  return manifest;
}

export async function runTrial({ live = false, resume = false } = {}) {
  const manifest = await prepare();
  if (!live) return { mode: 'prepare', manifestPath, manifest };
  if (!(await exists(join(outputDir, 'observations.json')))) throw new Error('observations.json must exist before live requests.');
  const provider = await readLocalCodexProvider(); if (provider.baseUrl !== FROZEN_CONFIG.baseUrl || provider.model !== FROZEN_CONFIG.model || provider.reasoningEffort !== FROZEN_CONFIG.reasoningEffort) throw new Error('Local provider does not match frozen model configuration.');
  const { totalRequests: _uncappedTotal, ...perRunLimits } = FROZEN_CONFIG.ledgerLimits;
  const ledger = new RealMealTestLedger(ledgerPath, { relatedLedgerPaths: historicalLedgers, limits: FROZEN_CONFIG.ledgerLimits, runLimits: { [`${RUN_ID}-project`]: perRunLimits, [`${RUN_ID}-direct`]: { ...perRunLimits, perMealRequests: 1, reviewMeals: 0 } } });
  let results = await exists(resultsPath) ? await json(resultsPath) : { schemaVersion: 'meal-ab-results.v1', runId: RUN_ID, meals: [], requests: [] };
  const existing = new Map(results.meals.flatMap((meal) => GROUPS.map((group) => [`${meal.mealId}:${group}`, meal[group]])));
  const schedule = manifest.schedule;
  let ledgerTotals;
  try {
    for (const task of schedule) {
      const key = `${task.mealId}:${task.group}`; if (existing.get(key)?.status && existing.get(key).status !== 'not_attempted') continue;
      // A crash after reservation but before results.json must remain an
      // interrupted attempt. Resume never sends a stage already present in the
      // ledger, even when its per-meal JSON was not flushed.
      const priorAttempts = ledger.attemptsForRun(task.validationRunId, task.mealId);
      if (priorAttempts.length) {
        const interrupted = { mealId: task.mealId, group: task.group, validationRunId: task.validationRunId, status: 'interrupted', workflowCompleted: false,
          maxStages: task.maxStages, stages: await Promise.all(priorAttempts.map(async (attempt) => {
            const base = { attemptId: attempt.attemptId, stage: attempt.stage, status: attempt.status,
            providerCompleted: attempt.providerCompleted === true, accepted: attempt.resultAccepted === true, httpStatus: attempt.httpStatus,
            errorCode: attempt.errorCode, errorName: attempt.errorName, usage: attempt.usage, rawArtifact: attempt.rawResponseArtifact,
              elapsedMs: attempt.elapsedMs, timing: null, analysis: null, recognition: null };
            try { return { ...base, ...await json(join(outputDir, `requests/${safeName(attempt.attemptId)}-${attempt.stage}.json`)) }; }
            catch { return { ...base, fatalPersistenceError: attempt.status !== 'in_flight' ? 'required_stage_archive_missing' : null }; }
          })), returnedStage: null, returnedAttemptId: null, analysis: null, elapsedMs: null, fallbackReason: null,
          error: { code: 'resume_preserved_prior_attempt', message: 'A prior reservation existed before results were flushed; no retry was sent.' } };
        interrupted.fatalPersistenceError = interrupted.stages.find((stage) => stage.fatalPersistenceError || stage.captureStatus === 'save_failed')?.fatalPersistenceError
          ?? (interrupted.stages.some((stage) => stage.captureStatus === 'save_failed') ? 'raw_archive_write_failed' : null);
        existing.set(key, interrupted);
        const records = manifest.meals.flatMap(({ mealId }) => GROUPS.map((group) => existing.get(`${mealId}:${group}`)).filter(Boolean));
        results = mergeTrialResults(manifest, records, records.flatMap((record) => record.stages.map((stage) => ({ ...stage, group: record.group, mealId: record.mealId }))));
        await writeJson(resultsPath, results); await progress({ type: 'resume_preserved_attempt', sequence: task.sequence, group: task.group, mealId: task.mealId, attempts: priorAttempts.length });
        if (interrupted.fatalPersistenceError) throw new Error(`Further paid calls stopped: ${interrupted.fatalPersistenceError}.`);
        continue;
      }
      const record = await runTask(task, manifest, ledger, provider, existing); existing.set(key, record);
      const records = manifest.meals.flatMap(({ mealId }) => GROUPS.map((group) => existing.get(`${mealId}:${group}`)).filter(Boolean));
      results = mergeTrialResults(manifest, records, records.flatMap((record) => record.stages.map((stage) => ({ ...stage, group: record.group, mealId: record.mealId }))));
      await writeJson(resultsPath, results);
      if (record.fatalPersistenceError) throw new Error(`Further paid calls stopped: ${record.fatalPersistenceError}.`);
    }
  } finally { ledgerTotals = ledger.totals(); ledger.close(); }
  results.ledger = { totals: ledgerTotals, limits: { ...FROZEN_CONFIG.ledgerLimits, totalRequests: null }, historicalLedgers: historicalLedgers.map((path) => path.split(/[\\/]/).pop()) };
  await writeJson(resultsPath, results);
  if (manifest.schedule.every((task) => existing.get(`${task.mealId}:${task.group}`)?.status)) {
    const reveal = await exists(join(outputDir, 'reveal-map.json')) ? await json(join(outputDir, 'reveal-map.json')) : createRevealMap(manifest.meals, randomBytes(32).toString('hex'));
    if (!(await exists(join(outputDir, 'reveal-map.json')))) await writeJson(join(outputDir, 'reveal-map.json'), reveal, 'wx');
    const blindImages = join(outputDir, 'blind', 'images'); await mkdir(blindImages, { recursive: true, mode: 0o700 });
    for (const entry of reveal.entries) {
      const meal = manifest.meals.find((row) => row.mealId === entry.mealId);
      if (meal) await copyFile(join(outputDir, meal.prepared.path), join(blindImages, `${entry.sampleId}.jpg`)).catch(() => {});
    }
    await writeJson(join(outputDir, 'blind', 'final.json'), createBlindPackage(results, reveal), 'w');
    await writeJson(join(outputDir, 'blind', 'first-pass.json'), createBlindPackage(results, reveal, { firstPass: true }), 'w');
    const comparison = compareTrial(results, reveal, {}); await writeJson(join(outputDir, 'comparison-draft.json'), comparison); await writeFile(join(outputDir, 'comparison-draft.md'), renderTrialMarkdown(comparison), { mode: 0o600 });
  }
  return results;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2); const live = argv.includes('--live'); const resume = argv.includes('--resume');
  if (!live && !argv.includes('--prepare')) { console.error('Use --prepare for offline preparation or --live [--resume] for authorized requests.'); process.exitCode = 2; }
  else runTrial({ live, resume }).then((value) => logLine({ complete: true, mode: live ? 'live' : 'prepare', summary: value?.summary ?? { manifest: manifestPath } })).catch((error) => { logLine({ complete: false, error: String(error?.message ?? error) }); process.exitCode = 1; });
}
