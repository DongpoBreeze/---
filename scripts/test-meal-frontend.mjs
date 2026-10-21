#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { access, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createParser } from 'eventsource-parser';
import { requestProvider } from '../src/ai-provider.ts';
import { offlineInputs, offlineEvidence, verifyOfflineProvider, verifyOfflineEvidence } from './meal-experiment-inputs.mjs';
import { mealAnalysisSchema } from '../src/nutrition-schema.ts';
import { frontendMealRecognitionSnapshot, mealRecognitionInstructions, validateFrontendMealRecognition } from '../shared/nutrition.mjs';
import { readLocalCodexProvider } from '../server/local-codex.mjs';
import { RealMealTestLedger } from './real-meal-test-ledger.mjs';
import { assertArtifactsHaveNoSecret, redactValue, runObservedMealTask } from './meal-latency-capture.mjs';
import { PROJECT_ROOT, durableWrite, recoverTask, validateFrozenRequest } from './meal-latency-trial.mjs';
import { normalizeAnalysis } from './meal-ab-core.mjs';
import { sha256, taskAccepted, validRunId } from './meal-latency-core.mjs';
import { HIGH_NUTRITION_INPUTS } from './meal-high-nutrition-comparison.mjs';
import { supplierEcho } from './meal-multidish-speed-trial.mjs';

export const FRONTEND_CONFIG = Object.freeze({ model: 'gpt-6.1-sol', reasoningEffort: 'high', protocol: 'responses',
  stream: true, imageDetail: 'low', maxOutputTokens: 8192, timeoutMs: 90000, maxStages: 1, retries: 0, maxLocalRequests: 3 });
const sourcePaths = ['src/ai-provider.ts', 'src/ai.ts', 'src/nutrition-schema.ts', 'shared/nutrition.mjs', 'shared/nutrition.d.mts',
  'server/local-codex.mjs', 'scripts/real-meal-test-ledger.mjs', 'scripts/meal-latency-capture.mjs', 'scripts/meal-latency-trial.mjs', 'scripts/test-meal-frontend.mjs', 'scripts/meal-experiment-inputs.mjs'];
