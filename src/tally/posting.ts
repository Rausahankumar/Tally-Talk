/**
 * Tally voucher posting: the write side, kept entirely separate from the
 * Phase 3 read-only export client (`client.ts`/`xml.ts`, both untouched by
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
import type { DatabaseSync } from 'node:sqlite';

import type { AuditLog } from '../audit/log.ts';
import type { GodownConfig, GstLedgerConfig } from '../config/index.ts';
import { CONVERSATION_DRAFTS_TABLE, TALLY_POSTINGS_TABLE } from '../db/schema.ts';
import { checkPostingReadiness } from '../gst/postingReadiness.ts';
import type { ItemLedgerMappingStore } from '../gst/itemLedgerMapping.ts';
import type { StockAvailabilityStore } from './stockAvailability.ts';
import type { TransactionDraft } from '../llm/schema.ts';
import type { DraftValidationResult } from '../validation/types.ts';
import { buildSalesVoucherXml, parseImportResponse } from './postingXml.ts';
import type { SalesVoucherInput } from './postingXml.ts';

export type FetchLike = typeof globalThis.fetch;
export type PostingStatus = 'posting' | 'posted' | 'failed' | 'uncertain';

const DEFAULT_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

export interface ImportResult {
  readonly outcome: 'posted' | 'failed' | 'uncertain';
  readonly message: string;
  readonly tallyVoucherId: string | null;
  readonly raw: string;
}

export interface TallyPostingClient {
  /** Never throws — every failure mode resolves to an outcome, so a caller can never miss recording one. */
  importVoucher(xml: string): Promise<ImportResult>;
}

export interface TallyPostingClientOptions {
  readonly host: string;
  readonly port: number;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
}

