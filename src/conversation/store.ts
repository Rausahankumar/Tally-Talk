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
import type { DatabaseSync } from 'node:sqlite';

import { CONVERSATION_DRAFTS_TABLE } from '../db/schema.ts';
import type { TransactionDraft } from '../llm/schema.ts';
import type { DraftValidationResult } from '../validation/types.ts';
import type { ConversationDraftRow, ConversationStatus, PendingClarification } from './types.ts';

/** An abandoned draft (no activity) stops being confirmable after this long. */
export const DRAFT_EXPIRY_MS = 15 * 60 * 1000;

interface Row {
  readonly chat_id: number;
  readonly telegram_user_id: number;
  readonly draft_version_id: string;
  readonly status: string;
  readonly draft_json: string;
  readonly validation_json: string;
  readonly pending_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly expires_at: string;
}

function toRow(row: Row): ConversationDraftRow {
  return {
    chatId: row.chat_id,
    telegramUserId: row.telegram_user_id,
    draftVersionId: row.draft_version_id,
    status: row.status as ConversationStatus,
    draft: JSON.parse(row.draft_json) as TransactionDraft,
    validation: JSON.parse(row.validation_json) as DraftValidationResult,
    pending: row.pending_json === null ? null : (JSON.parse(row.pending_json) as PendingClarification),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    expiresAt: new Date(row.expires_at),
  };
}

const OPEN_STATUSES: readonly ConversationStatus[] = ['collecting', 'ready_for_confirmation'];

export interface ConversationStore {
  /**
   * The chat's current draft, or `null` if there isn't one. A row past its
   * expiry is lazily flipped to `expired` (and persisted) before being
   * returned — expiry is checked on read, not on a background timer, so no
   * scheduler is needed for an MVP at this scale.
   */
  getActiveDraft(chatId: number): ConversationDraftRow | null;

  /**
   * Create or fully replace the draft for one chat. Always mints a new
   * `draftVersionId`, which is exactly what invalidates any Confirm/Cancel
   * buttons already sent to the user for a previous version.
   */
  saveDraft(input: {
    readonly chatId: number;
    readonly telegramUserId: number;
    readonly status: ConversationStatus;
    readonly draft: TransactionDraft;
    readonly validation: DraftValidationResult;
    readonly pending: PendingClarification | null;
  }): ConversationDraftRow;

  /**
   * Set `status` only if the row for `chatId` still has exactly the given
   * `telegramUserId` and `draftVersionId`. Returns the updated row on success,
   * `null` if the row didn't match (superseded, wrong user, or already moved
   * past `ready_for_confirmation`) — the caller cannot tell *why* it failed
   * from this alone, by design; that judgement is made by the caller, which
   * knows the whole context (e.g. re-fetches to explain expiry vs. staleness).
   */
  setStatusIfCurrent(input: {
    readonly chatId: number;
    readonly telegramUserId: number;
    readonly draftVersionId: string;
    readonly expectedCurrentStatus: ConversationStatus;
    readonly newStatus: ConversationStatus;
  }): ConversationDraftRow | null;
}

export function createConversationStore(db: DatabaseSync): ConversationStore {
  const selectByChatId = db.prepare(
    `SELECT * FROM ${CONVERSATION_DRAFTS_TABLE} WHERE chat_id = ?`,
  );
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

  function readRaw(chatId: number): Row | undefined {
    return selectByChatId.get(chatId) as unknown as Row | undefined;
  }

  return {
    getActiveDraft(chatId: number): ConversationDraftRow | null {
      const raw = readRaw(chatId);
      if (raw === undefined) return null;

      if (OPEN_STATUSES.includes(raw.status as ConversationStatus) && new Date(raw.expires_at) <= new Date()) {
        expireRow.run(new Date().toISOString(), chatId);
        return toRow({ ...raw, status: 'expired' });
      }

      return toRow(raw);
    },

    saveDraft(input): ConversationDraftRow {
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

    setStatusIfCurrent(input): ConversationDraftRow | null {
      const result = conditionalUpdateStatus.run({
        chatId: input.chatId,
        telegramUserId: input.telegramUserId,
        draftVersionId: input.draftVersionId,
        expectedCurrentStatus: input.expectedCurrentStatus,
        newStatus: input.newStatus,
        updatedAt: new Date().toISOString(),
      });

      if (result.changes === 0) return null;
      return toRow(readRaw(input.chatId)!);
    },
  };
}
