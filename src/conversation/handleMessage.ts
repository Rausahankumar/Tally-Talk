/**
 * Orchestrates one inbound text message through extraction, validation,
 * conversation state, and the user-facing reply.
 *
 * Nothing here calls Tally. This is the "AI understands → Backend verifies"
 * half of the project's core flow; confirmation and (in a later phase)
 * posting come after the user acts on the preview this produces.
 */

import type { DatabaseSync } from 'node:sqlite';

import type { AuditLog } from '../audit/log.ts';
import { buildCallbackData } from '../channels/telegram/types.ts';
import type { TelegramClient } from '../channels/telegram/client.ts';
import type { GodownConfig, GstLedgerConfig } from '../config/index.ts';
import { checkPostingReadiness, isOnlyMissingPlaceOfSupply } from '../gst/postingReadiness.ts';
import type { ItemLedgerMappingStore } from '../gst/itemLedgerMapping.ts';
import type { StockAvailabilityStore } from '../tally/stockAvailability.ts';
import type { LLMClient } from '../llm/client.ts';
import { LLMConnectionError, LLMResponseError } from '../llm/client.ts';
import { DraftValidationError } from '../llm/schema.ts';
import type { TransactionDraft } from '../llm/schema.ts';
import { validateTransactionDraft } from '../validation/validateDraft.ts';
import { applyClarification, deriveClarification, resolveClarificationReply } from './clarification.ts';
import { mergeDraft } from './merge.ts';
import {
  buildClarificationText,
  buildConfigurationErrorText,
  buildFollowUpRequestText,
  buildPreviewText,
  buildUnderstandingFailedText,
} from './messages.ts';
import type { ConversationStore } from './store.ts';
import type { ConversationStatus, PendingClarification } from './types.ts';

export interface MessageHandlerDeps {
  readonly db: DatabaseSync;
  readonly llm: LLMClient;
  readonly telegram: TelegramClient;
  readonly conversationStore: ConversationStore;
  readonly auditLog: AuditLog;
  readonly gstConfig: GstLedgerConfig;
  readonly itemLedgerMappingStore: ItemLedgerMappingStore;
  readonly godownConfig: GodownConfig;
  readonly stockAvailabilityStore: StockAvailabilityStore;
}

export interface IncomingTextTurn {
  readonly chatId: number;
  readonly userId: number;
  readonly text: string;
  readonly correlationId: string;
}

const OPEN_STATUSES: readonly ConversationStatus[] = ['collecting', 'ready_for_confirmation'];

