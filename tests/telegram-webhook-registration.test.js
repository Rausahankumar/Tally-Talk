import { describe, expect, it } from 'vitest';
import { registerWebhook } from '../src/channels/telegram/webhookRegistration.js';
import { silentLogger } from '../src/logger.js';
const WEBHOOK_PATH = '/webhook/telegram';
function fakeTelegram(setWebhookImpl) {
  const calls = [];
  return {
    calls,
    async setWebhook(url, secretToken) {
      calls.push({ url, secretToken });
      if (setWebhookImpl !== undefined) await setWebhookImpl(url, secretToken);
    },
  };
}
describe('registerWebhook', () => {
  it('skips entirely when PUBLIC_WEBHOOK_URL is not configured — local dev keeps registering by hand', async () => {
    const telegram = fakeTelegram();
    const config = { telegram: { publicWebhookUrl: null, webhookSecret: 'shh' } };
    await registerWebhook(telegram, config, WEBHOOK_PATH, silentLogger);
    expect(telegram.calls).toHaveLength(0);
  });
  it('registers the full URL (base + webhook path) with the configured secret when PUBLIC_WEBHOOK_URL is set', async () => {
    const telegram = fakeTelegram();
    const config = {
      telegram: { publicWebhookUrl: 'https://tallytalk.example.com', webhookSecret: 'my-secret' },
    };
    await registerWebhook(telegram, config, WEBHOOK_PATH, silentLogger);
    expect(telegram.calls).toEqual([
      { url: 'https://tallytalk.example.com/webhook/telegram', secretToken: 'my-secret' },
    ]);
  });
  it('is idempotent by construction: calling it repeatedly always sends the exact same request, matching Telegram\'s own no-op-on-repeat contract', async () => {
    const telegram = fakeTelegram();
    const config = {
      telegram: { publicWebhookUrl: 'https://tallytalk.example.com', webhookSecret: 'my-secret' },
    };
    await registerWebhook(telegram, config, WEBHOOK_PATH, silentLogger);
    await registerWebhook(telegram, config, WEBHOOK_PATH, silentLogger);
    await registerWebhook(telegram, config, WEBHOOK_PATH, silentLogger);
    expect(telegram.calls).toHaveLength(3);
    expect(new Set(telegram.calls.map((c) => JSON.stringify(c))).size).toBe(1); // every call identical
  });
  it('a failure talking to Telegram is logged, never thrown — the HTTP server must keep serving requests regardless', async () => {
    const telegram = fakeTelegram(async () => {
      throw new Error('Telegram unreachable');
    });
    const config = {
      telegram: { publicWebhookUrl: 'https://tallytalk.example.com', webhookSecret: 'my-secret' },
    };
    await expect(registerWebhook(telegram, config, WEBHOOK_PATH, silentLogger)).resolves.toBeUndefined();
  });
});
