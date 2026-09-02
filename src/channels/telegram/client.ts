/**
 * Outbound Telegram Bot API client.
 *
 * `fetch` is injectable so the webhook can be tested without network access.
 */

export interface TelegramClient {
  sendMessage(chatId: number, text: string): Promise<void>;
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
  return {
    async sendMessage(chatId: number, text: string): Promise<void> {
      const response = await fetchImpl(`${API_BASE}/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '<unreadable body>');
        throw new TelegramApiError('sendMessage', response.status, detail.slice(0, 200));
      }
    },
  };
}