const now = () => new Date().toISOString();
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const exists = async (path) => { try { await access(path); return true; } catch { return false; } };
function options(input = {}) {
  const runId = validRunId(input.runId ?? '20261018-high-v1');
  return { ...input, runId, projectRoot: resolve(input.projectRoot ?? PROJECT_ROOT),
    outputDir: resolve(input.outputDir ?? join(PROJECT_ROOT, 'artifacts', `meal-frontend-${runId}`)),
    historyDir: resolve(input.historyDir ?? join(PROJECT_ROOT, 'artifacts', 'meal-high-nutrition-20261018-high-v1')) };
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
export function frontendSchedule(runId, inputs = HIGH_NUTRITION_INPUTS) {
  return inputs.map(({ mealId }, index) => ({ taskId: `frontend:${mealId}`, sequence: index + 1,
    mealId, group: 'frontend', profile: 'frontend-high', phase: 'frontend', validationRunId: `${validRunId(runId)}-frontend`, maxStages: 1, timeoutMs: 90000 }));
}
export function frontendLedgerOptions(runId) {
  return { allowProviderOverride: true, limits: { totalRequests: 3, perMealRequests: 1, reviewMeals: 0, cohortMeals: 3 },
    runLimits: { [`${validRunId(runId)}-frontend`]: { perMealRequests: 1, reviewMeals: 0, cohortMeals: 3 } } };
}

/** Compare body length only. A partial text prefix never supplies usable nutrition. */
export function archivedOutput(bytes) {
  let delta = '', done = null, completed = null;
  const observe = (event) => {
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') delta += event.delta;
    if (event.type === 'response.output_text.done' && typeof event.text === 'string') done = event.text;
    const response = event.response ?? event;
    if ((event.type === 'response.completed' || response.status === 'completed') && Array.isArray(response.output)) {
      completed = response.output.filter((item) => item.type === 'message' && item.role === 'assistant')
        .flatMap((item) => item.content ?? []).filter((part) => part.type === 'output_text' && typeof part.text === 'string').map((part) => part.text).join('');
    }
  };
  const parser = createParser({ onEvent: (event) => { try { observe(JSON.parse(event.data)); } catch {} } });
  const raw = Buffer.from(bytes).toString('utf8');
  try { parser.feed(raw); } catch {} try { observe(JSON.parse(raw)); } catch {}
  const text = completed ?? done ?? delta;
  return { characters: text.length, utf8Bytes: Buffer.byteLength(text), complete: completed !== null, textSha256: sha256(text) };
}

/** Read historical artifacts and their ledgers without applying old source-code freezes. */
async function historicalInputs(opts) {
  const fixture = offlineInputs(opts), expectedInputs = fixture?.highInputs ?? HIGH_NUTRITION_INPUTS;
  const manifestBytes = await readFile(join(opts.historyDir, 'manifest.json')), manifest = JSON.parse(manifestBytes);
  verifyOfflineEvidence(opts, manifest);
  const { manifestSha256, ...body } = manifest;
  if (manifest.runId !== (fixture?.nutritionRunId ?? '20261018-high-v1') || sha256(JSON.stringify(body)) !== manifestSha256) throw new Error('Historical manifest integrity failed.');
  const resultsBytes = await readFile(join(opts.historyDir, 'results.json')), direct = JSON.parse(resultsBytes);
  const reusedBytes = await readFile(within(opts.historyDir, manifest.reusedProject.path)), reused = JSON.parse(reusedBytes);
  const promptsBytes = await readFile(within(opts.historyDir, manifest.prompts.path)), prompts = JSON.parse(promptsBytes);
  if (sha256(reusedBytes) !== manifest.reusedProject.sha256 || sha256(promptsBytes) !== manifest.prompts.sha256
    || direct.manifestSha256 !== manifestSha256 || direct.tasks.length !== 3 || reused.tasks.length !== 3
    || prompts.projectConcise.instructionsSha256 !== (fixture?.conciseSha ?? '87334343fbbb083730bc1e21e3cbbb9b5e1e40d00470bb18642148dee0b2a888')) throw new Error('Historical input snapshot changed.');
  const db = new DatabaseSync(join(opts.historyDir, 'requests.sqlite'), { readOnly: true });
  const meals = [], photos = [], entries = [];
  try {
    for (const expected of expectedInputs) {
      const meal = manifest.meals.find((row) => row.mealId === expected.mealId);
      const bytes = await readFile(within(opts.historyDir, meal.prepared.path));
      if (meal.label !== expected.label || meal.prepared.bytes !== expected.bytes || meal.prepared.sha256 !== expected.sha256
        || sha256(bytes) !== expected.sha256 || bytes.length !== expected.bytes) throw new Error('Frozen historical JPEG changed.');
      meals.push(meal); photos.push({ path: meal.prepared.path, bytes });
      for (const [arm, rows, prefix] of [['project', reused.tasks, 'reused-project/'], ['direct', direct.tasks, '']]) {
        const record = rows.find((row) => row.mealId === expected.mealId), stage = record?.stages?.[0];
        if (!stage || record.stages.length !== 1 || stage.stage !== 'whole' || record.fatalPersistenceError || stage.fatalPersistenceError) throw new Error('Historical stage is incomplete.');
        if (arm === 'project' && (record.status !== expected.status || record.elapsedMs !== expected.elapsedMs)) throw new Error('Historical project outcome changed.');
        const stageBytes = await readFile(within(opts.historyDir, prefix + stage.stageArtifact));
        const rawBytes = await readFile(within(opts.historyDir, prefix + stage.rawArtifact));
        if (!same(JSON.parse(stageBytes), stage) || rawBytes.length !== stage.capture.archivedBytes || sha256(rawBytes) !== stage.capture.artifactSha256) throw new Error('Historical raw/stage integrity failed.');
        if (arm === 'direct') {
          const ledger = db.prepare('SELECT * FROM attempts WHERE id=?').get(stage.attemptId);
          if (!ledger || ledger.meal_id !== expected.mealId || ledger.model !== FRONTEND_CONFIG.model || ledger.reasoning_effort !== 'high'
            || Boolean(ledger.provider_completed) !== stage.transportCompleted || Boolean(ledger.result_accepted) !== stage.businessAccepted || ledger.raw_artifact !== stage.rawArtifact) throw new Error('Historical ledger mismatch.');
        }
        entries.push({ mealId: expected.mealId, arm, record, rawPath: prefix + stage.rawArtifact,
          stageSha256: sha256(stageBytes), rawSha256: sha256(rawBytes), output: archivedOutput(rawBytes), supplierEcho: supplierEcho(rawBytes) });
      }
    }
  } finally { db.close(); }
  return { meals, photos, history: { sourceDirectory: relative(opts.projectRoot, opts.historyDir).replaceAll('\\', '/'),
    sourceManifestSha256: sha256(manifestBytes), sourceResultsSha256: sha256(resultsBytes), entries,
    prompts: { project: prompts.projectConcise, direct: prompts.direct } } };
}

export async function prepareFrontendTrial(input = {}) {
  const opts = options(input), { outputDir, runId } = opts;
  if (await exists(join(outputDir, 'manifest.json'))) return { outputDir, manifest: await verifyFrontendFreeze(opts) };
  const historical = await historicalInputs(opts), provider = await (opts.providerReader ?? readLocalCodexProvider)();
  verifyOfflineProvider(opts, provider);
  await mkdir(join(outputDir, 'photos'), { recursive: true, mode: 0o700 });
  const prompts = { frontend: { instructions: mealRecognitionInstructions('whole', [], [], 'frontend'),
    userText: `JSON record:\n${JSON.stringify({ kind: 'meal', data: { photoRoles: ['before'] } })}` } };
  const promptBytes = `${JSON.stringify(prompts, null, 2)}\n`, historyBytes = `${JSON.stringify(historical.history, null, 2)}\n`;
  for (const photo of historical.photos) await durableWrite(within(outputDir, photo.path), photo.bytes, { flag: 'wx' });
  await durableWrite(join(outputDir, 'prompts.json'), promptBytes, { flag: 'wx' });
  await durableWrite(join(outputDir, 'history.json'), historyBytes, { flag: 'wx' });
  const manifest = { schemaVersion: 'meal-frontend-manifest.v1', runId, createdAt: now(), config: FRONTEND_CONFIG, ...offlineEvidence(opts),
    profiles: { 'frontend-high': { promptProfile: 'frontend', reasoningEffort: 'high' } }, meals: historical.meals,
    schedule: frontendSchedule(runId, historical.meals), prompts: { path: 'prompts.json', sha256: sha256(promptBytes) }, history: { path: 'history.json', sha256: sha256(historyBytes) },
    sourceFingerprints: await Promise.all(sourcePaths.map(async (path) => ({ path, sha256: sha256(await readFile(join(opts.projectRoot, path))) }))),
    provider: { baseUrl: provider.baseUrl, keySource: 'readLocalCodexProvider at run time; credential never archived' },
    budget: { cap: 3, perMeal: 1, independentLedger: true, reservationBeforeSend: true, retries: 0 },
    scope: 'three new frontend/high whole-image first passes against historical project concise/high and direct/high; no adaptive reviews or accuracy claim' };
  manifest.manifestSha256 = sha256(JSON.stringify(manifest));
  await writeJson(join(outputDir, 'manifest.json'), manifest, { key: provider.key, exclusive: true });
  const ledger = new RealMealTestLedger(join(outputDir, 'requests.sqlite'), frontendLedgerOptions(runId)); ledger.close();
  await writeJson(join(outputDir, 'results.json'), { schemaVersion: 'meal-frontend-results.v1', runId, ...offlineEvidence(opts), manifestSha256: manifest.manifestSha256, tasks: [], updatedAt: now() }, { exclusive: true });
  await assertArtifactsHaveNoSecret(outputDir, provider.key);
  return { outputDir, manifest };
}

export async function verifyFrontendFreeze(input = {}) {
  const opts = options(input), manifest = await json(join(opts.outputDir, 'manifest.json')), { manifestSha256, ...body } = manifest;
  verifyOfflineEvidence(opts, manifest);
  if (sha256(JSON.stringify(body)) !== manifestSha256 || manifest.runId !== opts.runId || manifest.schemaVersion !== 'meal-frontend-manifest.v1'
    || !same(manifest.config, FRONTEND_CONFIG) || !same(manifest.schedule, frontendSchedule(opts.runId, offlineInputs(opts)?.highInputs ?? HIGH_NUTRITION_INPUTS))
    || !same(manifest.sourceFingerprints.map((row) => row.path), sourcePaths)) throw new Error('Frontend experiment freeze changed.');
  for (const row of manifest.sourceFingerprints) if (sha256(await readFile(join(opts.projectRoot, row.path))) !== row.sha256) throw new Error(`Frozen source changed: ${row.path}`);
  for (const entry of [manifest.prompts, manifest.history]) if (sha256(await readFile(within(opts.outputDir, entry.path))) !== entry.sha256) throw new Error('Frozen prompt/history changed.');
  const prompts = await json(join(opts.outputDir, 'prompts.json'));
  if (prompts.frontend.instructions !== mealRecognitionInstructions('whole', [], [], 'frontend')) throw new Error('Frontend prompt changed.');
  for (const meal of manifest.meals) {
    const bytes = await readFile(within(opts.outputDir, meal.prepared.path));
    if (sha256(bytes) !== meal.prepared.sha256 || bytes.length !== meal.prepared.bytes) throw new Error('Frozen photo changed.');
  }
  const historical = await historicalInputs(opts);
  if (!same(manifest.meals, historical.meals) || !same(await json(join(opts.outputDir, 'history.json')), historical.history)) throw new Error('Historical artifacts changed.');
  return manifest;
}

async function acquireLock(outputDir, resume) {
  const path = join(outputDir, 'execution.lock'); let handle;
  try { handle = await open(path, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST' || !resume) throw new Error('Execution lock exists; resume only after prior process stops.');
    const saved = await json(path); let active = false;
    if (Number.isSafeInteger(saved.pid)) try { process.kill(saved.pid, 0); active = true; } catch (check) { if (check.code === 'EPERM') active = true; }
    if (active) throw new Error('The prior process is still active.');
    await unlink(path); handle = await open(path, 'wx', 0o600);
  }
  await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: now() })); await handle.sync();
  return async (keep) => { await handle.close(); if (!keep) await unlink(path); };
}
function checkMembership(manifest, attempts) {
  if (attempts.length > 3) throw new Error('Three-request cap exceeded.');
  for (const row of attempts) if (!manifest.schedule.some((task) => task.validationRunId === row.validationRunId && task.mealId === row.mealId
    && row.stage === 'whole' && row.model === 'gpt-6.1-sol' && row.reasoningEffort === 'high')) throw new Error('Unexpected ledger reservation.');
}
async function verifySavedTask(task, saved, prior, outputDir) {
  const recovered = await recoverTask(task, prior, outputDir);
  if (recovered.fatalPersistenceError) throw new Error(`Required archive/ledger failed: ${recovered.fatalPersistenceError}`);
  if (saved && (!same(saved.stages, recovered.stages) || saved.transportCompleted !== recovered.transportCompleted
    || saved.businessAccepted !== recovered.businessAccepted || saved.businessAccepted && (!same(saved.analysis, recovered.analysis) || !same(saved.recognition, recovered.recognition)))) throw new Error('Saved task differs from archived stage.');
  const record = saved ?? recovered;
  if (taskAccepted(record)) { mealAnalysisSchema.parse(record.analysis); validateFrontendMealRecognition(frontendMealRecognitionSnapshot(record.recognition)); }
  return record;
}

