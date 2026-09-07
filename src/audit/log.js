/**
 * Append-only audit log.
 *
 * The interface exposes no update or delete operation, and the database refuses
 * both outright via triggers (DECISIONS.md #12) — nothing in the application
 * can rewrite history.
 */
import { AUDIT_EVENTS_TABLE } from '../db/schema.js';
import { AUDIT_SCHEMA_VERSION } from './events.js';
const INSERT_SQL = `
INSERT INTO ${AUDIT_EVENTS_TABLE}
  (schema_version, correlation_id, occurred_at, type, channel, actor_kind, telegram_user_id, chat_id, data)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`;
const SELECT_BY_CORRELATION_SQL = `
SELECT * FROM ${AUDIT_EVENTS_TABLE} WHERE correlation_id = ? ORDER BY occurred_at ASC, id ASC
`;
function toEvent(row) {
  return {
    id: row.id,
    schemaVersion: row.schema_version,
    correlationId: row.correlation_id,
    occurredAt: new Date(row.occurred_at),
    type: row.type,
    channel: row.channel,
    actor: {
      kind: row.actor_kind,
      ...(row.telegram_user_id !== null ? { telegramUserId: row.telegram_user_id } : {}),
      ...(row.chat_id !== null ? { chatId: row.chat_id } : {}),
    },
    data: JSON.parse(row.data),
  };
}
export function createAuditLog(deps) {
  // Prepared once; the statements are reused for the life of the process.
  const insert = deps.db.prepare(INSERT_SQL);
  const selectByCorrelation = deps.db.prepare(SELECT_BY_CORRELATION_SQL);
  return {
    record(input) {
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
    findByCorrelationId(correlationId) {
      const rows = selectByCorrelation.all(correlationId);
      return rows.map(toEvent);
    },
  };
}
