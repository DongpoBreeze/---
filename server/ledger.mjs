import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
}

function calendar(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type).value;
  return { day: `${value('year')}-${value('month')}-${value('day')}`, month: `${value('year')}-${value('month')}` };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export class BudgetLedger {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version !== 0 && version !== 1) { this.db.close(); throw new Error('Unsupported ledger schema version'); }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ledger_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS request_ledger (
        installation_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('meal','summary')),
        status TEXT NOT NULL CHECK(status IN ('reserved','completed','failed')),
        billing_month TEXT NOT NULL,
        billing_day TEXT NOT NULL,
        cost_micros INTEGER NOT NULL CHECK(cost_micros > 0),
        created_at_ms INTEGER NOT NULL,
        lease_expires_at_ms INTEGER NOT NULL,
        finished_at_ms INTEGER,
        http_status INTEGER,
        error_code TEXT,
        PRIMARY KEY (installation_id, request_id)
      );
      CREATE INDEX IF NOT EXISTS ledger_month ON request_ledger(billing_month);
      CREATE INDEX IF NOT EXISTS ledger_day ON request_ledger(installation_id,billing_day);
      CREATE INDEX IF NOT EXISTS ledger_active ON request_ledger(status,created_at_ms);
      PRAGMA user_version=1;
    `);
    if (!this.db.prepare('PRAGMA table_info(request_ledger)').all().some((column) => column.name === 'lease_expires_at_ms')) {
      this.db.exec('ALTER TABLE request_ledger ADD COLUMN lease_expires_at_ms INTEGER NOT NULL DEFAULT 0');
      this.db.exec('UPDATE request_ledger SET lease_expires_at_ms=created_at_ms+65000');
    }
    transaction(this.db, () => {
      this.db.prepare('INSERT OR IGNORE INTO ledger_metadata(key,value) VALUES (?,?)').run('fingerprint_key', randomBytes(32).toString('hex'));
    });
    this.hashKey = this.db.prepare('SELECT value FROM ledger_metadata WHERE key=?').get('fingerprint_key').value;
  }

  fingerprint(input) {
    return createHmac('sha256', this.hashKey).update(canonicalJson({ kind: input.kind, payload: input.payload })).digest('hex');
  }

  reserve(input, config, now = new Date()) {
    const timestamp = now.getTime();
    const { day, month } = calendar(now, config.budgetTimezone);
    const fingerprint = this.fingerprint(input);
    return transaction(this.db, () => {
      // Interrupted upstream calls retain their full cost; an expired reservation is never refunded.
      this.db.prepare(`UPDATE request_ledger SET status='failed', http_status=410,
        error_code='request_interrupted', finished_at_ms=? WHERE status='reserved' AND lease_expires_at_ms < ?`).run(timestamp, timestamp);
      const existing = this.db.prepare('SELECT * FROM request_ledger WHERE installation_id=? AND request_id=?').get(input.installationId, input.requestId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) return { status: 'conflict' };
        return { status: 'replay', entry: existing };
      }
      const used = Number(this.db.prepare('SELECT COALESCE(SUM(cost_micros),0) AS total FROM request_ledger WHERE billing_month=?').get(month).total);
      if (used + config.maxRequestCostMicros > config.aiBudgetMicros) return { status: 'monthly_limit' };
      const count = Number(this.db.prepare('SELECT COUNT(*) AS total FROM request_ledger WHERE installation_id=? AND billing_day=?').get(input.installationId, day).total);
      if (count >= config.dailyQuota) return { status: 'daily_limit' };
      const active = Number(this.db.prepare("SELECT COUNT(*) AS total FROM request_ledger WHERE status='reserved'").get().total);
      const activeInstallation = Number(this.db.prepare("SELECT COUNT(*) AS total FROM request_ledger WHERE status='reserved' AND installation_id=?").get(input.installationId).total);
      if (active >= config.maxConcurrent || activeInstallation >= config.maxConcurrentPerInstallation) return { status: 'concurrent_limit' };
      this.db.prepare(`INSERT INTO request_ledger(installation_id,request_id,fingerprint,kind,status,billing_month,billing_day,cost_micros,created_at_ms,lease_expires_at_ms)
        VALUES(?,?,?,?,'reserved',?,?,?,?,?)`).run(input.installationId, input.requestId, fingerprint, input.kind, month, day, config.maxRequestCostMicros, timestamp, timestamp + config.upstreamTimeoutMs + 10_000);
      return { status: 'reserved', usedMicros: used + config.maxRequestCostMicros, month };
    });
  }

  finish(input, httpStatus, errorCode, now = new Date()) {
    return transaction(this.db, () => {
      const result = this.db.prepare(`UPDATE request_ledger SET status=?,http_status=?,error_code=?,finished_at_ms=?
        WHERE installation_id=? AND request_id=? AND status='reserved'`).run(httpStatus === 200 ? 'completed' : 'failed', httpStatus, errorCode || null, now.getTime(), input.installationId, input.requestId);
      return Number(result.changes) === 1;
    });
  }

  close() { this.db.close(); }
}