export async function runFrontendTrial(input = {}) {
  const opts = options(input), { outputDir, runId } = opts;
  if (!opts.live) throw new Error('Real execution requires --live.');
  const manifest = await verifyFrontendFreeze(opts), providerConfig = await (opts.providerReader ?? readLocalCodexProvider)();
  verifyOfflineProvider(opts, providerConfig, true);
  if (providerConfig.baseUrl !== manifest.provider.baseUrl) throw new Error('Provider URL changed after preparation.');
  if (await exists(join(outputDir, 'fatal-stop.json'))) throw new Error('A prior persistence or guard failure blocks further requests.');
  await assertArtifactsHaveNoSecret(outputDir, providerConfig.key);
  const release = await acquireLock(outputDir, opts.resume); let ledger, keepLock = false;
  const key = providerConfig.key;
  const stop = async (code) => { keepLock = true; await writeJson(join(outputDir, 'fatal-stop.json'), { code, at: now() }, { key }); };
  try {
    ledger = (opts.ledgerFactory ?? ((path, settings) => new RealMealTestLedger(path, settings)))(join(outputDir, 'requests.sqlite'), frontendLedgerOptions(runId));
    const results = await json(join(outputDir, 'results.json')), prompts = await json(join(outputDir, 'prompts.json')), attempts = ledger.attempts();
    if (results.runId !== runId || results.manifestSha256 !== manifest.manifestSha256 || results.fatalPersistenceError || !Array.isArray(results.tasks)
      || new Set(results.tasks.map((row) => row.taskId)).size !== results.tasks.length
      || results.tasks.some((row) => row.fatalPersistenceError || !manifest.schedule.some((task) => task.taskId === row.taskId))) throw new Error('Invalid saved results.');
    checkMembership(manifest, attempts);
    if (attempts.length && !opts.resume) throw Object.assign(new Error('Prior reservations exist; use --resume without resending.'), { code: 'resume_required' });
    const persist = async () => { results.updatedAt = now(); await (opts.resultsWrite ?? writeJson)(join(outputDir, 'results.json'), results, { key }); };
    for (const task of manifest.schedule) {
      const prior = attempts.filter((row) => row.validationRunId === task.validationRunId && row.mealId === task.mealId), saved = results.tasks.find((row) => row.taskId === task.taskId);
      if (!prior.length) { if (saved && saved.status !== 'not_attempted') throw new Error('Saved result has no reservation.'); continue; }
      const record = await verifySavedTask(task, saved, prior, outputDir); if (!saved) results.tasks.push(record);
    }
    await persist();
    const progress = async (event) => {
      const handle = await open(join(outputDir, 'progress.jsonl'), 'a', 0o600);
      try { await handle.writeFile(`${JSON.stringify(redactValue({ at: now(), ...event }, key))}\n`); await handle.sync(); } finally { await handle.close(); }
    };
    for (const task of manifest.schedule.filter((row) => !results.tasks.some((saved) => saved.taskId === row.taskId && saved.status !== 'not_attempted'))) {
      const meal = manifest.meals.find((row) => row.mealId === task.mealId), bytes = await readFile(within(outputDir, meal.prepared.path));
      const provider = { ...providerConfig, model: 'gpt-6.1-sol', reasoningEffort: 'high' }; let sent = 0, guardFatal = null, outbound = null;
      const guardedRequest = async (...args) => {
        if (args[4]?.promptProfile !== 'frontend' || args[4]?.timeoutMs !== 90000 || args[4]?.maxStages !== 1 || args[4]?.contract !== 'app') {
          guardFatal = 'frontend_options_mismatch'; throw new Error('Frontend stage options changed.');
        }
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async (url, init) => {
          try { validateFrozenRequest({ url, init, provider, manifest, task, prompts, imageBytes: bytes,
            reservedAttempts: ledger.attemptsForRun(task.validationRunId, task.mealId), sentCount: sent }); }
          catch (error) { guardFatal = 'outbound_guard_failed'; throw error; }
          outbound = { model: provider.model, reasoningEffort: provider.reasoningEffort, requestSha256: sha256(init.body), imageSha256: sha256(bytes), sent: false };
          try { await progress({ type: 'dispatch_ready', taskId: task.taskId, ...outbound }); }
          catch (error) { guardFatal = 'dispatch_audit_persistence_failed'; throw error; }
          sent += 1; outbound.sent = true; return originalFetch(url, init);
        };
        try { return await (opts.requestProvider ?? requestProvider)(...args); } finally { globalThis.fetch = originalFetch; }
      };
      const record = await runObservedMealTask({ task, ledger, provider, photo: `data:image/jpeg;base64,${bytes.toString('base64')}`,
        artifactDir: outputDir, requestProvider: guardedRequest, providerOptions: { promptProfile: 'frontend', contract: 'app', timeoutMs: 90000 },
        write: opts.artifactWrite ?? durableWrite, progress, clock: opts.clock ?? Date.now });
      record.outbound = outbound; record.fatalPersistenceError ??= guardFatal;
      if (record.businessAccepted && sent !== 1) record.fatalPersistenceError ??= 'missing_guarded_dispatch';
      if (record.stages[0]?.rawArtifact) {
        const raw = await readFile(within(outputDir, record.stages[0].rawArtifact)); record.output = archivedOutput(raw); record.supplierEcho = supplierEcho(raw);
      }
      results.tasks = [...results.tasks.filter((row) => row.taskId !== task.taskId), record];
      if (record.fatalPersistenceError) results.fatalPersistenceError = record.fatalPersistenceError;
      await persist(); await assertArtifactsHaveNoSecret(outputDir, key);
      if (record.fatalPersistenceError) throw new Error('Required archive, ledger or guard failed.');
    }
    const report = await reportFrontendTrial(opts); await assertArtifactsHaveNoSecret(outputDir, key); return report;
  } catch (error) {
    if (error.code === 'resume_required') throw error;
    await stop('trial_persistence_or_guard_failed'); throw error;
  } finally { ledger?.close(); await release(keepLock); }
}

