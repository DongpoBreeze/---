#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { access, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { requestProvider, discoverModels, discoverModel } from '../src/ai-provider.ts';
import { offlineInputs, offlineEvidence, verifyOfflineProvider, verifyOfflineEvidence } from './meal-experiment-inputs.mjs';
import { readLocalCodexProvider } from '../server/local-codex.mjs';
import { RealMealTestLedger } from './real-meal-test-ledger.mjs';
import { runObservedMealTask, redactValue, assertArtifactsHaveNoSecret } from './meal-latency-capture.mjs';
import { durableWrite, verifyLatencyFreeze, validateFrozenRequest, recoverTask, DEFAULT_SOURCE_PATHS, PROJECT_ROOT } from './meal-latency-trial.mjs';
import { sha256, validRunId, emptyTask, taskAccepted, summarizeProfile } from './meal-latency-core.mjs';
import { percentile } from './meal-ab-core.mjs';

export const EFFORT_SPEED_CONFIG = Object.freeze({ model: 'gpt-6.1-sol', protocol: 'responses', stream: true,
  imageDetail: 'low', maxOutputTokens: 8192, timeoutMs: 90000, maxStages: 1, retries: 0, maxLocalRequests: 6 });
export const EFFORT_SPEED_PROFILES = Object.freeze({ high: { promptProfile: 'concise', reasoningEffort: 'high' },
  xhigh: { promptProfile: 'concise', reasoningEffort: 'xhigh' } });
