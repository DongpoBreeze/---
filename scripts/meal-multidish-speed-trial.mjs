#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { access, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createParser } from 'eventsource-parser';
import { requestProvider } from '../src/ai-provider.ts';
import { offlineInputs, offlineEvidence, verifyOfflineProvider, verifyOfflineEvidence } from './meal-experiment-inputs.mjs';
import { readLocalCodexProvider } from '../server/local-codex.mjs';
import { RealMealTestLedger } from './real-meal-test-ledger.mjs';
import { runObservedMealTask, redactValue, assertArtifactsHaveNoSecret } from './meal-latency-capture.mjs';
import { durableWrite, validateFrozenRequest, recoverTask, DEFAULT_SOURCE_PATHS, PROJECT_ROOT } from './meal-latency-trial.mjs';
import { sha256, validRunId, emptyTask, taskAccepted } from './meal-latency-core.mjs';

export const MULTIDISH_CONFIG = Object.freeze({ model: 'gpt-6.1-sol', protocol: 'responses', stream: true,
  imageDetail: 'low', maxOutputTokens: 8192, promptProfile: 'concise', timeoutMs: 180000,
  historicalBaselineTimeoutMs: 90000, maxStages: 1, retries: 0, maxLocalRequests: 4 });
export const MULTIDISH_EFFORTS = Object.freeze(['medium', 'xhigh', 'high', 'max']);
export const MULTIDISH_INPUT = Object.freeze({ mealId: 'dinner_01_68aff31e000000001d015c77', label: '多菜晚餐',
  bytes: 236603, sha256: 'e557b5e9d32ff7f8b645949bd1394d1e0b4b776a093dc0d70300570fe36bef4f',
  instructionsSha256: '87334343fbbb083730bc1e21e3cbbb9b5e1e40d00470bb18642148dee0b2a888' });
