/**
 * Orchestrates one inbound text message through extraction, validation,
 * conversation state, and the user-facing reply.
 *
 * Nothing here calls Tally. This is the "AI understands → Backend verifies"
 * half of the project's core flow; confirmation and (in a later phase)
 * posting come after the user acts on the preview this produces.
 */
import { buildCallbackData } from '../channels/telegram/types.js';
import {
  checkPostingReadiness,
  findGodownSelectionNeeded,
  isOnlyMissingPlaceOfSupply,
} from '../gst/postingReadiness.js';
import { LLMConnectionError, LLMResponseError } from '../llm/client.js';
import { DraftValidationError } from '../llm/schema.js';
import { validateTransactionDraft } from '../validation/validateDraft.js';
import {
  applyClarification,
  deriveClarification,
  resolveClarificationReply,
} from './clarification.js';
import { mergeDraft } from './merge.js';
import {
  buildClarificationText,
  buildConfigurationErrorText,
  buildFollowUpRequestText,
  buildPreviewText,
  buildUnderstandingFailedText,
} from './messages.js';
const OPEN_STATUSES = ['collecting', 'ready_for_confirmation'];
export async function handleIncomingTextMessage(deps, turn) {
  const actor = { kind: 'user', telegramUserId: turn.userId, chatId: turn.chatId };
  const stored = deps.conversationStore.getActiveDraft(turn.chatId);
  // Isolation: a row belonging to a different user is never treated as this
  // user's conversation, even if it happens to sit under the same chat id.
  const existing =
    stored !== null &&
    stored.telegramUserId === turn.userId &&
    OPEN_STATUSES.includes(stored.status)
      ? stored
      : null;
  let candidateDraft = null;
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
    let extracted;
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
            error instanceof LLMConnectionError ||
            error instanceof LLMResponseError ||
            error instanceof DraftValidationError
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
  const validation = validateTransactionDraft(deps.db, candidateDraft, deps.itemLedgerMappingStore);
  // The canonical draft from here on: rate/GST filled in from trusted
  // per-item configuration wherever the user left them unstated, the same
  // way a resolved party or item name already flows back onto the draft via
  // `applyClarification`.
  candidateDraft = validation.resolvedDraft;
  deps.auditLog.record({
    correlationId: turn.correlationId,
    type: 'validation.completed',
    channel: 'telegram',
    actor,
    data: { isValid: validation.isValid, issueCodes: validation.issues.map((issue) => issue.code) },
  });
  let pending = deriveClarification(validation);
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
            companyRevenueLedgerDefaultsStore: deps.companyRevenueLedgerDefaultsStore,
            companyName: deps.companyName,
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
    } else if (!readiness.ready) {
      const godownSelection = findGodownSelectionNeeded(readiness);
      if (godownSelection !== null) {
        pending = {
          kind: 'godown',
          itemIndex: godownSelection.itemIndex,
          candidates: godownSelection.candidates,
        };
      }
    }
  }
  const ready = validation.isValid && (readiness === null || readiness.ready);
  const status = ready ? 'ready_for_confirmation' : 'collecting';
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
      buildPreviewText(candidateDraft, validation, readiness),
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
