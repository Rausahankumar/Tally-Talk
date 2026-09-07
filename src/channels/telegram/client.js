/**
 * Outbound Telegram Bot API client.
 *
 * `fetch` is injectable so the webhook can be tested without network access.
 */
const API_BASE = 'https://api.telegram.org';
/** Failure talking to the Telegram Bot API. Never carries the bot token. */
export class TelegramApiError extends Error {
  status;
  constructor(method, status, detail) {
    super(`Telegram API ${method} failed with status ${status}: ${detail}`);
    this.name = 'TelegramApiError';
    this.status = status;
  }
}
export function createTelegramClient(botToken, fetchImpl = globalThis.fetch) {
  async function call(method, body) {
    const response = await fetchImpl(`${API_BASE}/bot${botToken}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '<unreadable body>');
      throw new TelegramApiError(method, response.status, detail.slice(0, 200));
    }
  }
  return {
    async sendMessage(chatId, text, buttons) {
      const replyMarkup =
        buttons === undefined
          ? undefined
          : {
              inline_keyboard: [
                buttons.map((b) => ({ text: b.text, callback_data: b.callbackData })),
              ],
            };
      await call('sendMessage', {
        chat_id: chatId,
        text,
        ...(replyMarkup === undefined ? {} : { reply_markup: replyMarkup }),
      });
    },
    async answerCallbackQuery(callbackQueryId, text) {
      await call('answerCallbackQuery', {
        callback_query_id: callbackQueryId,
        ...(text === undefined ? {} : { text }),
      });
    },
  };
}
