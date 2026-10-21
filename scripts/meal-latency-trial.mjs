#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, access, copyFile, open, rename, unlink, stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { resolve, join, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestProvider as actualRequestProvider } from '../src/ai-provider.ts';
import { offlineEvidence, offlineInputs, verifyOfflineEvidence, verifyOfflineProvider } from './meal-experiment-inputs.mjs';
import { mealRecognitionInstructions } from '../shared/nutrition.mjs';
import { readLocalCodexProvider } from '../server/local-codex.mjs';
import { RealMealTestLedger, REAL_MEAL_LEDGER_PATHS } from './real-meal-test-ledger.mjs';
import { LATENCY_CONFIG, LATENCY_PROFILES, validRunId, selectPilot, makeLatencySchedule, sha256,
  createLatencyReveal, blindPilotPayload, qualityTemplate, normalizeQuality, chooseFinalist,
  buildLatencyReport, renderLatencyMarkdown, emptyTask } from './meal-latency-core.mjs';
import { runObservedMealTask, redactSecrets, redactValue, assertArtifactsHaveNoSecret } from './meal-latency-capture.mjs';

export const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
export const DEFAULT_SOURCE_PATHS = Object.freeze(['src/ai-provider.ts', 'shared/nutrition.mjs',
  'data/nutrition/usda-sr-legacy.json', 'data/nutrition/category-ranges.json', 'server/local-codex.mjs',
  'scripts/meal-ab-core.mjs', 'scripts/real-meal-test-ledger.mjs',
  'scripts/meal-latency-core.mjs', 'scripts/meal-latency-capture.mjs', 'scripts/meal-latency-trial.mjs',
  'scripts/meal-experiment-inputs.mjs']);
