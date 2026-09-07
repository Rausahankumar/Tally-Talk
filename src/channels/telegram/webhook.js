/**
 * Telegram webhook route.
 *
 * Enforces the two security gates, in order, before anything else happens with
 * a request, for every kind of update this bot handles — a text message or a
 * Confirm/Cancel button tap alike:
 *
 *   1. The request carries the exact `X-Telegram-Bot-Api-Secret-Token` value
 *      configured for this deployment — otherwise it did not come from
 *      Telegram and is rejected with 401.
 *   2. The sending Telegram user is on the allowlist — otherwise the update is
 *      acknowledged and dropped without any further processing.
 *
 * After the gates, the update is dispatched to the conversation layer
 * (`src/conversation/`), which owns extraction, validation, state, and
 * replies. This file's job stops at transport and security — it does not
 * decide what a message means or what to say back.
 *
 * Every inbound message and every authorization outcome is appended to the
 * audit log under one `correlationId`, so a whole turn can be replayed later.
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { handleCallbackQuery } from '../../conversation/handleCallback.js';
import { handleIncomingTextMessage } from '../../conversation/handleMessage.js';
import { parseCallbackQuery, parseIncomingMessage } from './types.js';
export const SECRET_TOKEN_HEADER = 'x-telegram-bot-api-secret-token';
/**
 * Constant-time string comparison, so a caller cannot recover the secret by
 * measuring how long a mismatch takes to reject.
 */
function secretMatches(provided, expected) {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
export function createTelegramWebhookRouter(deps) {
  const router = Router();
  router.post('/', async (req, res) => {
    // Minted per inbound update and carried by every event of this turn.
    const correlationId = randomUUID();
    const provided = req.get(SECRET_TOKEN_HEADER);
    if (provided === undefined || !secretMatches(provided, deps.webhookSecret)) {
      deps.logger.warn('Rejected webhook request with missing or invalid secret token', {
        hasHeader: provided !== undefined,
      });
      deps.auditLog.record({
        correlationId,
        type: 'webhook.rejected',
        channel: 'system',
        actor: { kind: 'system' },
        // Nothing in the body is trustworthy here, so none of it is recorded.
        data: { reason: provided === undefined ? 'missing_secret_token' : 'invalid_secret_token' },
      });
      // Deliberately unspecific: do not tell an unauthenticated caller which
      // part was wrong, or whether this endpoint expects a secret at all.
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const message = parseIncomingMessage(req.body);
    const callbackQuery = message === null ? parseCallbackQuery(req.body) : null;
    if (message === null && callbackQuery === null) {
      // Not something this bot handles (edited message, non-text media, a
      // callback with unrecognised data). Acknowledge so Telegram does not
      // retry it. Nothing is audited: there is no identified actor to record.
      deps.logger.info('Ignoring update with no handleable message or callback query');
      res.status(200).json({ ok: true });
      return;
    }
    const userId = message?.userId ?? callbackQuery.userId;
    const chatId = message?.chatId ?? callbackQuery.chatId;
    const actor = { kind: 'user', telegramUserId: userId, chatId };
    if (message !== null) {
      deps.auditLog.record({
        correlationId,
        type: 'message.received',
        channel: 'telegram',
        actor,
        // The raw message is the first line of the audit trail: "what did the
        // user actually say?" It stays on-premises with the rest of the log.
        data: { text: message.text },
      });
    }
    if (!deps.allowedUserIds.has(userId)) {
      // Silent drop: replying would confirm to an unauthorized prober that a
      // live bot sits behind this endpoint. Still acknowledged, and recorded so
      // an operator can see the attempt and add the user if it was genuine.
      deps.logger.warn('Rejected update from user not on allowlist', { userId });
      deps.auditLog.record({
        correlationId,
        type: 'authorization.denied',
        channel: 'telegram',
        actor,
        data: { reason: 'user_not_on_allowlist' },
      });
      res.status(200).json({ ok: true });
      return;
    }
    deps.auditLog.record({
      correlationId,
      type: 'authorization.granted',
      channel: 'telegram',
      actor,
    });
    try {
      if (message !== null) {
        await handleIncomingTextMessage(
          {
            db: deps.db,
            llm: deps.llm,
            telegram: deps.telegram,
            conversationStore: deps.conversationStore,
            gstConfig: deps.gstConfig,
            itemLedgerMappingStore: deps.itemLedgerMappingStore,
            godownConfig: deps.godownConfig,
            stockAvailabilityStore: deps.stockAvailabilityStore,
            auditLog: deps.auditLog,
          },
          { chatId: message.chatId, userId: message.userId, text: message.text, correlationId },
        );
      } else {
        await handleCallbackQuery(
          {
            telegram: deps.telegram,
            conversationStore: deps.conversationStore,
            auditLog: deps.auditLog,
            db: deps.db,
            gstConfig: deps.gstConfig,
            itemLedgerMappingStore: deps.itemLedgerMappingStore,
            godownConfig: deps.godownConfig,
            stockAvailabilityStore: deps.stockAvailabilityStore,
            companyName: deps.companyName,
            postingStore: deps.postingStore,
            postingClient: deps.postingClient,
          },
          {
            chatId: callbackQuery.chatId,
            userId: callbackQuery.userId,
            callbackQueryId: callbackQuery.callbackQueryId,
            action: callbackQuery.action,
            draftVersionId: callbackQuery.draftVersionId,
            correlationId,
          },
        );
      }
    } catch (error) {
      // A failure inside the conversation layer must not surface as an
      // unhandled rejection or a 500 that makes Telegram retry a request that
      // may have already partially applied — acknowledge and log instead.
      deps.logger.error('Failed to process authorized update', {
        userId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    res.status(200).json({ ok: true });
  });
  return router;
}
