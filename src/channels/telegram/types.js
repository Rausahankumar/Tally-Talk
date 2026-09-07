/**
 * Minimal typings for the slice of the Telegram Bot API we consume, plus
 * defensive parsers.
 *
 * The webhook body arrives from the network, so it is treated as `unknown` and
 * narrowed explicitly rather than cast.
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null;
}
function readId(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value !== 0 ? value : null;
}
/**
 * Extract a usable text message from a raw Telegram update.
 *
 * Returns `null` for anything this does not handle — edited messages, callback
 * queries, channel posts, media without text, malformed bodies. The caller
 * acknowledges those without acting on them.
 */
export function parseIncomingMessage(body) {
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
const CALLBACK_DATA_PREFIX = 'tt';
/** A v4 UUID, loosely — enough to reject obvious garbage without re-implementing UUID validation. */
const VERSION_ID_PATTERN = /^[0-9a-fA-F-]{16,64}$/;
/** Build the `callback_data` for a Confirm/Cancel button, paired with {@link parseCallbackQuery}. */
export function buildCallbackData(action, draftVersionId) {
  return `${CALLBACK_DATA_PREFIX}:${action}:${draftVersionId}`;
}
/**
 * Parse a callback-query update. Returns `null` for anything malformed: an
 * update that isn't a callback query, a missing sender/message/chat, or
 * `callback_data` that doesn't match the exact shape this bot produces.
 *
 * This only recovers *what the button claimed* — it is never treated as proof
 * of anything by itself. The caller must still check the claimed
 * `draftVersionId` against the server's own stored state before acting on it.
 */
export function parseCallbackQuery(body) {
  if (!isRecord(body)) return null;
  const callbackQuery = body.callback_query;
  if (!isRecord(callbackQuery)) return null;
  const from = isRecord(callbackQuery.from) ? callbackQuery.from : null;
  const message = isRecord(callbackQuery.message) ? callbackQuery.message : null;
  const chat = message !== null && isRecord(message.chat) ? message.chat : null;
  if (from === null || chat === null) return null;
  const userId = readId(from.id);
  const chatId = readId(chat.id);
  const callbackQueryId = callbackQuery.id;
  if (userId === null || chatId === null || typeof callbackQueryId !== 'string') return null;
  const data = callbackQuery.data;
  if (typeof data !== 'string') return null;
  const parts = data.split(':');
  if (parts.length !== 3 || parts[0] !== CALLBACK_DATA_PREFIX) return null;
  const [, action, draftVersionId] = parts;
  if ((action !== 'confirm' && action !== 'cancel') || !VERSION_ID_PATTERN.test(draftVersionId)) {
    return null;
  }
  return { userId, chatId, callbackQueryId, action, draftVersionId: draftVersionId };
}