const now = () => new Date().toISOString();
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const exists = async (path) => { try { await access(path); return true; } catch { return false; } };
const userText = `JSON record:\n${JSON.stringify({ kind: 'meal', data: { photoRoles: ['before'] } })}`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = (message, code = 'frozen_request_mismatch') => { const error = new Error(message); error.code = code; throw error; };
const within = (directory, path) => {
  const target = resolve(directory, path.replaceAll('\\', '/')), rel = relative(resolve(directory), target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Frozen file path escapes its artifact directory.');
  return target;
};
function optionsOf({ projectRoot = PROJECT_ROOT, runId = '20261018-90s-v1', outputDir, frozenManifestPath, sourcePaths = DEFAULT_SOURCE_PATHS, ...rest } = {}) {
  validRunId(runId);
  const root = resolve(projectRoot);
  return { ...rest, projectRoot: root, runId, outputDir: resolve(outputDir ?? join(root, 'artifacts', `meal-latency-${runId}`)),
    frozenManifestPath: resolve(frozenManifestPath ?? join(root, 'artifacts/meal-ab-20261018-10-v1/manifest.json')), sourcePaths };
}
export async function durableWrite(path, text, options = {}) {
  const handle = await open(path, options.flag ?? 'w', options.mode ?? 0o600);
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
}
async function writeJson(path, value, { exclusive = false, key = '' } = {}) {
  const text = `${JSON.stringify(redactValue(value, key), null, 2)}\n`;
  if (exclusive) return durableWrite(path, text, { flag: 'wx' });
  const temporary = `${path}.${randomBytes(5).toString('hex')}.tmp`;
  await durableWrite(temporary, text, { flag: 'wx' });
  await rename(temporary, path);
}
function providerSummary(provider) {
  return { baseUrl: provider.baseUrl, configuredModel: provider.model, configuredReasoningEffort: provider.reasoningEffort,
    selectedModel: LATENCY_CONFIG.model, selectedProfiles: LATENCY_PROFILES, credentials: 'read at runtime; never stored' };
}
async function promptsFor(root) {
  const catalog = await json(join(root, 'data/nutrition/usda-sr-legacy.json'));
  const categories = await json(join(root, 'data/nutrition/category-ranges.json'));
  return Object.fromEntries(['current', 'concise'].map((profile) => {
    const instructions = mealRecognitionInstructions('whole', catalog.foods, Object.keys(categories.categories), profile);
    return [profile, { instructions, instructionsSha256: sha256(instructions), userText, userTextSha256: sha256(userText) }];
  }));
}
export function latencyLedgerOptions(manifest) {
  return { allowProviderOverride: true,
    limits: { totalRequests: 22, perMealRequests: 1, reviewMeals: 0, cohortMeals: 10 },
    runLimits: Object.fromEntries(Object.keys(LATENCY_PROFILES).flatMap((id) => [
      [`${manifest.runId}-pilot-${id}`, { perMealRequests: 1, reviewMeals: 0, cohortMeals: 4 }],
      [`${manifest.runId}-confirm-${id}`, { perMealRequests: 1, reviewMeals: 0, cohortMeals: 10 }],
    ])) };
}
/** History is audit information only; it never participates in the new 22-request budget. */
export function historicalLedgerSummary(paths = REAL_MEAL_LEDGER_PATHS) {
  return paths.map((path) => {
    let db;
    try { db = new DatabaseSync(path, { readOnly: true }); return { path, access: 'read_only_information', requests: Number(db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n) }; }
    catch { return { path, access: 'read_only_information', requests: null, status: 'unavailable' }; }
    finally { db?.close(); }
  });
}

export async function prepareLatencyTrial(input = {}) {
  const opts = optionsOf(input), { projectRoot, outputDir, frozenManifestPath, runId, sourcePaths } = opts;
  offlineInputs(opts);
  if (await exists(join(outputDir, 'manifest.json'))) return { outputDir, manifest: await verifyLatencyFreeze(opts) };
  const sourceBytes = await readFile(frozenManifestPath), source = JSON.parse(sourceBytes.toString('utf8'));
  verifyOfflineEvidence(opts, source);
  selectPilot(source.meals);
  if (source.meals.some((meal) => meal.prepared?.mime !== 'image/jpeg')) throw new Error('Frozen inputs must be the existing ten JPEGs.');
  const provider = await (opts.providerReader ?? readLocalCodexProvider)();
  verifyOfflineProvider(opts, provider);
  const prompts = await promptsFor(projectRoot);
  if (prompts.current.instructions === prompts.concise.instructions) throw new Error('Current and concise prompt profiles are not distinct.');
  const fingerprints = await Promise.all(sourcePaths.map(async (path) => ({ path, sha256: sha256(await readFile(within(projectRoot, path))) })));
  const photos = await Promise.all(source.meals.map(async (meal) => {
    const bytes = await readFile(within(dirname(frozenManifestPath), meal.prepared.path));
    if (bytes.length !== meal.prepared.bytes || sha256(bytes) !== meal.prepared.sha256 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error(`Frozen JPEG bytes mismatch: ${meal.mealId}.`);
    return { meal, bytes };
  }));
  await mkdir(dirname(outputDir), { recursive: true });
  // Never overwrite a partially prepared directory or an earlier experiment.
  await mkdir(outputDir, { mode: 0o700 });
  for (const sub of ['photos', 'requests', 'blind', 'blind/images']) await mkdir(join(outputDir, sub), { recursive: true, mode: 0o700 });
  const meals = [];
  for (const { meal, bytes } of photos) {
    const path = `photos/${meal.mealId}.jpg`;
    await durableWrite(join(outputDir, path), bytes, { flag: 'wx' });
    meals.push({ mealId: meal.mealId, original: meal.original, retainedSourcePath: meal.sourcePath ?? null,
      frozenPreparedSource: meal.prepared.path, prepared: { ...meal.prepared, path, preprocessing: 'copied byte-for-byte; not recompressed' } });
  }
  const manifest = { schemaVersion: 'meal-latency-manifest.v1', runId, createdAt: now(), config: LATENCY_CONFIG, profiles: LATENCY_PROFILES,
    ...offlineEvidence(opts),
    provider: providerSummary(provider), source: { manifestPath: frozenManifestPath, sha256: sha256(sourceBytes), runId: source.runId },
    meals, prompts: { path: 'prompts.json', sha256: sha256(`${JSON.stringify(prompts, null, 2)}\n`) }, sourceFingerprints: fingerprints,
    pilotSchedule: makeLatencySchedule(meals, runId),
    confirmationSchedules: Object.fromEntries(Object.keys(LATENCY_PROFILES).map((id) => [id, makeLatencySchedule(meals, runId, 'confirm', id)])),
    history: historicalLedgerSummary(opts.historicalLedgerPaths),
    budget: { cap: 22, scope: 'this experiment requests.sqlite only; historical ledgers are read-only information', pilot: 12, confirmation: 10 },
    metrics: { percentiles: 'linear interpolation at (n-1)*p', denominator: 'all four pilot or ten confirmation samples, including failures',
      timeoutMs: 90000, timeoutAccounting: 'max(90000, measured elapsed) for timeout/interruption; unavailable elapsed uses 90000' } };
  manifest.manifestSha256 = sha256(JSON.stringify(manifest));
  const reveal = createLatencyReveal(meals, randomBytes(32).toString('hex'));
  await writeJson(join(outputDir, 'prompts.json'), prompts, { exclusive: true });
  await writeJson(join(outputDir, 'reveal-map.json'), reveal, { exclusive: true });
  await writeJson(join(outputDir, 'quality-assessment.template.json'), qualityTemplate(runId, reveal), { exclusive: true });
  for (const entry of reveal.samples) {
    const meal = meals.find((row) => row.mealId === entry.mealId);
    await copyFile(join(outputDir, meal.prepared.path), join(outputDir, 'blind/images', `${entry.sampleId}.jpg`));
  }
  await writeJson(join(outputDir, 'manifest.json'), manifest, { exclusive: true });
  const ledger = new RealMealTestLedger(join(outputDir, 'requests.sqlite'), latencyLedgerOptions(manifest));
  ledger.close();
  await writeJson(join(outputDir, 'results.json'), { schemaVersion: 'meal-latency-results.v1', runId,
    ...offlineEvidence(opts),
    manifestSha256: manifest.manifestSha256, updatedAt: now(), tasks: [] }, { exclusive: true });
  await assertArtifactsHaveNoSecret(outputDir, provider.key);
  await reportLatencyTrial(opts);
  return { outputDir, manifest };
}

export async function verifyLatencyFreeze(input = {}) {
  const opts = optionsOf(input), { projectRoot, outputDir, runId } = opts;
  const manifest = await json(join(outputDir, 'manifest.json'));
  verifyOfflineEvidence(opts, manifest);
  const { manifestSha256, ...body } = manifest;
  if (manifest.schemaVersion !== 'meal-latency-manifest.v1' || manifest.runId !== runId || sha256(JSON.stringify(body)) !== manifestSha256
    || !same(manifest.config, LATENCY_CONFIG) || !same(manifest.profiles, LATENCY_PROFILES)) throw new Error('Frozen manifest or experiment settings changed.');
  if (!same(manifest.pilotSchedule, makeLatencySchedule(manifest.meals, runId))) throw new Error('Frozen interleaved order changed.');
  for (const id of Object.keys(LATENCY_PROFILES)) if (!same(manifest.confirmationSchedules[id], makeLatencySchedule(manifest.meals, runId, 'confirm', id))) throw new Error('Frozen confirmation task identities changed.');
  for (const source of manifest.sourceFingerprints) if (sha256(await readFile(within(projectRoot, source.path))) !== source.sha256) throw new Error(`Relevant source changed after preparation: ${source.path}. Prepare a new run before paid calls.`);
  const promptBytes = await readFile(join(outputDir, manifest.prompts.path));
  if (sha256(promptBytes) !== manifest.prompts.sha256 || !same(JSON.parse(promptBytes.toString('utf8')), await promptsFor(projectRoot))) throw new Error('Frozen prompts changed.');
  for (const meal of manifest.meals) {
    const bytes = await readFile(within(outputDir, meal.prepared.path));
    if (bytes.length !== meal.prepared.bytes || sha256(bytes) !== meal.prepared.sha256) throw new Error(`Frozen image changed: ${meal.mealId}.`);
  }
  return manifest;
}

/** Verify the actual outgoing body immediately before fetch can reach the network. */
export function validateFrozenRequest({ url, init, provider, manifest, task, prompts, imageBytes, reservedAttempts, sentCount }) {
  if (sentCount !== 0 || reservedAttempts.length !== 1 || reservedAttempts[0].stage !== 'whole') fail('Exactly one durable whole-stage reservation and one send are required.');
  const expectedUrl = `${provider.baseUrl.replace(/\/+$/, '')}/responses`;
  if (String(url) !== expectedUrl || init?.method !== 'POST' || typeof init?.body !== 'string') fail('Unexpected supplier endpoint or request method.');
  let body; try { body = JSON.parse(init.body); } catch { fail('Outgoing body is not JSON.'); }
  const p = manifest.profiles[task.profile], frozen = prompts[p.promptProfile];
  const meal = manifest.meals.find((row) => row.mealId === task.mealId);
  if (!meal || sha256(imageBytes) !== meal.prepared.sha256 || imageBytes.length !== meal.prepared.bytes) fail('Image bytes no longer match the frozen hash.');
  const content = body.input?.[0]?.content;
  if (body.model !== LATENCY_CONFIG.model || body.reasoning?.effort !== p.reasoningEffort || body.max_output_tokens !== 8192
    || body.stream !== true || body.store !== false || body.text?.format?.type !== 'json_object'
    || body.instructions !== frozen.instructions || body.input?.length !== 1 || body.input?.[0]?.role !== 'user'
    || !Array.isArray(content) || content.length !== 2 || content[0]?.type !== 'input_text' || content[0]?.text !== frozen.userText
    || content[1]?.type !== 'input_image' || content[1]?.detail !== 'low'
    || content[1]?.image_url !== `data:image/jpeg;base64,${imageBytes.toString('base64')}`) fail('Outgoing model, prompt, image bytes, stage or transport settings differ from the frozen experiment.');
  return true;
}

export async function recoverTask(task, attempts, outputDir) {
  const stages = [];
  let fatal = null;
  for (const attempt of attempts) {
    const stagePath = `requests/${attempt.attemptId}-${attempt.stage}.json`;
    let saved = null; try { saved = await json(join(outputDir, stagePath)); } catch {}
    if (saved) {
      fatal ??= saved.fatalPersistenceError ?? saved.capture?.saveError ?? (saved.captureStatus === 'save_failed' ? 'raw_archive_write_failed' : null);
      if (saved.attemptId !== attempt.attemptId || saved.stage !== attempt.stage || saved.validationRunId !== task.validationRunId || saved.mealId !== task.mealId) fatal ??= 'stage_archive_identity_mismatch';
      if (saved.transportCompleted !== (attempt.providerCompleted === true) || saved.businessAccepted !== (attempt.resultAccepted === true)
        || attempt.status === 'in_flight') fatal ??= 'ledger_stage_state_mismatch';
      if (!['saved', 'empty', 'truncated'].includes(saved.captureStatus) || !saved.rawArtifact || saved.rawArtifact !== attempt.rawResponseArtifact) fatal ??= 'required_raw_archive_missing';
      else try {
        const bytes = await readFile(within(outputDir, saved.rawArtifact));
        if (saved.capture?.archivedBytes !== bytes.length || !saved.capture?.artifactSha256 || sha256(bytes) !== saved.capture.artifactSha256
          || saved.captureStatus === 'empty' && (bytes.length !== 0 || saved.capture.observedBytes !== 0)) fatal ??= 'raw_archive_integrity_failed';
      } catch { fatal ??= 'required_raw_archive_missing'; }
    } else if (attempt.status !== 'in_flight' || attempt.rawResponseArtifact) fatal ??= 'required_stage_archive_missing';
    stages.push(saved ?? { attemptId: attempt.attemptId, stage: attempt.stage, stageCount: stages.length + 1,
      status: attempt.status, transportCompleted: attempt.providerCompleted === true, businessAccepted: false,
      providerCompleted: attempt.providerCompleted === true, accepted: false, usage: attempt.usage,
      rawArtifact: attempt.rawResponseArtifact, captureStatus: 'unavailable_interrupted', analysis: null, recognition: null,
      elapsedMs: attempt.elapsedMs, httpStatus: attempt.httpStatus, errorCode: attempt.errorCode ?? 'resume_preserved_prior_attempt', timing: null });
  }
  const whole = stages.find((row) => row.stage === 'whole');
  // A fully archived returned stage can be recovered; everything else remains an interrupted first attempt.
  const completed = !fatal && stages.length === 1 && whole?.businessAccepted && whole?.transportCompleted && whole?.timing?.returnedMs !== null && whole?.timing?.returnedMs !== undefined;
  return { ...emptyTask(task), status: completed ? 'accepted' : 'interrupted', stages, transportCompleted: whole?.transportCompleted === true,
    businessAccepted: completed === true, workflowCompleted: completed === true,
    analysis: completed ? whole.analysis : null, recognition: completed ? whole.recognition : null,
    timing: whole?.timing ? { ...whole.timing, diagnosticReturnedMs: whole.timing.returnedMs,
      returnedMs: completed ? whole.taskElapsedMs ?? whole.timing.returnedMs : null } : null,
    elapsedMs: whole?.taskElapsedMs ?? whole?.timing?.returnedMs ?? whole?.elapsedMs ?? 90000,
    captureStatus: whole?.captureStatus ?? 'unavailable_interrupted', recoveredFromLedger: true, fatalPersistenceError: fatal,
    error: completed ? null : { code: 'resume_preserved_prior_attempt', message: 'A durable reservation existed; no retry was sent and missing raw bytes are not represented as an empty capture.' } };
}
async function acquireLock(outputDir, resume) {
  const path = join(outputDir, 'execution.lock');
  let handle;
  try { handle = await open(path, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST' || !resume) throw new Error('An execution lock exists. Use --resume only after the prior process has ended.');
    const lock = await json(path);
    let active = false;
    if (Number.isSafeInteger(lock.pid)) try { process.kill(lock.pid, 0); active = true; } catch (check) { if (check.code === 'EPERM') active = true; }
    if (active) throw new Error('The previous trial process is still active; no second runner was started.');
    await unlink(path); handle = await open(path, 'wx', 0o600);
  }
  await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: now() })); await handle.sync();
  return async () => { await handle.close(); await unlink(path); };
}

