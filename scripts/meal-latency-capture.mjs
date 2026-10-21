import { createParser } from 'eventsource-parser';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { LATENCY_CONFIG, sha256 } from './meal-latency-core.mjs';

const cleanName = (value) => String(value).replace(/[^A-Za-z0-9_-]/g, '_');
export function credentialForms(key) {
  const forms = new Set();
  for (let level = 0, value = key; typeof value === 'string' && value && level < 9 && value.length <= 2 * 1024 * 1024; level += 1) {
    if (forms.has(value)) break;
    forms.add(value); value = JSON.stringify(value).slice(1, -1);
  }
  return [...forms].sort((a, b) => b.length - a.length);
}
export function redactSecrets(value, exactKey = '', { truncated = false } = {}) {
  let text = String(value);
  for (const form of credentialForms(exactKey)) text = text.replaceAll(form, '[REDACTED_CREDENTIAL]');
  text = text.replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]');
  // Reader errors, the HTTP prefix window and the local cap can all end mid-key.
  if (truncated && exactKey) {
    let longest = 0;
    for (const form of credentialForms(exactKey)) {
      const tail = text.slice(-Math.min(form.length - 1, text.length));
      for (let index = tail.indexOf(form[0]); index >= 0; index = tail.indexOf(form[0], index + 1)) {
        const candidate = tail.slice(index);
        if (form.startsWith(candidate)) { longest = Math.max(longest, candidate.length); break; }
      }
    }
    if (longest) text = `${text.slice(0, -longest)}[REDACTED_TRUNCATED_CREDENTIAL]`;
  }
  return text;
}
export function redactValue(value, key = '') {
  if (typeof value === 'string') return redactSecrets(value, key);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [redactSecrets(name, key), redactValue(item, key)]));
  return value;
}
export function redactRawBytes(bytes, key = '', options = {}) {
  // Latin-1 is a reversible byte view: invalid UTF-8 prefixes are preserved too.
  const text = Buffer.from(bytes).toString('latin1');
  const rawKey = Buffer.from(key, 'utf8').toString('latin1');
  return Buffer.from(redactSecrets(text, rawKey, options), 'latin1');
}
export function safeUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = { ...value,
    cached_input_tokens: value.cached_input_tokens ?? value.input_tokens_details?.cached_tokens ?? value.prompt_tokens_details?.cached_tokens,
    reasoning_tokens: value.reasoning_tokens ?? value.output_tokens_details?.reasoning_tokens ?? value.completion_tokens_details?.reasoning_tokens,
    input_tokens: value.input_tokens ?? value.prompt_tokens, output_tokens: value.output_tokens ?? value.completion_tokens };
  const usage = Object.fromEntries(['input_tokens', 'output_tokens', 'total_tokens', 'cached_input_tokens', 'reasoning_tokens']
    .filter((key) => Number.isSafeInteger(source[key]) && source[key] >= 0).map((key) => [key, source[key]]));
  return Object.keys(usage).length ? usage : null;
}

