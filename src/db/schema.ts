/**
 * Database schema and migrations.
 *
 * Applied automatically when the database is opened. SQLite's `user_version`
 * pragma tracks which migrations have run, so this is idempotent and safe on
 * every startup.
 */

import type { DatabaseSync } from 'node:sqlite';

import { AUDIT_ACTOR_KINDS, AUDIT_CHANNELS, AUDIT_EVENT_TYPES } from '../audit/events.ts';
import type { Logger } from '../logger.ts';

export const AUDIT_EVENTS_TABLE = 'audit_events';
export const TALLY_MASTERS_TABLE = 'tally_masters';

/** Render a string list as a SQL `IN (...)` value list. */
function sqlList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

/**
 * Migration 1 — the audit event log.
 *
 * The CHECK constraints accept the whole event vocabulary from the start, so
 * later phases emit their own event types without a migration. The two triggers
 * are what make the log genuinely append-only: no connection can rewrite or
 * remove an event, including the application's own (DECISIONS.md #12).
 */
const MIGRATION_1 = `
CREATE TABLE ${AUDIT_EVENTS_TABLE} (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  schema_version   INTEGER NOT NULL,
  correlation_id   TEXT    NOT NULL,
  occurred_at      TEXT    NOT NULL,
  type             TEXT    NOT NULL CHECK (type IN (${sqlList(AUDIT_EVENT_TYPES)})),
  channel          TEXT    NOT NULL CHECK (channel IN (${sqlList(AUDIT_CHANNELS)})),
  actor_kind       TEXT    NOT NULL CHECK (actor_kind IN (${sqlList(AUDIT_ACTOR_KINDS)})),
  telegram_user_id INTEGER,
  chat_id          INTEGER,
  data             TEXT    NOT NULL CHECK (json_valid(data))
);

-- Replay one user turn in order.
CREATE INDEX idx_audit_events_correlation
  ON ${AUDIT_EVENTS_TABLE} (correlation_id, occurred_at);

-- Recent activity across the deployment.
CREATE INDEX idx_audit_events_occurred_at
  ON ${AUDIT_EVENTS_TABLE} (occurred_at DESC);

-- One user's history, most recent first.
CREATE INDEX idx_audit_events_user
  ON ${AUDIT_EVENTS_TABLE} (telegram_user_id, occurred_at DESC);

CREATE TRIGGER ${AUDIT_EVENTS_TABLE}_no_update
BEFORE UPDATE ON ${AUDIT_EVENTS_TABLE}
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only: updates are not permitted');
END;

CREATE TRIGGER ${AUDIT_EVENTS_TABLE}_no_delete
BEFORE DELETE ON ${AUDIT_EVENTS_TABLE}
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only: deletes are not permitted');
END;
`;

/**
 * Migration 2 — the Tally master data cache.
 *
 * Unlike `audit_events`, this is a cache, not a log: `data` holds the whole raw
 * record as JSON so a new field Tally returns needs no migration, and a full
 * resync replaces rows for a given `master_type` outright (Phase 3 does no
 * incremental sync). `UNIQUE(master_type, name)` is what makes that replace
 * idempotent rather than accumulating duplicates across syncs.
 */
const MIGRATION_2 = `
CREATE TABLE ${TALLY_MASTERS_TABLE} (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  master_type   TEXT    NOT NULL,
  name          TEXT    NOT NULL,
  data          TEXT    NOT NULL CHECK (json_valid(data)),
  synced_at     TEXT    NOT NULL,
  UNIQUE (master_type, name)
);

CREATE INDEX idx_tally_masters_type ON ${TALLY_MASTERS_TABLE} (master_type);
`;

/** Ordered migrations. Append to this list; never edit an applied entry. */
const MIGRATIONS: readonly string[] = [MIGRATION_1, MIGRATION_2];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.length;

function currentVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  return row?.user_version ?? 0;
}

/**
 * Bring the database up to {@link LATEST_SCHEMA_VERSION}. Each migration runs in
 * a transaction, so a failure leaves the recorded version untouched rather than
 * half-applied.
 */
export function migrate(db: DatabaseSync, logger: Logger): void {
  const from = currentVersion(db);

  for (let version = from; version < MIGRATIONS.length; version += 1) {
    const migration = MIGRATIONS[version];
    if (migration === undefined) continue;

    db.exec('BEGIN');
    try {
      db.exec(migration);
      // PRAGMA does not accept a bound parameter; the value is a loop counter.
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    logger.info('Applied database migration', { version: version + 1 });
  }

  if (from !== LATEST_SCHEMA_VERSION) {
    logger.info('Database schema ready', { version: LATEST_SCHEMA_VERSION });
  }
}
