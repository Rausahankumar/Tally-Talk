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
export const CONVERSATION_DRAFTS_TABLE = 'conversation_drafts';
export const TALLY_POSTINGS_TABLE = 'tally_postings';

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

/**
 * Migration 3 — widen `audit_events.type` to accept the Phase 6 event
 * vocabulary (draft.created, draft.updated, preview.shown,
 * confirmation.rejected — `user.confirmed`/`user.cancelled` were already
 * accepted, just unused until now).
 *
 * SQLite has no `ALTER TABLE ... DROP/ADD CONSTRAINT`. The standard, correct
 * way to change a CHECK constraint is to rename the table aside, recreate it
 * with the new constraint, copy the rows across, then drop the old one — done
 * explicitly here (including dropping and recreating the triggers and
 * indexes) rather than relying on however a given SQLite build treats
 * triggers across a bare table rename.
 */
const MIGRATION_3 = `
DROP TRIGGER ${AUDIT_EVENTS_TABLE}_no_update;
DROP TRIGGER ${AUDIT_EVENTS_TABLE}_no_delete;
ALTER TABLE ${AUDIT_EVENTS_TABLE} RENAME TO ${AUDIT_EVENTS_TABLE}_v1;

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

INSERT INTO ${AUDIT_EVENTS_TABLE}
  SELECT * FROM ${AUDIT_EVENTS_TABLE}_v1;

DROP TABLE ${AUDIT_EVENTS_TABLE}_v1;

CREATE INDEX idx_audit_events_correlation
  ON ${AUDIT_EVENTS_TABLE} (correlation_id, occurred_at);

CREATE INDEX idx_audit_events_occurred_at
  ON ${AUDIT_EVENTS_TABLE} (occurred_at DESC);

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
 * Migration 4 — per-chat conversation state.
 *
 * One row per Telegram chat (`chat_id` is the primary key): a chat has at most
 * one active draft at a time, and a new draft for the same chat replaces it
 * outright. Unlike `audit_events`, this is live, mutable state, not a log —
 * no append-only triggers here.
 *
 * `draft_version_id` is what makes Confirm/Cancel safe: it changes every time
 * the draft is created or materially updated, and is embedded in the inline
 * button's callback data. A confirm/cancel is only honoured if the version in
 * the callback still matches the version currently stored — anything else
 * (a superseded draft, a second tap on an old message, a forged callback) is
 * rejected server-side rather than trusted from the callback alone.
 */
const MIGRATION_4 = `
CREATE TABLE ${CONVERSATION_DRAFTS_TABLE} (
  chat_id           INTEGER PRIMARY KEY,
  telegram_user_id  INTEGER NOT NULL,
  draft_version_id  TEXT    NOT NULL,
  status            TEXT    NOT NULL CHECK (status IN ('collecting', 'ready_for_confirmation', 'confirmed', 'cancelled', 'expired')),
  draft_json        TEXT    NOT NULL CHECK (json_valid(draft_json)),
  validation_json   TEXT    NOT NULL CHECK (json_valid(validation_json)),
  pending_json      TEXT    CHECK (pending_json IS NULL OR json_valid(pending_json)),
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL,
  expires_at        TEXT    NOT NULL
);
`;

/**
 * Migration 5 — Tally posting attempts.
 *
 * `draft_version_id` is the primary key, not just an indexed column: it is
 * what makes "post this confirmed draft" safe to call more than once. The
 * first call's `INSERT` succeeds and proceeds to actually contact Tally; any
 * other call for the same draft version — a duplicate confirmation callback,
 * a concurrent request, a retry after the caller didn't see the first
 * response — fails the `INSERT` on the primary key, atomically, before it
 * gets anywhere near Tally. There is deliberately no retry path once a row
 * exists here, even for `failed` or `uncertain`: a second attempt cannot tell
 * whether the first one actually reached Tally, so investigating a stuck
 * row is a manual decision, not an automatic one (DECISIONS.md #25).
 */
const MIGRATION_5 = `
CREATE TABLE ${TALLY_POSTINGS_TABLE} (
  draft_version_id  TEXT PRIMARY KEY,
  status            TEXT NOT NULL CHECK (status IN ('posting', 'posted', 'failed', 'uncertain')),
  request_xml       TEXT NOT NULL,
  response_raw      TEXT,
  tally_voucher_id  TEXT,
  message           TEXT,
  created_at        TEXT NOT NULL,
  completed_at      TEXT
);
`;

/**
 * Migration 6 — widen `audit_events.type` again, this time for
 * `tally.posting.rejected` (a posting attempt refused before ever contacting
 * Tally: the draft was not confirmed, or a posting attempt already exists for
 * it). Same recreate-table technique as migration 3, for the same reason
 * (DECISIONS.md #24) — SQLite cannot alter a CHECK constraint in place.
 */
const MIGRATION_6 = `
DROP TRIGGER ${AUDIT_EVENTS_TABLE}_no_update;
DROP TRIGGER ${AUDIT_EVENTS_TABLE}_no_delete;
ALTER TABLE ${AUDIT_EVENTS_TABLE} RENAME TO ${AUDIT_EVENTS_TABLE}_v2;

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

INSERT INTO ${AUDIT_EVENTS_TABLE}
  SELECT * FROM ${AUDIT_EVENTS_TABLE}_v2;

DROP TABLE ${AUDIT_EVENTS_TABLE}_v2;

CREATE INDEX idx_audit_events_correlation
  ON ${AUDIT_EVENTS_TABLE} (correlation_id, occurred_at);

CREATE INDEX idx_audit_events_occurred_at
  ON ${AUDIT_EVENTS_TABLE} (occurred_at DESC);

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

/** Ordered migrations. Append to this list; never edit an applied entry. */
const MIGRATIONS: readonly string[] = [
  MIGRATION_1,
  MIGRATION_2,
  MIGRATION_3,
  MIGRATION_4,
  MIGRATION_5,
  MIGRATION_6,
];

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
