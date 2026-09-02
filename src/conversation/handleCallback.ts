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
 * Confirming only records that the user approved the draft. It does not call
 * Tally — that is a later phase's job.
 */

import type { AuditLog } from '../audit/log.ts';
import type { ConfirmationAction } from '../channels/telegram/types.ts';
import type { TelegramClient } from '../channels/telegram/client.ts';
import {
  buildCancelledText,
  buildConfirmedText,
  buildRejectedConfirmationText,
} from './messages.ts';
import type { ConversationStore } from './store.ts';

export interface CallbackHandlerDeps {
  readonly telegram: TelegramClient;
  readonly conversationStore: ConversationStore;
  readonly auditLog: AuditLog;
}

export interface IncomingCallbackTurn {
  readonly chatId: number;
  readonly userId: number;
  readonly callbackQueryId: string;
  readonly action: ConfirmationAction;
  readonly draftVersionId: string;
  readonly correlationId: string;
}

async function reject(
  deps: CallbackHandlerDeps,
  turn: IncomingCallbackTurn,
  reason: string,
): Promise<void> {
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

export async function handleCallbackQuery(
  deps: CallbackHandlerDeps,
  turn: IncomingCallbackTurn,
): Promise<void> {
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
  if (current.status !== 'ready_for_confirmation' || current.draftVersionId !== turn.draftVersionId) {
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
    // compare-and-set (e.g. a duplicate tap processed concurrently).
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
  await deps.telegram.sendMessage(
    turn.chatId,
    turn.action === 'confirm' ? buildConfirmedText() : buildCancelledText(),
  );
}