/** One bounded buffer attached to the provider's actual body reader, never Response.clone(). */
export class RawStreamCapture {
  constructor({ key = '', maxBytes = LATENCY_CONFIG.rawCaptureLimitBytes, clock = Date.now, startedAt = clock() } = {}) {
    this.key = key; this.maxBytes = maxBytes; this.clock = clock; this.startedAt = startedAt;
    this.chunks = []; this.observedBytes = 0; this.capturedBytes = 0; this.truncated = false; this.httpStatus = null;
    this.usage = null; this.transportCompleted = false; this.captureStatus = 'pending'; this.rawArtifact = null;
    this.timing = { headersMs: null, firstEventMs: null, firstTextMs: null, firstTextDeltaMs: null, responseCompletedMs: null,
      transportCompletedMs: null, businessValidatedMs: null, returnedMs: null, endMs: null };
    this.decoder = new TextDecoder();
    this.parser = createParser({ onEvent: (event) => {
      this.mark('firstEventMs');
      try {
        const value = JSON.parse(event.data);
        const type = value.type ?? event.event;
        if (type === 'response.output_text.delta' && typeof value.delta === 'string' && value.delta.length > 0) {
          this.mark('firstTextMs'); this.mark('firstTextDeltaMs');
        }
        if (type === 'response.output_text.done' && typeof value.text === 'string' && value.text.length > 0) this.mark('firstTextMs');
        if (type === 'response.completed') { this.mark('responseCompletedMs'); this.observeCompletedText(value.response); }
        const usage = safeUsage(value.response?.usage ?? value.usage); if (usage) this.usage = { ...this.usage, ...usage };
      } catch { /* Raw non-JSON and [DONE] are still archived. */ }
    } });
  }
  elapsed() { return Math.max(0, this.clock() - this.startedAt); }
  mark(name) { if (this.timing[name] === null) this.timing[name] = this.elapsed(); }
  observeCompletedText(response) {
    if (Array.isArray(response?.output) && response.output.some((item) => item?.type === 'message' && item.role === 'assistant'
      && Array.isArray(item.content) && item.content.some((part) => part?.type === 'output_text' && typeof part.text === 'string' && part.text.length > 0))) this.mark('firstTextMs');
  }
  observe(event) {
    if (Number.isInteger(event.httpStatus)) this.httpStatus = event.httpStatus;
    if (event.type === 'headers') this.mark('headersMs');
    if (event.type === 'chunk' && event.bytes instanceof Uint8Array) {
      this.observedBytes += event.bytes.byteLength;
      const remaining = Math.max(0, this.maxBytes - this.capturedBytes);
      if (remaining) {
        const saved = Buffer.from(event.bytes.subarray(0, remaining)); this.chunks.push(saved); this.capturedBytes += saved.length;
      }
      this.truncated = this.observedBytes > this.capturedBytes;
      // Timing observation is streaming too; never parse a clone or a 5-second snapshot.
      try { this.parser.feed(this.decoder.decode(event.bytes, { stream: true })); } catch { /* Provider owns validation. */ }
    }
    if (event.type === 'event') {
      this.mark('firstEventMs');
      if (event.eventType === 'response.completed') this.mark('responseCompletedMs');
    }
    if (event.type === 'transport_complete') {
      this.transportCompleted = true; this.mark('transportCompletedMs');
      if (this.timing.firstTextMs === null) try { this.observeCompletedText(JSON.parse(Buffer.concat(this.chunks).toString('utf8'))); } catch {}
    }
    const usage = safeUsage(event.usage); if (usage) this.usage = { ...this.usage, ...usage };
  }
  finish() {
    if (this.timing.endMs === null) this.timing.endMs = this.elapsed();
    if (!this.decoderFinished) {
      try { this.parser.feed(this.decoder.decode()); } catch {}
      this.decoderFinished = true;
      if (!this.usage) try { const value = JSON.parse(Buffer.concat(this.chunks).toString('utf8')); this.usage = safeUsage(value.usage ?? value.response?.usage); } catch {}
    }
  }
  async save(directory, relativePath, write = writeFile) {
    if (this.captureStatus !== 'pending') return this.captureStatus;
    this.finish();
    const target = resolve(directory, relativePath), rel = relative(resolve(directory), target);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Capture path must stay within the artifact directory.');
    const bytes = redactRawBytes(Buffer.concat(this.chunks), this.key, { truncated: true });
    try {
      await write(target, bytes, { flag: 'wx', mode: 0o600 });
      this.archivedBytes = bytes.length;
      this.artifactSha256 = sha256(bytes);
      this.captureStatus = this.truncated ? 'truncated' : this.observedBytes === 0 ? 'empty' : 'saved';
      this.rawArtifact = relativePath;
    } catch {
      this.captureStatus = 'save_failed'; this.saveError = 'raw_archive_write_failed';
    }
    return this.captureStatus;
  }
}

