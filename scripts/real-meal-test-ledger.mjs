import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { LOCAL_MODEL, LOCAL_REASONING } from '../server/local-codex.mjs';

export const REAL_MEAL_LIMITS = Object.freeze({ totalRequests: 75, perMealRequests: 3, reviewMeals: 25, cohortMeals: 50 });
function ledgerLimits(input = {}) {
  const value = { ...REAL_MEAL_LIMITS, ...input };
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((key) => !Object.hasOwn(REAL_MEAL_LIMITS, key))
    || (value.totalRequests !== null && (!Number.isSafeInteger(value.totalRequests) || value.totalRequests < 1))
    || ![1, 2, 3].includes(value.perMealRequests)
    || !Number.isSafeInteger(value.reviewMeals) || value.reviewMeals < 0
    || !Number.isSafeInteger(value.cohortMeals) || value.cohortMeals < 1) throw new TypeError('Invalid explicit real-meal limits.');
  return Object.freeze(value);
}
const root = fileURLToPath(new URL('../', import.meta.url));
export const REAL_MEAL_LEDGER_PATHS = Object.freeze([
  resolve(root, 'artifacts/real-meal-request-ledger.sqlite'),
  resolve(root, 'artifacts/real-meal-request-ledger-batch-20261016.sqlite'),
]);

function pathKey(path) {
  let canonical = resolve(path);
  try { canonical = realpathSync.native(canonical); } catch {}
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

export function isExistingRealMealLedgerPath(path) {
  return typeof path === 'string' && path !== ':memory:' && REAL_MEAL_LEDGER_PATHS.some((known) => pathKey(known) === pathKey(path));
}

/** Known live ledgers always share a budget; unrelated temporary ledgers stay isolated. */
export function resolveRealMealLedgerPaths(path, { relatedLedgerPaths = [] } = {}) {
  if (path === ':memory:') {
    if (relatedLedgerPaths.length) throw new TypeError('An in-memory ledger cannot share a persistent request budget.');
    return [path];
  }
  if (typeof path !== 'string' || !path.trim() || !Array.isArray(relatedLedgerPaths)) throw new TypeError('Invalid ledger paths.');
  const paths = [path, ...(isExistingRealMealLedgerPath(path) ? REAL_MEAL_LEDGER_PATHS : []), ...relatedLedgerPaths];
  const unique = new Map();
  for (const candidate of paths) {
    if (typeof candidate !== 'string' || !candidate.trim() || candidate === ':memory:') throw new TypeError('Invalid related ledger path.');
    unique.set(pathKey(candidate), resolve(candidate));
  }
  return [...unique.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, value]) => value);
}

function existingFile(path) {
  try { if (statSync(path).isFile()) return; } catch {}
  throw new Error('An existing ledger in the shared request budget is missing or unreadable; no request was reserved.');
}

function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
}

function validText(value, label, maxLength = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength || /[\r\n\0]/.test(value)) {
    throw new TypeError(`Invalid ${label}.`);
  }
  return value.trim();
}

function cleanUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const usage = {};
  for (const key of ['input_tokens', 'output_tokens', 'total_tokens', 'cached_input_tokens', 'reasoning_tokens']) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) usage[key] = value[key];
  }
  return Object.keys(usage).length ? usage : null;
}

function attemptView(row) {
  return {
    attemptId: row.id,
    mealId: row.meal_id,
    validationRunId: row.validation_run_id,
    stage: row.stage,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    resultVersion: row.result_version,
    status: row.outcome ?? 'in_flight',
    startedAt: new Date(row.started_at_ms).toISOString(),
    elapsedMs: row.elapsed_ms,
    httpStatus: row.http_status,
    providerCompleted: row.provider_completed === null ? null : row.provider_completed === 1,
    resultAccepted: row.result_accepted === null ? null : row.result_accepted === 1,
    errorCode: row.error_code ?? null,
    errorName: row.error_name ?? null,
    usage: row.usage_json ? JSON.parse(row.usage_json) : null,
    rawResponseArtifact: row.raw_artifact,
  };
}