export const EFFORT_SPEED_MEALS = Object.freeze([
  { mealId: 'breakfast_01_67f8ed1f000000001e003951', label: '三明治', bytes: 151695, sha256: '63135201c3769384fb7f7f9c291b53f8a1fac2c4870fe28617288b4fc9289777' },
  { mealId: 'breakfast_04_6a2a52dc000000000702de33', label: '玉米', bytes: 7166, sha256: '5fb07ee8b76a71fb1d4cf3badd638afe60b170af6f7ee17a4117e44e1e977c67' },
  { mealId: 'dinner_01_68aff31e000000001d015c77', label: '多菜晚餐', bytes: 236603, sha256: 'e557b5e9d32ff7f8b645949bd1394d1e0b4b776a093dc0d70300570fe36bef4f' },
]);
const now = () => new Date().toISOString();
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const exists = async (path) => { try { await access(path); return true; } catch { return false; } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const codeOf = (error) => /^[A-Za-z0-9_.:-]{1,100}$/.test(error?.code ?? '') ? error.code : 'trial_failed';
function options(input = {}) {
  const runId = validRunId(input.runId ?? '20261018-high-xhigh-v1');
  return { ...input, runId, projectRoot: resolve(input.projectRoot ?? PROJECT_ROOT),
    outputDir: resolve(input.outputDir ?? join(PROJECT_ROOT, 'artifacts', `meal-effort-speed-${runId}`)),
    sourceOutputDir: resolve(input.sourceOutputDir ?? join(PROJECT_ROOT, 'artifacts/meal-latency-20261018-90s-v1')),
    sourceRunId: input.sourceRunId ?? '20261018-90s-v1' };
}
async function writeJson(path, value, { key = '', exclusive = false } = {}) {
  const bytes = `${JSON.stringify(redactValue(value, key), null, 2)}\n`;
  if (exclusive) return durableWrite(path, bytes, { flag: 'wx' });
  const temporary = `${path}.${randomBytes(5).toString('hex')}.tmp`;
  await durableWrite(temporary, bytes, { flag: 'wx' }); await rename(temporary, path);
}
export function makeEffortSpeedSchedule(runId, meals = EFFORT_SPEED_MEALS) {
  validRunId(runId);
  return meals.flatMap(({ mealId }, index) => (index === 1 ? ['xhigh', 'high'] : ['high', 'xhigh'])
    .map((profile) => ({ taskId: `speed:${profile}:${mealId}`, sequence: 0, mealId, profile, phase: 'speed',
      validationRunId: `${runId}-${profile}`, maxStages: 1 }))).map((task, index) => ({ ...task, sequence: index + 1 }));
}
export function effortSpeedLedgerOptions(runId) {
  return { allowProviderOverride: true, limits: { totalRequests: 6, perMealRequests: 1, reviewMeals: 0, cohortMeals: 3 },
    runLimits: Object.fromEntries(['high', 'xhigh'].map((effort) => [`${runId}-${effort}`, { perMealRequests: 1, reviewMeals: 0, cohortMeals: 3 }])) };
}

export async function prepareEffortSpeedTrial(input = {}) {
  const opts = options(input), { outputDir, projectRoot, sourceOutputDir, runId } = opts;
  const expectedMeals = offlineInputs(opts)?.meals ?? EFFORT_SPEED_MEALS;
  if (await exists(join(outputDir, 'manifest.json'))) return { outputDir, manifest: await verifyEffortSpeedFreeze(opts) };
  const source = await verifyLatencyFreeze({ projectRoot, outputDir: sourceOutputDir, runId: opts.sourceRunId,
    offlineFixture: opts.offlineFixture, providerReader: opts.providerReader });
  const provider = await (opts.providerReader ?? readLocalCodexProvider)();
  verifyOfflineProvider(opts, provider);
  const promptBytes = await readFile(join(sourceOutputDir, 'prompts.json'));
  const prompts = { concise: JSON.parse(promptBytes).concise };
  const sourceResultsBytes = await readFile(join(sourceOutputDir, 'results.json'));
  const sourceResults = JSON.parse(sourceResultsBytes);
  const meals = expectedMeals.map((expected) => {
    const meal = source.meals.find((row) => row.mealId === expected.mealId);
    if (!meal || meal.prepared.sha256 !== expected.sha256 || meal.prepared.bytes !== expected.bytes) throw new Error('Required frozen image differs.');
    return { mealId: meal.mealId, label: expected.label, prepared: { ...meal.prepared, path: `photos/${meal.mealId}.jpg` } };
  });
  const sourcePaths = [...DEFAULT_SOURCE_PATHS, 'scripts/meal-effort-speed-trial.mjs'];
  const sourceFingerprints = await Promise.all(sourcePaths.map(async (path) => ({ path, sha256: sha256(await readFile(join(projectRoot, path))) })));
  await mkdir(resolve(outputDir, '..'), { recursive: true }); await mkdir(outputDir, { mode: 0o700 });
  await mkdir(join(outputDir, 'photos')); await mkdir(join(outputDir, 'requests'));
  for (const meal of meals) {
    const bytes = await readFile(join(sourceOutputDir, meal.prepared.path));
    if (sha256(bytes) !== meal.prepared.sha256 || bytes.length !== meal.prepared.bytes) throw new Error('Frozen input bytes changed.');
    await durableWrite(join(outputDir, meal.prepared.path), bytes, { flag: 'wx' });
  }
  const historicalMedium = { label: '历史 medium 参考，非同期对照', phase: 'confirm', sourceRunId: source.runId,
    sourceResultsSha256: sha256(sourceResultsBytes), samples: meals.map(({ mealId }) => {
      const row = sourceResults.tasks.find((r) => r.mealId === mealId && r.profile === 'C' && r.phase === 'confirm');
      return { mealId, elapsedMs: row?.elapsedMs ?? null, firstTextMs: row?.timing?.firstTextMs ?? null,
        completed: row?.transportCompleted === true, valid: taskAccepted(row), sourceTaskId: row?.taskId ?? null };
    }) };
  const promptText = `${JSON.stringify(prompts, null, 2)}\n`;
  const manifest = { schemaVersion: 'meal-effort-speed-manifest.v1', runId, createdAt: now(), config: EFFORT_SPEED_CONFIG, ...offlineEvidence(opts),
    profiles: EFFORT_SPEED_PROFILES, provider: { baseUrl: provider.baseUrl, configuredModel: provider.model,
      configuredReasoningEffort: provider.reasoningEffort, selectedModel: EFFORT_SPEED_CONFIG.model, credentials: 'runtime only; never saved' },
    source: { runId: source.runId, manifestSha256: source.manifestSha256, promptsSha256: sha256(promptBytes) },
    meals, prompts: { path: 'prompts.json', sha256: sha256(promptText) }, sourceFingerprints,
    schedule: makeEffortSpeedSchedule(runId, expectedMeals), historicalMedium,
    budget: { cap: 6, scope: 'this experiment requests.sqlite only', perEffort: 3, historicalLedgersUsed: false } };
  manifest.manifestSha256 = sha256(JSON.stringify(manifest));
  await writeJson(join(outputDir, 'prompts.json'), prompts, { exclusive: true, key: provider.key });
  await writeJson(join(outputDir, 'manifest.json'), manifest, { exclusive: true, key: provider.key });
  const ledger = new RealMealTestLedger(join(outputDir, 'requests.sqlite'), effortSpeedLedgerOptions(runId)); ledger.close();
  await writeJson(join(outputDir, 'results.json'), { schemaVersion: 'meal-effort-speed-results.v1', runId,
    ...offlineEvidence(opts),
    manifestSha256: manifest.manifestSha256, updatedAt: now(), metadataDiscovery: null, tasks: [] }, { exclusive: true });
  await assertArtifactsHaveNoSecret(outputDir, provider.key);
  await reportEffortSpeedTrial(opts);
  return { outputDir, manifest };
}

export async function verifyEffortSpeedFreeze(input = {}) {
  const opts = options(input), manifest = await json(join(opts.outputDir, 'manifest.json'));
  const expectedMeals = offlineInputs(opts)?.meals ?? EFFORT_SPEED_MEALS;
  verifyOfflineEvidence(opts, manifest);
  const { manifestSha256, ...body } = manifest;
  if (manifest.runId !== opts.runId || manifest.schemaVersion !== 'meal-effort-speed-manifest.v1' || sha256(JSON.stringify(body)) !== manifestSha256
    || !same(manifest.config, EFFORT_SPEED_CONFIG) || !same(manifest.profiles, EFFORT_SPEED_PROFILES)
    || !same(manifest.schedule, makeEffortSpeedSchedule(opts.runId, expectedMeals))) throw new Error('Frozen effort-speed settings changed.');
  for (const entry of manifest.sourceFingerprints) if (sha256(await readFile(join(opts.projectRoot, entry.path))) !== entry.sha256) throw new Error(`Relevant frozen source changed: ${entry.path}.`);
  const prompts = await readFile(join(opts.outputDir, manifest.prompts.path));
  if (sha256(prompts) !== manifest.prompts.sha256) throw new Error('Frozen concise prompt changed.');
  const originalPrompts = await readFile(join(opts.sourceOutputDir, 'prompts.json'));
  if (sha256(originalPrompts) !== manifest.source.promptsSha256 || !same(JSON.parse(prompts).concise, JSON.parse(originalPrompts).concise)) throw new Error('Source concise prompt changed.');
  for (const expected of expectedMeals) {
    const meal = manifest.meals.find((row) => row.mealId === expected.mealId);
    if (!meal || meal.prepared.path !== `photos/${expected.mealId}.jpg` || meal.prepared.sha256 !== expected.sha256 || meal.prepared.bytes !== expected.bytes) throw new Error('Frozen input metadata changed.');
    const bytes = await readFile(join(opts.outputDir, meal.prepared.path));
    if (sha256(bytes) !== expected.sha256 || bytes.length !== expected.bytes) throw new Error('Frozen image changed.');
  }
  return manifest;
}

/** Read-only upstream discovery; metadata is evidence, never an automatic effort substitution. */
export async function discoverEffortCapabilities(provider) {
  const connection = { baseUrl: provider.baseUrl, apiKey: provider.key, protocol: 'responses' };
  const startedAt = now(), requests = [], originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url)), expected = new URL(provider.baseUrl);
    if ((init?.method ?? 'GET') !== 'GET' || parsed.origin !== expected.origin
      || ![`${expected.pathname.replace(/\/$/, '')}/models`, `${expected.pathname.replace(/\/$/, '')}/models/${EFFORT_SPEED_CONFIG.model}`].includes(parsed.pathname)) throw new Error('Metadata discovery attempted a non-read-only endpoint.');
    const row = { endpoint: parsed.pathname.endsWith('/models') ? 'models' : 'selected_model', startedAt: now(), httpStatus: null };
    requests.push(row);
    try { const response = await originalFetch(url, init); row.httpStatus = response.status; return response; }
    finally { row.finishedAt = now(); }
  };
  let selected = { id: EFFORT_SPEED_CONFIG.model, label: EFFORT_SPEED_CONFIG.model, reasoningEfforts: [], reasoningSource: 'unavailable' };
  const operations = [];
  try {
    try { const models = await discoverModels(connection); const found = models.find((row) => row.id === selected.id);
      if (found) selected = found; operations.push({ operation: 'list', status: found ? 'selected_model_found' : 'selected_model_not_listed' }); }
    catch (error) { operations.push({ operation: 'list', status: 'failed', errorCode: codeOf(error), httpStatus: error?.status ?? null }); }
    if (selected.reasoningSource !== 'upstream') {
      try { selected = await discoverModel(connection, selected); operations.push({ operation: 'detail', status: 'returned' }); }
      catch (error) { operations.push({ operation: 'detail', status: 'failed', errorCode: codeOf(error), httpStatus: error?.status ?? null }); }
    }
  } finally { globalThis.fetch = originalFetch; }
  return { startedAt, finishedAt: now(), readOnly: true, metadataGetCount: requests.length, requests, operations,
    selectedModel: selected.id, reasoningSource: selected.reasoningSource,
    reasoningEfforts: selected.reasoningEfforts, vision: selected.vision ?? null,
    requestedEfforts: Object.fromEntries(['high', 'xhigh'].map((effort) => [effort,
      selected.reasoningSource === 'upstream' ? selected.reasoningEfforts.includes(effort) ? 'declared_supported' : 'not_declared_supported' : 'unconfirmed'])),
    policy: 'Test explicitly requested high/xhigh unchanged; an unsupported response consumes its one attempt; no fallback or retry.' };
}

