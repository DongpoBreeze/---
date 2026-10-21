#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { access, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AiProviderError, requestProvider } from '../src/ai-provider.ts';
import { offlineInputs, offlineEvidence, verifyOfflineProvider, verifyOfflineEvidence } from './meal-experiment-inputs.mjs';
import { readLocalCodexProvider } from '../server/local-codex.mjs';
import { DIRECT_INSTRUCTIONS, DIRECT_USER_TEXT, normalizeAnalysis, validateDirect } from './meal-ab-core.mjs';
import { RealMealTestLedger } from './real-meal-test-ledger.mjs';
import { sha256, taskAccepted, validRunId } from './meal-latency-core.mjs';
import { assertArtifactsHaveNoSecret, redactValue, runObservedMealTask } from './meal-latency-capture.mjs';
import { DEFAULT_SOURCE_PATHS, PROJECT_ROOT, durableWrite, recoverTask, validateFrozenRequest } from './meal-latency-trial.mjs';
import { supplierEcho } from './meal-multidish-speed-trial.mjs';

export const HIGH_NUTRITION_CONFIG = Object.freeze({ model: 'gpt-6.1-sol', reasoningEffort: 'high', protocol: 'responses',
  stream: true, imageDetail: 'low', maxOutputTokens: 8192, timeoutMs: 90000, maxStages: 1, retries: 0,
  maxLocalRequests: 3, review: false, fallback: false, estimatePhotoWeight: false, estimateMealTotals: false });