export async function reportLatencyTrial(input = {}) {
  const opts = optionsOf(input), { outputDir, runId } = opts;
  const manifest = await json(join(outputDir, 'manifest.json'));
  const results = await json(join(outputDir, 'results.json'));
  if (results.runId !== runId || results.manifestSha256 !== manifest.manifestSha256) throw new Error('Results do not match the frozen manifest.');
  const reveal = await json(join(outputDir, 'reveal-map.json'));
  const assessmentPath = opts.assessmentPath ? resolve(opts.assessmentPath) : join(outputDir, 'quality-assessment.json');
  let assessment = null, assessmentSha256 = null;
  if (await exists(assessmentPath)) {
    const bytes = await readFile(assessmentPath); assessment = JSON.parse(bytes.toString('utf8')); assessmentSha256 = sha256(bytes);
  }
  const quality = normalizeQuality(assessment, reveal, runId);
  let gateOverride = null;
  if (await exists(join(outputDir, 'confirmation-plan.json'))) {
    const plan = await json(join(outputDir, 'confirmation-plan.json')), { planSha256, ...body } = plan;
    if (sha256(JSON.stringify(body)) !== planSha256 || plan.assessmentSha256 !== assessmentSha256) throw new Error('Confirmation plan or its frozen quality assessment changed.');
    gateOverride = plan.gate;
  }
  const ledger = new DatabaseSync(join(outputDir, 'requests.sqlite'), { readOnly: true });
  let totals;
  try {
    const localRequests = Number(ledger.prepare('SELECT COUNT(*) AS n FROM attempts').get().n);
    totals = { localRequests, cap: 22, remaining: Math.max(0, 22 - localRequests), history: manifest.history, historyCountsTowardCap: false };
  } finally { ledger.close(); }
  const report = buildLatencyReport(manifest, results.tasks, quality, { ledger: totals, gateOverride, assessmentSha256 });
  await writeJson(join(outputDir, 'blind/pilot.json'), blindPilotPayload(manifest, results.tasks, reveal));
  await writeJson(join(outputDir, 'report.json'), report);
  await durableWrite(join(outputDir, 'report.md'), renderLatencyMarkdown(report));
  if (opts.assessmentPath && quality.valid && resolve(assessmentPath) !== join(outputDir, 'quality-assessment.json')) {
    await durableWrite(join(outputDir, 'quality-assessment.json'), await readFile(assessmentPath));
  }
  return report;
}