export function createTallyPostingClient(options: TallyPostingClientOptions): TallyPostingClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `http://${options.host}:${options.port}`;

  return {
    async importVoucher(xml: string): Promise<ImportResult> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      let response: Response;
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

      let raw: string;
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

// ---------------------------------------------------------------------------
// Posting state store
// ---------------------------------------------------------------------------

export interface PostingRecord {
  readonly draftVersionId: string;
  readonly status: PostingStatus;
  readonly requestXml: string;
  readonly responseRaw: string | null;
  readonly tallyVoucherId: string | null;
  readonly message: string | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

export type BeginPostingResult =
  | { readonly started: true }
  | { readonly started: false; readonly existing: PostingRecord };

export interface PostingStore {
  /**
   * Atomically claim the right to post `draftVersionId`. Fails (returns
   * `started: false`) if a row already exists for it, in any status — this is
   * the entire duplicate/concurrency defence: whichever call's `INSERT` wins
   * the primary key proceeds; every other call, no matter how it arrived
   * (duplicate callback, a genuinely concurrent request, a caller retrying
   * because it didn't see the first response), gets the existing row back
   * instead of touching Tally.
   */
  beginPosting(draftVersionId: string, requestXml: string): BeginPostingResult;
  recordOutcome(
    draftVersionId: string,
    outcome: { status: 'posted' | 'failed' | 'uncertain'; message: string; tallyVoucherId: string | null },
    responseRaw: string,
  ): void;
  getPosting(draftVersionId: string): PostingRecord | null;
}

interface PostingRow {
  readonly draft_version_id: string;
  readonly status: string;
  readonly request_xml: string;
  readonly response_raw: string | null;
  readonly tally_voucher_id: string | null;
  readonly message: string | null;
  readonly created_at: string;
  readonly completed_at: string | null;
}

function toRecord(row: PostingRow): PostingRecord {
  return {
    draftVersionId: row.draft_version_id,
    status: row.status as PostingStatus,
    requestXml: row.request_xml,
    responseRaw: row.response_raw,
    tallyVoucherId: row.tally_voucher_id,
    message: row.message,
    createdAt: new Date(row.created_at),
    completedAt: row.completed_at === null ? null : new Date(row.completed_at),
  };
}

/** node:sqlite's error shape for a UNIQUE/PRIMARY KEY constraint violation. */
function isUniqueConstraintError(error: unknown): boolean {
  const errcode = (error as { errcode?: unknown } | null)?.errcode;
  return (
    error instanceof Error &&
    (error as { code?: unknown }).code === 'ERR_SQLITE_ERROR' &&
    (errcode === 1555 || errcode === 2067) // SQLITE_CONSTRAINT_PRIMARYKEY / _UNIQUE
  );
}

export function createPostingStore(db: DatabaseSync): PostingStore {
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
    beginPosting(draftVersionId: string, requestXml: string): BeginPostingResult {
      try {
        insert.run(draftVersionId, requestXml, new Date().toISOString());
        return { started: true };
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;

        const existing = select.get(draftVersionId) as unknown as PostingRow;
        return { started: false, existing: toRecord(existing) };
      }
    },

    recordOutcome(draftVersionId, outcome, responseRaw): void {
      update.run(
        outcome.status,
        responseRaw,
        outcome.tallyVoucherId,
        outcome.message,
        new Date().toISOString(),
        draftVersionId,
      );
    },

    getPosting(draftVersionId: string): PostingRecord | null {
      const row = select.get(draftVersionId) as unknown as PostingRow | undefined;
      return row === undefined ? null : toRecord(row);
    },
  };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/** A posting attempt was refused before ever contacting Tally. */
export type PostingRejectionReason = 'not_confirmed' | 'already_attempted' | 'gst_or_ledger_not_ready';

export class PostingRejectedError extends Error {
  readonly reason: PostingRejectionReason;

  constructor(reason: PostingRejectionReason, message: string) {
    super(message);
    this.name = 'PostingRejectedError';
    this.reason = reason;
  }
}

export interface PostConfirmedTransactionDeps {
  readonly db: DatabaseSync;
  readonly postingStore: PostingStore;
  readonly postingClient: TallyPostingClient;
  readonly auditLog: AuditLog;
  readonly gstConfig: GstLedgerConfig;
  readonly itemLedgerMappingStore: ItemLedgerMappingStore;
  readonly godownConfig: GodownConfig;
  readonly stockAvailabilityStore: StockAvailabilityStore;
}

export interface PostConfirmedTransactionInput {
  readonly draftVersionId: string;
  /**
   * The fully-resolved voucher to post. Not derived from the draft
   * automatically — see the Phase 7 report for exactly which fields a bare
   * `TransactionDraft` cannot yet supply (sales/tax ledger allocation, party
   * state for CGST+SGST vs. IGST, godown) and which project phase would need
   * to grow to supply them safely.
   */
  readonly voucher: SalesVoucherInput;
  /** Threads through an existing audit correlation id, when the caller has one. */
  readonly correlationId?: string;
}

export interface PostConfirmedTransactionResult {
  readonly status: PostingStatus;
  readonly message: string;
  readonly tallyVoucherId: string | null;
}

interface ConfirmationContext {
  readonly chatId: number;
  readonly telegramUserId: number;
  readonly status: string;
  readonly draft: TransactionDraft;
  readonly validation: DraftValidationResult;
}

function findConfirmationContext(db: DatabaseSync, draftVersionId: string): ConfirmationContext | null {
  const row = db
    .prepare(
      `SELECT chat_id, telegram_user_id, status, draft_json, validation_json FROM ${CONVERSATION_DRAFTS_TABLE} WHERE draft_version_id = ?`,
    )
    .get(draftVersionId) as
    | {
        chat_id: number;
        telegram_user_id: number;
        status: string;
        draft_json: string;
        validation_json: string;
      }
    | undefined;

  if (row === undefined) return null;
  return {
    chatId: row.chat_id,
    telegramUserId: row.telegram_user_id,
    status: row.status,
    draft: JSON.parse(row.draft_json) as TransactionDraft,
    validation: JSON.parse(row.validation_json) as DraftValidationResult,
  };
}

/**
 * Post an already-confirmed draft to TallyPrime, exactly once.
 *
 * @throws {PostingRejectedError} if the draft was never confirmed, is not the
 * one currently on record for its chat, or a posting attempt already exists
 * for it — in every one of those cases, no Import request is sent.
 */
export async function postConfirmedTransaction(
  deps: PostConfirmedTransactionDeps,
  input: PostConfirmedTransactionInput,
): Promise<PostConfirmedTransactionResult> {
  const correlationId = input.correlationId ?? randomUUID();
  const context = findConfirmationContext(deps.db, input.draftVersionId);
  const actor =
    context !== null
      ? ({ kind: 'user', telegramUserId: context.telegramUserId, chatId: context.chatId } as const)
      : ({ kind: 'system' } as const);

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

  let outcome: ImportResult;
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

  return { status: outcome.outcome, message: outcome.message, tallyVoucherId: outcome.tallyVoucherId };
}
