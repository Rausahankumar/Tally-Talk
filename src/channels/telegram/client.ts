/**
 * Outbound Telegram Bot API client.
 *
 * `fetch` is injectable so the webhook can be tested without network access.
 */

export interface InlineKeyboardButton {
  readonly text: string;
  readonly callbackData: string;
}

export interface TelegramClient {
  sendMessage(chatId: number, text: string, buttons?: readonly InlineKeyboardButton[]): Promise<void>;
  /** Stops the loading spinner on the tapped button. `text`, if given, shows as a small toast. */
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
}

export type FetchLike = typeof globalThis.fetch;

const API_BASE = 'https://api.telegram.org';

/** Failure talking to the Telegram Bot API. Never carries the bot token. */
export class TelegramApiError extends Error {
  readonly status: number;

  constructor(method: string, status: number, detail: string) {
    super(`Telegram API ${method} failed with status ${status}: ${detail}`);
    this.name = 'TelegramApiError';
    this.status = status;
  }
}

export function createTelegramClient(
  botToken: string,
  fetchImpl: FetchLike = globalThis.fetch,
): TelegramClient {
  async function call(method: string, body: Record<string, unknown>): Promise<void> {
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
    async sendMessage(
      chatId: number,
      text: string,
      buttons?: readonly InlineKeyboardButton[],
    ): Promise<void> {
      const replyMarkup =
        buttons === undefined
          ? undefined
          : { inline_keyboard: [buttons.map((b) => ({ text: b.text, callback_data: b.callbackData }))] };

      await call('sendMessage', {
        chat_id: chatId,
        text,
        ...(replyMarkup === undefined ? {} : { reply_markup: replyMarkup }),
      });
    },

    async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
      await call('answerCallbackQuery', {
        callback_query_id: callbackQueryId,
        ...(text === undefined ? {} : { text }),
      });
    },
  };
}
