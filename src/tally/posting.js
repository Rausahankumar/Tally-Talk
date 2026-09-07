/**
 * Tally voucher posting: the write side, kept entirely separate from the
 * Phase 3 read-only export client (`client.js`/`xml.js`, both untouched by
 * this module).
 *
 * `postConfirmedTransaction` is the only entry point. It:
 *   1. Refuses to proceed unless the referenced draft is actually confirmed
 *      in `conversation_drafts` — never trusts a caller's say-so.
 *   2. Atomically claims the right to post this exact draft version via a
 *      primary-key `INSERT`; a duplicate call for the same version never
 *      reaches Tally a second time (DECISIONS.md #25).
 *   3. Sends the Import request and records whatever outcome resulted —
 *      posted, failed, or uncertain — before returning.
 *
 * There is no HTTP route anywhere that calls this. It is only ever invoked
 * from trusted, internal application code with an already-confirmed draft.
 */
import { randomUUID } from 'node:crypto';
import { CONVERSATION_DRAFTS_TABLE, TALLY_POSTINGS_TABLE } from '../db/schema.js';
import { checkPostingReadiness } from '../gst/postingReadiness.js';
import { buildSalesVoucherXml, parseImportResponse } from './postingXml.js';
const DEFAULT_TIMEOUT_MS = 15_000;
export function createTallyPostingClient(options) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `http://${options.host}:${options.port}`;
  return {
    async importVoucher(xml) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'text/xml' },
          body: xml,
          signal: controller.signal,
        });
      } catch (error) {
        // Network failure or a timed-out request: Tally may have received and
        // even processed this before the connection dropped. Never assumed
        // to be a failure — see the module doc and DECISIONS.md #25.
        return {
          outcome: 'uncertain',
          message: `Could not confirm the outcome: ${error instanceof Error ? error.message : String(error)}`,
          tallyVoucherId: null,
          raw: '',
        };
      } finally {
        clearTimeout(timeout);
      }
      if (!response.ok) {
        const raw = await response.text().catch(() => '');
        return {
          outcome: 'uncertain',
          message: `Tally responded with HTTP ${response.status}`,
          tallyVoucherId: null,
          raw,
        };
      }
      let raw;
      try {
        raw = await response.text();
      } catch (error) {
        return {
          outcome: 'uncertain',
          message: `Could not read the Tally response: ${error instanceof Error ? error.message : String(error)}`,
          tallyVoucherId: null,
          raw: '',
        };
      }
      const parsed = parseImportResponse(raw);
      return { ...parsed, raw };
    },
  };
}
function toRecord(row) {
  return {
    draftVersionId: row.draft_version_id,
    status: row.status,
    requestXml: row.request_xml,
    responseRaw: row.response_raw,
    tallyVoucherId: row.tally_voucher_id,
    message: row.message,
    createdAt: new Date(row.created_at),
    completedAt: row.completed_at === null ? null : new Date(row.completed_at),
  };
}
/** node:sqlite's error shape for a UNIQUE/PRIMARY KEY constraint violation. */
function isUniqueConstraintError(error) {
  const errcode = error?.errcode;
  return (
    error instanceof Error &&
    error.code === 'ERR_SQLITE_ERROR' &&
    (errcode === 1555 || errcode === 2067) // SQLITE_CONSTRAINT_PRIMARYKEY / _UNIQUE
  );
}
export function createPostingStore(db) {
  const insert = db.prepare(`
    INSERT INTO ${TALLY_POSTINGS_TABLE} (draft_version_id, status, request_xml, created_at)
    VALUES (?, 'posting', ?, ?)
  `);
  const update = db.prepare(`
    UPDATE ${TALLY_POSTINGS_TABLE}
    SET status = ?, response_raw = ?, tally_voucher_id = ?, message = ?, completed_at = ?
    WHERE draft_version_id = ?
  `);
  const select = db.prepare(`SELECT * FROM ${TALLY_POSTINGS_TABLE} WHERE draft_version_id = ?`);
  return {
    beginPosting(draftVersionId, requestXml) {
      try {
        insert.run(draftVersionId, requestXml, new Date().toISOString());
        return { started: true };
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
        const existing = select.get(draftVersionId);
        return { started: false, existing: toRecord(existing) };
      }
    },
    recordOutcome(draftVersionId, outcome, responseRaw) {
      update.run(
        outcome.status,
        responseRaw,
        outcome.tallyVoucherId,
        outcome.message,
        new Date().toISOString(),
        draftVersionId,
      );
    },
    getPosting(draftVersionId) {
      const row = select.get(draftVersionId);
      return row === undefined ? null : toRecord(row);
    },
  };
}
export class PostingRejectedError extends Error {
  reason;
  constructor(reason, message) {
    super(message);
    this.name = 'PostingRejectedError';
    this.reason = reason;
  }
}
function findConfirmationContext(db, draftVersionId) {
  const row = db
    .prepare(
      `SELECT chat_id, telegram_user_id, status, draft_json, validation_json FROM ${CONVERSATION_DRAFTS_TABLE} WHERE draft_version_id = ?`,
    )
    .get(draftVersionId);
  if (row === undefined) return null;
  return {
    chatId: row.chat_id,
    telegramUserId: row.telegram_user_id,
    status: row.status,
    draft: JSON.parse(row.draft_json),
    validation: JSON.parse(row.validation_json),
  };
}
/**
 * Post an already-confirmed draft to TallyPrime, exactly once.
 *
 * @throws {PostingRejectedError} if the draft was never confirmed, is not the
 * one currently on record for its chat, or a posting attempt already exists
 * for it — in every one of those cases, no Import request is sent.
 */
