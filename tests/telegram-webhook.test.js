import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { TELEGRAM_WEBHOOK_PATH, createApp } from '../src/app.js';
import { SECRET_TOKEN_HEADER } from '../src/channels/telegram/webhook.js';
import { silentLogger } from '../src/logger.js';
import { createAuditLog } from '../src/audit/log.js';
import { createConversationStore } from '../src/conversation/store.js';
import { createItemLedgerMappingStore } from '../src/gst/itemLedgerMapping.js';
import { createStockAvailabilityCache } from '../src/tally/stockAvailabilityCache.js';
import { createPostingStore } from '../src/tally/posting.js';
import { createTestDatabase } from './helpers/testDatabase.js';
/** None of this file's tests reach a real Confirm — this must never be called. */
function unusedPostingClient() {
  return {
    async importVoucher() {
      throw new Error('test bug: unexpected Tally import call in telegram-webhook.test.js');
    },
  };
}
/** A draft that extracts to "nothing usable" — deterministic, no real LLM call. */
const UNKNOWN_DRAFT = {
  voucherType: 'unknown',
  partyName: null,
  items: [],
  gstPercent: null,
  placeOfSupply: null,
  missingFields: ['voucherType', 'partyName', 'items', 'gstPercent', 'placeOfSupply'],
  ambiguityNote: null,
};
function createFakeLLMClient(draft = UNKNOWN_DRAFT) {
  return {
    async extractTransactionDraft() {
      return draft;
    },
  };
}
const WEBHOOK_SECRET = 'correct-webhook-secret';
const AUTHORIZED_USER_ID = 111;
const UNAUTHORIZED_USER_ID = 999;
const CHAT_ID = 5150;
/** Records outbound calls instead of hitting the Telegram API. */
function createFakeTelegramClient() {
  const sent = [];
  return {
    sent,
    async sendMessage(chatId, text) {
      sent.push({ chatId, text });
    },
    async answerCallbackQuery() {},
  };
}
const config = {
  port: 3000,
  nodeEnv: 'test',
  telegram: {
    botToken: '123456789:AAEEabcdefghijklmnopqrstuvwxyz0123456',
    webhookSecret: WEBHOOK_SECRET,
    allowedUserIds: new Set([AUTHORIZED_USER_ID]),
  },
  databasePath: ':memory:',
  tally: { host: '127.0.0.1', port: 9000 },
  llm: {
    provider: 'anthropic',
    apiKey: 'test-api-key',
    model: 'claude-sonnet-5',
    workspaceId: null,
  },
  gst: { defaultPlaceOfSupply: null },
};
// companyName/companyState are discovered from Tally at startup in the real
// app (tally/company.js) — passed directly here, the same way server.js does.
const COMPANY_NAME = 'Test Company';
const COMPANY_STATE = 'Delhi';
function messageUpdate(userId, text) {
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
let telegram;
let database;
let auditLog;
let conversationStore;
let app;
beforeEach(() => {
  telegram = createFakeTelegramClient();
  database = createTestDatabase();
  auditLog = createAuditLog({ db: database.db, logger: silentLogger });
  conversationStore = createConversationStore(database.db);
  app = createApp({
    config,
    companyName: COMPANY_NAME,
    companyState: COMPANY_STATE,
    telegram,
    llm: createFakeLLMClient(),
    db: database.db,
    conversationStore,
    itemLedgerMappingStore: createItemLedgerMappingStore(database.db),
    stockAvailabilityStore: createStockAvailabilityCache({ db: database.db }),
    postingStore: createPostingStore(database.db),
    postingClient: unusedPostingClient(),
    auditLog,
    logger: silentLogger,
  });
});
afterEach(() => {
  database.close();
});
/** Every event recorded so far, oldest first. */
function recordedEvents() {
  return database.db
    .prepare(
      'SELECT type, correlation_id, telegram_user_id, chat_id, actor_kind, data FROM audit_events ORDER BY id',
    )
    .all();
}
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
  it('lets an authorized user reach the conversation layer and get a reply', async () => {
    const response = await request(app)
      .post(TELEGRAM_WEBHOOK_PATH)
      .set(SECRET_TOKEN_HEADER, WEBHOOK_SECRET)
      .send(messageUpdate(AUTHORIZED_USER_ID, 'sell 100 bags to Ramesh'));
    expect(response.status).toBe(200);
    // The exact reply is the conversation layer's concern (see the dedicated
    // Phase 6 flow tests) — this only proves the gates let the message through.
    expect(telegram.sent).toHaveLength(1);
    expect(telegram.sent[0]?.chatId).toBe(CHAT_ID);
  });
  it('treats /start as an ordinary text message — there is no dedicated command handler', async () => {
    const response = await request(app)
      .post(TELEGRAM_WEBHOOK_PATH)
      .set(SECRET_TOKEN_HEADER, WEBHOOK_SECRET)
      .send(messageUpdate(AUTHORIZED_USER_ID, '/start'));
    expect(response.status).toBe(200);
    // Same gates, same conversation layer, same reply path as any other text —
    // /start carries no special meaning anywhere in this codebase.
    expect(telegram.sent).toHaveLength(1);
    expect(telegram.sent[0]?.chatId).toBe(CHAT_ID);
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
      .send(body);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(telegram.sent).toHaveLength(0);
  });
});
describe('audit trail', () => {
  it('records a rejected webhook without trusting anything in the body', async () => {
    await request(app)
      .post(TELEGRAM_WEBHOOK_PATH)
      .set(SECRET_TOKEN_HEADER, 'wrong-webhook-secret')
      .send(messageUpdate(AUTHORIZED_USER_ID, 'sell 100 bags'));
    const events = recordedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('webhook.rejected');
    expect(events[0]?.actor_kind).toBe('system');
    expect(events[0]?.telegram_user_id).toBeNull();
    expect(JSON.parse(events[0]?.data ?? '{}')).toEqual({ reason: 'invalid_secret_token' });
    // The unauthenticated caller's claimed user id and text must not be stored.
    expect(JSON.stringify(events[0])).not.toContain('sell 100 bags');
    expect(JSON.stringify(events[0])).not.toContain(String(AUTHORIZED_USER_ID));
  });
  it('distinguishes a missing secret token from a wrong one', async () => {
    await request(app).post(TELEGRAM_WEBHOOK_PATH).send(messageUpdate(AUTHORIZED_USER_ID, 'hi'));
    expect(JSON.parse(recordedEvents()[0]?.data ?? '{}')).toEqual({
      reason: 'missing_secret_token',
    });
  });
  it('records the message and the denial for an unauthorized user', async () => {
    await request(app)
      .post(TELEGRAM_WEBHOOK_PATH)
      .set(SECRET_TOKEN_HEADER, WEBHOOK_SECRET)
      .send(messageUpdate(UNAUTHORIZED_USER_ID, 'sell 100 bags to Ramesh'));
    const events = recordedEvents();
    expect(events.map((e) => e.type)).toEqual(['message.received', 'authorization.denied']);
    expect(JSON.parse(events[0]?.data ?? '{}')).toEqual({ text: 'sell 100 bags to Ramesh' });
    expect(JSON.parse(events[1]?.data ?? '{}')).toEqual({ reason: 'user_not_on_allowlist' });
    expect(events[1]?.telegram_user_id).toBe(UNAUTHORIZED_USER_ID);
  });
  it('records the message and the grant for an authorized user before anything else', async () => {
    await request(app)
      .post(TELEGRAM_WEBHOOK_PATH)
      .set(SECRET_TOKEN_HEADER, WEBHOOK_SECRET)
      .send(messageUpdate(AUTHORIZED_USER_ID, 'sell 100 bags to Ramesh'));
    const events = recordedEvents();
    expect(events.slice(0, 2).map((e) => e.type)).toEqual([
      'message.received',
      'authorization.granted',
    ]);
    expect(events[0]?.telegram_user_id).toBe(AUTHORIZED_USER_ID);
    expect(events[0]?.chat_id).toBe(CHAT_ID);
  });
  it('ties every event of one turn to a single correlation id', async () => {
    await request(app)
      .post(TELEGRAM_WEBHOOK_PATH)
      .set(SECRET_TOKEN_HEADER, WEBHOOK_SECRET)
      .send(messageUpdate(AUTHORIZED_USER_ID, 'hello'));
    const correlationIds = new Set(recordedEvents().map((e) => e.correlation_id));
    expect(correlationIds.size).toBe(1);
    const [correlationId] = [...correlationIds];
    // message.received, authorization.granted, llm.extraction.completed,
    // validation.completed, draft.created — the conversation layer's own
    // tests cover the exact content of each.
    expect(auditLog.findByCorrelationId(correlationId).length).toBeGreaterThanOrEqual(2);
  });
  it('gives separate turns separate correlation ids', async () => {
    for (const text of ['first', 'second']) {
      await request(app)
        .post(TELEGRAM_WEBHOOK_PATH)
        .set(SECRET_TOKEN_HEADER, WEBHOOK_SECRET)
        .send(messageUpdate(AUTHORIZED_USER_ID, text));
    }
    expect(new Set(recordedEvents().map((e) => e.correlation_id)).size).toBe(2);
  });
  it('does not record updates it cannot handle', async () => {
    await request(app)
      .post(TELEGRAM_WEBHOOK_PATH)
      .set(SECRET_TOKEN_HEADER, WEBHOOK_SECRET)
      .send({ update_id: 1 });
    expect(recordedEvents()).toHaveLength(0);
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
