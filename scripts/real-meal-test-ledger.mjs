import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LOCAL_MODEL, LOCAL_REASONING } from '../server/local-codex.mjs';

export const REAL_MEAL_LIMITS = Object.freeze({ totalRequests: 75, perMealRequests: 3, reviewMeals: 25, cohortMeals: 50 });

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
    usage: row.usage_json ? JSON.parse(row.usage_json) : null,
    rawResponseArtifact: row.raw_artifact,
  };
}

/** Local-only SQLite request counter for real-meal model checks; it has no cost accounting. */
export class RealMealTestLedger {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
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
        raw_artifact TEXT
      );
      CREATE INDEX IF NOT EXISTS attempts_meal ON attempts(meal_id, id);
      CREATE TABLE IF NOT EXISTS ledger_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const columns = new Set(this.db.prepare('PRAGMA table_info(attempts)').all().map((column) => column.name));
    if (!columns.has('validation_run_id')) this.db.exec("ALTER TABLE attempts ADD COLUMN validation_run_id TEXT NOT NULL DEFAULT 'legacy'");
    this.db.exec('DROP INDEX IF EXISTS one_stage_per_meal');
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS one_stage_per_run_meal_stage ON attempts(validation_run_id,meal_id,stage)');
    transaction(this.db, () => {
      const stored = this.db.prepare('SELECT value FROM ledger_metadata WHERE key=?').get('limits');
      const limits = JSON.stringify(REAL_MEAL_LIMITS);
      if (stored && stored.value !== limits) throw new Error('Real-meal ledger limits do not match this runner version.');
      this.db.prepare('INSERT OR IGNORE INTO ledger_metadata(key,value) VALUES(?,?)').run('limits', limits);
    });
  }

  reserve({ mealId, stage, model, reasoningEffort, resultVersion = 2, validationRunId = 'legacy', now = Date.now() }) {
    mealId = validText(mealId, 'meal ID');
    validationRunId = validText(validationRunId, 'validation run ID', 80);
    if (!/^[A-Za-z0-9_-]+$/.test(validationRunId)) throw new TypeError('Invalid validation run ID.');
    stage = validText(stage, 'stage');
    model = validText(model, 'model');
    reasoningEffort = validText(reasoningEffort, 'reasoning effort');
    if (!['whole', 'crop_review', 'final_merge'].includes(stage)) throw new TypeError('Invalid real-meal stage.');
    if (model !== LOCAL_MODEL || reasoningEffort !== LOCAL_REASONING) {
      throw new Error('The real-meal validation model and reasoning effort are fixed for this ledger.');
    }
    if (!Number.isSafeInteger(resultVersion) || resultVersion < 1) throw new TypeError('Invalid result version.');
    return transaction(this.db, () => {
      const total = Number(this.db.prepare('SELECT COUNT(*) AS count FROM attempts').get().count);
      const mealCount = Number(this.db.prepare('SELECT COUNT(*) AS count FROM attempts WHERE validation_run_id=? AND meal_id=?').get(validationRunId, mealId).count);
      if (mealCount >= REAL_MEAL_LIMITS.perMealRequests) throw new Error('The 3-request per-meal validation limit has been reached.');
      const anyFirstPassAlreadyUsed = Boolean(this.db.prepare("SELECT 1 AS found FROM attempts WHERE validation_run_id=? AND meal_id=? AND stage='whole'").get(validationRunId, mealId));
      const existingStage = this.db.prepare('SELECT 1 AS found FROM attempts WHERE validation_run_id=? AND meal_id=? AND stage=?').get(validationRunId, mealId, stage);
      if (existingStage) throw new Error(`Stage ${stage} has already been attempted for this meal; retries are disabled.`);
      const initialMeals = Number(this.db.prepare("SELECT COUNT(DISTINCT meal_id) AS count FROM attempts WHERE validation_run_id=? AND stage='whole'").get(validationRunId).count);
      if (stage === 'whole' && !anyFirstPassAlreadyUsed && initialMeals >= REAL_MEAL_LIMITS.cohortMeals) {
        throw new Error('The 50 first-pass meal capacity has been reached.');
      }
      if (stage !== 'whole') {
        const hasAcceptedFirstPass = Boolean(this.db.prepare("SELECT 1 AS found FROM attempts WHERE validation_run_id=? AND meal_id=? AND stage='whole' AND outcome='accepted'").get(validationRunId, mealId));
        if (!hasAcceptedFirstPass) throw new Error('An accepted first-pass result is required before this meal can be reviewed.');
        if (stage === 'final_merge') {
          const hasAcceptedReview = Boolean(this.db.prepare("SELECT 1 AS found FROM attempts WHERE validation_run_id=? AND meal_id=? AND stage='crop_review' AND outcome='accepted'").get(validationRunId, mealId));
          if (!hasAcceptedReview) throw new Error('An accepted crop review is required before a final merge.');
        }
        const distinctReviews = Number(this.db.prepare("SELECT COUNT(DISTINCT meal_id) AS count FROM attempts WHERE validation_run_id=? AND stage<>'whole'").get(validationRunId).count);
        const hasReviewed = Boolean(this.db.prepare("SELECT 1 AS found FROM attempts WHERE validation_run_id=? AND meal_id=? AND stage<>'whole'").get(validationRunId, mealId));
        if (!hasReviewed && distinctReviews >= REAL_MEAL_LIMITS.reviewMeals) {
          throw new Error('The 25-meal additional-review limit has been reached.');
        }
      }
      if (total >= REAL_MEAL_LIMITS.totalRequests) throw new Error('The 75-request real-meal validation limit has been reached.');
      const result = this.db.prepare(`INSERT INTO attempts(meal_id,validation_run_id,stage,model,reasoning_effort,result_version,started_at_ms)
        VALUES(?,?,?,?,?,?,?)`).run(mealId, validationRunId, stage, model, reasoningEffort, resultVersion, now);
      return { attemptId: Number(result.lastInsertRowid) };
    });
  }

  finish(attemptId, { elapsedMs, httpStatus = null, providerCompleted = false, resultAccepted = false,
    usage = null, outcome = 'request_error' }) {
    if (!Number.isSafeInteger(attemptId) || attemptId < 1) throw new TypeError('Invalid attempt ID.');
    if (elapsedMs !== null && (!Number.isFinite(elapsedMs) || elapsedMs < 0)) throw new TypeError('Invalid elapsed time.');
    if (httpStatus !== null && (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599)) throw new TypeError('Invalid HTTP status.');
    outcome = validText(outcome, 'outcome', 64);
    const result = this.db.prepare(`UPDATE attempts SET finished_at_ms=?,elapsed_ms=?,http_status=?,provider_completed=?,
      result_accepted=?,outcome=?,usage_json=? WHERE id=? AND outcome IS NULL`).run(Date.now(), elapsedMs,
      httpStatus, providerCompleted ? 1 : 0, resultAccepted ? 1 : 0, outcome,
      cleanUsage(usage) ? JSON.stringify(cleanUsage(usage)) : null, attemptId);
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
    return {
      totalRequests: Number(this.db.prepare('SELECT COUNT(*) AS count FROM attempts').get().count),
      perMeal: this.db.prepare('SELECT meal_id AS mealId,COUNT(*) AS requests FROM attempts GROUP BY meal_id ORDER BY meal_id').all()
        .map((row) => ({ mealId: row.mealId, requests: Number(row.requests) })),
      reviewedMeals: Number(this.db.prepare("SELECT COUNT(DISTINCT meal_id) AS count FROM attempts WHERE stage<>'whole'").get().count),
      firstPassMeals: Number(this.db.prepare("SELECT COUNT(DISTINCT meal_id) AS count FROM attempts WHERE stage='whole'").get().count),
    };
  }

  close() { this.db.close(); }
}