export const HIGH_NUTRITION_INPUTS = Object.freeze([
  { mealId: 'breakfast_01_67f8ed1f000000001e003951', label: '三明治', bytes: 151695,
    sha256: '63135201c3769384fb7f7f9c291b53f8a1fac2c4870fe28617288b4fc9289777', attemptId: 1, status: 'accepted', elapsedMs: 43226, firstTextMs: 30081 },
  { mealId: 'breakfast_04_6a2a52dc000000000702de33', label: '玉米', bytes: 7166,
    sha256: '5fb07ee8b76a71fb1d4cf3badd638afe60b170af6f7ee17a4117e44e1e977c67', attemptId: 4, status: 'accepted', elapsedMs: 35241, firstTextMs: 23949 },
  { mealId: 'dinner_01_68aff31e000000001d015c77', label: '多菜晚餐', bytes: 236603,
    sha256: 'e557b5e9d32ff7f8b645949bd1394d1e0b4b776a093dc0d70300570fe36bef4f', attemptId: 5, status: 'timeout', elapsedMs: 90027, firstTextMs: 49230 },
]);
const SOURCE_RUN_ID = '20261018-high-xhigh-v1';
const CONCISE_SHA = '87334343fbbb083730bc1e21e3cbbb9b5e1e40d00470bb18642148dee0b2a888';
const profiles = { 'direct-high': { promptProfile: 'direct', reasoningEffort: 'high' } };
const sourcePaths = [...DEFAULT_SOURCE_PATHS, 'scripts/meal-multidish-speed-trial.mjs', 'scripts/meal-high-nutrition-comparison.mjs'];
const now = () => new Date().toISOString();
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const exists = async (path) => { try { await access(path); return true; } catch { return false; } };
const codeOf = (error) => /^[A-Za-z0-9_.:-]{1,100}$/.test(error?.code ?? '') ? error.code : 'comparison_failed';
function options(input = {}) {
  const runId = validRunId(input.runId ?? '20261018-high-v1');
  return { ...input, runId, projectRoot: resolve(input.projectRoot ?? PROJECT_ROOT),
    outputDir: resolve(input.outputDir ?? join(PROJECT_ROOT, 'artifacts', `meal-high-nutrition-${runId}`)),
    sourceOutputDir: resolve(input.sourceOutputDir ?? join(PROJECT_ROOT, 'artifacts', `meal-effort-speed-${SOURCE_RUN_ID}`)) };
}
function within(directory, path) {
  const target = resolve(directory, path), rel = relative(resolve(directory), target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Artifact path escapes its directory.');
  return target;
}
async function writeJson(path, value, { key = '', exclusive = false } = {}) {
  const text = `${JSON.stringify(redactValue(value, key), null, 2)}\n`;
  if (exclusive) return durableWrite(path, text, { flag: 'wx' });
  const temporary = `${path}.${randomBytes(5).toString('hex')}.tmp`;
  await durableWrite(temporary, text, { flag: 'wx' }); await rename(temporary, path);
}
export function highNutritionSchedule(runId, inputs = HIGH_NUTRITION_INPUTS) {
  validRunId(runId);
  return inputs.map(({ mealId }, index) => ({ taskId: `direct-high:${mealId}`, sequence: index + 1,
    mealId, group: 'direct', profile: 'direct-high', phase: 'nutrition', validationRunId: `${runId}-direct-high`,
    maxStages: 1, timeoutMs: 90000 }));
}
export function highNutritionLedgerOptions(runId) {
  return { allowProviderOverride: true, limits: { totalRequests: 3, perMealRequests: 1, reviewMeals: 0, cohortMeals: 3 },
    runLimits: { [`${validRunId(runId)}-direct-high`]: { perMealRequests: 1, reviewMeals: 0, cohortMeals: 3 } } };
}

/** Verify historical artifacts and ledger read-only; their original source fingerprints are never rewritten. */
async function historicalInputs(opts) {
  const fixture = offlineInputs(opts), expectedInputs = fixture?.highInputs ?? HIGH_NUTRITION_INPUTS;
  const sourceRunId = fixture?.effortRunId ?? SOURCE_RUN_ID, conciseSha = fixture?.conciseSha ?? CONCISE_SHA;
  const manifestBytes = await readFile(join(opts.sourceOutputDir, 'manifest.json')), manifest = JSON.parse(manifestBytes);
  verifyOfflineEvidence(opts, manifest);
  const { manifestSha256, ...body } = manifest;
  if (manifest.runId !== sourceRunId || sha256(JSON.stringify(body)) !== manifestSha256
    || !same(manifest.config, { model: 'gpt-6.1-sol', protocol: 'responses', stream: true, imageDetail: 'low',
      maxOutputTokens: 8192, timeoutMs: 90000, maxStages: 1, retries: 0, maxLocalRequests: 6 })
    || !same(manifest.profiles.high, { promptProfile: 'concise', reasoningEffort: 'high' })) throw new Error('Historical high manifest changed.');
  const promptsBytes = await readFile(within(opts.sourceOutputDir, manifest.prompts.path)), concise = JSON.parse(promptsBytes).concise;
  if (sha256(promptsBytes) !== manifest.prompts.sha256 || sha256(concise.instructions) !== conciseSha
    || concise.instructionsSha256 !== conciseSha || sha256(concise.userText) !== concise.userTextSha256) throw new Error('Historical concise prompt changed.');
  for (const path of ['data/nutrition/usda-sr-legacy.json', 'data/nutrition/category-ranges.json']) {
    const historicalSha = manifest.sourceFingerprints.find((row) => row.path === path)?.sha256;
    if (!historicalSha || sha256(await readFile(join(opts.projectRoot, path))) !== historicalSha) throw new Error('Historical nutrition data changed.');
  }
  const resultsBytes = await readFile(join(opts.sourceOutputDir, 'results.json')), result = JSON.parse(resultsBytes);
  if (result.runId !== sourceRunId || result.manifestSha256 !== manifestSha256
    || result.tasks.filter((row) => row.profile === 'high').length !== 3) throw new Error('Historical results differ from the selected high run.');
  const db = new DatabaseSync(join(opts.sourceOutputDir, 'requests.sqlite'), { readOnly: true });
  const meals = [], photos = [], tasks = [], files = [], reuse = [];
  try {
    for (const expected of expectedInputs) {
      const meal = manifest.meals.find((row) => row.mealId === expected.mealId);
      if (meal?.label !== expected.label || meal.prepared.path !== `photos/${expected.mealId}.jpg`
        || meal.prepared.bytes !== expected.bytes || meal.prepared.sha256 !== expected.sha256) throw new Error('Historical JPEG metadata changed.');
      const photo = await readFile(within(opts.sourceOutputDir, meal.prepared.path));
      if (photo.length !== expected.bytes || sha256(photo) !== expected.sha256) throw new Error('Historical JPEG bytes changed.');
      const record = result.tasks.find((row) => row.profile === 'high' && row.mealId === expected.mealId), stage = record?.stages?.[0];
      if (record?.status !== expected.status || record.elapsedMs !== expected.elapsedMs || record.timing?.firstTextMs !== expected.firstTextMs
        || record.maxStages !== 1 || record.stages.length !== 1 || stage.stage !== 'whole' || stage.attemptId !== expected.attemptId
        || stage.rawArtifact !== `requests/${expected.attemptId}-whole.sse` || stage.stageArtifact !== `requests/${expected.attemptId}-whole.json`
        || record.fatalPersistenceError || stage.fatalPersistenceError) throw new Error('Historical high record changed.');
      const savedBytes = await readFile(within(opts.sourceOutputDir, stage.stageArtifact));
      const rawBytes = await readFile(within(opts.sourceOutputDir, stage.rawArtifact));
      if (!same(JSON.parse(savedBytes), stage) || rawBytes.length !== stage.capture.archivedBytes
        || sha256(rawBytes) !== stage.capture.artifactSha256 || !['saved', 'truncated', 'empty'].includes(stage.captureStatus)) throw new Error('Historical raw/stage integrity failed.');
      const ledger = db.prepare('SELECT * FROM attempts WHERE id=?').get(expected.attemptId);
      const accepted = expected.status === 'accepted';
      if (!ledger || ledger.validation_run_id !== record.validationRunId || ledger.meal_id !== expected.mealId || ledger.stage !== 'whole'
        || ledger.model !== 'gpt-6.1-sol' || ledger.reasoning_effort !== 'high' || ledger.raw_artifact !== stage.rawArtifact
        || Boolean(ledger.provider_completed) !== stage.transportCompleted || Boolean(ledger.result_accepted) !== stage.businessAccepted
        || taskAccepted(record) !== accepted || ledger.outcome !== expected.status
        || (!accepted && (record.analysis !== null || record.recognition !== null))) throw new Error('Historical ledger/result integrity failed.');
      meals.push(meal); photos.push({ path: meal.prepared.path, bytes: photo }); tasks.push(record);
      const rawPath = `reused-project/${stage.rawArtifact}`, stagePath = `reused-project/${stage.stageArtifact}`;
      files.push({ path: rawPath, bytes: rawBytes }, { path: stagePath, bytes: savedBytes });
      reuse.push({ mealId: expected.mealId, taskId: record.taskId, attemptId: stage.attemptId,
        sourceRawArtifact: stage.rawArtifact, sourceStageArtifact: stage.stageArtifact,
        rawArtifact: rawPath, rawSha256: sha256(rawBytes), rawBytes: rawBytes.length,
        stageArtifact: stagePath, stageSha256: sha256(savedBytes), stageBytes: savedBytes.length,
        ledgerRowSha256: sha256(JSON.stringify(ledger)), supplierEcho: supplierEcho(rawBytes) });
    }
  } finally { db.close(); }
  const snapshot = { schemaVersion: 'meal-high-nutrition-reused-project.v1', sourceRunId, ...offlineEvidence(opts), tasks };
  return { meals, photos, files, snapshot, prompts: { projectConcise: concise, direct: { instructions: DIRECT_INSTRUCTIONS,
    instructionsSha256: sha256(DIRECT_INSTRUCTIONS), userText: DIRECT_USER_TEXT, userTextSha256: sha256(DIRECT_USER_TEXT) } },
    provenance: { sourceRunId, ...offlineEvidence(opts), manifestSha256, manifestFileSha256: sha256(manifestBytes), resultsFileSha256: sha256(resultsBytes),
      promptsFileSha256: sha256(promptsBytes), historicalProviderSourceSha256: manifest.sourceFingerprints.find((row) => row.path === 'src/ai-provider.ts')?.sha256,
      selection: 'exactly the three high whole-image first-pass records; the original 90-second dinner timeout remains unavailable',
      verification: 'historical manifest self-hash, frozen JPEG/prompt/result/raw/stage hashes and read-only ledger rows; historical source fingerprints preserved', entries: reuse } };
}

export async function prepareHighNutritionComparison(input = {}) {
  const opts = options(input), { outputDir, runId } = opts;
  if (await exists(join(outputDir, 'manifest.json'))) return { outputDir, manifest: await verifyHighNutritionFreeze(opts) };
  const historical = await historicalInputs(opts), provider = await (opts.providerReader ?? readLocalCodexProvider)();
  verifyOfflineProvider(opts, provider);
  const fingerprints = await Promise.all(sourcePaths.map(async (path) => ({ path, sha256: sha256(await readFile(join(opts.projectRoot, path))) })));
  await mkdir(resolve(outputDir, '..'), { recursive: true }); await mkdir(outputDir, { mode: 0o700 });
  for (const path of ['photos', 'requests', 'reused-project/requests']) await mkdir(join(outputDir, path), { recursive: true });
  for (const file of [...historical.photos, ...historical.files]) await durableWrite(within(outputDir, file.path), file.bytes, { flag: 'wx' });
  const promptText = `${JSON.stringify(historical.prompts, null, 2)}\n`, reusedText = `${JSON.stringify(historical.snapshot, null, 2)}\n`;
  const manifest = { schemaVersion: 'meal-high-nutrition-manifest.v1', runId, createdAt: now(), config: HIGH_NUTRITION_CONFIG, profiles, ...offlineEvidence(opts),
    meals: historical.meals, schedule: highNutritionSchedule(runId, historical.meals), prompts: { path: 'prompts.json', sha256: sha256(promptText) },
    reusedProject: { path: 'reused-project.json', sha256: sha256(reusedText) }, reuseProvenance: historical.provenance, sourceFingerprints: fingerprints,
    provider: { baseUrl: provider.baseUrl, selectedModel: 'gpt-6.1-sol', selectedReasoningEffort: 'high', credentials: 'runtime only; never stored' },
    budget: { cap: 3, scope: 'this experiment requests.sqlite only', perMeal: 1, historicalLedgersUsed: false, reservationBeforeSend: true },
    comparisonScope: 'historical project concise/schema high first pass vs three new direct high requests; not full adaptive analysis or simultaneous/interleaved control',
    nonGoals: ['photo weights or portions', 'meal totals', 'quality winner or accuracy inferred from interval width', 'metadata capability requests', 'retries or reviews'] };
  manifest.manifestSha256 = sha256(JSON.stringify(manifest));
  await durableWrite(join(outputDir, 'prompts.json'), promptText, { flag: 'wx' });
  await durableWrite(join(outputDir, 'reused-project.json'), reusedText, { flag: 'wx' });
  await writeJson(join(outputDir, 'manifest.json'), manifest, { key: provider.key, exclusive: true });
  const ledger = new RealMealTestLedger(join(outputDir, 'requests.sqlite'), highNutritionLedgerOptions(runId)); ledger.close();
  await writeJson(join(outputDir, 'results.json'), { schemaVersion: 'meal-high-nutrition-results.v1', runId,
    ...offlineEvidence(opts),
    manifestSha256: manifest.manifestSha256, updatedAt: now(), tasks: [] }, { exclusive: true });
  await assertArtifactsHaveNoSecret(outputDir, provider.key); await reportHighNutritionComparison(opts);
  return { outputDir, manifest };
}

export async function verifyHighNutritionFreeze(input = {}) {
  const opts = options(input), manifest = await json(join(opts.outputDir, 'manifest.json')), { manifestSha256, ...body } = manifest;
  verifyOfflineEvidence(opts, manifest);
  if (manifest.schemaVersion !== 'meal-high-nutrition-manifest.v1' || manifest.runId !== opts.runId || sha256(JSON.stringify(body)) !== manifestSha256
    || !same(manifest.config, HIGH_NUTRITION_CONFIG) || !same(manifest.profiles, profiles) || !same(manifest.schedule, highNutritionSchedule(opts.runId, offlineInputs(opts)?.highInputs ?? HIGH_NUTRITION_INPUTS))
    || !same(manifest.sourceFingerprints.map((row) => row.path), sourcePaths)) throw new Error('Frozen high nutrition comparison changed.');
  for (const row of manifest.sourceFingerprints) if (sha256(await readFile(join(opts.projectRoot, row.path))) !== row.sha256) throw new Error(`Frozen source changed: ${row.path}.`);
  const historical = await historicalInputs(opts);
  if (!same(manifest.meals, historical.meals) || !same(manifest.reuseProvenance, historical.provenance)) throw new Error('Frozen historical provenance changed.');
  const promptsBytes = await readFile(within(opts.outputDir, manifest.prompts.path)), reusedBytes = await readFile(within(opts.outputDir, manifest.reusedProject.path));
  if (sha256(promptsBytes) !== manifest.prompts.sha256 || !same(JSON.parse(promptsBytes), historical.prompts)
    || sha256(reusedBytes) !== manifest.reusedProject.sha256 || !same(JSON.parse(reusedBytes), historical.snapshot)) throw new Error('Frozen prompts or reused project records changed.');
  for (const file of [...historical.photos, ...historical.files]) if (!Buffer.from(await readFile(within(opts.outputDir, file.path))).equals(file.bytes)) throw new Error('Frozen photo or historical archive changed.');
  return manifest;
}

async function acquireLock(outputDir, resume) {
  const path = join(outputDir, 'execution.lock'); let handle;
  try { handle = await open(path, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST' || !resume) throw new Error('Execution lock exists; resume only after the prior process stops.');
    const saved = await json(path); let active = false;
    if (Number.isSafeInteger(saved.pid)) try { process.kill(saved.pid, 0); active = true; } catch (check) { if (check.code === 'EPERM') active = true; }
    if (active) throw new Error('The prior comparison process is still active.');
    await unlink(path); handle = await open(path, 'wx', 0o600);
  }
  await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: now() })); await handle.sync();
  return async (keep) => { await handle.close(); if (!keep) await unlink(path); };
}