export async function runLatencyPhase(input = {}) {
  const opts = optionsOf(input), { outputDir, resume = false, phase = 'pilot' } = opts;
  if (!opts.live) throw new Error('Paid phases require explicit --live. Preparation and reports are offline.');
  if (!['pilot', 'confirm'].includes(phase)) throw new Error('Invalid phase.');
  const manifest = await verifyLatencyFreeze(opts);
  const providerConfig = await (opts.providerReader ?? readLocalCodexProvider)();
  verifyOfflineProvider(opts, providerConfig, true);
  if (providerConfig.baseUrl !== manifest.provider.baseUrl) throw new Error('Provider address changed after preparation.');
  await assertArtifactsHaveNoSecret(outputDir, providerConfig.key);
  const prompts = await json(join(outputDir, 'prompts.json'));
  const release = await acquireLock(outputDir, resume);
  let ledger;
  try {
    ledger = new RealMealTestLedger(join(outputDir, 'requests.sqlite'), latencyLedgerOptions(manifest));
    let results = await json(join(outputDir, 'results.json'));
    if (results.runId !== manifest.runId || results.manifestSha256 !== manifest.manifestSha256 || !Array.isArray(results.tasks)) throw new Error('Results do not match the frozen manifest.');
    if (results.tasks.some((row) => row.fatalPersistenceError) || results.fatalPersistenceError) throw new Error('A previous artifact or ledger persistence failure blocks further paid calls.');
    if (ledger.attempts().some((row) => row.validationRunId.includes(`-${phase}-`)) && !resume) throw new Error('Prior reservations in this phase exist; use --resume to preserve them without resending.');
    let schedule = manifest.pilotSchedule;
    if (phase === 'confirm') {
      const report = await reportLatencyTrial(opts);
      if (!report.gate.allowed) throw new Error(`Confirmation blocked: ${report.gate.reason}.`);
      const planPath = join(outputDir, 'confirmation-plan.json');
      const pilotRecords = manifest.pilotSchedule.map((task) => results.tasks.find((row) => row.taskId === task.taskId));
      if (!(await exists(planPath))) {
        const plan = { schemaVersion: 'meal-latency-confirmation-plan.v1', runId: manifest.runId, createdAt: now(),
          manifestSha256: manifest.manifestSha256, assessmentSha256: report.assessmentSha256,
          pilotSnapshotSha256: sha256(JSON.stringify(pilotRecords)), gate: report.gate,
          schedule: manifest.confirmationSchedules[report.gate.chosenProfile] };
        plan.planSha256 = sha256(JSON.stringify(plan));
        await writeJson(planPath, plan, { exclusive: true });
      }
      const plan = await json(planPath);
      if (plan.pilotSnapshotSha256 !== sha256(JSON.stringify(pilotRecords))) throw new Error('Pilot results changed after finalist selection.');
      schedule = plan.schedule;
      const unexpected = ledger.attempts().some((row) => row.validationRunId.includes('-confirm-') && row.validationRunId !== schedule[0].validationRunId);
      if (unexpected) throw new Error('A different confirmation condition has reservations; only the selected finalist may run.');
    }
    const appendProgress = async (event) => {
      const handle = await open(join(outputDir, 'progress.jsonl'), 'a', 0o600);
      try { await handle.writeFile(`${JSON.stringify(redactValue({ at: now(), ...event }, providerConfig.key))}\n`); await handle.sync(); }
      finally { await handle.close(); }
    };
    for (const task of schedule) {
      const existing = results.tasks.find((row) => row.taskId === task.taskId);
      if (existing && existing.status !== 'not_attempted') continue;
      const prior = ledger.attemptsForRun(task.validationRunId, task.mealId);
      let record;
      if (prior.length) record = await recoverTask(task, prior, outputDir);
      else {
        const photo = manifest.meals.find((row) => row.mealId === task.mealId);
        const bytes = await readFile(join(outputDir, photo.prepared.path));
        if (sha256(bytes) !== photo.prepared.sha256 || bytes.length !== photo.prepared.bytes) throw new Error('Frozen image changed before the next reservation.');
        const p = manifest.profiles[task.profile];
        const provider = { ...providerConfig, model: manifest.config.model, reasoningEffort: p.reasoningEffort };
        const suppliedRequest = opts.requestProvider ?? actualRequestProvider;
        // This wrapper audits the actual outgoing body; response bytes are captured only by onTransport.
        const guardedRequest = async (...args) => {
          if (args[4]?.timeoutMs !== manifest.config.timeoutMs || args[4]?.maxStages !== 1) throw new Error('Experimental stage deadline changed.');
          const originalFetch = globalThis.fetch; let sent = 0;
          globalThis.fetch = async (url, init) => {
            validateFrozenRequest({ url, init, provider, manifest, task, prompts, imageBytes: bytes,
              reservedAttempts: ledger.attemptsForRun(task.validationRunId, task.mealId), sentCount: sent });
            sent += 1;
            return originalFetch(url, init);
          };
          try { return await suppliedRequest(...args); }
          finally { globalThis.fetch = originalFetch; }
        };
        record = await runObservedMealTask({ task, ledger, provider, photo: `data:image/jpeg;base64,${bytes.toString('base64')}`,
          artifactDir: outputDir, requestProvider: guardedRequest, progress: appendProgress,
          providerOptions: { promptProfile: p.promptProfile, timeoutMs: manifest.config.timeoutMs }, write: opts.artifactWrite ?? durableWrite, clock: opts.clock ?? Date.now });
        record.configuredProvider = providerSummary(providerConfig);
      }
      results.tasks = [...results.tasks.filter((row) => row.taskId !== task.taskId), record]; results.updatedAt = now();
      if (record.fatalPersistenceError) results.fatalPersistenceError = record.fatalPersistenceError;
      await writeJson(join(outputDir, 'results.json'), results, { key: providerConfig.key });
      await assertArtifactsHaveNoSecret(outputDir, providerConfig.key);
      if (record.fatalPersistenceError) throw new Error(`Further paid calls stopped: ${record.fatalPersistenceError}.`);
    }
    const report = await reportLatencyTrial(opts);
    await assertArtifactsHaveNoSecret(outputDir, providerConfig.key);
    return report;
  } finally { ledger?.close(); await release(); }
}