export async function verifyFrontendArtifacts(input = {}) {
  const opts = options(input), manifest = await verifyFrontendFreeze(opts), results = await json(join(opts.outputDir, 'results.json'));
  const ledger = new RealMealTestLedger(join(opts.outputDir, 'requests.sqlite'), frontendLedgerOptions(opts.runId));
  let attempts; try { attempts = ledger.attempts(); } finally { ledger.close(); }
  checkMembership(manifest, attempts);
  if (results.manifestSha256 !== manifest.manifestSha256 || results.runId !== opts.runId || results.fatalPersistenceError
    || new Set(results.tasks.map((row) => row.taskId)).size !== results.tasks.length) throw new Error('Results identity or persistence failed.');
  for (const task of manifest.schedule) {
    const prior = attempts.filter((row) => row.mealId === task.mealId && row.validationRunId === task.validationRunId), saved = results.tasks.find((row) => row.taskId === task.taskId);
    if (prior.length) await verifySavedTask(task, saved, prior, opts.outputDir);
    else if (saved && saved.status !== 'not_attempted') throw new Error('Result without reservation.');
  }
  return { verified: true, reservedRequests: attempts.length, recordedDispatches: results.tasks.filter((row) => row.outbound?.sent).length,
    completeAndValid: results.tasks.filter(taskAccepted).length, cap: 3, metadataRequests: 0 };
}

