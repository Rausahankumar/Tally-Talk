import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import { TELEGRAM_WEBHOOK_PATH, createApp } from '../src/app.ts';
import type { Config } from '../src/config/index.ts';
import { SECRET_TOKEN_HEADER } from '../src/channels/telegram/webhook.ts';
import type { TelegramClient } from '../src/channels/telegram/client.ts';
import { silentLogger } from '../src/logger.ts';

const WEBHOOK_SECRET = 'correct-webhook-secret';
const AUTHORIZED_USER_ID = 111;
const UNAUTHORIZED_USER_ID = 999;
const CHAT_ID = 5150;

interface SentMessage {
  chatId: number;
  text: string;
}

/** Records outbound calls instead of hitting the Telegram API. */
function createFakeTelegramClient(): TelegramClient & { readonly sent: SentMessage[] } {
  const sent: SentMessage[] = [];
  return {
    sent,
    async sendMessage(chatId: number, text: string): Promise<void> {
      sent.push({ chatId, text });
    },
  };
}

const config: Config = {
  port: 3000,
  nodeEnv: 'test',
  telegram: {
    botToken: '123456789:AAEEabcdefghijklmnopqrstuvwxyz0123456',
    webhookSecret: WEBHOOK_SECRET,
    allowedUserIds: new Set([AUTHORIZED_USER_ID]),
  },
};

function messageUpdate(userId: number, text: string): object {
  return {
    update_id: 1,
    message: {
      message_id: 7,
      from: { id: userId, is_bot: false, first_name: 'Test' },
      chat: { id: CHAT_ID, type: 'private' },
      text,
    },
  };
}

let telegram: ReturnType<typeof createFakeTelegramClient>;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  telegram = createFakeTelegramClient();
  app = createApp({ config, telegram, logger: silentLogger });
});

describe('secret token verification', () => {
  it('rejects a request with no secret token header', async () => {
    const response = await request(app)
      .post(TELEGRAM_WEBHOOK_PATH)
      .send(messageUpdate(AUTHORIZED_USER_ID, 'hello'));

    expect(response.status).toBe(401);
    expect(telegram.sent).toHaveLength(0);
  });

  it('rejects a request with the wrong secret token', async () => {
    const response = await request(app)
      .post(TELEGRAM_WEBHOOK_PATH)
      .set(SECRET_TOKEN_HEADER, 'wrong-webhook-secret')
      .send(messageUpdate(AUTHORIZED_USER_ID, 'hello'));

    expect(response.status).toBe(401);
    expect(telegram.sent).toHaveLength(0);
  });

  it('rejects a secret token of a different length', async () => {
    const response = await request(app)
      .post(TELEGRAM_WEBHOOK_PATH)
      .set(SECRET_TOKEN_HEADER, `${WEBHOOK_SECRET}-extra`)
      .send(messageUpdate(AUTHORIZED_USER_ID, 'hello'));

    expect(response.status).toBe(401);
    expect(telegram.sent).toHaveLength(0);
  });

  it('does not disclose why the request was rejected', async () => {
    const response = await request(app)
      .post(TELEGRAM_WEBHOOK_PATH)
      .set(SECRET_TOKEN_HEADER, 'wrong-webhook-secret')
      .send(messageUpdate(AUTHORIZED_USER_ID, 'hello'));

    expect(response.body).toEqual({ error: 'unauthorized' });
    expect(JSON.stringify(response.body)).not.toContain(WEBHOOK_SECRET);
  });

  it('checks the secret before the allowlist, so an unauthenticated caller cannot probe user ids', async () => {
    const response = await request(app)
      .post(TELEGRAM_WEBHOOK_PATH)
      .send(messageUpdate(UNAUTHORIZED_USER_ID, 'hello'));

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'unauthorized' });
  });
});

describe('user allowlist', () => {
  it('drops a message from a user not on the allowlist without replying', async () => {
    const response = await request(app)
      .post(TELEGRAM_WEBHOOK_PATH)
      .set(SECRET_TOKEN_HEADER, WEBHOOK_SECRET)
      .send(messageUpdate(UNAUTHORIZED_USER_ID, 'sell 100 bags to Ramesh'));

    // Acknowledged so Telegram stops retrying, but nothing is sent back.
    expect(response.status).toBe(200);
    expect(telegram.sent).toHaveLength(0);
  });

  it('echoes a message from an authorized user', async () => {
    const response = await request(app)
      .post(TELEGRAM_WEBHOOK_PATH)
      .set(SECRET_TOKEN_HEADER, WEBHOOK_SECRET)
      .send(messageUpdate(AUTHORIZED_USER_ID, 'sell 100 bags to Ramesh'));

    expect(response.status).toBe(200);
    expect(telegram.sent).toEqual([
      { chatId: CHAT_ID, text: 'TallyTalk received: sell 100 bags to Ramesh' },
    ]);
  });
});

describe('update parsing', () => {
  it.each([
    ['an empty body', {}],
    ['an update with no message', { update_id: 1 }],
    ['a message with no sender', { message: { chat: { id: CHAT_ID }, text: 'hi' } }],
    ['a message with no chat', { message: { from: { id: AUTHORIZED_USER_ID }, text: 'hi' } }],
    [
      'a message with no text',
      { message: { from: { id: AUTHORIZED_USER_ID }, chat: { id: CHAT_ID } } },
    ],
    [
      'a whitespace-only message',
      { message: { from: { id: AUTHORIZED_USER_ID }, chat: { id: CHAT_ID }, text: '   ' } },
    ],
    [
      'a non-numeric user id',
      { message: { from: { id: 'abc' }, chat: { id: CHAT_ID }, text: 'hi' } },
    ],
  ])('acknowledges but ignores %s', async (_label, body) => {
    const response = await request(app)
      .post(TELEGRAM_WEBHOOK_PATH)
      .set(SECRET_TOKEN_HEADER, WEBHOOK_SECRET)
      .send(body as object);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(telegram.sent).toHaveLength(0);
  });
});

describe('server basics', () => {
  it('serves a health check', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('returns 404 for unknown routes', async () => {
    const response = await request(app).get('/does-not-exist');

    expect(response.status).toBe(404);
  });

  it('does not accept the webhook on a different path', async () => {
    const response = await request(app)
      .post('/webhook')
      .set(SECRET_TOKEN_HEADER, WEBHOOK_SECRET)
      .send(messageUpdate(AUTHORIZED_USER_ID, 'hello'));

    expect(response.status).toBe(404);
    expect(telegram.sent).toHaveLength(0);
  });
});