/** Local-only SQLite request counter for real-meal model checks; it has no cost accounting. */
export class RealMealTestLedger {
  constructor(path, options = {}) {
    this.limits = ledgerLimits(options.limits);
    const runLimits = options.runLimits ?? {};
    if (!runLimits || typeof runLimits !== 'object' || Array.isArray(runLimits)) throw new TypeError('Invalid run limits.');
    this.runLimits = Object.fromEntries(Object.entries(runLimits).sort(([a], [b]) => a.localeCompare(b)).map(([id, limits]) => {
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new TypeError('Invalid run ID in limits.');
      if (!limits || typeof limits !== 'object' || Array.isArray(limits) || Object.hasOwn(limits, 'totalRequests')) throw new TypeError('Invalid run limits.');
      return [id, ledgerLimits({ ...this.limits, ...limits })];
    }));
    const paths = resolveRealMealLedgerPaths(path, options);
    const activeKey = path === ':memory:' ? path : pathKey(path);
    const knownLiveLedger = isExistingRealMealLedgerPath(path);
    // Never silently recreate either historical live ledger or a missing peer.
    for (const scopedPath of paths) if (scopedPath !== ':memory:' && (knownLiveLedger || pathKey(scopedPath) !== activeKey)) existingFile(scopedPath);
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.allowProviderOverride = options.allowProviderOverride === true;
    this.connections = [this.db];
    this.closed = false;
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS attempts (
          id INTEGER PRIMARY KEY,
          meal_id TEXT NOT NULL,
          validation_run_id TEXT NOT NULL DEFAULT 'legacy',
          stage TEXT NOT NULL,
          model TEXT NOT NULL,
          reasoning_effort TEXT NOT NULL,
          result_version INTEGER NOT NULL,
          started_at_ms INTEGER NOT NULL,
          finished_at_ms INTEGER,
          elapsed_ms INTEGER,
          http_status INTEGER,
          provider_completed INTEGER,
          result_accepted INTEGER,
          outcome TEXT,
          usage_json TEXT,
          raw_artifact TEXT,
          error_code TEXT,
          error_name TEXT
        );
        CREATE INDEX IF NOT EXISTS attempts_meal ON attempts(meal_id, id);
        CREATE TABLE IF NOT EXISTS ledger_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      `);
      const columns = new Set(this.db.prepare('PRAGMA table_info(attempts)').all().map((column) => column.name));
      if (!columns.has('validation_run_id')) this.db.exec("ALTER TABLE attempts ADD COLUMN validation_run_id TEXT NOT NULL DEFAULT 'legacy'");
      if (!columns.has('error_code')) this.db.exec('ALTER TABLE attempts ADD COLUMN error_code TEXT');
      if (!columns.has('error_name')) this.db.exec('ALTER TABLE attempts ADD COLUMN error_name TEXT');
      this.db.exec('DROP INDEX IF EXISTS one_stage_per_meal');
      this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS one_stage_per_run_meal_stage ON attempts(validation_run_id,meal_id,stage)');
      transaction(this.db, () => {
        const stored = this.db.prepare('SELECT value FROM ledger_metadata WHERE key=?').get('limits');
        const limits = JSON.stringify(this.limits);
        if (stored && stored.value !== limits) throw new Error('Real-meal ledger limits do not match this runner version.');
        this.db.prepare('INSERT OR IGNORE INTO ledger_metadata(key,value) VALUES(?,?)').run('limits', limits);
        const runs = JSON.stringify(this.runLimits);
        const storedRuns = this.db.prepare('SELECT value FROM ledger_metadata WHERE key=?').get('run_limits');
        if (storedRuns && storedRuns.value !== runs) throw new Error('Real-meal ledger run limits do not match this runner version.');
        this.db.prepare('INSERT OR IGNORE INTO ledger_metadata(key,value) VALUES(?,?)').run('run_limits', runs);
      });
      this.scope = paths.map((scopedPath) => {
        const active = scopedPath === ':memory:' || pathKey(scopedPath) === activeKey;
        const db = active ? this.db : new DatabaseSync(scopedPath, { readOnly: true });
        if (!active) this.connections.push(db);
        db.exec('PRAGMA busy_timeout=5000');
        const peerColumns = new Set(db.prepare('PRAGMA table_info(attempts)').all().map((column) => column.name));
        if (!peerColumns.has('meal_id') || !peerColumns.has('stage') || !peerColumns.has('outcome')) {
          throw new Error('A ledger in the shared request budget has an invalid attempts table.');
        }
        return { path: scopedPath, active, db, hasRunId: peerColumns.has('validation_run_id') };
      });
      // Every writer locks the same existing database, then its active database.
      // SQLite releases these short locks after a crash; there is no stale PID file.
      // With an explicitly uncapped total, peers are audit history only. Never
      // acquire a write connection or transaction on those historical files.
      this.coordinator = this.limits.totalRequests === null || this.scope[0].active ? this.db : new DatabaseSync(this.scope[0].path);
      if (this.coordinator !== this.db) {
        this.connections.push(this.coordinator);
        this.coordinator.exec('PRAGMA busy_timeout=5000');
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }

  withBudgetLock(fn) {
    return transaction(this.coordinator, () => this.coordinator === this.db ? fn() : transaction(this.db, fn));
  }

  scopedRows() {
    return this.scope.flatMap(({ db, hasRunId }) => db.prepare(`SELECT meal_id,${hasRunId ? 'validation_run_id' : "'legacy' AS validation_run_id"},stage,outcome FROM attempts`).all());
  }

  reserve({ mealId, stage, model, reasoningEffort, resultVersion = 3, validationRunId = 'legacy', now = Date.now() }) {
    mealId = validText(mealId, 'meal ID');
    validationRunId = validText(validationRunId, 'validation run ID', 80);
    if (!/^[A-Za-z0-9_-]+$/.test(validationRunId)) throw new TypeError('Invalid validation run ID.');
    stage = validText(stage, 'stage');
    model = validText(model, 'model');
    reasoningEffort = validText(reasoningEffort, 'reasoning effort');
    if (!['whole', 'crop_review', 'final_merge'].includes(stage)) throw new TypeError('Invalid real-meal stage.');
    if (!this.allowProviderOverride && (model !== LOCAL_MODEL || reasoningEffort !== LOCAL_REASONING)) {
      throw new Error('The real-meal validation model and reasoning effort are fixed for this ledger.');
    }
    if (!Number.isSafeInteger(resultVersion) || resultVersion < 1) throw new TypeError('Invalid result version.');
    return this.withBudgetLock(() => {
      const allRows = this.scopedRows();
      const total = allRows.length;
      const runRows = allRows.filter((row) => row.validation_run_id === validationRunId);
      const mealRows = runRows.filter((row) => row.meal_id === mealId);
      const mealCount = mealRows.length;
      const limits = this.runLimits[validationRunId] ?? this.limits;
      if (mealCount >= limits.perMealRequests) throw new Error(`The ${limits.perMealRequests}-request per-meal validation limit has been reached.`);
      if (['whole', 'crop_review', 'final_merge'].indexOf(stage) >= limits.perMealRequests) throw new Error(`Stage ${stage} is not permitted by this run's ${limits.perMealRequests}-stage limit.`);
      const anyFirstPassAlreadyUsed = mealRows.some((row) => row.stage === 'whole');
      const existingStage = mealRows.some((row) => row.stage === stage);
      if (existingStage) throw new Error(`Stage ${stage} has already been attempted for this meal; retries are disabled.`);
      const initialMeals = new Set(runRows.filter((row) => row.stage === 'whole').map((row) => row.meal_id)).size;
      if (stage === 'whole' && !anyFirstPassAlreadyUsed && initialMeals >= limits.cohortMeals) {
        throw new Error(`The ${limits.cohortMeals} first-pass meal capacity has been reached.`);
      }
      if (stage !== 'whole') {
        const hasAcceptedFirstPass = mealRows.some((row) => row.stage === 'whole' && row.outcome === 'accepted');
        if (!hasAcceptedFirstPass) throw new Error('An accepted first-pass result is required before this meal can be reviewed.');
        if (stage === 'final_merge') {
          const hasAcceptedReview = mealRows.some((row) => row.stage === 'crop_review' && row.outcome === 'accepted');
          if (!hasAcceptedReview) throw new Error('An accepted crop review is required before a final merge.');
        }
        const distinctReviews = new Set(runRows.filter((row) => row.stage !== 'whole').map((row) => row.meal_id)).size;
        const hasReviewed = mealRows.some((row) => row.stage !== 'whole');
        if (!hasReviewed && distinctReviews >= limits.reviewMeals) {
          throw new Error(`The ${limits.reviewMeals}-meal additional-review limit has been reached.`);
        }
      }
      if (this.limits.totalRequests !== null && total >= this.limits.totalRequests) throw new Error(`The ${this.limits.totalRequests}-request real-meal validation limit has been reached.`);
      const result = this.db.prepare(`INSERT INTO attempts(meal_id,validation_run_id,stage,model,reasoning_effort,result_version,started_at_ms)
        VALUES(?,?,?,?,?,?,?)`).run(mealId, validationRunId, stage, model, reasoningEffort, resultVersion, now);
      return { attemptId: Number(result.lastInsertRowid) };
    });
  }

  finish(attemptId, { elapsedMs, httpStatus = null, providerCompleted = false, resultAccepted = false,
    usage = null, outcome = 'request_error', errorCode = null, errorName = null }) {
    if (!Number.isSafeInteger(attemptId) || attemptId < 1) throw new TypeError('Invalid attempt ID.');
    if (elapsedMs !== null && (!Number.isFinite(elapsedMs) || elapsedMs < 0)) throw new TypeError('Invalid elapsed time.');
    if (httpStatus !== null && (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599)) throw new TypeError('Invalid HTTP status.');
    outcome = validText(outcome, 'outcome', 64);
    if (outcome === 'accepted' && (providerCompleted !== true || resultAccepted !== true || httpStatus < 200 || httpStatus >= 300 || httpStatus === null)) {
      throw new TypeError('An accepted stage requires provider completion, an accepted business result and a successful HTTP status.');
    }
    errorCode ??= ({ timeout: 'upstream_timeout', format_error: 'invalid_model_response', http_error: 'upstream_unavailable',
      upstream_error: 'upstream_unavailable', request_error: 'upstream_request_error', transport_error: 'diagnostic_transport_failure' })[outcome] ?? null;
    const cleanError = (value) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(value) ? value : null;
    const cleanedUsage = cleanUsage(usage);
    const result = this.db.prepare(`UPDATE attempts SET finished_at_ms=?,elapsed_ms=?,http_status=?,provider_completed=?,
      result_accepted=?,outcome=?,usage_json=?,error_code=?,error_name=? WHERE id=? AND outcome IS NULL`).run(Date.now(), elapsedMs,
      httpStatus, providerCompleted ? 1 : 0, resultAccepted ? 1 : 0, outcome,
      cleanedUsage ? JSON.stringify(cleanedUsage) : null, cleanError(errorCode), cleanError(errorName), attemptId);
    return Number(result.changes) === 1;
  }

  setRawArtifact(attemptId, relativePath) {
    relativePath = validText(relativePath, 'artifact path', 500);
    if (relativePath.startsWith('/') || relativePath.includes('..') || /^[A-Za-z]:/.test(relativePath)) {
      throw new TypeError('Raw-response artifact path must stay inside the local artifact directory.');
    }
    const result = this.db.prepare('UPDATE attempts SET raw_artifact=? WHERE id=?').run(relativePath, attemptId);
    return Number(result.changes) === 1;
  }

  attempts(ids) {
    if (ids === undefined) return this.db.prepare('SELECT * FROM attempts ORDER BY id').all().map(attemptView);
    if (!Array.isArray(ids) || ids.some((id) => !Number.isSafeInteger(id))) throw new TypeError('Invalid attempt ID list.');
    return ids.map((id) => this.db.prepare('SELECT * FROM attempts WHERE id=?').get(id)).filter(Boolean).map(attemptView);
  }

  attemptsForRun(validationRunId, mealId) {
    validationRunId = validText(validationRunId, 'validation run ID', 80);
    if (!/^[A-Za-z0-9_-]+$/.test(validationRunId)) throw new TypeError('Invalid validation run ID.');
    const rows = mealId === undefined
      ? this.db.prepare('SELECT * FROM attempts WHERE validation_run_id=? ORDER BY id').all(validationRunId)
      : this.db.prepare('SELECT * FROM attempts WHERE validation_run_id=? AND meal_id=? ORDER BY id').all(validationRunId, validText(mealId, 'meal ID'));
    return rows.map(attemptView);
  }

  totals() {
    return this.withBudgetLock(() => {
      const rows = this.scopedRows();
      const perMeal = new Map();
      for (const row of rows) perMeal.set(row.meal_id, (perMeal.get(row.meal_id) ?? 0) + 1);
      const ledgers = this.scope.map(({ path, db, active }) => ({
        name: path === ':memory:' ? ':memory:' : basename(path), active,
        totalRequests: Number(db.prepare('SELECT COUNT(*) AS count FROM attempts').get().count),
      }));
      const localRequests = ledgers.find((ledger) => ledger.active).totalRequests;
      return {
        totalRequests: rows.length,
        localRequests,
        relatedRequests: rows.length - localRequests,
        remainingRequests: this.limits.totalRequests === null ? null : Math.max(0, this.limits.totalRequests - rows.length),
        budgetScope: this.scope.length > 1 ? (this.limits.totalRequests === null ? 'related-ledgers-read-only' : 'shared-existing-ledgers') : 'isolated-ledger',
        ledgerCount: this.scope.length,
        ledgers,
        perMeal: [...perMeal.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([mealId, requests]) => ({ mealId, requests })),
        reviewedMeals: new Set(rows.filter((row) => row.stage !== 'whole').map((row) => row.meal_id)).size,
        firstPassMeals: new Set(rows.filter((row) => row.stage === 'whole').map((row) => row.meal_id)).size,
      };
    });
  }

  close() {
    if (this.closed) return;
    for (const db of this.connections ?? []) { try { db.close(); } catch {} }
    this.closed = true;
  }
}