function parseArgs(argv) {
  const command = argv[0];
  if (!['prepare', 'pilot', 'assess', 'report', 'confirm'].includes(command)) throw new Error('Use prepare | pilot --live | assess --assessment file | report | confirm --live, with --run-id ID [--output DIR] [--resume].');
  const opts = { command };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (['--live', '--resume'].includes(arg)) opts[arg.slice(2)] = true;
    else {
      const key = { '--run-id': 'runId', '--output': 'outputDir', '--assessment': 'assessmentPath', '--frozen-manifest': 'frozenManifestPath' }[arg];
      if (!key || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`Unknown or missing argument: ${arg}.`);
      opts[key] = argv[++index];
    }
  }
  return opts;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  (async () => {
    const opts = parseArgs(process.argv.slice(2));
    const value = opts.command === 'prepare' ? await prepareLatencyTrial(opts) : ['assess', 'report'].includes(opts.command)
      ? await reportLatencyTrial(opts) : await runLatencyPhase({ ...opts, phase: opts.command === 'confirm' ? 'confirm' : 'pilot' });
    process.stdout.write(`${JSON.stringify(value.manifest ? { prepared: true, outputDir: value.outputDir, runId: value.manifest.runId, requestsSent: 0 }
      : { runId: value.runId, gate: value.gate, confirmation: value.confirmation.status, report: join(optionsOf(opts).outputDir, 'report.md') }, null, 2)}\n`);
  })().catch((error) => { process.stderr.write(`${String(error?.message ?? 'Trial failed.')}\n`); process.exitCode = 1; });
}
