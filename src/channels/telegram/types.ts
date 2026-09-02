/**
 * Minimal typings for the slice of the Telegram Bot API we consume, plus a
 * defensive parser.
 *
 * The webhook body arrives from the network, so it is treated as `unknown` and
 * narrowed explicitly rather than cast. Only fields Phase 1 needs are modelled.
 */

/** What the backend needs from an inbound text message. */
export interface IncomingMessage {
  readonly userId: number;
  readonly chatId: number;
  readonly text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readId(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value !== 0 ? value : null;
}

/**
 * Extract a usable text message from a raw Telegram update.
 *
 * Returns `null` for anything this phase does not handle — edited messages,
 * callback queries, channel posts, media without text, malformed bodies. The
 * caller acknowledges those without acting on them.
 */
export function parseIncomingMessage(body: unknown): IncomingMessage | null {
  if (!isRecord(body)) return null;

  const message = body.message;
  if (!isRecord(message)) return null;

  const from = isRecord(message.from) ? message.from : null;
  const chat = isRecord(message.chat) ? message.chat : null;
  if (from === null || chat === null) return null;

  const userId = readId(from.id);
  const chatId = readId(chat.id);
  if (userId === null || chatId === null) return null;

  const text = message.text;
  if (typeof text !== 'string' || text.trim() === '') return null;

  return { userId, chatId, text };
}