function presentation(record, extra = {}) {
  const accepted = taskAccepted(record), stage = record?.stages?.[0], normalized = normalizeAnalysis(accepted ? record.analysis : null, accepted ? record.recognition : null);
  return { status: record?.status ?? 'not_attempted', businessAccepted: accepted, transportCompleted: stage?.transportCompleted === true,
    elapsedMs: record?.elapsedMs ?? null, timing: record?.timing ?? null, usage: stage?.usage ?? null, httpStatus: stage?.httpStatus ?? null,
    output: record?.output ?? extra.output ?? null, supplierEcho: record?.supplierEcho ?? extra.supplierEcho ?? null,
    rawArtifact: stage?.rawArtifact ?? null, error: record?.error ?? null, ...normalized,
    components: normalized.components.map((component, index) => ({ ...component,
      cookingMethod: record.analysis.components[index].cookingMethod ?? null, confidence: record.analysis.components[index].confidence ?? null,
      nutritionConfidence: record.analysis.components[index].source?.confidence ?? record.recognition?.components?.[index]?.nutritionEstimate?.confidence ?? null })) };
}
export function buildFrontendReport(manifest, results, history, ledger) {
  const meals = manifest.meals.map((meal) => ({ mealId: meal.mealId, label: meal.label, photo: meal.prepared.path, imageSha256: meal.prepared.sha256,
    ...Object.fromEntries(['project', 'direct'].map((arm) => {
      const entry = history.entries.find((row) => row.mealId === meal.mealId && row.arm === arm);
      return [arm, presentation(entry.record, entry)];
    })), frontend: presentation(results.tasks.find((row) => row.mealId === meal.mealId)) }));
  return { schemaVersion: 'meal-frontend-report.v1', runId: manifest.runId, generatedAt: now(), config: manifest.config, ledger,
    ...(manifest.evidence ? { evidence: manifest.evidence } : {}),
    promptCharacters: { project: history.prompts.project.instructions.length, direct: history.prompts.direct.instructions.length,
      frontend: mealRecognitionInstructions('whole', [], [], 'frontend').length }, meals,
    summary: Object.fromEntries(['project', 'direct', 'frontend'].map((arm) => [arm, { denominator: 3,
      completeAndValid: meals.filter((meal) => meal[arm].businessAccepted).length, completedTransports: meals.filter((meal) => meal[arm].transportCompleted).length,
      components: meals.reduce((sum, meal) => sum + meal[arm].components.length, 0),
      componentsWithReference: meals.flatMap((meal) => meal[arm].components).filter((component) => component.per100g !== null).length }])),
    limitations: ['本轮最多三次新 frontend/high 首轮请求；project concise/high 和 direct/high 均为历史结果，并非同期对照。',
      '同一冻结 JPEG；gpt-6.1-sol/high、Responses streaming、low 图片、8192 输出 tokens、90 秒、单阶段；无重试或复核。',
      '所有数值为可食用成品每 100 g 的近似参考；没有照片重量、实际份量或整餐总量。未识别饮品应保留并明确未知。',
      '无人工营养真值或盲评；耗时、完成率、区间宽度与组件数都不能证明营养准确性提升。',
      '失败的部分正文仅用于统计已观察长度，不能补成营养结果；供应商回显不能独立验证其内部模型。'] };
}
const md = (value) => String(value ?? '—').replaceAll('|', '\\|').replaceAll('\n', ' ');
const sec = (value) => value == null ? '—' : `${(value / 1000).toFixed(3)}s`;
const interval = (value) => value ? `${value.min}–${value.max}` : '未知';
export function renderFrontendMarkdown(report) {
  const lines = ['# 前端 JSON 协议首轮实测', '', ...report.limitations.map((line) => `- ${line}`), '',
    ...(report.evidence ? ['离线合成 fixture；仅验证代码，不是真实实验或营养质量证据。', ''] : []),
    `新账本预留 ${report.ledger.reservedRequests}/3，记录发出 ${report.ledger.recordedDispatches}/3；完整有效 ${report.summary.frontend.completeAndValid}/3。`, '',
    `提示字符：project ${report.promptCharacters.project}；direct ${report.promptCharacters.direct}；frontend ${report.promptCharacters.frontend}。`, '',
    '| 图片 | 历史 project | 历史 direct | 新 frontend |', '| --- | --- | --- | --- |'];
  for (const meal of report.meals) lines.push(`| ${meal.label} | ${['project', 'direct', 'frontend'].map((arm) => `${meal[arm].status} / ${sec(meal[arm].elapsedMs)} / ${meal[arm].output?.characters ?? '—'}字${meal[arm].output?.complete ? '' : '（部分）'}`).join(' | ')} |`);
  for (const meal of report.meals) {
    lines.push('', `## ${meal.label}`, '', `JPEG SHA256：${meal.imageSha256}`, '');
    for (const arm of ['project', 'direct', 'frontend']) {
      const row = meal[arm];
      lines.push(`### ${arm}`, '', `${row.status}；HTTP ${row.httpStatus ?? '—'}；传输完整=${row.transportCompleted}；业务有效=${row.businessAccepted}。主耗时 ${sec(row.elapsedMs)}；首正文 ${sec(row.timing?.firstTextMs)}。`, '',
        `时间线(ms)：${JSON.stringify(row.timing)}；usage：${JSON.stringify(row.usage)}；回显：${JSON.stringify(row.supplierEcho)}。`, '',
        '| 菜品 | 做法 | 识别/营养置信 | kcal/100g | 蛋白质g | 碳水g | 脂肪g |', '| --- | --- | --- | --- | --- | --- | --- |');
      for (const component of row.components) lines.push(`| ${md(component.label)} | ${md(component.cookingMethod)} | ${md(component.confidence)}/${md(component.nutritionConfidence)} | ${['calories', 'protein', 'carbs', 'fat'].map((key) => interval(component.per100g?.[key])).join(' | ')} |`);
      if (!row.components.length) lines.push('| 未获得完整有效结果 | — | — | 未知 | 未知 | 未知 | 未知 |');
      for (const component of row.components) lines.push('', `- ${md(component.label)}：配方依据 ${md(component.recipeBasis)}；假设 ${md(component.assumptions.join('；'))}；不确定性 ${md(component.uncertainty.join('；'))}。`);
      if (row.uncertainty.length) lines.push('', `全图未决：${md(row.uncertainty.join('；'))}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
export async function reportFrontendTrial(input = {}) {
  const opts = options(input), ledger = await verifyFrontendArtifacts(opts), manifest = await json(join(opts.outputDir, 'manifest.json'));
  const report = buildFrontendReport(manifest, await json(join(opts.outputDir, 'results.json')), await json(join(opts.outputDir, 'history.json')), ledger);
  await writeJson(join(opts.outputDir, 'report.json'), report);
  await durableWrite(join(opts.outputDir, 'report.md'), renderFrontendMarkdown(report));
  await writeJson(join(opts.outputDir, 'validation.json'), ledger);
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), command = args[0] ?? 'report', input = { live: args.includes('--live'), resume: args.includes('--resume') };
    for (const [flag, field] of [['--run-id', 'runId'], ['--output-dir', 'outputDir']]) if (args.includes(flag)) input[field] = args[args.indexOf(flag) + 1];
    const result = command === 'prepare' ? await prepareFrontendTrial(input) : command === 'run' ? await runFrontendTrial(input)
      : command === 'verify' ? await verifyFrontendArtifacts(input) : await reportFrontendTrial(input);
    process.stdout.write(`${JSON.stringify(result.meals ? { runId: result.runId, ledger: result.ledger, summary: result.summary, promptCharacters: result.promptCharacters,
      meals: result.meals.map((meal) => ({ label: meal.label, frontend: { status: meal.frontend.status, elapsedMs: meal.frontend.elapsedMs,
        firstTextMs: meal.frontend.timing?.firstTextMs, output: meal.frontend.output, supplierEcho: meal.frontend.supplierEcho,
        labels: meal.frontend.components.map((row) => row.label) } })), report: join(options(input).outputDir, 'report.md') }
      : result.manifest ? { outputDir: result.outputDir, runId: result.manifest.runId, cap: result.manifest.budget.cap } : result, null, 2)}\n`);
  } catch (error) { process.stderr.write(`${error.code ?? 'frontend_trial_failed'}: ${String(error.message).slice(0, 300)}\n`); process.exitCode = 1; }
}
