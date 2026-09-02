/**
 * Append-only audit log.
 *
 * The interface exposes no update or delete operation, and the database refuses
 * both outright via triggers (DECISIONS.md #12) — nothing in the application
 * can rewrite history.
 */

import type { DatabaseSync, StatementSync } from 'node:sqlite';

import type { Logger } from '../logger.ts';
import { AUDIT_EVENTS_TABLE } from '../db/schema.ts';
import { AUDIT_SCHEMA_VERSION } from './events.ts';
import type { AuditEvent, AuditEventInput } from './events.ts';

export interface AuditLog {
  /** Append one event. Never throws — see the note in {@link createAuditLog}. */
  record(input: AuditEventInput): void;
  /** Read every event of one user turn, oldest first. */
  findByCorrelationId(correlationId: string): readonly AuditEvent[];
}

export interface AuditLogDeps {
  readonly db: DatabaseSync;
  readonly logger: Logger;
}

/** A row exactly as SQLite returns it. */
interface AuditEventRow {
  readonly id: number;
  readonly schema_version: number;
  readonly correlation_id: string;
  readonly occurred_at: string;
  readonly type: string;
  readonly channel: string;
  readonly actor_kind: string;
  readonly telegram_user_id: number | null;
  readonly chat_id: number | null;
  readonly data: string;
}

const INSERT_SQL = `
INSERT INTO ${AUDIT_EVENTS_TABLE}
  (schema_version, correlation_id, occurred_at, type, channel, actor_kind, telegram_user_id, chat_id, data)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const SELECT_BY_CORRELATION_SQL = `
SELECT * FROM ${AUDIT_EVENTS_TABLE} WHERE correlation_id = ? ORDER BY occurred_at ASC, id ASC
`;

function toEvent(row: AuditEventRow): AuditEvent {
  return {
    id: row.id,
    schemaVersion: row.schema_version,
    correlationId: row.correlation_id,
    occurredAt: new Date(row.occurred_at),
    type: row.type as AuditEvent['type'],
    channel: row.channel as AuditEvent['channel'],
    actor: {
      kind: row.actor_kind as AuditEvent['actor']['kind'],
      ...(row.telegram_user_id !== null ? { telegramUserId: row.telegram_user_id } : {}),
      ...(row.chat_id !== null ? { chatId: row.chat_id } : {}),
    },
    data: JSON.parse(row.data) as Record<string, unknown>,
  };
}

export function createAuditLog(deps: AuditLogDeps): AuditLog {
  // Prepared once; the statements are reused for the life of the process.
  const insert: StatementSync = deps.db.prepare(INSERT_SQL);
  const selectByCorrelation: StatementSync = deps.db.prepare(SELECT_BY_CORRELATION_SQL);

  return {
    record(input: AuditEventInput): void {
      try {
        insert.run(
          AUDIT_SCHEMA_VERSION,
          input.correlationId,
          new Date().toISOString(),
          input.type,
          input.channel,
          input.actor.kind,
          input.actor.telegramUserId ?? null,
          input.actor.chatId ?? null,
          JSON.stringify(input.data ?? {}),
        );
      } catch (error) {
        // A failed audit write must not take down request handling: dropping
        // the user's message would be a worse outcome than a gap in the log.
        // The failure is surfaced loudly instead.
        deps.logger.error('Failed to append audit event', {
          type: input.type,
          correlationId: input.correlationId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    },

    findByCorrelationId(correlationId: string): readonly AuditEvent[] {
      const rows = selectByCorrelation.all(correlationId) as unknown as AuditEventRow[];
      return rows.map(toEvent);
    },
  };
}
