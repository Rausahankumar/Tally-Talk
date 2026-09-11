import { describe, expect, it } from 'vitest';
import { TelegramApiError, createTelegramClient } from '../src/channels/telegram/client.js';
/** A fake `fetch` that records the request and returns a scripted response — never real network access. */
function fakeFetch({ ok = true, status = 200, body = '' } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok, status, text: async () => body };
  };
  return { calls, fetchImpl };
}
describe('createTelegramClient — setWebhook', () => {
  it('calls Telegram\'s setWebhook with the url and secret_token, never echoing the bot token in the request body', async () => {
    const { calls, fetchImpl } = fakeFetch();
    const client = createTelegramClient('123456:real-bot-token', fetchImpl);
    await client.setWebhook('https://example.com/webhook/telegram', 'my-webhook-secret');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.telegram.org/bot123456:real-bot-token/setWebhook');
    const body = JSON.parse(calls[0].options.body);
    expect(body).toEqual({ url: 'https://example.com/webhook/telegram', secret_token: 'my-webhook-secret' });
  });
  it('throws TelegramApiError on a non-ok response, without leaking the bot token', async () => {
    const { fetchImpl } = fakeFetch({ ok: false, status: 401, body: 'Unauthorized' });
    const client = createTelegramClient('123456:real-bot-token', fetchImpl);
    await expect(client.setWebhook('https://example.com/webhook/telegram', 'secret')).rejects.toThrow(
      TelegramApiError,
    );
    try {
      await client.setWebhook('https://example.com/webhook/telegram', 'secret');
    } catch (error) {
      expect(error.message).not.toContain('real-bot-token');
      expect(error.status).toBe(401);
    }
  });
});
