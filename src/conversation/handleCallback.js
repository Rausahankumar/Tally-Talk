/**
 * Orchestrates a Confirm/Cancel button tap.
 *
 * The claimed draft version in the callback is never trusted by itself — it
 * is only acted on if it still matches what the server has stored for this
 * exact chat and user, changed atomically via
 * {@link ConversationStore.setStatusIfCurrent}. Anything else (a superseded
 * draft, a second tap, an expired draft, someone else's chat) is rejected the
 * same way and audited with the specific reason.
 *
 * Cancel only records that the user discarded the draft. Confirm goes
 * further: once the atomic status transition to `confirmed` succeeds (the
 * same duplicate/race protection above, so this section runs at most once
 * per draft version), it drives the whole posting pipeline —
 *   confirmed draft -> checkPostingReadiness -> buildSalesVoucherInput -> postConfirmedTransaction
 * — deterministically and with no LLM call. Every stage fails closed: a
 * problem at any point reports to the user and stops before Tally is ever
 * contacted, except `postConfirmedTransaction` itself, which re-checks
 * readiness once more immediately before sending anything (closing the
 * window between this check and the actual write) and is idempotent per
 * draft version (its own primary-key claim on `draftVersionId`) — so even a
 * retried or redelivered Confirm callback that somehow reached this far a
 * second time cannot post twice.
 */
import { buildSalesVoucherInput } from '../tally/draftToVoucher.js';
import { resolveReadinessWithRefresh } from '../tally/masterResolutionRefresh.js';
import { PostingRejectedError, postConfirmedTransaction } from '../tally/posting.js';
import {
  buildCancelledText,
  buildConfirmedText,
  buildPostedResultText,
  buildPostingFailedText,
  buildRejectedConfirmationText,
  buildTallyUnavailableText,
} from './messages.js';
async function reject(deps, turn, reason) {
  deps.auditLog.record({
    correlationId: turn.correlationId,
    type: 'confirmation.rejected',
    channel: 'telegram',
    actor: { kind: 'user', telegramUserId: turn.userId, chatId: turn.chatId },
    data: { action: turn.action, draftVersionId: turn.draftVersionId, reason },
  });
  await deps.telegram.answerCallbackQuery(turn.callbackQueryId, 'No longer valid');
  await deps.telegram.sendMessage(turn.chatId, buildRejectedConfirmationText());
}
/**
 * Attempt the actual posting pipeline for an already-confirmed draft.
 * Never throws for an expected failure mode — every stage reports to the
 * user and returns instead. Only called once per draft version, from the
 * confirm branch below, after the atomic status transition has already
 * succeeded.
 */
