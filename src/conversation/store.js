/**
 * Per-chat conversation state, backed by the `conversation_drafts` table.
 *
 * This is the enforcement point for Confirm/Cancel safety: `setStatusIfCurrent`
 * only changes anything when the caller's `chatId`, `telegramUserId`, and
 * `draftVersionId` all match the row exactly as currently stored — a stale
 * button (superseded draft), a duplicate tap (already confirmed), or a forged
 * callback for someone else's chat all fail the same way, deterministically,
 * with no special-casing per failure kind.
 */
import { randomUUID } from 'node:crypto';
import { CONVERSATION_DRAFTS_TABLE } from '../db/schema.js';
/** An abandoned draft (no activity) stops being confirmable after this long. */
export const DRAFT_EXPIRY_MS = 15 * 60 * 1000;
function toRow(row) {
  return {
    chatId: row.chat_id,
    telegramUserId: row.telegram_user_id,
    draftVersionId: row.draft_version_id,
    status: row.status,
    draft: JSON.parse(row.draft_json),
    validation: JSON.parse(row.validation_json),
    pending: row.pending_json === null ? null : JSON.parse(row.pending_json),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    expiresAt: new Date(row.expires_at),
  };
}
const OPEN_STATUSES = ['collecting', 'ready_for_confirmation'];
export function createConversationStore(db) {
  const selectByChatId = db.prepare(`SELECT * FROM ${CONVERSATION_DRAFTS_TABLE} WHERE chat_id = ?`);
  const upsert = db.prepare(`
    INSERT INTO ${CONVERSATION_DRAFTS_TABLE}
      (chat_id, telegram_user_id, draft_version_id, status, draft_json, validation_json, pending_json, created_at, updated_at, expires_at)
    VALUES (@chatId, @telegramUserId, @draftVersionId, @status, @draftJson, @validationJson, @pendingJson, @createdAt, @updatedAt, @expiresAt)
    ON CONFLICT(chat_id) DO UPDATE SET
      telegram_user_id = excluded.telegram_user_id,
      draft_version_id = excluded.draft_version_id,
      status = excluded.status,
      draft_json = excluded.draft_json,
      validation_json = excluded.validation_json,
      pending_json = excluded.pending_json,
      updated_at = excluded.updated_at,
      expires_at = excluded.expires_at
  `);
  const expireRow = db.prepare(
    `UPDATE ${CONVERSATION_DRAFTS_TABLE} SET status = 'expired', updated_at = ? WHERE chat_id = ?`,
  );
  const conditionalUpdateStatus = db.prepare(`
    UPDATE ${CONVERSATION_DRAFTS_TABLE}
    SET status = @newStatus, updated_at = @updatedAt
    WHERE chat_id = @chatId
      AND telegram_user_id = @telegramUserId
      AND draft_version_id = @draftVersionId
      AND status = @expectedCurrentStatus
  `);
  function readRaw(chatId) {
    return selectByChatId.get(chatId);
  }
  return {
    getActiveDraft(chatId) {
      const raw = readRaw(chatId);
      if (raw === undefined) return null;
      if (OPEN_STATUSES.includes(raw.status) && new Date(raw.expires_at) <= new Date()) {
        expireRow.run(new Date().toISOString(), chatId);
        return toRow({ ...raw, status: 'expired' });
      }
      return toRow(raw);
    },
    saveDraft(input) {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + DRAFT_EXPIRY_MS);
      const draftVersionId = randomUUID();
      upsert.run({
        chatId: input.chatId,
        telegramUserId: input.telegramUserId,
        draftVersionId,
        status: input.status,
        draftJson: JSON.stringify(input.draft),
        validationJson: JSON.stringify(input.validation),
        pendingJson: input.pending === null ? null : JSON.stringify(input.pending),
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      });
      return toRow({
        chat_id: input.chatId,
        telegram_user_id: input.telegramUserId,
        draft_version_id: draftVersionId,
        status: input.status,
        draft_json: JSON.stringify(input.draft),
        validation_json: JSON.stringify(input.validation),
        pending_json: input.pending === null ? null : JSON.stringify(input.pending),
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
        expires_at: expiresAt.toISOString(),
      });
    },
    setStatusIfCurrent(input) {
      const result = conditionalUpdateStatus.run({
        chatId: input.chatId,
        telegramUserId: input.telegramUserId,
        draftVersionId: input.draftVersionId,
        expectedCurrentStatus: input.expectedCurrentStatus,
        newStatus: input.newStatus,
        updatedAt: new Date().toISOString(),
      });
      if (result.changes === 0) return null;
      return toRow(readRaw(input.chatId));
    },
  };
}