export async function runEffortSpeedTrial(input = {}) {
  const opts = options(input), { outputDir, runId } = opts;
  if (!opts.live) throw new Error('Real analysis requires --live.');
  const manifest = await verifyEffortSpeedFreeze(opts), providerConfig = await (opts.providerReader ?? readLocalCodexProvider)();
  verifyOfflineProvider(opts, providerConfig, true);
  if (manifest.provider.baseUrl !== providerConfig.baseUrl) throw new Error('Provider address changed after preparation.');
  await assertArtifactsHaveNoSecret(outputDir, providerConfig.key);
  if (await exists(join(outputDir, 'fatal-stop.json'))) throw new Error('A previous artifact or ledger persistence failure blocks further requests.');
  const lockPath = join(outputDir, 'execution.lock');
  // Fail closed on an existing lock, including a stale one; --resume never steals a running or failed writer's lock.
  const lock = await open(lockPath, 'wx', 0o600);
  await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: now() })); await lock.sync();
  let ledger, keepLock = false;
  const key = providerConfig.key;
  const stop = async (code) => { keepLock = true; await writeJson(join(outputDir, 'fatal-stop.json'), { at: now(), code }, { key }); };
  try {
    ledger = (opts.ledgerFactory ?? ((path, settings) => new RealMealTestLedger(path, settings)))(join(outputDir, 'requests.sqlite'), effortSpeedLedgerOptions(runId));
    const results = await json(join(outputDir, 'results.json')), prompts = await json(join(outputDir, 'prompts.json'));
    if (results.runId !== runId || results.manifestSha256 !== manifest.manifestSha256 || !Array.isArray(results.tasks)) throw new Error('Results do not match frozen manifest.');
    if (results.fatalPersistenceError || results.tasks.some((row) => row.fatalPersistenceError)) throw new Error('A previous artifact or ledger persistence failure blocks further requests.');
    const attempts = ledger.attempts();
    if (attempts.length && !opts.resume) throw Object.assign(new Error('Prior reservations exist; use --resume without resending them.'), { code: 'resume_required' });
    for (const attempt of attempts) if (!manifest.schedule.some((task) => task.validationRunId === attempt.validationRunId && task.mealId === attempt.mealId
      && attempt.stage === 'whole' && attempt.model === manifest.config.model && attempt.reasoningEffort === task.profile)) throw new Error('Ledger contains an unexpected reservation.');
    const persist = async () => {
      results.updatedAt = now();
      try { await (opts.resultsWrite ?? writeJson)(join(outputDir, 'results.json'), results, { key }); }
      catch { await stop('results_persistence_failed'); throw new Error('Results persistence failed; further requests stopped.'); }
    };
    for (const task of manifest.schedule) {
      const prior = attempts.filter((a) => a.validationRunId === task.validationRunId && a.mealId === task.mealId);
      const saved = results.tasks.find((row) => row.taskId === task.taskId);
      if (saved && saved.status !== 'not_attempted' && !prior.length) throw new Error('A task result has no durable reservation.');
      if (!prior.length) continue;
      const recovered = await recoverTask(task, prior, outputDir);
      if (recovered.fatalPersistenceError) { results.fatalPersistenceError = recovered.fatalPersistenceError; await persist(); await stop(recovered.fatalPersistenceError); throw new Error('Prior archive or ledger integrity failed; further requests stopped.'); }
      if (saved && (!same(saved.stages.map((row) => row.attemptId), recovered.stages.map((row) => row.attemptId))
        || saved.transportCompleted !== recovered.transportCompleted || saved.businessAccepted !== recovered.businessAccepted)) throw new Error('Saved task and durable stage disagree.');
      if (!saved) results.tasks.push(recovered);
    }
    await persist();
    const pending = manifest.schedule.filter((task) => !results.tasks.some((row) => row.taskId === task.taskId && row.status !== 'not_attempted'));
    if (pending.length && !results.metadataDiscovery) {
      results.metadataDiscovery = await discoverEffortCapabilities(providerConfig);
      await writeJson(join(outputDir, 'model-capabilities.json'), results.metadataDiscovery, { key }); await persist();
    }
    const progress = async (event) => {
      const handle = await open(join(outputDir, 'progress.jsonl'), 'a', 0o600);
      try { await handle.writeFile(`${JSON.stringify(redactValue({ at: now(), ...event }, key))}\n`); await handle.sync(); }
      finally { await handle.close(); }
    };
    for (const task of pending) {
      const meal = manifest.meals.find((row) => row.mealId === task.mealId), bytes = await readFile(join(outputDir, meal.prepared.path));
      const provider = { ...providerConfig, model: manifest.config.model, reasoningEffort: task.profile };
      let sent = 0, guardFatal = null, outbound = null;
      const guardedRequest = async (...args) => {
        if (args[4]?.timeoutMs !== manifest.config.timeoutMs || args[4]?.maxStages !== 1) {
          guardFatal = 'experiment_options_mismatch'; throw new Error('Experimental stage deadline changed.');
        }
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async (url, init) => {
          try { validateFrozenRequest({ url, init, provider, manifest, task, prompts, imageBytes: bytes,
            reservedAttempts: ledger.attemptsForRun(task.validationRunId, task.mealId), sentCount: sent }); }
          catch (error) { guardFatal = 'outbound_guard_failed'; throw error; }
          outbound = { model: provider.model, reasoningEffort: provider.reasoningEffort, requestSha256: sha256(init.body),
            imageSha256: sha256(bytes), sent: false };
          try { await progress({ type: 'request_dispatch_ready', taskId: task.taskId, ...outbound }); }
          catch (error) { guardFatal = 'dispatch_audit_persistence_failed'; throw error; }
          sent += 1; outbound.sent = true; return originalFetch(url, init);
        };
        try { return await (opts.requestProvider ?? requestProvider)(...args); }
        finally { globalThis.fetch = originalFetch; }
      };
      const record = await runObservedMealTask({ task, ledger, provider, photo: `data:image/jpeg;base64,${bytes.toString('base64')}`,
        artifactDir: outputDir, requestProvider: guardedRequest, providerOptions: { promptProfile: 'concise', timeoutMs: manifest.config.timeoutMs },
        write: opts.artifactWrite ?? durableWrite, progress, clock: opts.clock ?? Date.now });
      record.outbound = outbound; record.fatalPersistenceError ??= guardFatal;
      if (record.businessAccepted && sent !== 1) record.fatalPersistenceError ??= 'missing_guarded_dispatch';
      results.tasks = [...results.tasks.filter((row) => row.taskId !== task.taskId), record];
      if (record.fatalPersistenceError) results.fatalPersistenceError = record.fatalPersistenceError;
      await persist(); await assertArtifactsHaveNoSecret(outputDir, key);
      if (record.fatalPersistenceError) { await stop(record.fatalPersistenceError); throw new Error('Further requests stopped after artifact or ledger persistence failure.'); }
    }
    const report = await reportEffortSpeedTrial(opts);
    await assertArtifactsHaveNoSecret(outputDir, key); return report;
  } catch (error) {
    if (codeOf(error) === 'resume_required') throw error;
    keepLock = true;
    if (!(await exists(join(outputDir, 'fatal-stop.json')))) try { await stop(codeOf(error)); } catch {}
    throw error;
  } finally { ledger?.close(); await lock.close(); if (!keepLock) await unlink(lockPath); }
}