async function postConfirmedDraft(deps, turn, draft, validation) {
  const actor = { kind: 'user', telegramUserId: turn.userId, chatId: turn.chatId };
  // Re-checked fresh here (readiness can drift between preview and Confirm —
  // unchanged, existing behaviour), with the same refresh-and-retry safety
  // net as the first understanding of the message: a non-exact/unsafe result
  // tries one live Tally refresh before being trusted as final.
  const resolvedReadiness = await resolveReadinessWithRefresh(deps, draft, validation);
  if (resolvedReadiness.refreshFailed) {
    deps.auditLog.record({
      correlationId: turn.correlationId,
      type: 'tally.posting.rejected',
      channel: 'telegram',
      actor,
      data: { draftVersionId: turn.draftVersionId, reason: 'tally_unavailable_at_confirm' },
    });
    await deps.telegram.sendMessage(turn.chatId, buildTallyUnavailableText());
    return;
  }
  const readiness = resolvedReadiness.readiness;
  if (!readiness.ready) {
    deps.auditLog.record({
      correlationId: turn.correlationId,
      type: 'tally.posting.rejected',
      channel: 'telegram',
      actor,
      data: {
        draftVersionId: turn.draftVersionId,
        reason: 'not_ready_at_confirm',
        blockerCodes: readiness.blockers.map((b) => b.code),
      },
    });
    await deps.telegram.sendMessage(
      turn.chatId,
      buildPostingFailedText(readiness.blockers.map((b) => b.message)),
    );
    return;
  }
  const adapterResult = buildSalesVoucherInput(
    { db: deps.db, companyName: deps.companyName },
    draft,
    validation,
    readiness,
  );
  if (!adapterResult.ok) {
    deps.auditLog.record({
      correlationId: turn.correlationId,
      type: 'tally.posting.rejected',
      channel: 'telegram',
      actor,
      data: {
        draftVersionId: turn.draftVersionId,
        reason: 'adapter_failed',
        reasons: adapterResult.reasons,
      },
    });
    await deps.telegram.sendMessage(turn.chatId, buildPostingFailedText(adapterResult.reasons));
    return;
  }
  try {
    const result = await postConfirmedTransaction(
      {
        db: deps.db,
        postingStore: deps.postingStore,
        postingClient: deps.postingClient,
        auditLog: deps.auditLog,
        gstConfig: deps.gstConfig,
        itemLedgerMappingStore: deps.itemLedgerMappingStore,
        companyRevenueLedgerDefaultsStore: deps.companyRevenueLedgerDefaultsStore,
        companyName: deps.companyName,
        godownConfig: deps.godownConfig,
        stockAvailabilityStore: deps.stockAvailabilityStore,
        syncCoordinator: deps.syncCoordinator,
      },
      {
        draftVersionId: turn.draftVersionId,
        voucher: adapterResult.voucher,
        correlationId: turn.correlationId,
      },
    );
    await deps.telegram.sendMessage(turn.chatId, buildPostedResultText(result));
  } catch (error) {
    // PostingRejectedError covers 'not_confirmed' (a race with something
    // else touching this draft) and 'gst_or_ledger_not_ready' (readiness
    // drifted between the check above and postConfirmedTransaction's own
    // immediate-pre-write re-check) — postConfirmedTransaction has already
    // audited the specific reason itself. Anything else is unexpected.
    if (error instanceof PostingRejectedError) {
      await deps.telegram.sendMessage(turn.chatId, buildPostingFailedText([error.message]));
      return;
    }
    throw error;
  }
}
export async function handleCallbackQuery(deps, turn) {
  const current = deps.conversationStore.getActiveDraft(turn.chatId);
  if (current === null || current.telegramUserId !== turn.userId) {
    await reject(deps, turn, 'no_matching_draft');
    return;
  }
  if (current.status === 'expired') {
    await reject(deps, turn, 'expired');
    return;
  }
  if (current.status === 'confirmed' || current.status === 'cancelled') {
    // Covers both a genuine duplicate tap and a tap on a superseded outcome.
    await reject(deps, turn, 'already_actioned');
    return;
  }
  if (
    current.status !== 'ready_for_confirmation' ||
    current.draftVersionId !== turn.draftVersionId
  ) {
    await reject(deps, turn, 'stale_version');
    return;
  }
  const newStatus = turn.action === 'confirm' ? 'confirmed' : 'cancelled';
  const updated = deps.conversationStore.setStatusIfCurrent({
    chatId: turn.chatId,
    telegramUserId: turn.userId,
    draftVersionId: turn.draftVersionId,
    expectedCurrentStatus: 'ready_for_confirmation',
    newStatus,
  });
  if (updated === null) {
    // Lost a race with another request between the read above and this
    // compare-and-set (e.g. a duplicate tap processed concurrently, or
    // Telegram redelivering the same callback). The pipeline below never
    // runs a second time for the same draft version because of this.
    await reject(deps, turn, 'concurrent_update');
    return;
  }
  deps.auditLog.record({
    correlationId: turn.correlationId,
    type: turn.action === 'confirm' ? 'user.confirmed' : 'user.cancelled',
    channel: 'telegram',
    actor: { kind: 'user', telegramUserId: turn.userId, chatId: turn.chatId },
    data: { draftVersionId: turn.draftVersionId },
  });
  await deps.telegram.answerCallbackQuery(turn.callbackQueryId);
  if (turn.action === 'cancel') {
    await deps.telegram.sendMessage(turn.chatId, buildCancelledText());
    return;
  }
  await deps.telegram.sendMessage(turn.chatId, buildConfirmedText());
  await postConfirmedDraft(deps, turn, updated.draft, updated.validation);
}