const now = () => new Date().toISOString();
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const exists = async (path) => { try { await access(path); return true; } catch { return false; } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const codeOf = (error) => /^[A-Za-z0-9_.:-]{1,100}$/.test(error?.code ?? '') ? error.code : 'trial_failed';
const profiles = Object.fromEntries(MULTIDISH_EFFORTS.map((effort) => [effort, { promptProfile: 'concise', reasoningEffort: effort }]));
function options(input = {}) {
  const runId = validRunId(input.runId ?? '20261018-180s-v1');
  return { ...input, runId, projectRoot: resolve(input.projectRoot ?? PROJECT_ROOT),
    outputDir: resolve(input.outputDir ?? join(PROJECT_ROOT, 'artifacts', `meal-multidish-speed-${runId}`)),
    sourceOutputDir: resolve(input.sourceOutputDir ?? join(PROJECT_ROOT, 'artifacts/meal-latency-20261018-90s-v1')),
    effortOutputDir: resolve(input.effortOutputDir ?? join(PROJECT_ROOT, 'artifacts/meal-effort-speed-20261018-high-xhigh-v1')) };
}
async function writeJson(path, value, { key = '', exclusive = false } = {}) {
  const bytes = `${JSON.stringify(redactValue(value, key), null, 2)}\n`;
  if (exclusive) return durableWrite(path, bytes, { flag: 'wx' });
  const temporary = `${path}.${randomBytes(5).toString('hex')}.tmp`;
  await durableWrite(temporary, bytes, { flag: 'wx' }); await rename(temporary, path);
}
export function makeMultidishSchedule(runId, input = MULTIDISH_INPUT) {
  validRunId(runId);
  return MULTIDISH_EFFORTS.map((profile, index) => ({ taskId: `multidish:${profile}:${input.mealId}`,
    sequence: index + 1, mealId: input.mealId, profile, phase: 'multidish',
    validationRunId: `${runId}-${profile}`, maxStages: 1, timeoutMs: 180000 }));
}
export function multidishLedgerOptions(runId) {
  return { allowProviderOverride: true, limits: { totalRequests: 4, perMealRequests: 1, reviewMeals: 0, cohortMeals: 1 },
    runLimits: Object.fromEntries(MULTIDISH_EFFORTS.map((effort) => [`${runId}-${effort}`, { perMealRequests: 1, reviewMeals: 0, cohortMeals: 1 }])) };
}
/** Validate historical input artifacts themselves; old source fingerprints intentionally stay untouched. */
async function frozenInput(opts) {
  const fixture = offlineInputs(opts), expected = fixture
    ? { ...fixture.meals[2], instructionsSha256: fixture.conciseSha } : MULTIDISH_INPUT;
  const manifestBytes = await readFile(join(opts.sourceOutputDir, 'manifest.json')), manifest = JSON.parse(manifestBytes);
  verifyOfflineEvidence(opts, manifest);
  const { manifestSha256, ...body } = manifest;
  if (sha256(JSON.stringify(body)) !== manifestSha256) throw new Error('Historical manifest integrity failed.');
  const meal = manifest.meals.find((row) => row.mealId === expected.mealId);
  if (meal?.prepared.sha256 !== expected.sha256 || meal?.prepared.bytes !== expected.bytes
    || meal.prepared.path !== `photos/${expected.mealId}.jpg`) throw new Error('Historical meal metadata differs.');
  const photo = await readFile(join(opts.sourceOutputDir, meal.prepared.path));
  if (sha256(photo) !== expected.sha256 || photo.length !== expected.bytes) throw new Error('Historical JPEG changed.');
  const promptBytes = await readFile(join(opts.sourceOutputDir, manifest.prompts.path)), concise = JSON.parse(promptBytes).concise;
  if (sha256(promptBytes) !== manifest.prompts.sha256 || sha256(concise.instructions) !== expected.instructionsSha256
    || concise.instructionsSha256 !== expected.instructionsSha256 || sha256(concise.userText) !== concise.userTextSha256) throw new Error('Historical concise prompt changed.');
  return { photo, prompts: { concise }, meal: { mealId: meal.mealId, label: expected.label, prepared: meal.prepared },
    source: { runId: manifest.runId, manifestSha256, manifestFileSha256: sha256(manifestBytes), promptsSha256: sha256(promptBytes),
      providerSourceSha256: manifest.sourceFingerprints.find((row) => row.path === 'src/ai-provider.ts')?.sha256,
      verification: 'input artifact hashes only; historical source fingerprints are preserved, not rewritten for current code' } };
}
async function historicalReference(opts) {
  const samples = [], sources = [];
  for (const [directory, efforts, select] of [[opts.sourceOutputDir, ['medium'], (row) => row.phase === 'confirm' && row.profile === 'C'],
    [opts.effortOutputDir, ['high', 'xhigh'], (row) => ['high', 'xhigh'].includes(row.profile)]]) {
    const bytes = await readFile(join(directory, 'results.json')), result = JSON.parse(bytes);
    sources.push({ runId: result.runId, resultsSha256: sha256(bytes) });
    for (const effort of efforts) {
      const row = result.tasks.find((task) => task.mealId === (offlineInputs(opts)?.meals[2] ?? MULTIDISH_INPUT).mealId && select(task) && (effort === 'medium' || task.profile === effort));
      samples.push({ effort, timeoutMs: 90000, runId: result.runId, taskId: row?.taskId ?? null, status: row?.status ?? 'unavailable',
        elapsedMs: row?.elapsedMs ?? null, firstTextMs: row?.timing?.firstTextMs ?? null,
        transportCompleted: row?.transportCompleted === true, businessAccepted: taskAccepted(row), errorCode: row?.error?.code ?? null });
    }
  }
  return { label: '历史同图 90 秒请求，非同期对照；不是给原请求续时', sources, samples };
}
export async function prepareMultidishTrial(input = {}) {
  const opts = options(input), { outputDir, runId } = opts;
  if (await exists(join(outputDir, 'manifest.json'))) return { outputDir, manifest: await verifyMultidishFreeze(opts) };
  const source = await frozenInput(opts), provider = await (opts.providerReader ?? readLocalCodexProvider)();
  verifyOfflineProvider(opts, provider);
  const sourceFingerprints = await Promise.all([...DEFAULT_SOURCE_PATHS, 'scripts/meal-multidish-speed-trial.mjs']
    .map(async (path) => ({ path, sha256: sha256(await readFile(join(opts.projectRoot, path))) })));
  await mkdir(resolve(outputDir, '..'), { recursive: true }); await mkdir(outputDir, { mode: 0o700 });
  await mkdir(join(outputDir, 'photos')); await mkdir(join(outputDir, 'requests'));
  await durableWrite(join(outputDir, source.meal.prepared.path), source.photo, { flag: 'wx' });
  const promptText = `${JSON.stringify(source.prompts, null, 2)}\n`;
  const manifest = { schemaVersion: 'meal-multidish-speed-manifest.v1', runId, createdAt: now(), config: MULTIDISH_CONFIG, profiles, ...offlineEvidence(opts),
    schedule: makeMultidishSchedule(runId, source.meal), meals: [source.meal], prompts: { path: 'prompts.json', sha256: sha256(promptText) },
    provider: { baseUrl: provider.baseUrl, selectedModel: MULTIDISH_CONFIG.model, credentials: 'runtime only; never stored' },
    source: source.source, sourceFingerprints, historicalReference: await historicalReference(opts),
    budget: { cap: 4, scope: 'this experiment requests.sqlite only', perEffort: 1, historicalLedgersUsed: false },
    codeChange: 'Diagnostic MealProviderOptions.timeoutMs explicitly sets 180000 for this run; the historical comparison used 90000. The app default is maintained independently. Historical manifests and fingerprints are unchanged.' };
  manifest.manifestSha256 = sha256(JSON.stringify(manifest));
  await writeJson(join(outputDir, 'prompts.json'), source.prompts, { key: provider.key, exclusive: true });
  await writeJson(join(outputDir, 'manifest.json'), manifest, { key: provider.key, exclusive: true });
  const ledger = new RealMealTestLedger(join(outputDir, 'requests.sqlite'), multidishLedgerOptions(runId)); ledger.close();
  await writeJson(join(outputDir, 'results.json'), { schemaVersion: 'meal-multidish-speed-results.v1', runId,
    ...offlineEvidence(opts),
    manifestSha256: manifest.manifestSha256, updatedAt: now(), tasks: [] }, { exclusive: true });
  await assertArtifactsHaveNoSecret(outputDir, provider.key); await reportMultidishTrial(opts); return { outputDir, manifest };
}
export async function verifyMultidishFreeze(input = {}) {
  const opts = options(input), manifest = await json(join(opts.outputDir, 'manifest.json')), { manifestSha256, ...body } = manifest;
  verifyOfflineEvidence(opts, manifest);
  const expected = offlineInputs(opts)?.meals[2] ?? MULTIDISH_INPUT;
  if (manifest.schemaVersion !== 'meal-multidish-speed-manifest.v1' || manifest.runId !== opts.runId || sha256(JSON.stringify(body)) !== manifestSha256
    || !same(manifest.config, MULTIDISH_CONFIG) || !same(manifest.profiles, profiles) || !same(manifest.schedule, makeMultidishSchedule(opts.runId, expected))) throw new Error('Frozen multidish experiment changed.');
  for (const source of manifest.sourceFingerprints) if (sha256(await readFile(join(opts.projectRoot, source.path))) !== source.sha256) throw new Error(`Relevant frozen source changed: ${source.path}.`);
  const original = await frozenInput(opts), promptBytes = await readFile(join(opts.outputDir, manifest.prompts.path));
  if (!same(manifest.source, original.source) || sha256(promptBytes) !== manifest.prompts.sha256 || !same(JSON.parse(promptBytes), original.prompts)) throw new Error('Frozen concise input changed.');
  const bytes = await readFile(join(opts.outputDir, `photos/${expected.mealId}.jpg`));
  if (sha256(bytes) !== expected.sha256 || bytes.length !== expected.bytes || manifest.meals.length !== 1 || !same(manifest.meals[0], original.meal)) throw new Error('Frozen multidish JPEG changed.');
  return manifest;
}
/** Parse only safe metadata from the already archived same-reader prefix; never create another body reader. */
export function supplierEcho(bytes) {
  const models = [], efforts = [];
  const observe = (value) => {
    const row = value?.response ?? value;
    if (typeof row?.model === 'string' && /^[A-Za-z0-9._:/-]{1,200}$/.test(row.model) && !models.includes(row.model)) models.push(row.model);
    const effort = row?.reasoning?.effort ?? row?.reasoning_effort;
    if (typeof effort === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(effort) && !efforts.includes(effort)) efforts.push(effort);
  };
  const text = Buffer.from(bytes).toString('utf8');
  const parser = createParser({ onEvent: (event) => { try { observe(JSON.parse(event.data)); } catch {} } });
  try { parser.feed(text); } catch {} try { observe(JSON.parse(text)); } catch {}
  return { model: models.at(-1) ?? null, reasoningEffort: efforts.at(-1) ?? null, models, efforts,
    source: 'metadata in archived same-reader response prefix; not independent verification of supplier internals' };
}
async function acquireLock(outputDir, resume) {
  const path = join(outputDir, 'execution.lock'); let handle;
  try { handle = await open(path, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST' || !resume) throw new Error('Execution lock exists; only a stopped prior process may be resumed.');
    const saved = await json(path); let active = false;
    if (Number.isSafeInteger(saved.pid)) try { process.kill(saved.pid, 0); active = true; } catch (check) { if (check.code === 'EPERM') active = true; }
    if (active) throw new Error('The prior trial process is still active.');
    await unlink(path); handle = await open(path, 'wx', 0o600);
  }
  await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: now() })); await handle.sync();
  return async (keep) => { await handle.close(); if (!keep) await unlink(path); };
}
export async function runMultidishTrial(input = {}) {
  const opts = options(input), { outputDir, runId } = opts;
  if (!opts.live) throw new Error('Real analysis requires --live.');
  const manifest = await verifyMultidishFreeze(opts), providerConfig = await (opts.providerReader ?? readLocalCodexProvider)();
  verifyOfflineProvider(opts, providerConfig, true);
  if (manifest.provider.baseUrl !== providerConfig.baseUrl) throw new Error('Provider address changed after preparation.');
  if (await exists(join(outputDir, 'fatal-stop.json'))) throw new Error('A prior persistence failure blocks further requests.');
  await assertArtifactsHaveNoSecret(outputDir, providerConfig.key);
  const release = await acquireLock(outputDir, opts.resume); let ledger, keepLock = false;
  const key = providerConfig.key;
  const stop = async (code) => { keepLock = true; await writeJson(join(outputDir, 'fatal-stop.json'), { code, at: now() }, { key }); };
  try {
    ledger = (opts.ledgerFactory ?? ((path, settings) => new RealMealTestLedger(path, settings)))(join(outputDir, 'requests.sqlite'), multidishLedgerOptions(runId));
    const results = await json(join(outputDir, 'results.json')), prompts = await json(join(outputDir, 'prompts.json')), attempts = ledger.attempts();
    if (results.runId !== runId || results.manifestSha256 !== manifest.manifestSha256 || !Array.isArray(results.tasks)) throw new Error('Results and manifest disagree.');
    if (results.fatalPersistenceError || results.tasks.some((row) => row.fatalPersistenceError)) throw new Error('A prior persistence failure blocks further requests.');
    if (attempts.length && !opts.resume) throw Object.assign(new Error('Prior reservations exist; use --resume without resending.'), { code: 'resume_required' });
    for (const attempt of attempts) if (!manifest.schedule.some((task) => task.validationRunId === attempt.validationRunId && task.mealId === attempt.mealId
      && attempt.stage === 'whole' && attempt.model === manifest.config.model && attempt.reasoningEffort === task.profile)) throw new Error('Unexpected ledger reservation.');
    const persist = async () => {
      results.updatedAt = now();
      try { await (opts.resultsWrite ?? writeJson)(join(outputDir, 'results.json'), results, { key }); }
      catch { await stop('results_persistence_failed'); throw new Error('Results persistence failed; further requests stopped.'); }
    };
    for (const task of manifest.schedule) {
      const prior = attempts.filter((a) => a.validationRunId === task.validationRunId), saved = results.tasks.find((row) => row.taskId === task.taskId);
      if (saved && saved.status !== 'not_attempted' && !prior.length) throw new Error('Saved result has no reservation.');
      if (!prior.length) continue;
      const recovered = await recoverTask(task, prior, outputDir);
      if (recovered.fatalPersistenceError) { results.fatalPersistenceError = recovered.fatalPersistenceError; await persist(); await stop(recovered.fatalPersistenceError); throw new Error('Prior archive or ledger integrity failed.'); }
      if (saved && (!same(saved.stages.map((row) => row.attemptId), recovered.stages.map((row) => row.attemptId))
        || saved.transportCompleted !== recovered.transportCompleted || saved.businessAccepted !== recovered.businessAccepted)) throw new Error('Saved result and archived stage disagree.');
      if (!saved) {
        if (recovered.status === 'interrupted') recovered.elapsedMs = Math.max(180000, recovered.elapsedMs ?? 0);
        results.tasks.push(recovered);
      }
    }
    await persist();
    const progress = async (event) => {
      const handle = await open(join(outputDir, 'progress.jsonl'), 'a', 0o600);
      try { await handle.writeFile(`${JSON.stringify(redactValue({ at: now(), ...event }, key))}\n`); await handle.sync(); } finally { await handle.close(); }
    };
    for (const task of manifest.schedule.filter((task) => !results.tasks.some((row) => row.taskId === task.taskId && row.status !== 'not_attempted'))) {
      const bytes = await readFile(join(outputDir, manifest.meals[0].prepared.path)), provider = { ...providerConfig, model: manifest.config.model, reasoningEffort: task.profile };
      let sent = 0, guardFatal = null, outbound = null;
      const guardedRequest = async (...args) => {
        if (args[4]?.timeoutMs !== 180000 || args[4]?.maxStages !== 1) { guardFatal = 'diagnostic_options_mismatch'; throw new Error('Diagnostic stage deadline changed.'); }
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async (url, init) => {
          try { validateFrozenRequest({ url, init, provider, manifest, task, prompts, imageBytes: bytes,
            reservedAttempts: ledger.attemptsForRun(task.validationRunId, task.mealId), sentCount: sent }); }
          catch (error) { guardFatal = 'outbound_guard_failed'; throw error; }
          outbound = { model: provider.model, reasoningEffort: provider.reasoningEffort, timeoutMs: 180000,
            requestSha256: sha256(init.body), imageSha256: sha256(bytes), sent: false };
          try { await progress({ type: 'request_dispatch_ready', taskId: task.taskId, ...outbound }); }
          catch (error) { guardFatal = 'dispatch_audit_persistence_failed'; throw error; }
          sent += 1; outbound.sent = true; return originalFetch(url, init);
        };
        try { return await (opts.requestProvider ?? requestProvider)(...args); } finally { globalThis.fetch = originalFetch; }
      };
      const record = await runObservedMealTask({ task, ledger, provider, photo: `data:image/jpeg;base64,${bytes.toString('base64')}`,
        artifactDir: outputDir, requestProvider: guardedRequest, providerOptions: { promptProfile: 'concise', timeoutMs: 180000 },
        write: opts.artifactWrite ?? durableWrite, progress, clock: opts.clock ?? Date.now });
      record.outbound = outbound; record.fatalPersistenceError ??= guardFatal;
      if (record.businessAccepted && sent !== 1) record.fatalPersistenceError ??= 'missing_guarded_dispatch';
      if (record.stages[0]?.rawArtifact) record.supplierEcho = supplierEcho(await readFile(join(outputDir, record.stages[0].rawArtifact)));
      results.tasks = [...results.tasks.filter((row) => row.taskId !== task.taskId), record];
      if (record.fatalPersistenceError) results.fatalPersistenceError = record.fatalPersistenceError;
      await persist(); await assertArtifactsHaveNoSecret(outputDir, key);
      if (record.fatalPersistenceError) { await stop(record.fatalPersistenceError); throw new Error('Further requests stopped after persistence or guard failure.'); }
    }
    const report = await reportMultidishTrial(opts); await assertArtifactsHaveNoSecret(outputDir, key); return report;
  } catch (error) {
    if (codeOf(error) === 'resume_required') throw error;
    keepLock = true; if (!(await exists(join(outputDir, 'fatal-stop.json')))) try { await stop(codeOf(error)); } catch {}
    throw error;
  } finally { ledger?.close(); await release(keepLock); }
}
export function multidishAccountedElapsed(row) {
  const elapsed = Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0 ? row.elapsedMs : null;
  return row.status === 'timeout' || row.status === 'interrupted' || row.error?.code === 'timeout' ? Math.max(180000, elapsed ?? 0) : elapsed ?? 180000;
}
export function buildMultidishReport(manifest, results, ledger = {}) {
  const samples = manifest.schedule.map((task) => {
    const row = results.tasks.find((r) => r.taskId === task.taskId) ?? emptyTask(task), stage = row.stages?.[0], valid = taskAccepted(row);
    return { sequence: task.sequence, effort: task.profile, status: row.status, transportCompleted: row.transportCompleted, businessAccepted: valid,
      within90Seconds: valid && row.elapsedMs <= 90000, within180Seconds: valid && row.elapsedMs <= 180000,
      completedAfter90Seconds: valid && row.elapsedMs > 90000 && row.elapsedMs <= 180000,
      additionalWaitBeyond90Ms: valid && row.elapsedMs > 90000 ? row.elapsedMs - 90000 : null,
      elapsedMs: row.elapsedMs, accountedElapsedMs: multidishAccountedElapsed(row), archiveElapsedMs: row.archiveElapsedMs ?? null,
      timing: row.timing, httpStatus: stage?.httpStatus ?? null, error: row.error, usage: stage?.usage ?? null,
      requestedModel: manifest.config.model, supplierEcho: row.supplierEcho ?? { model: null, reasoningEffort: null },
      imageSha256: MULTIDISH_INPUT.sha256, imageBytes: MULTIDISH_INPUT.bytes, promptSha256: manifest.prompts.sha256,
      outbound: row.outbound ?? null, rawArtifact: stage?.rawArtifact ?? null, stageArtifact: stage?.stageArtifact ?? null,
      captureStatus: row.captureStatus, capture: stage?.capture ?? null };
  });
  return { schemaVersion: 'meal-multidish-speed-report.v1', runId: manifest.runId, generatedAt: now(), config: manifest.config,
    manifestSha256: manifest.manifestSha256, budget: manifest.budget, ledger, source: manifest.source, codeChange: manifest.codeChange,
    samples, summary: { denominator: 4, attempted: samples.filter((row) => row.status !== 'not_attempted').length,
      completed: samples.filter((row) => row.transportCompleted).length, valid: samples.filter((row) => row.businessAccepted).length,
      within90Seconds: samples.filter((row) => row.within90Seconds).length, within180Seconds: samples.filter((row) => row.within180Seconds).length,
      completedAfter90Seconds: samples.filter((row) => row.completedAfter90Seconds).length, allSampleAccountedElapsedMs: samples.map((row) => row.accountedElapsedMs) },
    historicalReference: manifest.historicalReference, fatalPersistenceError: results.fatalPersistenceError ?? null,
    metrics: { timeoutPenaltyMs: 180000, denominator: 4, thresholdDefinition: 'Complete transport and business validation, with primary elapsed <= threshold.',
      primaryElapsed: 'provider resolve/reject, excluding local raw/stage archive I/O',
      missingAndFailures: 'Missing elapsed uses 180000 ms; timeout/interruption uses max(180000, measured elapsed). Partial output is never success.' },
    limitations: ['每档只有一张同图请求，不能推断长期成功率、稳定速度排序或 SLA。', '这是四次新请求，历史 90 秒结果为非同期参考，并非对原请求续时。',
      '只诊断速度与业务格式校验，没有人工营养真值或质量优劣结论。', '回显 model/effort 仅记录供应商实际提供的元数据；缺失不以请求值填充，也不能独立验证内部执行强度。',
      'usage 仅记录上游报告值，包含 reasoning/cache；缺失不估算。', '旧实验源码指纹保持原样；新增诊断选项导致当前源码与旧指纹不同，不代表历史实验曾使用新代码。'] };
}
const seconds = (value) => Number.isFinite(value) ? `${(value / 1000).toFixed(3)}s` : '—';
export function renderMultidishMarkdown(report) {
  const lines = [`# 多菜图 180 秒推理强度补测：${report.runId}`, '',
    '同一冻结 JPEG，固定 gpt-6.1-sol、concise、Responses streaming、detail low、8192 输出 tokens；按 medium→xhigh→high→max 串行各一次，无复核、重试或降档。独立硬上限四次。', '',
    '本轮显式 timeoutMs=180000；历史对照使用 90000，App 的默认值由运行时代码独立维护。旧实验的源码指纹和产物保留，本轮自行冻结当前源码，仅按哈希验证旧图片/提示。', '',
    `预留 ${report.ledger.reservedRequests ?? 0}/4，记录实际 fetch ${report.ledger.recordedDispatches ?? 0}/4；完整且有效 ${report.summary.valid}/4。`, '',
    '| 顺序 / 强度 | 90秒内完整有效 | 180秒内完整有效 | 主耗时 | 首正文 | 完成 / 业务有效 | HTTP / 失败 | 回显模型 / 强度 |',
    '|---|---|---|---|---|---|---|---|'];
  for (const row of report.samples) lines.push(`| ${row.sequence} / ${row.effort} | ${row.within90Seconds} | ${row.within180Seconds} | ${seconds(row.elapsedMs)} | ${seconds(row.timing?.firstTextMs)} | ${row.transportCompleted} / ${row.businessAccepted} | ${row.httpStatus ?? '—'} / ${row.error?.code ?? '—'} | ${row.supplierEcho.model ?? '未回显'} / ${row.supplierEcho.reasoningEffort ?? '未回显'} |`);
  lines.push('', report.summary.completedAfter90Seconds ? `本轮有 ${report.summary.completedAfter90Seconds} 档在 90–180 秒之间完整有效返回；延长等待窗口保留了这些本会超过 90 秒的结果，代价是继续等待。` : '本轮没有观察到 90–180 秒之间完整有效返回的请求。', '');
  for (const row of report.samples.filter((r) => r.completedAfter90Seconds)) lines.push(`- ${row.effort}：主耗时 ${seconds(row.elapsedMs)}，超过 90 秒额外等待 ${seconds(row.additionalWaitBeyond90Ms)}。`);
  lines.push('', '主耗时冻结于 provider 返回/抛错，排除本地归档时间；部分正文不算成功。超时/中断在全四样本口径中至少计 180 秒，缺失耗时计 180 秒。首正文不含 reasoning。', '',
    '| 强度 | 响应头 | 首事件 | 首正文 | 首 delta | completed | 传输完成 | 业务校验 | 返回 | 主耗时 | 归档 | raw |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const row of report.samples) {
    const t = row.timing ?? {};
    lines.push(`| ${row.effort} | ${seconds(t.headersMs)} | ${seconds(t.firstEventMs)} | ${seconds(t.firstTextMs)} | ${seconds(t.firstTextDeltaMs)} | ${seconds(t.responseCompletedMs)} | ${seconds(t.transportCompletedMs)} | ${seconds(t.businessValidatedMs)} | ${seconds(t.returnedMs)} | ${seconds(row.elapsedMs)} | ${seconds(row.archiveElapsedMs)} | ${row.rawArtifact ? `[${row.captureStatus}](${row.rawArtifact})` : '—'} |`);
  }
  lines.push('', `JPEG：${MULTIDISH_INPUT.bytes} bytes；SHA256：\`${MULTIDISH_INPUT.sha256}\`。`, '', '逐次 usage（null 为上游缺失）及阶段存档：', '');
  for (const row of report.samples) lines.push(`- ${row.effort}：${JSON.stringify(row.usage)}；stage=${row.stageArtifact ?? '—'}。`);
  lines.push('', '**历史同图 90 秒请求：非同期参考，未给旧请求续时。**', '');
  for (const row of report.historicalReference.samples) lines.push(`- ${row.effort}：${row.status}；完整有效=${row.businessAccepted}；主耗时 ${seconds(row.elapsedMs)}；首正文 ${seconds(row.firstTextMs)}；来源 ${row.runId}。`);
  lines.push('', ...report.limitations.map((line) => `- ${line}`), ''); return lines.join('\n');
}
export async function reportMultidishTrial(input = {}) {
  const opts = options(input), manifest = await json(join(opts.outputDir, 'manifest.json')), results = await json(join(opts.outputDir, 'results.json'));
  if (results.runId !== opts.runId || results.manifestSha256 !== manifest.manifestSha256) throw new Error('Results and manifest disagree.');
  const db = new DatabaseSync(join(opts.outputDir, 'requests.sqlite'), { readOnly: true });
  let reservedRequests; try { reservedRequests = Number(db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n); } finally { db.close(); }
  const report = buildMultidishReport(manifest, results, { reservedRequests, cap: 4, remainingReservations: Math.max(0, 4 - reservedRequests),
    recordedDispatches: results.tasks.filter((row) => row.outbound?.sent === true).length });
  await writeJson(join(opts.outputDir, 'report.json'), report); await durableWrite(join(opts.outputDir, 'report.md'), renderMultidishMarkdown(report)); return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  (async () => {
    const [command, ...args] = process.argv.slice(2), input = {};
    for (let i = 0; i < args.length; i += 1) {
      if (['--live', '--resume'].includes(args[i])) input[args[i].slice(2)] = true;
      else if (args[i] === '--run-id' && args[i + 1]) input.runId = args[++i]; else throw new Error('Invalid trial argument.');
    }
    const result = command === 'prepare' ? await prepareMultidishTrial(input) : command === 'run' ? await runMultidishTrial(input)
      : command === 'report' ? await reportMultidishTrial(input) : command === 'verify' ? { verified: true, runId: (await verifyMultidishFreeze(input)).runId }
      : (() => { throw new Error('Use prepare | run --live [--resume] | report | verify [--run-id ID].'); })();
    process.stdout.write(`${JSON.stringify(result.manifest ? { prepared: true, runId: result.manifest.runId, outputDir: result.outputDir, analysisRequests: 0 }
      : result.samples ? { runId: result.runId, ledger: result.ledger, summary: result.summary, samples: result.samples.map(({ effort, status, elapsedMs, within90Seconds, within180Seconds, supplierEcho, usage }) =>
        ({ effort, status, elapsedMs, within90Seconds, within180Seconds, supplierEcho, usage })), report: join(options(input).outputDir, 'report.md') } : result, null, 2)}\n`);
  })().catch((error) => { process.stderr.write(`Multidish trial stopped (${codeOf(error)}): ${String(error.message).slice(0, 350)}\n`); process.exitCode = 1; });
}