function verifyLedgerMembership(manifest, attempts) {
  if (attempts.length > 3) throw new Error('Independent three-request cap exceeded.');
  for (const attempt of attempts) if (!manifest.schedule.some((task) => task.validationRunId === attempt.validationRunId
    && task.mealId === attempt.mealId && attempt.stage === 'whole' && attempt.model === 'gpt-6.1-sol'
    && attempt.reasoningEffort === 'high')) throw new Error('Unexpected ledger reservation.');
}
async function verifySavedTask(task, saved, prior, outputDir) {
  const recovered = await recoverTask(task, prior, outputDir);
  if (recovered.fatalPersistenceError) throw Object.assign(new Error('Required raw/stage archive or ledger integrity failed.'), { code: recovered.fatalPersistenceError });
  if (saved && (!same(saved.stages, recovered.stages) || saved.transportCompleted !== recovered.transportCompleted
    || saved.businessAccepted !== recovered.businessAccepted || (saved.businessAccepted
      && (!same(saved.analysis, recovered.analysis) || !same(saved.recognition, recovered.recognition))))) throw new Error('Saved result and archived stage disagree.');
  if (taskAccepted(saved ?? recovered)) validateDirect((saved ?? recovered).analysis);
  return saved ?? recovered;
}

export async function runHighNutritionComparison(input = {}) {
  const opts = options(input), { outputDir, runId } = opts;
  if (!opts.live) throw new Error('Real comparison requires --live.');
  const manifest = await verifyHighNutritionFreeze(opts), providerConfig = await (opts.providerReader ?? readLocalCodexProvider)();
  verifyOfflineProvider(opts, providerConfig, true);
  if (manifest.provider.baseUrl !== providerConfig.baseUrl) throw new Error('Provider address changed after preparation.');
  if (await exists(join(outputDir, 'fatal-stop.json'))) throw new Error('A prior persistence or guard failure blocks further requests.');
  await assertArtifactsHaveNoSecret(outputDir, providerConfig.key);
  const release = await acquireLock(outputDir, opts.resume); let ledger, keepLock = false;
  const key = providerConfig.key;
  const stop = async (code) => { keepLock = true; await writeJson(join(outputDir, 'fatal-stop.json'), { code, at: now() }, { key }); };
  try {
    ledger = (opts.ledgerFactory ?? ((path, settings) => new RealMealTestLedger(path, settings)))(join(outputDir, 'requests.sqlite'), highNutritionLedgerOptions(runId));
    const results = await json(join(outputDir, 'results.json')), prompts = await json(join(outputDir, 'prompts.json')), attempts = ledger.attempts();
    if (results.runId !== runId || results.manifestSha256 !== manifest.manifestSha256 || !Array.isArray(results.tasks)
      || results.fatalPersistenceError || results.tasks.some((row) => row.fatalPersistenceError)
      || new Set(results.tasks.map((row) => row.taskId)).size !== results.tasks.length
      || results.tasks.some((row) => !manifest.schedule.some((task) => task.taskId === row.taskId))) throw new Error('Results identity or persistence state is invalid.');
    if (attempts.length && !opts.resume) throw Object.assign(new Error('Prior reservations exist; use --resume without resending.'), { code: 'resume_required' });
    verifyLedgerMembership(manifest, attempts);
    const persist = async () => {
      results.updatedAt = now();
      try { await (opts.resultsWrite ?? writeJson)(join(outputDir, 'results.json'), results, { key }); }
      catch { await stop('results_persistence_failed'); throw new Error('Results persistence failed; further requests stopped.'); }
    };
    for (const task of manifest.schedule) {
      const prior = attempts.filter((row) => row.validationRunId === task.validationRunId && row.mealId === task.mealId);
      const saved = results.tasks.find((row) => row.taskId === task.taskId);
      if (saved && saved.status !== 'not_attempted' && !prior.length) throw new Error('Saved result has no durable reservation.');
      if (!prior.length) continue;
      const recovered = await verifySavedTask(task, saved, prior, outputDir);
      if (!saved) results.tasks.push(recovered);
    }
    await persist();
    const progress = async (event) => {
      const handle = await open(join(outputDir, 'progress.jsonl'), 'a', 0o600);
      try { await handle.writeFile(`${JSON.stringify(redactValue({ at: now(), ...event }, key))}\n`); await handle.sync(); } finally { await handle.close(); }
    };
    for (const task of manifest.schedule.filter((row) => !results.tasks.some((saved) => saved.taskId === row.taskId && saved.status !== 'not_attempted'))) {
      const meal = manifest.meals.find((row) => row.mealId === task.mealId), bytes = await readFile(within(outputDir, meal.prepared.path));
      const provider = { ...providerConfig, model: 'gpt-6.1-sol', reasoningEffort: 'high' };
      let sent = 0, guardFatal = null, outbound = null;
      const guardedRequest = async (...args) => {
        if (args[4]?.timeoutMs !== 90000 || args[4]?.maxStages !== 1 || args[4]?.contract !== 'direct') {
          guardFatal = 'direct_options_mismatch'; throw new Error('Direct high stage options changed.');
        }
        const originalFetch = globalThis.fetch, onDiagnostic = args[4].onDiagnostic; let invalidContract = false;
        args[4] = { ...args[4], onDiagnostic: (event) => {
          if (event.type === 'stage_result') {
            try { validateDirect(event.analysis); }
            catch { invalidContract = true; onDiagnostic({ ...event, type: 'stage_error', code: 'invalid_response' }); return; }
          }
          if (event.type === 'returned' && invalidContract) return;
          onDiagnostic(event);
        } };
        globalThis.fetch = async (url, init) => {
          try { validateFrozenRequest({ url, init, provider, manifest, task, prompts, imageBytes: bytes,
            reservedAttempts: ledger.attemptsForRun(task.validationRunId, task.mealId), sentCount: sent }); }
          catch (error) { guardFatal = 'outbound_guard_failed'; throw error; }
          outbound = { model: provider.model, reasoningEffort: provider.reasoningEffort, timeoutMs: 90000,
            requestSha256: sha256(init.body), imageSha256: sha256(bytes), instructionsSha256: sha256(DIRECT_INSTRUCTIONS), sent: false };
          try { await progress({ type: 'request_dispatch_ready', taskId: task.taskId, ...outbound }); }
          catch (error) { guardFatal = 'dispatch_audit_persistence_failed'; throw error; }
          sent += 1; outbound.sent = true; return originalFetch(url, init);
        };
        try {
          const result = await (opts.requestProvider ?? requestProvider)(...args);
          if (invalidContract) throw new AiProviderError('invalid_response', '直接结果未通过冻结业务契约。');
          return result;
        } finally { globalThis.fetch = originalFetch; }
      };
      const record = await runObservedMealTask({ task, ledger, provider, photo: `data:image/jpeg;base64,${bytes.toString('base64')}`,
        artifactDir: outputDir, requestProvider: guardedRequest, providerOptions: { contract: 'direct', timeoutMs: 90000 },
        write: opts.artifactWrite ?? durableWrite, progress, clock: opts.clock ?? Date.now });
      record.outbound = outbound; record.fatalPersistenceError ??= guardFatal;
      if (record.businessAccepted && sent !== 1) record.fatalPersistenceError ??= 'missing_guarded_dispatch';
      if (record.stages[0]?.rawArtifact) record.supplierEcho = supplierEcho(await readFile(within(outputDir, record.stages[0].rawArtifact)));
      results.tasks = [...results.tasks.filter((row) => row.taskId !== task.taskId), record];
      if (record.fatalPersistenceError) results.fatalPersistenceError = record.fatalPersistenceError;
      await persist(); await assertArtifactsHaveNoSecret(outputDir, key);
      if (record.fatalPersistenceError) { await stop(record.fatalPersistenceError); throw new Error('Further requests stopped after persistence or guard failure.'); }
    }
    await verifyHighNutritionArtifacts(opts);
    const report = await reportHighNutritionComparison(opts); await assertArtifactsHaveNoSecret(outputDir, key); return report;
  } catch (error) {
    if (codeOf(error) === 'resume_required') throw error;
    keepLock = true; if (!(await exists(join(outputDir, 'fatal-stop.json')))) try { await stop(codeOf(error)); } catch {}
    throw error;
  } finally { ledger?.close(); await release(keepLock); }
}