export async function postConfirmedTransaction(deps, input) {
  const correlationId = input.correlationId ?? randomUUID();
  const context = findConfirmationContext(deps.db, input.draftVersionId);
  const actor =
    context !== null
      ? { kind: 'user', telegramUserId: context.telegramUserId, chatId: context.chatId }
      : { kind: 'system' };
  if (context === null || context.status !== 'confirmed') {
    deps.auditLog.record({
      correlationId,
      type: 'tally.posting.rejected',
      channel: 'system',
      actor,
      data: {
        draftVersionId: input.draftVersionId,
        reason: context === null ? 'unknown_draft' : 'not_confirmed',
        currentStatus: context?.status ?? null,
      },
    });
    throw new PostingRejectedError(
      'not_confirmed',
      'This transaction has not been confirmed and cannot be posted to Tally.',
    );
  }
  // Re-checked fresh here, never trusted from whatever state the conversation
  // layer computed earlier: a configured ledger could have been renamed or
  // deleted in Tally, or the mapping changed, between confirmation and this
  // call. GST/ledger selection is never taken from `input.voucher` blindly —
  // it must still agree with what backend configuration says is correct now.
  const readiness = checkPostingReadiness(
    {
      db: deps.db,
      gstConfig: deps.gstConfig,
      itemLedgerMappingStore: deps.itemLedgerMappingStore,
      godownConfig: deps.godownConfig,
      stockAvailabilityStore: deps.stockAvailabilityStore,
    },
    context.draft,
    context.validation,
  );
  if (!readiness.ready) {
    deps.auditLog.record({
      correlationId,
      type: 'tally.posting.rejected',
      channel: 'system',
      actor,
      data: {
        draftVersionId: input.draftVersionId,
        reason: 'gst_or_ledger_not_ready',
        blockerCodes: readiness.blockers.map((blocker) => blocker.code),
      },
    });
    throw new PostingRejectedError(
      'gst_or_ledger_not_ready',
      'This transaction is not ready to post: GST or ledger configuration is incomplete or invalid.',
    );
  }
  const requestXml = buildSalesVoucherXml(input.voucher);
  const begin = deps.postingStore.beginPosting(input.draftVersionId, requestXml);
  if (!begin.started) {
    // Covers both "already posted" (return the prior success, no new attempt)
    // and the deliberate no-retry rule for failed/uncertain/in-flight
    // (DECISIONS.md #25) — the caller gets the truth either way, never a
    // second Import request.
    deps.auditLog.record({
      correlationId,
      type: 'tally.posting.rejected',
      channel: 'system',
      actor,
      data: {
        draftVersionId: input.draftVersionId,
        reason: 'already_attempted',
        existingStatus: begin.existing.status,
      },
    });
    return {
      status: begin.existing.status,
      message: begin.existing.message ?? '',
      tallyVoucherId: begin.existing.tallyVoucherId,
    };
  }
  deps.auditLog.record({
    correlationId,
    type: 'tally.request.sent',
    channel: 'system',
    actor,
    data: { draftVersionId: input.draftVersionId },
  });
  let outcome;
  try {
    outcome = await deps.postingClient.importVoucher(requestXml);
  } catch (error) {
    // Defensive only — importVoucher is built to never throw. If it somehow
    // does, the row must still not be left stuck at 'posting' forever.
    outcome = {
      outcome: 'uncertain',
      message: `Unexpected error while posting: ${error instanceof Error ? error.message : String(error)}`,
      tallyVoucherId: null,
      raw: '',
    };
  }
  deps.postingStore.recordOutcome(
    input.draftVersionId,
    { status: outcome.outcome, message: outcome.message, tallyVoucherId: outcome.tallyVoucherId },
    outcome.raw,
  );
  deps.auditLog.record({
    correlationId,
    type: 'tally.response.received',
    channel: 'system',
    actor,
    data: {
      draftVersionId: input.draftVersionId,
      status: outcome.outcome,
      tallyVoucherId: outcome.tallyVoucherId,
    },
  });
  return {
    status: outcome.outcome,
    message: outcome.message,
    tallyVoucherId: outcome.tallyVoucherId,
  };
}