export async function handleIncomingTextMessage(
  deps: MessageHandlerDeps,
  turn: IncomingTextTurn,
): Promise<void> {
  const actor = { kind: 'user' as const, telegramUserId: turn.userId, chatId: turn.chatId };

  const stored = deps.conversationStore.getActiveDraft(turn.chatId);
  // Isolation: a row belonging to a different user is never treated as this
  // user's conversation, even if it happens to sit under the same chat id.
  const existing =
    stored !== null && stored.telegramUserId === turn.userId && OPEN_STATUSES.includes(stored.status)
      ? stored
      : null;

  let candidateDraft: TransactionDraft | null = null;

  if (existing !== null && existing.pending !== null) {
    const resolvedName = resolveClarificationReply(existing.pending, turn.text);
    if (resolvedName !== null) {
      // The reply clearly picked one of the offered candidates — resolved
      // deterministically, with no LLM call needed for this turn.
      candidateDraft = applyClarification(existing.draft, existing.pending, resolvedName);
    }
    // If it didn't match, fall through: the user may be saying something else
    // entirely, so the message still goes through normal extraction below.
  }

  if (candidateDraft === null) {
    let extracted: TransactionDraft;
    try {
      extracted = await deps.llm.extractTransactionDraft(turn.text);
    } catch (error) {
      deps.auditLog.record({
        correlationId: turn.correlationId,
        type: 'llm.extraction.completed',
        channel: 'telegram',
        actor,
        data: {
          ok: false,
          reason:
            error instanceof LLMConnectionError || error instanceof LLMResponseError || error instanceof DraftValidationError
              ? error.message
              : 'unknown_error',
        },
      });
      await deps.telegram.sendMessage(turn.chatId, buildUnderstandingFailedText());
      return;
    }

    deps.auditLog.record({
      correlationId: turn.correlationId,
      type: 'llm.extraction.completed',
      channel: 'telegram',
      actor,
      data: { ok: true, draft: extracted },
    });

    candidateDraft = existing !== null ? mergeDraft(existing.draft, extracted) : extracted;
  }

  const validation = validateTransactionDraft(deps.db, candidateDraft);
  deps.auditLog.record({
    correlationId: turn.correlationId,
    type: 'validation.completed',
    channel: 'telegram',
    actor,
    data: { isValid: validation.isValid, issueCodes: validation.issues.map((issue) => issue.code) },
  });

  let pending: PendingClarification | null = deriveClarification(validation);

  // GST/ledger readiness is only worth checking once Phase 5 is clean and
  // there is no outstanding party/item ambiguity to resolve first — asking
  // about Place of Supply before the basics are sorted would be confusing.
  const readiness =
    validation.isValid && pending === null
      ? checkPostingReadiness(
          {
            db: deps.db,
            gstConfig: deps.gstConfig,
            itemLedgerMappingStore: deps.itemLedgerMappingStore,
            godownConfig: deps.godownConfig,
            stockAvailabilityStore: deps.stockAvailabilityStore,
          },
          candidateDraft,
          validation,
        )
      : null;

  if (readiness !== null) {
    deps.auditLog.record({
      correlationId: turn.correlationId,
      type: 'gst.determination.completed',
      channel: 'telegram',
      actor,
      data: {
        ready: readiness.ready,
        treatmentType: readiness.gstTreatment?.type ?? null,
        blockerCodes: readiness.blockers.map((blocker) => blocker.code),
      },
    });

    if (!readiness.ready && isOnlyMissingPlaceOfSupply(readiness)) {
      // The one gap here is something the user can actually answer —
      // deterministically resolved from their next reply, no LLM call.
      pending = { kind: 'place_of_supply' };
    }
  }

  const ready = validation.isValid && (readiness === null || readiness.ready);
  const status: ConversationStatus = ready ? 'ready_for_confirmation' : 'collecting';

  const saved = deps.conversationStore.saveDraft({
    chatId: turn.chatId,
    telegramUserId: turn.userId,
    status,
    draft: candidateDraft,
    validation,
    pending,
  });

  deps.auditLog.record({
    correlationId: turn.correlationId,
    type: existing === null ? 'draft.created' : 'draft.updated',
    channel: 'telegram',
    actor,
    data: { draftVersionId: saved.draftVersionId, status },
  });

  if (status === 'ready_for_confirmation') {
    await deps.telegram.sendMessage(
      turn.chatId,
      buildPreviewText(candidateDraft, validation, readiness?.gstTreatment ?? null),
      [
        { text: 'Confirm', callbackData: buildCallbackData('confirm', saved.draftVersionId) },
        { text: 'Cancel', callbackData: buildCallbackData('cancel', saved.draftVersionId) },
      ],
    );
    deps.auditLog.record({
      correlationId: turn.correlationId,
      type: 'preview.shown',
      channel: 'telegram',
      actor,
      data: { draftVersionId: saved.draftVersionId },
    });
    return;
  }

  if (readiness !== null && !readiness.ready && !isOnlyMissingPlaceOfSupply(readiness)) {
    // A configuration problem — nothing the user types can fix this, so ask
    // for nothing; report it plainly instead.
    await deps.telegram.sendMessage(turn.chatId, buildConfigurationErrorText(readiness.blockers));
    return;
  }

  if (pending !== null) {
    await deps.telegram.sendMessage(turn.chatId, buildClarificationText(pending));
    return;
  }

  await deps.telegram.sendMessage(turn.chatId, buildFollowUpRequestText(validation.issues));
}