export async function verifyHighNutritionArtifacts(input = {}) {
  const opts = options(input), manifest = await verifyHighNutritionFreeze(opts), results = await json(join(opts.outputDir, 'results.json'));
  if (results.schemaVersion !== 'meal-high-nutrition-results.v1' || results.runId !== opts.runId || results.manifestSha256 !== manifest.manifestSha256
    || results.fatalPersistenceError || !Array.isArray(results.tasks)
    || new Set(results.tasks.map((row) => row.taskId)).size !== results.tasks.length
    || results.tasks.some((row) => !manifest.schedule.some((task) => task.taskId === row.taskId))) throw new Error('Results identity or persistence state is invalid.');
  const db = new DatabaseSync(join(opts.outputDir, 'requests.sqlite'), { readOnly: true }); let rows;
  try { rows = db.prepare('SELECT * FROM attempts ORDER BY id').all(); } finally { db.close(); }
  const attempts = rows.map((row) => ({ attemptId: row.id, mealId: row.meal_id, validationRunId: row.validation_run_id, stage: row.stage,
    model: row.model, reasoningEffort: row.reasoning_effort, status: row.outcome ?? 'in_flight', elapsedMs: row.elapsed_ms,
    providerCompleted: row.provider_completed === 1, resultAccepted: row.result_accepted === 1,
    rawResponseArtifact: row.raw_artifact, httpStatus: row.http_status, usage: row.usage_json ? JSON.parse(row.usage_json) : null, errorCode: row.error_code }));
  verifyLedgerMembership(manifest, attempts);
  for (const task of manifest.schedule) {
    const prior = attempts.filter((row) => row.validationRunId === task.validationRunId && row.mealId === task.mealId);
    const saved = results.tasks.find((row) => row.taskId === task.taskId);
    if (!prior.length) { if (saved && saved.status !== 'not_attempted') throw new Error('Result has no reservation.'); continue; }
    await verifySavedTask(task, saved, prior, opts.outputDir);
  }
  return { verified: true, runId: opts.runId, reservedRequests: attempts.length,
    recordedDispatches: results.tasks.filter((row) => row.outbound?.sent === true).length,
    validDirectMeals: results.tasks.filter(taskAccepted).length, historicalHighRecords: 3, dinnerProjectStatus: 'timeout' };
}

