/**
 * Telegram webhook route.
 *
 * Enforces the two Phase 1 security gates, in order, before anything else
 * happens with a request:
 *
 *   1. The request carries the exact `X-Telegram-Bot-Api-Secret-Token` value
 *      configured for this deployment — otherwise it did not come from
 *      Telegram and is rejected with 401.
 *   2. The sending Telegram user is on the allowlist — otherwise the update is
 *      acknowledged and dropped without any further processing.
 *
 * Later phases add LLM extraction, validation and Tally posting *after* these
 * gates; nothing may be inserted before them.
 */

import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';

import type { Logger } from '../../logger.ts';
import type { TelegramClient } from './client.ts';
import { parseIncomingMessage } from './types.ts';

export const SECRET_TOKEN_HEADER = 'x-telegram-bot-api-secret-token';

export interface TelegramWebhookDeps {
  readonly webhookSecret: string;
  readonly allowedUserIds: ReadonlySet<number>;
  readonly telegram: TelegramClient;
  readonly logger: Logger;
}

/**
 * Constant-time string comparison, so a caller cannot recover the secret by
 * measuring how long a mismatch takes to reject.
 */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function createTelegramWebhookRouter(deps: TelegramWebhookDeps): Router {
  const router = Router();

  router.post('/', async (req: Request, res: Response): Promise<void> => {
    const provided = req.get(SECRET_TOKEN_HEADER);

    if (provided === undefined || !secretMatches(provided, deps.webhookSecret)) {
      deps.logger.warn('Rejected webhook request with missing or invalid secret token', {
        hasHeader: provided !== undefined,
      });
      // Deliberately unspecific: do not tell an unauthenticated caller which
      // part was wrong, or whether this endpoint expects a secret at all.
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const message = parseIncomingMessage(req.body);
    if (message === null) {
      // Not something this phase handles (edited message, callback query,
      // non-text media). Acknowledge so Telegram does not retry it.
      deps.logger.info('Ignoring update with no handleable text message');
      res.status(200).json({ ok: true });
      return;
    }

    if (!deps.allowedUserIds.has(message.userId)) {
      // Silent drop: replying would confirm to an unauthorized prober that a
      // live bot sits behind this endpoint. Still acknowledged, and logged so
      // an operator can see the attempt and add the user if it was genuine.
      deps.logger.warn('Rejected message from user not on allowlist', { userId: message.userId });
      res.status(200).json({ ok: true });
      return;
    }

    // Phase 1 stops here: echo the text back. Extraction, validation, preview,
    // confirmation and Tally posting arrive in later phases.
    await deps.telegram.sendMessage(message.chatId, `TallyTalk received: ${message.text}`);

    deps.logger.info('Echoed message back to authorized user', { userId: message.userId });
    res.status(200).json({ ok: true });
  });

  return router;
}