export function buildEffortSpeedReport(manifest, results, ledger = {}) {
  const rows = manifest.schedule.map((task) => results.tasks.find((row) => row.taskId === task.taskId) ?? emptyTask(task));
  const profiles = Object.fromEntries(['high', 'xhigh'].map((effort) => {
    const selected = rows.filter((row) => row.profile === effort), summary = summarizeProfile(selected, 3);
    const success = selected.filter(taskAccepted).map((row) => row.elapsedMs).filter(Number.isFinite);
    return [effort, { ...summary, successOnlyLatencyMs: { denominator: success.length, excludesFailures: true,
      median: percentile(success, 0.5), p90: percentile(success, 0.9), values: success } }];
  }));
  return { schemaVersion: 'meal-effort-speed-report.v1', runId: manifest.runId, generatedAt: now(), config: manifest.config,
    ...(manifest.evidence ? { evidence: manifest.evidence } : {}),
    manifestSha256: manifest.manifestSha256, budget: manifest.budget, ledger, metadataDiscovery: results.metadataDiscovery,
    profiles, samples: rows.map((row) => {
      const meal = manifest.meals.find((m) => m.mealId === row.mealId), stage = row.stages?.[0];
      return { sequence: row.sequence, mealId: row.mealId, label: meal.label, effort: row.profile, status: row.status,
        transportCompleted: row.transportCompleted, businessAccepted: taskAccepted(row), elapsedMs: row.elapsedMs,
        archiveElapsedMs: row.archiveElapsedMs ?? null, timing: row.timing, httpStatus: stage?.httpStatus ?? null,
        error: row.error, usage: stage?.usage ?? null, imageSha256: meal.prepared.sha256, imageBytes: meal.prepared.bytes,
        promptSha256: manifest.prompts.sha256, outbound: row.outbound ?? null, rawArtifact: stage?.rawArtifact ?? null,
        stageArtifact: stage?.stageArtifact ?? null, captureStatus: row.captureStatus, capture: stage?.capture ?? null };
    }), historicalMedium: manifest.historicalMedium, fatalPersistenceError: results.fatalPersistenceError ?? null,
    metrics: { percentile: 'linear interpolation at (n-1)*p', allSampleDenominatorPerEffort: 3,
      elapsed: 'provider resolve/reject time, excluding local raw/stage archive I/O',
      failures: 'All three assigned samples remain in denominator; timeout/interruption use max(90000, measured ms); missing elapsed uses 90000.',
      successOnly: 'Only transport-completed, business-accepted samples; separate denominator; never substitute for all-three metrics.' },
    limitations: ['每档只有三张样本，不能推断长期成功率或 SLA。', '只评估速度、传输完成及业务格式校验；没有人工营养真值或内容优劣结论。',
      '历史 medium 来自之前的确认阶段，非同期对照。', 'usage 仅使用上游报告值，缺失字段不估算。',
      '空 raw 表示实际读取器在限定窗口内观察到零字节；不能推断供应商之后没有响应体。'] };
}
const seconds = (value) => Number.isFinite(value) ? `${(value / 1000).toFixed(3)}s` : '—';
export function renderEffortSpeedMarkdown(report) {
  const lines = [`# high / xhigh 餐图速度补测：${report.runId}`, '',
    '固定 gpt-6.1-sol、concise 提示、Responses streaming、image detail low、8192 输出 tokens、90 秒超时；每图每档一次、串行、无重试、无复核或降档。独立预算上限六次。', '',
    `持久化预留 ${report.ledger.reservedRequests ?? 0}/6；记录实际调用 fetch ${report.ledger.recordedDispatches ?? 0}/6。`, '',
    '| 推理强度 | 传输完成 /3 | 完整且业务有效 /3 | 全三样本中位数 / P90 | 仅成功样本 n | 仅成功中位数 / P90 | 首段正文中位数 |',
    '|---|---:|---:|---|---:|---|---|'];
  for (const [effort, s] of Object.entries(report.profiles)) lines.push(`| ${effort} | ${s.completed}/3 | ${s.valid}/3 | ${seconds(s.latencyMs.median)} / ${seconds(s.latencyMs.p90)} | ${s.successOnlyLatencyMs.denominator} | ${seconds(s.successOnlyLatencyMs.median)} / ${seconds(s.successOnlyLatencyMs.p90)} | ${seconds(s.firstTextMs.median)} |`);
  const metadata = report.metadataDiscovery;
  lines.push('', `只读模型发现：${metadata ? `${metadata.metadataGetCount} 次 GET；推理元数据来源 ${metadata.reasoningSource}；high=${metadata.requestedEfforts.high}，xhigh=${metadata.requestedEfforts.xhigh}；上游明确列出 ${JSON.stringify(metadata.reasoningEfforts)}` : '尚未执行'}。未披露的强度标为未确认，仍按授权发送 high/xhigh；不支持响应计失败、不补发。`, '',
    '主耗时固定于 provider 成功返回或抛错，排除本地 raw/stage 归档耗时。全三样本统计包含失败；超时/中断至少计 90 秒。仅成功统计单独标明分母。P90 用线性插值，三样本仅供本次观察。首段正文排除 reasoning。', '',
    '| 序号 / 图片 | 强度 | 状态 / HTTP | 完成 / 有效 | 响应头 | 首事件 | 首正文 | completed 事件 | 业务校验 | 返回 | 主耗时 | 归档 | 错误 | raw |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const row of report.samples) {
    const t = row.timing ?? {};
    lines.push(`| ${row.sequence} / ${row.label} | ${row.effort} | ${row.status} / ${row.httpStatus ?? '—'} | ${row.transportCompleted} / ${row.businessAccepted} | ${seconds(t.headersMs)} | ${seconds(t.firstEventMs)} | ${seconds(t.firstTextMs)} | ${seconds(t.responseCompletedMs)} | ${seconds(t.businessValidatedMs)} | ${seconds(t.returnedMs)} | ${seconds(row.elapsedMs)} | ${seconds(row.archiveElapsedMs)} | ${row.error?.code ?? '—'} | ${row.rawArtifact ? `[${row.captureStatus}](${row.rawArtifact})` : '—'} |`);
  }
  lines.push('', '每次 usage（null 表示上游缺失）、输入哈希与存档：', '');
  for (const row of report.samples) lines.push(`- ${row.sequence} ${row.label}/${row.effort}：usage=${JSON.stringify(row.usage)}；JPEG ${row.imageBytes} bytes，SHA256 \`${row.imageSha256}\`；stage=${row.stageArtifact ?? '—'}。`);
  lines.push('', '**历史 medium 参考，非同期对照**：', '');
  for (const row of report.historicalMedium.samples) lines.push(`- ${row.mealId}：完成=${row.completed}，有效=${row.valid}，耗时 ${seconds(row.elapsedMs)}，首正文 ${seconds(row.firstTextMs)}。`);
  lines.push('', ...report.limitations.map((line) => `- ${line}`), ''); return lines.join('\n');
}
export async function reportEffortSpeedTrial(input = {}) {
  const opts = options(input), manifest = await json(join(opts.outputDir, 'manifest.json')), results = await json(join(opts.outputDir, 'results.json'));
  if (results.runId !== opts.runId || results.manifestSha256 !== manifest.manifestSha256) throw new Error('Results and manifest disagree.');
  const db = new DatabaseSync(join(opts.outputDir, 'requests.sqlite'), { readOnly: true });
  let reservedRequests; try { reservedRequests = Number(db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n); } finally { db.close(); }
  const report = buildEffortSpeedReport(manifest, results, { reservedRequests, cap: 6,
    remainingReservations: Math.max(0, 6 - reservedRequests), recordedDispatches: results.tasks.filter((row) => row.outbound?.sent === true).length });
  await writeJson(join(opts.outputDir, 'report.json'), report);
  await durableWrite(join(opts.outputDir, 'report.md'), renderEffortSpeedMarkdown(report)); return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  (async () => {
    const [command, ...args] = process.argv.slice(2), input = {};
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === '--live' || args[i] === '--resume') input[args[i].slice(2)] = true;
      else if (args[i] === '--run-id' && args[i + 1]) input.runId = args[++i];
      else throw new Error('Use prepare | run --live [--resume] | report | verify [--run-id ID].');
    }
    const result = command === 'prepare' ? await prepareEffortSpeedTrial(input) : command === 'run' ? await runEffortSpeedTrial(input)
      : command === 'report' ? await reportEffortSpeedTrial(input) : command === 'verify' ? { verified: true, runId: (await verifyEffortSpeedFreeze(input)).runId }
      : (() => { throw new Error('Use prepare | run --live [--resume] | report | verify.'); })();
    process.stdout.write(`${JSON.stringify(result.manifest ? { prepared: true, runId: result.manifest.runId, outputDir: result.outputDir, analysisRequests: 0 }
      : result.profiles ? { runId: result.runId, ledger: result.ledger, metadataDiscovery: result.metadataDiscovery, profiles: result.profiles,
        report: join(options(input).outputDir, 'report.md') } : result, null, 2)}\n`);
  })().catch((error) => { process.stderr.write(`Effort-speed trial stopped (${codeOf(error)}): ${String(error.message).slice(0, 350)}\n`); process.exitCode = 1; });
}