const errorCode = (error) => typeof error?.code === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(error.code) ? error.code : error?.name === 'AbortError' ? 'cancelled' : 'upstream_unavailable';
function outcomeFor(code) { return code === 'timeout' ? 'timeout' : code === 'invalid_response' ? 'format_error' : code === 'cancelled' ? 'interrupted' : 'request_error'; }

/** Shared orchestration for the new single-stage trial and the historical multi-stage A/B runner. */
export async function runObservedMealTask({ task, ledger, provider, photo, artifactDir, requestProvider,
  providerOptions = {}, clock = Date.now, progress = async () => {}, write = writeFile }) {
  await mkdir(join(artifactDir, 'requests'), { recursive: true, mode: 0o700 });
  const started = clock(), attempts = [], diagnostics = [];
  let fatal = null, reserveFailure = null, returnedEvent = null, thrown = null, response = null;
  let providerSettledAt = null, archiveElapsedMs = 0, archiveWhileProviderPendingMs = 0;
  const failPersistence = (code, attempt) => { fatal ??= code; if (attempt) attempt.persistenceError ??= code; };
  const settings = { baseUrl: provider.baseUrl, apiKey: provider.key, model: provider.model,
    reasoningEffort: provider.reasoningEffort, protocol: 'responses' };
  const find = (event) => attempts.find((row) => row.stage === event.stage && row.stageCount === event.stageCount);
  const stageRecord = (attempt) => {
    const c = attempt.capture;
    return { attemptId: attempt.attemptId, mealId: task.mealId, group: task.group ?? null, profile: task.profile ?? null,
      phase: task.phase ?? null, validationRunId: task.validationRunId, stage: attempt.stage, stageCount: attempt.stageCount,
      status: attempt.status ?? 'interrupted', transportCompleted: c.transportCompleted,
      businessAccepted: attempt.businessAccepted === true, providerCompleted: c.transportCompleted, accepted: attempt.businessAccepted === true,
      httpStatus: c.httpStatus, usage: c.usage, analysis: attempt.analysis ?? null, recognition: attempt.recognition ?? null,
      errorCode: attempt.errorCode ?? null, errorName: attempt.errorName ?? null,
      fatalPersistenceError: attempt.persistenceError ?? null,
      rawArtifact: c.rawArtifact, stageArtifact: attempt.stageArtifact ?? null, captureStatus: c.captureStatus,
      taskElapsedMs: providerSettledAt === null ? null : Math.max(0, providerSettledAt - started - archiveWhileProviderPendingMs),
      capture: { observedBytes: c.observedBytes, capturedBytes: c.capturedBytes, archivedBytes: c.archivedBytes ?? null, artifactSha256: c.artifactSha256 ?? null, truncated: c.truncated, maxBytes: c.maxBytes,
        scope: 'prefix observed in the actual provider reader', httpErrorMaxBytes: 65536, httpErrorReadWindowMs: 50,
        credentialBoundaryRedaction: 'always, including escaped credential prefixes',
        emptyMeaning: 'zero bytes observed by the reader, including the bounded HTTP error read window', saveError: c.saveError ?? null },
      timing: { ...c.timing, completeMs: c.timing.responseCompletedMs }, elapsedMs: c.timing.endMs ?? c.elapsed() };
  };
  const finishLedger = (attempt) => {
    if (attempt.ledgerFinished) return;
    attempt.capture.finish();
    try {
      const c = attempt.capture;
      const accepted = c.transportCompleted && attempt.businessAccepted === true;
      const changed = ledger.finish(attempt.attemptId, { elapsedMs: c.timing.endMs, httpStatus: c.httpStatus,
        providerCompleted: c.transportCompleted, resultAccepted: attempt.businessAccepted === true, usage: c.usage,
        outcome: accepted ? 'accepted' : outcomeFor(attempt.errorCode), errorCode: attempt.errorCode ?? null, errorName: attempt.errorName ?? null });
      if (changed !== true) throw new Error('Ledger finish did not persist.');
      attempt.ledgerFinished = true;
    } catch { failPersistence('ledger_finish_failed', attempt); }
  };
  const archive = async (attempt) => {
    const archiveStarted = clock();
    try {
    finishLedger(attempt);
    const raw = `requests/${cleanName(attempt.attemptId)}-${attempt.stage}.sse`;
    await attempt.capture.save(artifactDir, raw, write);
    if (attempt.capture.captureStatus === 'save_failed') failPersistence('raw_archive_write_failed', attempt);
    if (attempt.capture.rawArtifact && !attempt.rawRegistered) {
      try {
        if (ledger.setRawArtifact(attempt.attemptId, attempt.capture.rawArtifact) !== true) throw new Error('Raw path not saved.');
        attempt.rawRegistered = true;
      } catch { failPersistence('ledger_archive_registration_failed', attempt); }
    }
    attempt.stageArtifact = `requests/${cleanName(attempt.attemptId)}-${attempt.stage}.json`;
    try { await write(join(artifactDir, attempt.stageArtifact), `${JSON.stringify(redactValue(stageRecord(attempt), provider.key), null, 2)}\n`, { mode: 0o600 }); }
    catch { failPersistence('stage_archive_write_failed', attempt); }
    } finally {
      const elapsed = Math.max(0, clock() - archiveStarted);
      archiveElapsedMs += elapsed;
      if (providerSettledAt === null) archiveWhileProviderPendingMs += elapsed;
    }
  };
  const beforeRequest = async ({ stage, stageCount }) => {
    // A later stage cannot start until prior raw bytes and stage data are durable.
    for (const attempt of attempts) if (!attempt.rawRegistered) await archive(attempt);
    if (fatal) throw new Error('A required capture or ledger operation failed.');
    let reservation;
    try {
      reservation = ledger.reserve({ mealId: task.mealId, stage, model: provider.model, reasoningEffort: provider.reasoningEffort,
        validationRunId: task.validationRunId, resultVersion: 3 });
    } catch (error) { reserveFailure = errorCode(error); failPersistence('request_reservation_failed'); throw error; }
    const attempt = { attemptId: reservation.attemptId, stage, stageCount,
      capture: new RawStreamCapture({ key: provider.key, clock, startedAt: clock() }), status: 'in_flight', businessAccepted: false };
    attempts.push(attempt);
    try { await progress({ type: 'request_reserved', taskId: task.taskId ?? null, sequence: task.sequence,
      mealId: task.mealId, profile: task.profile ?? null, group: task.group ?? null, stage, attemptId: attempt.attemptId }); }
    catch { failPersistence('progress_persistence_failed', attempt); throw new Error('Reservation progress could not be persisted.'); }
  };
  const onTransport = (event) => { const attempt = find(event); if (attempt) attempt.capture.observe(event); };
  const onDiagnostic = (event) => {
    diagnostics.push(event);
    if (event.type === 'returned') {
      returnedEvent = event;
      const attempt = attempts.findLast((row) => row.stage === event.stage);
      attempt?.capture.mark('returnedMs');
      return;
    }
    const attempt = find(event);
    if (!attempt) return;
    const usage = safeUsage(event.usage); if (usage) attempt.capture.usage = { ...attempt.capture.usage, ...usage };
    if (typeof event.httpStatus === 'number' || typeof event.status === 'number') attempt.capture.httpStatus = event.httpStatus ?? event.status;
    if (event.transportCompleted === true) attempt.capture.transportCompleted = true;
    if (event.type === 'stage_result') {
      attempt.status = 'accepted'; attempt.businessAccepted = true; attempt.analysis = event.analysis; attempt.recognition = event.recognition;
      attempt.capture.mark('businessValidatedMs');
    } else if (event.type === 'stage_error') {
      attempt.status = outcomeFor(event.code); attempt.errorCode = event.code; attempt.errorName = null;
    } else return;
    finishLedger(attempt);
  };
  try {
    response = await requestProvider(settings, 'meal', { photos: [photo], photoRoles: ['before'] }, providerOptions.signal, {
      ...providerOptions, maxStages: task.maxStages ?? 1, beforeRequest, onTransport, onDiagnostic,
    });
    providerSettledAt = clock();
  } catch (error) { thrown = error; providerSettledAt = clock(); }
  finally {
    for (const attempt of attempts) {
      if (attempt.status === 'in_flight') {
        attempt.errorCode = thrown ? errorCode(thrown) : 'missing_stage_diagnostic';
        attempt.errorName = thrown?.name ?? null; attempt.status = outcomeFor(attempt.errorCode);
      }
      await archive(attempt);
    }
  }
  const stages = attempts.map(stageRecord);
  const returnedStage = returnedEvent?.stage ?? (response ? 'whole' : null);
  const selected = stages.findLast((row) => row.stage === returnedStage) ?? stages.at(-1);
  // Fix the business outcome time before any final archive I/O. Instrumentation
  // between old A/B stages is excluded too, so it cannot select the finalist.
  const providerWallElapsedMs = Math.max(0, providerSettledAt - started);
  const elapsedMs = Math.max(0, providerWallElapsedMs - archiveWhileProviderPendingMs);
  const error = thrown ? { code: errorCode(thrown), name: thrown?.name ?? 'Error', message: redactSecrets(String(thrown?.message ?? ''), provider.key).slice(0, 500) } : null;
  const result = { ...task, status: thrown ? error.code === 'timeout' ? 'timeout' : error.code === 'cancelled' ? 'interrupted'
    : error.code === 'invalid_response' ? 'schema_error' : error.code === 'request_not_started' ? 'not_sent' : 'request_error' : 'accepted',
    transportCompleted: selected?.transportCompleted === true, businessAccepted: response !== null && selected?.businessAccepted === true,
    captureStatus: stages.length === 1 ? stages[0].captureStatus : stages.some((row) => row.captureStatus === 'save_failed') ? 'save_failed' : stages.length ? 'saved' : 'not_started',
    workflowCompleted: response !== null && stages.length > 0 && stages.every((row) => row.transportCompleted && row.businessAccepted),
    stages, returnedStage, returnedAttemptId: response ? selected?.attemptId ?? null : null, fallbackReason: returnedEvent?.fallbackReason ?? null,
    analysis: response?.analysis ?? null, recognition: response ? selected?.recognition ?? null : null,
    elapsedMs, archiveElapsedMs, archiveWhileProviderPendingMs, providerWallElapsedMs,
    timing: selected ? { ...selected.timing, diagnosticReturnedMs: selected.timing.returnedMs,
      returnedMs: response ? elapsedMs : null, providerSettledMs: elapsedMs } : null, error,
    diagnostics: redactValue(diagnostics, provider.key),
    fatalPersistenceError: fatal, reservationError: reserveFailure };
  try { await progress({ type: 'task_finished', taskId: task.taskId ?? null, sequence: task.sequence,
    mealId: task.mealId, profile: task.profile ?? null, status: result.status, stages: stages.length }); }
  catch { result.fatalPersistenceError ??= 'progress_persistence_failed'; }
  result.runnerElapsedMs = Math.max(0, clock() - started);
  return redactValue(result, provider.key);
}

/** A credential check is read-only and also covers JSON/Markdown/error artifacts. */
export async function assertArtifactsHaveNoSecret(directory, key) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await assertArtifactsHaveNoSecret(path, key);
    else if (entry.isFile()) {
      const bytes = await readFile(path);
      if (credentialForms(key).some((form) => bytes.includes(Buffer.from(form)))) throw new Error('Credential found in a trial artifact; further paid calls are blocked.');
      if (!/\.(?:sqlite(?:-wal|-shm)?|jpg|jpeg|png)$/i.test(entry.name)
        && /Bearer\s+(?!\[REDACTED)[^\s"'<>]+/i.test(bytes.toString('utf8'))) throw new Error('Unredacted bearer credential found in a trial artifact.');
    }
  }
}