const textList = (value) => Array.isArray(value) ? value.filter((row) => typeof row === 'string') : [];
function presentation(record, archive = null) {
  const accepted = taskAccepted(record), stage = record?.stages?.[0];
  const normalized = accepted ? normalizeAnalysis(record.analysis, record.recognition) : normalizeAnalysis(null);
  return { status: record?.status ?? 'not_attempted', transportCompleted: record?.transportCompleted === true,
    businessAccepted: accepted, elapsedMs: record?.elapsedMs ?? null, timing: record?.timing ?? null,
    errorCode: record?.error?.code ?? stage?.errorCode ?? null, httpStatus: stage?.httpStatus ?? null,
    usage: stage?.usage ?? null, supplierEcho: record?.supplierEcho ?? archive?.supplierEcho ?? supplierEcho(''),
    rawArtifact: archive?.rawArtifact ?? stage?.rawArtifact ?? null, stageArtifact: archive?.stageArtifact ?? stage?.stageArtifact ?? null,
    rawSha256: archive?.rawSha256 ?? stage?.capture?.artifactSha256 ?? null, captureStatus: stage?.captureStatus ?? 'not_started',
    archiveElapsedMs: record?.archiveElapsedMs ?? null, ...normalized,
    globalAssumptions: accepted ? [...new Set([...textList(record.analysis?.assumptions), ...textList(record.recognition?.assumptions)])] : [],
    uncertainty: accepted ? [...new Set([...normalized.uncertainty, ...textList(record.analysis?.unresolved), ...textList(record.recognition?.unresolved)])] : normalized.uncertainty };
}
export function buildHighNutritionComparison(manifest, results, reused, ledger = {}) {
  const meals = manifest.meals.map((meal) => ({ mealId: meal.mealId, label: meal.label, photo: meal.prepared.path,
    imageSha256: meal.prepared.sha256, imageBytes: meal.prepared.bytes,
    project: presentation(reused.tasks.find((row) => row.mealId === meal.mealId), manifest.reuseProvenance.entries.find((row) => row.mealId === meal.mealId)),
    direct: presentation(results.tasks.find((row) => row.mealId === meal.mealId)) }));
  const summary = Object.fromEntries(['project', 'direct'].map((arm) => {
    const values = meals.map((meal) => meal[arm]), components = values.flatMap((row) => row.components);
    return [arm, { denominator: 3, completeAndValid: values.filter((row) => row.businessAccepted).length,
      completedTransports: values.filter((row) => row.transportCompleted).length, returnedComponents: components.length,
      componentsWithPer100g: components.filter((row) => row.per100g !== null).length }];
  }));
  return { schemaVersion: 'meal-high-nutrition-comparison.v1', runId: manifest.runId, generatedAt: now(), config: HIGH_NUTRITION_CONFIG,
    ...(manifest.evidence ? { evidence: manifest.evidence } : {}),
    comparisonScope: manifest.comparisonScope, sourceProjectRunId: manifest.reuseProvenance.sourceRunId, ledger, summary, meals,
    limitations: ['项目组仅复用历史 concise/schema high 首轮，直接组是本轮三次新请求；不是完整自适应分析，也不是同期交错实验。',
      '两组使用同一冻结 JPEG 和 high、90 秒单阶段设置，但提示词及业务输出结构不同；源码版本差异按各自指纹保留。',
      '晚餐项目组原始 90 秒超时保持不可用；部分正文和后来的 180 秒成功记录均不补入营养表。',
      '所有数值都是可食用成品每 100g 的模型参考范围；不估照片重量、份量、整餐总量。玉米参考排除玉米芯。',
      '无称重、实测营养真值或人工盲评；范围较窄、组件较多、返回较快均不能单独证明更准确或更优。',
      '只展示各组全部返回组件，不强制配对不同菜名。失败或未知值保持 null/不可用，不补零。',
      '回显仅来自已归档响应元数据；缺失不以请求参数补齐，无法独立验证供应商内部模型与推理强度。',
      'usage 仅记录供应商报告值，含 reasoning/cache；缺失不估算。本轮没有额外能力发现请求。'] };
}
const seconds = (value) => Number.isFinite(value) ? `${(value / 1000).toFixed(3)} 秒` : '不可用';
const range = (value) => value ? `${value.min}–${value.max}` : '不可用';
const md = (value) => String(value ?? '不可用').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('|', '\\|').replaceAll('\n', ' ');
const html = (value) => String(value ?? '不可用').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const armLabel = { project: '项目 high 首轮（历史复用）', direct: '直接 high（本轮新请求）' };
const statusLabel = (row) => row.businessAccepted ? '完整且有效' : row.status === 'timeout' ? '90 秒超时／营养不可用' : row.status === 'not_attempted' ? '尚未请求' : `${row.status}／营养不可用`;
export function renderHighNutritionMarkdown(report) {
  const lines = [`# high 每 100g 营养对照：${report.runId}`, '',
    ...(report.evidence ? ['离线合成 fixture；仅验证代码，不是真实实验或营养质量证据。', ''] : []),
    '项目组：历史 concise/schema high 首轮；直接组：本轮同图 high 单阶段。两组均为 gpt-6.1-sol、Responses streaming、detail low、8192 输出 tokens、90 秒。', '',
    `本轮独立预留 ${report.ledger.reservedRequests ?? 0}/3 次，记录实际 POST ${report.ledger.recordedDispatches ?? 0}/3 次；项目完整有效 ${report.summary.project.completeAndValid}/3，直接完整有效 ${report.summary.direct.completeAndValid}/3。`, '',
    '以下均为可食用成品每 100g；热量单位 kcal，蛋白质／碳水／脂肪单位 g。未知与失败显示不可用，不是 0。', '',
    '| 图片 | 项目状态 / 主耗时 / 首正文 | 直接状态 / 主耗时 / 首正文 |', '|---|---|---|'];
  for (const meal of report.meals) lines.push(`| ${md(meal.label)} | ${md(statusLabel(meal.project))} / ${seconds(meal.project.elapsedMs)} / ${seconds(meal.project.timing?.firstTextMs)} | ${md(statusLabel(meal.direct))} / ${seconds(meal.direct.elapsedMs)} / ${seconds(meal.direct.timing?.firstTextMs)} |`);
  for (const meal of report.meals) {
    lines.push('', `## ${md(meal.label)}`, '', `![${md(meal.label)}](${meal.photo})`, '',
      '| 组别 | 成品菜 | 热量 kcal | 蛋白质 g | 碳水 g | 脂肪 g |', '|---|---|---:|---:|---:|---:|');
    for (const arm of ['project', 'direct']) {
      const row = meal[arm];
      if (!row.available) lines.push(`| ${armLabel[arm]} | 不可用（${md(row.status)}） | 不可用 | 不可用 | 不可用 | 不可用 |`);
      for (const c of row.components) lines.push(`| ${armLabel[arm]} | ${md(c.label)} | ${range(c.per100g?.calories)} | ${range(c.per100g?.protein)} | ${range(c.per100g?.carbs)} | ${range(c.per100g?.fat)} |`);
    }
    for (const arm of ['project', 'direct']) {
      const row = meal[arm]; lines.push('', `### ${armLabel[arm]}`, '', `状态：${md(statusLabel(row))}；传输完成=${row.transportCompleted}；业务有效=${row.businessAccepted}；主耗时 ${seconds(row.elapsedMs)}；首正文 ${seconds(row.timing?.firstTextMs)}。`, '');
      row.components.forEach((c, index) => {
        lines.push(`**${index + 1}. ${md(c.label)}**`, '', `配方依据：${md(c.recipeBasis)}`, '',
          `可见依据：${c.evidence.length ? c.evidence.map(md).join('；') : '未提供'}`, '',
          `假设：${c.assumptions.length ? c.assumptions.map(md).join('；') : '未提供'}`, '',
          `不确定性：${c.uncertainty.length ? c.uncertainty.map(md).join('；') : '未提供'}`, '');
      });
      if (row.uncertainty.length) lines.push(`整图未决项：${row.uncertainty.map(md).join('；')}`, '');
      if (row.globalAssumptions.length) lines.push(`整图假设：${row.globalAssumptions.map(md).join('；')}`, '');
      lines.push(`usage：\`${JSON.stringify(row.usage)}\`；供应商回显 model=${md(row.supplierEcho.model ?? '未回显')}，effort=${md(row.supplierEcho.reasoningEffort ?? '未回显')}。`, '',
        `归档：${row.rawArtifact ? `[raw](${row.rawArtifact})` : '无 raw'}；${row.stageArtifact ? `[stage](${row.stageArtifact})` : '无 stage'}。`, '');
    }
  }
  lines.push('## 阅读限制', '', ...report.limitations.map((value) => `- ${value}`), ''); return lines.join('\n');
}
function htmlList(values, empty = '未提供') { return values.length ? `<ul>${values.map((value) => `<li>${html(value)}</li>`).join('')}</ul>` : `<p>${empty}</p>`; }
function armHtml(row, arm) {
  const components = row.components.map((c, index) => `<article class="component"><h4>${index + 1}. ${html(c.label)}</h4>
    <table><thead><tr><th>热量 kcal</th><th>蛋白质 g</th><th>碳水 g</th><th>脂肪 g</th></tr></thead><tbody><tr>${['calories', 'protein', 'carbs', 'fat'].map((key) => `<td>${html(range(c.per100g?.[key]))}</td>`).join('')}</tr></tbody></table>
    <dl><dt>配方依据</dt><dd>${html(c.recipeBasis)}</dd><dt>可见依据</dt><dd>${htmlList(c.evidence)}</dd><dt>假设</dt><dd>${htmlList(c.assumptions)}</dd><dt>不确定性</dt><dd>${htmlList(c.uncertainty)}</dd></dl></article>`).join('');
  return `<section class="arm ${arm}"><h3>${armLabel[arm]}</h3><p class="status">${html(statusLabel(row))}</p><p class="meta">主耗时 ${seconds(row.elapsedMs)} · 首正文 ${seconds(row.timing?.firstTextMs)}</p>
    ${components || '<p class="unavailable">未获得完整有效结果，全部营养项不可用。</p>'}
    ${row.uncertainty.length ? `<details open><summary>整图未决项</summary>${htmlList(row.uncertainty)}</details>` : ''}
    ${row.globalAssumptions.length ? `<details open><summary>整图假设</summary>${htmlList(row.globalAssumptions)}</details>` : ''}
    <details><summary>请求与归档</summary><p>传输完成 ${row.transportCompleted}；业务有效 ${row.businessAccepted}；HTTP ${row.httpStatus ?? '不可用'}；失败 ${html(row.errorCode)}</p>
    <p>回显 model：${html(row.supplierEcho.model ?? '未回显')}；effort：${html(row.supplierEcho.reasoningEffort ?? '未回显')}</p><p>usage：<code>${html(JSON.stringify(row.usage))}</code></p>
    <p>${row.rawArtifact ? `<a href="${html(row.rawArtifact)}">raw</a>` : '无 raw'} · ${row.stageArtifact ? `<a href="${html(row.stageArtifact)}">stage</a>` : '无 stage'}</p></details></section>`;
}
export function renderHighNutritionHtml(report, photos = {}) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>high 营养对照 · ${html(report.runId)}</title><style>
    :root{color-scheme:light;--ink:#202d31;--muted:#56676b;--line:#d3dfdf;--paper:#fff;--accent:#196a64}*{box-sizing:border-box}body{margin:0;background:#edf3f2;color:var(--ink);font-family:system-ui,'Microsoft YaHei',sans-serif;line-height:1.65}main{max-width:1320px;margin:auto;padding:42px 28px 60px}h1{font-size:clamp(28px,3.5vw,42px);line-height:1.25;margin:12px 0 22px}h2{font-size:27px;margin:0 0 10px}h3{font-size:20px;margin:0 0 10px}h4{font-size:18px;margin:0 0 15px}p{margin:8px 0 14px}.eyebrow{font-size:13px;color:var(--accent);letter-spacing:.1em;font-weight:700}.lead{max-width:980px;color:var(--muted)}.chips{display:flex;gap:10px;flex-wrap:wrap;margin:24px 0}.chips span{background:#fff;border:1px solid var(--line);border-radius:30px;padding:7px 14px;font-size:14px}.meal{background:#fff;border:1px solid var(--line);border-radius:18px;margin:28px 0;overflow:hidden}.meal-head{display:grid;grid-template-columns:240px 1fr;gap:25px;align-items:center;padding:26px;border-bottom:1px solid var(--line)}.photo{width:100%;height:220px;object-fit:contain;background:#f4f6f5;border-radius:10px}.meta{font-size:13px;color:var(--muted);overflow-wrap:anywhere}.arms{display:grid;grid-template-columns:1fr 1fr}.arm{padding:25px;min-width:0}.arm+.arm{border-left:1px solid var(--line)}.project{background:#fbfcfb}.status{font-size:14px;color:var(--accent);font-weight:650}.component{border-top:1px solid var(--line);padding-top:20px;margin:22px 0}table{width:100%;border-collapse:collapse;font-size:14px;text-align:left;margin:12px 0 20px}th,td{padding:9px 6px;border-bottom:1px solid var(--line)}th{font-size:12px;color:var(--muted);font-weight:600}td{font-variant-numeric:tabular-nums;font-weight:650}dl{font-size:14px;margin:0}dt{font-weight:700;margin-top:15px}dd{margin:4px 0;color:#40545a}ul{padding-left:20px;margin:6px 0}li{margin:5px 0}details{margin:12px 0;font-size:13px}summary{cursor:pointer;font-weight:650}code{overflow-wrap:anywhere;white-space:normal}.unavailable{padding:24px 0;color:#6d5650}a{color:var(--accent)}.limits{padding:5px 8px;font-size:14px}.footer{font-size:12px;color:var(--muted);overflow-wrap:anywhere;margin-top:28px}@media(max-width:800px){main{padding:24px 14px}.arms{grid-template-columns:1fr}.arm+.arm{border-left:0;border-top:1px solid var(--line)}.meal-head{grid-template-columns:140px 1fr;padding:18px;gap:18px}.photo{height:170px}.arm{padding:20px}h2{font-size:24px}}@media(max-width:430px){.meal-head{grid-template-columns:1fr}.photo{height:200px}th,td{padding:8px 3px;font-size:12px}}@media print{body{background:white}main{padding:0;max-width:none}.meal{break-inside:auto}.component{break-inside:avoid}details{display:block}.chips{margin:12px 0}}
    </style></head><body><main><div class="eyebrow">MEAL REFERENCE COMPARISON · HIGH</div><h1>同图 high，每 100g 营养对照</h1>
    <p class="lead">项目组复用历史 concise/schema high 首轮；直接组是本轮三次新请求。固定同一 JPEG、gpt-6.1-sol、90 秒单阶段。这里展示两组全部返回成品菜及其配方依据。</p>
    <div class="chips"><span>项目完整有效 ${report.summary.project.completeAndValid} / 3</span><span>直接完整有效 ${report.summary.direct.completeAndValid} / 3</span><span>本轮 POST ${report.ledger.recordedDispatches ?? 0} / 3</span><span>low 图像 · 8192 输出 tokens · 无重试</span></div>
    <p class="lead">全部营养范围按<strong>可食用成品每 100g</strong>；热量 kcal，蛋白质／碳水／脂肪 g。不可用不是 0。没有照片重量、份量和整餐总量，范围宽窄不能证明准确性。</p>
    ${report.meals.map((meal) => `<section class="meal"><header class="meal-head">${photos[meal.mealId] ? `<img class="photo" src="data:image/jpeg;base64,${photos[meal.mealId]}" alt="${html(meal.label)}原始冻结照片">` : '<div>照片不可用</div>'}<div><h2>${html(meal.label)}</h2><p>${html(meal.mealId)}</p><p class="meta">相同 JPEG · ${meal.imageBytes} bytes<br>SHA256 ${html(meal.imageSha256)}</p></div></header><div class="arms">${armHtml(meal.project, 'project')}${armHtml(meal.direct, 'direct')}</div></section>`).join('')}
    <section class="limits"><h2>如何解读</h2>${htmlList(report.limitations)}</section><p class="footer">运行 ${html(report.runId)} · 项目历史来源 ${html(report.sourceProjectRunId)} · <a href="comparison.json">结构化对照</a> · <a href="comparison.md">Markdown</a> · <a href="manifest.json">冻结清单</a><br>图片已嵌入，本页无需联网即可阅读。</p></main></body></html>`;
}

export async function reportHighNutritionComparison(input = {}) {
  await verifyHighNutritionArtifacts(input);
  const opts = options(input), manifest = await verifyHighNutritionFreeze(opts), results = await json(join(opts.outputDir, 'results.json'));
  if (results.runId !== opts.runId || results.manifestSha256 !== manifest.manifestSha256) throw new Error('Results and manifest disagree.');
  const reused = await json(within(opts.outputDir, manifest.reusedProject.path));
  const db = new DatabaseSync(join(opts.outputDir, 'requests.sqlite'), { readOnly: true }); let reservedRequests;
  try { reservedRequests = Number(db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n); } finally { db.close(); }
  const report = buildHighNutritionComparison(manifest, results, reused, { reservedRequests, cap: 3,
    remainingReservations: Math.max(0, 3 - reservedRequests), recordedDispatches: results.tasks.filter((row) => row.outbound?.sent === true).length,
    reusedProjectRequests: 3, newProjectRequests: 0, metadataRequests: 0 });
  const photos = Object.fromEntries(await Promise.all(manifest.meals.map(async (meal) => [meal.mealId,
    Buffer.from(await readFile(within(opts.outputDir, meal.prepared.path))).toString('base64')])));
  await writeJson(join(opts.outputDir, 'comparison.json'), report);
  await durableWrite(join(opts.outputDir, 'comparison.md'), renderHighNutritionMarkdown(report));
  await durableWrite(join(opts.outputDir, 'comparison.html'), renderHighNutritionHtml(report, photos)); return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  (async () => {
    const [command, ...args] = process.argv.slice(2), input = {};
    for (let i = 0; i < args.length; i += 1) {
      if (['--live', '--resume'].includes(args[i])) input[args[i].slice(2)] = true;
      else if (args[i] === '--run-id' && args[i + 1]) input.runId = args[++i]; else throw new Error('Invalid comparison argument.');
    }
    const result = command === 'prepare' ? await prepareHighNutritionComparison(input) : command === 'run' ? await runHighNutritionComparison(input)
      : command === 'verify' ? await verifyHighNutritionArtifacts(input) : command === 'report' ? await reportHighNutritionComparison(input)
      : (() => { throw new Error('Use prepare | run --live [--resume] | verify | report [--run-id ID].'); })();
    const brief = result.manifest ? { prepared: true, runId: result.manifest.runId, outputDir: result.outputDir, analysisRequests: 0 }
      : result.meals ? { runId: result.runId, ledger: result.ledger, summary: result.summary,
        meals: result.meals.map((meal) => ({ label: meal.label, project: { status: meal.project.status, elapsedMs: meal.project.elapsedMs },
          direct: { status: meal.direct.status, elapsedMs: meal.direct.elapsedMs, components: meal.direct.components.length } })),
        report: join(options(input).outputDir, 'comparison.html') } : result;
    process.stdout.write(`${JSON.stringify(brief, null, 2)}\n`);
  })().catch((error) => { process.stderr.write(`High nutrition comparison stopped (${codeOf(error)}): ${String(error.message).slice(0, 350)}\n`); process.exitCode = 1; });
}
