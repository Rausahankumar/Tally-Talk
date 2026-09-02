/**
 * End-to-end tests of the Phase 6 conversation flow: Telegram update -> LLM
 * extraction -> Phase 5 validation -> conversation state -> preview ->
 * Confirm/Cancel. Runs against the real webhook, the real SQLite database
 * (masters seeded as controlled fixtures), and the real conversation and
 * validation modules — only the Telegram HTTP calls and the Anthropic call
 * are replaced with in-memory fakes. No real network access, no real API key.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import { TELEGRAM_WEBHOOK_PATH, createApp } from '../src/app.ts';
import type { Config } from '../src/config/index.ts';
import { SECRET_TOKEN_HEADER } from '../src/channels/telegram/webhook.ts';
import { buildCallbackData } from '../src/channels/telegram/types.ts';
import type { InlineKeyboardButton, TelegramClient } from '../src/channels/telegram/client.ts';
import { createAuditLog } from '../src/audit/log.ts';
import type { AuditLog } from '../src/audit/log.ts';
import { CONVERSATION_DRAFTS_TABLE } from '../src/db/schema.ts';
import { createConversationStore } from '../src/conversation/store.ts';
import type { ConversationStore } from '../src/conversation/store.ts';
import { createTallyMasterCache } from '../src/tally/cache.ts';
import type { LLMClient } from '../src/llm/client.ts';
import type { TransactionDraft } from '../src/llm/schema.ts';
import type { Database } from '../src/db/sqlite.ts';
import { silentLogger } from '../src/logger.ts';
import { createTestDatabase } from './helpers/testDatabase.ts';

const WEBHOOK_SECRET = 'correct-webhook-secret';
const USER_A = 111;
const USER_B = 222;
const UNAUTHORIZED_USER = 999;
const CHAT_A = 5150;
const CHAT_B = 6250;

const config: Config = {
  port: 3000,
  nodeEnv: 'test',
  telegram: {
    botToken: '123456789:AAEEabcdefghijklmnopqrstuvwxyz0123456',
    webhookSecret: WEBHOOK_SECRET,
    allowedUserIds: new Set([USER_A, USER_B]),
  },
  databasePath: ':memory:',
  tally: { host: '127.0.0.1', port: 9000, companyName: 'Test Company' },
  llm: { provider: 'anthropic', apiKey: 'test-api-key', model: 'claude-sonnet-5' },
};

interface SentMessage {
  readonly chatId: number;
  readonly text: string;
  readonly buttons?: readonly InlineKeyboardButton[];
}

function createFakeTelegramClient(): TelegramClient & {
  readonly sent: SentMessage[];
  readonly answeredCallbacks: string[];
} {
  const sent: SentMessage[] = [];
  const answeredCallbacks: string[] = [];
  return {
    sent,
    answeredCallbacks,
    async sendMessage(chatId, text, buttons) {
      sent.push({ chatId, text, buttons });
    },
    async answerCallbackQuery(callbackQueryId) {
      answeredCallbacks.push(callbackQueryId);
    },
  };
}

/** Lets each test script exactly what the "model" returns for the next message. */
function createControllableLLMClient(): LLMClient & {
  setNextResponse(draft: TransactionDraft): void;
  callCount: number;
} {
  let next: TransactionDraft | null = null;
  const state = {
    callCount: 0,
    setNextResponse(draft: TransactionDraft): void {
      next = draft;
    },
    async extractTransactionDraft(): Promise<TransactionDraft> {
      state.callCount += 1;
      if (next === null) throw new Error('test bug: no LLM response scripted for this call');
      return next;
    },
  };
  return state;
}

function draft(overrides: Partial<TransactionDraft> = {}): TransactionDraft {
  return {
    voucherType: 'sales',
    partyName: null,
    items: [],
    gstPercent: null,
    missingFields: [],
    ambiguityNote: null,
    ...overrides,
  };
}

function messageUpdate(userId: number, chatId: number, text: string): object {
  return {
    update_id: Math.floor(Math.random() * 1_000_000),
    message: {
      message_id: 7,
      from: { id: userId, is_bot: false, first_name: 'Test' },
      chat: { id: chatId, type: 'private' },
      text,
    },
  };
}

function callbackUpdate(
  userId: number,
  chatId: number,
  action: 'confirm' | 'cancel',
  draftVersionId: string,
  callbackQueryId = `cbq-${Math.floor(Math.random() * 1_000_000)}`,
): object {
  return {
    update_id: Math.floor(Math.random() * 1_000_000),
    callback_query: {
      id: callbackQueryId,
      from: { id: userId, is_bot: false, first_name: 'Test' },
      message: { message_id: 10, chat: { id: chatId, type: 'private' } },
      data: buildCallbackData(action, draftVersionId),
    },
  };
}

let telegram: ReturnType<typeof createFakeTelegramClient>;
let llm: ReturnType<typeof createControllableLLMClient>;
let database: Database;
let auditLog: AuditLog;
let conversationStore: ConversationStore;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  telegram = createFakeTelegramClient();
  llm = createControllableLLMClient();
  database = createTestDatabase();
  auditLog = createAuditLog({ db: database.db, logger: silentLogger });
  conversationStore = createConversationStore(database.db);

  const masterCache = createTallyMasterCache({ db: database.db });
  masterCache.replaceAll('Ledger', [
    { NAME: 'Ramesh Kumar Enterprises', PARENT: 'Sundry Debtors' },
    { NAME: 'Ramesh Traders', PARENT: 'Sundry Debtors' },
    { NAME: 'Suresh & Sons', PARENT: 'Sundry Creditors' },
  ]);
  masterCache.replaceAll('StockItem', [
    { NAME: 'ACC Cement OPC 43 Grade', PARENT: 'Building Materials', BASEUNITS: 'Bags' },
    { NAME: 'Cement Bags', PARENT: 'Building Materials', BASEUNITS: 'Bags' },
    { NAME: 'Steel Rods', PARENT: 'Building Materials', BASEUNITS: 'Kg' },
  ]);
  masterCache.replaceAll('VoucherType', [{ NAME: 'Sales', PARENT: '' }, { NAME: 'Purchase', PARENT: '' }]);

  app = createApp({ config, telegram, llm, db: database.db, conversationStore, auditLog, logger: silentLogger });
});

afterEach(() => {
  database.close();
});

async function sendMessage(userId: number, chatId: number, text: string): Promise<void> {
  await request(app)
    .post(TELEGRAM_WEBHOOK_PATH)
    .set(SECRET_TOKEN_HEADER, WEBHOOK_SECRET)
    .send(messageUpdate(userId, chatId, text));
}

async function sendCallback(
  userId: number,
  chatId: number,
  action: 'confirm' | 'cancel',
  draftVersionId: string,
): Promise<void> {
  await request(app)
    .post(TELEGRAM_WEBHOOK_PATH)
    .set(SECRET_TOKEN_HEADER, WEBHOOK_SECRET)
    .send(callbackUpdate(userId, chatId, action, draftVersionId));
}

function auditTypes(): string[] {
  return (
    database.db
      .prepare('SELECT type FROM audit_events ORDER BY id')
      .all() as unknown as { type: string }[]
  ).map((r) => r.type);
}

function conversationRow(chatId: number): { status: string; draft_version_id: string } | undefined {
  return database.db
    .prepare(`SELECT status, draft_version_id FROM ${CONVERSATION_DRAFTS_TABLE} WHERE chat_id = ?`)
    .get(chatId) as { status: string; draft_version_id: string } | undefined;
}

describe('a valid transaction request reaches preview', () => {
  it('shows the resolved party, items, quantity, rate, GST, and a no-Tally disclaimer', async () => {
    llm.setNextResponse(
      draft({
        partyName: 'Suresh & Sons',
        items: [{ itemName: 'Steel Rods', quantity: 100, rate: 500 }],
        gstPercent: 18,
      }),
    );

    await sendMessage(USER_A, CHAT_A, 'Sell 100 steel rods to Suresh & Sons at 500 each, 18% GST');

    expect(telegram.sent).toHaveLength(1);
    const preview = telegram.sent[0]!;
    expect(preview.text).toContain('Suresh & Sons');
    expect(preview.text).toContain('Steel Rods');
    expect(preview.text).toContain('100');
    expect(preview.text).toContain('500');
    expect(preview.text).toContain('18%');
    expect(preview.text).toMatch(/nothing has been sent to TallyPrime/i);
    expect(preview.buttons).toHaveLength(2);
    expect(preview.buttons?.map((b) => b.text)).toEqual(['Confirm', 'Cancel']);

    expect(conversationRow(CHAT_A)?.status).toBe('ready_for_confirmation');
    expect(auditTypes()).toEqual(
      expect.arrayContaining(['draft.created', 'validation.completed', 'preview.shown']),
    );
  });
});

describe('missing information triggers a targeted follow-up', () => {
  it('asks only for what is actually missing, and preserves what is known', async () => {
    llm.setNextResponse(
      draft({ partyName: 'Suresh & Sons', items: [{ itemName: 'Steel Rods', quantity: 100, rate: 500 }] }),
    );

    await sendMessage(USER_A, CHAT_A, 'Sell 100 steel rods to Suresh & Sons');

    expect(telegram.sent).toHaveLength(1);
    expect(telegram.sent[0]?.text).toMatch(/GST rate/i);
    expect(telegram.sent[0]?.buttons).toBeUndefined();
    expect(conversationRow(CHAT_A)?.status).toBe('collecting');

    const stored = conversationStore.getActiveDraft(CHAT_A);
    expect(stored?.draft.partyName).toBe('Suresh & Sons');
    expect(stored?.draft.items).toHaveLength(1);
  });
});

describe('a follow-up message continues the existing draft', () => {
  it('merges new information into what was already known rather than starting over', async () => {
    llm.setNextResponse(draft({ partyName: 'Suresh & Sons' }));
    await sendMessage(USER_A, CHAT_A, 'I need to sell something to Suresh & Sons');
    expect(conversationRow(CHAT_A)?.status).toBe('collecting');

    llm.setNextResponse(
      draft({ items: [{ itemName: 'Steel Rods', quantity: 10, rate: 50 }], gstPercent: 18 }),
    );
    await sendMessage(USER_A, CHAT_A, '10 steel rods at 50 each, 18% GST');

    expect(telegram.sent).toHaveLength(2);
    const preview = telegram.sent[1]!;
    expect(preview.text).toContain('Suresh & Sons'); // preserved from turn 1
    expect(preview.text).toContain('Steel Rods'); // added in turn 2
    expect(conversationRow(CHAT_A)?.status).toBe('ready_for_confirmation');
  });
});

describe('an ambiguous master match requires clarification', () => {
  it('shows only the relevant candidates and never guesses', async () => {
    llm.setNextResponse(
      draft({ partyName: 'Ramesh', items: [{ itemName: 'Steel Rods', quantity: 1, rate: 1 }], gstPercent: 18 }),
    );
    await sendMessage(USER_A, CHAT_A, 'Sell to Ramesh: 1 steel rod at ₹1, 18% GST');

    expect(telegram.sent).toHaveLength(1);
    const clarification = telegram.sent[0]!.text;
    expect(clarification).toContain('Ramesh Kumar Enterprises');
    expect(clarification).toContain('Ramesh Traders');
    expect(clarification).not.toContain('Suresh & Sons'); // not a plausible candidate — must not appear
    expect(conversationRow(CHAT_A)?.status).toBe('collecting');
  });

  it('resolves the ambiguity from a plain reply, deterministically, with no extra LLM call', async () => {
    llm.setNextResponse(
      draft({ partyName: 'Ramesh', items: [{ itemName: 'Steel Rods', quantity: 1, rate: 1 }], gstPercent: 18 }),
    );
    await sendMessage(USER_A, CHAT_A, 'Sell to Ramesh: 1 steel rod at ₹1, 18% GST');
    const callsBeforeReply = llm.callCount;

    await sendMessage(USER_A, CHAT_A, 'Ramesh Kumar Enterprises');

    expect(llm.callCount).toBe(callsBeforeReply); // resolved without asking the model again
    expect(telegram.sent).toHaveLength(2);
    expect(telegram.sent[1]?.text).toContain('Ramesh Kumar Enterprises');
    expect(telegram.sent[1]?.buttons).toHaveLength(2); // moved straight to preview
    expect(conversationRow(CHAT_A)?.status).toBe('ready_for_confirmation');
  });
});

describe('conversation isolation between users', () => {
  it('does not let one chat influence another', async () => {
    llm.setNextResponse(draft({ partyName: 'Suresh & Sons' }));
    await sendMessage(USER_A, CHAT_A, 'Selling to Suresh & Sons');

    llm.setNextResponse(draft({ items: [{ itemName: 'Steel Rods', quantity: 5, rate: 50 }] }));
    await sendMessage(USER_B, CHAT_B, '5 steel rods at 50 each');

    const draftA = conversationStore.getActiveDraft(CHAT_A);
    const draftB = conversationStore.getActiveDraft(CHAT_B);

    expect(draftA?.draft.partyName).toBe('Suresh & Sons');
    expect(draftA?.draft.items).toEqual([]); // must not have picked up B's items
    expect(draftB?.draft.partyName).toBeNull(); // must not have picked up A's party
    expect(draftB?.draft.items).toHaveLength(1);
  });
});

describe('confirm', () => {
  async function reachPreview(): Promise<string> {
    llm.setNextResponse(
      draft({
        partyName: 'Suresh & Sons',
        items: [{ itemName: 'Steel Rods', quantity: 100, rate: 500 }],
        gstPercent: 18,
      }),
    );
    await sendMessage(USER_A, CHAT_A, 'Sell 100 steel rods to Suresh & Sons at 500, 18% GST');
    return conversationRow(CHAT_A)!.draft_version_id;
  }

  it('marks only the exact pending draft as confirmed, and calls no Tally capability', async () => {
    const versionId = await reachPreview();

    await sendCallback(USER_A, CHAT_A, 'confirm', versionId);

    expect(conversationRow(CHAT_A)?.status).toBe('confirmed');
    expect(telegram.sent.at(-1)?.text).toMatch(/confirmed/i);
    expect(telegram.sent.at(-1)?.text).toMatch(/not.*sent to TallyPrime|has not been sent/i);
    expect(auditTypes()).toContain('user.confirmed');
    // There is no Tally-write capability anywhere in this codebase; this
    // asserts the behavioural side of that too — nothing Tally-related fires.
    expect(auditTypes().some((t) => t.startsWith('tally.'))).toBe(false);
  });

  it('rejects a duplicate confirmation safely', async () => {
    const versionId = await reachPreview();
    await sendCallback(USER_A, CHAT_A, 'confirm', versionId);

    await sendCallback(USER_A, CHAT_A, 'confirm', versionId);

    expect(auditTypes().filter((t) => t === 'user.confirmed')).toHaveLength(1);
    expect(auditTypes()).toContain('confirmation.rejected');
    expect(telegram.sent.at(-1)?.text).toMatch(/no longer valid/i);
  });

  it('rejects a stale confirmation for a superseded draft version', async () => {
    const staleVersionId = await reachPreview();

    // A follow-up materially changes the draft, minting a new version.
    llm.setNextResponse(draft({ partyName: 'Suresh & Sons', items: [{ itemName: 'Steel Rods', quantity: 200, rate: 500 }], gstPercent: 18 }));
    await sendMessage(USER_A, CHAT_A, 'actually make that 200');

    await sendCallback(USER_A, CHAT_A, 'confirm', staleVersionId);

    expect(conversationRow(CHAT_A)?.status).not.toBe('confirmed');
    expect(auditTypes()).toContain('confirmation.rejected');
  });

  it('rejects a confirmation on an expired draft', async () => {
    const versionId = await reachPreview();
    // Force expiry deterministically rather than waiting on a real clock.
    database.db
      .prepare(`UPDATE ${CONVERSATION_DRAFTS_TABLE} SET expires_at = '2000-01-01T00:00:00.000Z' WHERE chat_id = ?`)
      .run(CHAT_A);

    await sendCallback(USER_A, CHAT_A, 'confirm', versionId);

    expect(conversationRow(CHAT_A)?.status).toBe('expired');
    const rejectedEvent = database.db
      .prepare("SELECT data FROM audit_events WHERE type = 'confirmation.rejected'")
      .get() as { data: string } | undefined;
    expect(JSON.parse(rejectedEvent?.data ?? '{}').reason).toBe('expired');
  });
});

describe('cancel', () => {
  it('invalidates the pending draft', async () => {
    llm.setNextResponse(
      draft({ partyName: 'Suresh & Sons', items: [{ itemName: 'Steel Rods', quantity: 1, rate: 1 }], gstPercent: 18 }),
    );
    await sendMessage(USER_A, CHAT_A, 'Sell 1 steel rod to Suresh & Sons at 1, 18% GST');
    const versionId = conversationRow(CHAT_A)!.draft_version_id;

    await sendCallback(USER_A, CHAT_A, 'cancel', versionId);

    expect(conversationRow(CHAT_A)?.status).toBe('cancelled');
    expect(telegram.sent.at(-1)?.text).toMatch(/cancelled/i);
    expect(auditTypes()).toContain('user.cancelled');
  });

  it('a cancelled draft cannot later be confirmed', async () => {
    llm.setNextResponse(
      draft({ partyName: 'Suresh & Sons', items: [{ itemName: 'Steel Rods', quantity: 1, rate: 1 }], gstPercent: 18 }),
    );
    await sendMessage(USER_A, CHAT_A, 'Sell 1 steel rod to Suresh & Sons at 1, 18% GST');
    const versionId = conversationRow(CHAT_A)!.draft_version_id;
    await sendCallback(USER_A, CHAT_A, 'cancel', versionId);

    await sendCallback(USER_A, CHAT_A, 'confirm', versionId);

    expect(conversationRow(CHAT_A)?.status).toBe('cancelled');
    expect(auditTypes()).toContain('confirmation.rejected');
  });
});

describe('security gates remain unchanged for both update kinds', () => {
  it('blocks a text message from an unauthorized user', async () => {
    await sendMessage(UNAUTHORIZED_USER, 99999, 'Sell 100 bags to Ramesh');

    expect(telegram.sent).toHaveLength(0);
    expect(auditTypes()).toContain('authorization.denied');
  });

  it('blocks a callback query from an unauthorized user, even with a well-formed callback', async () => {
    await sendCallback(UNAUTHORIZED_USER, 99999, 'confirm', '11111111-1111-1111-1111-111111111111');

    expect(telegram.sent).toHaveLength(0);
    expect(telegram.answeredCallbacks).toHaveLength(0);
    expect(auditTypes()).toContain('authorization.denied');
  });

  it('rejects a callback query from an authorized user for a chat with no pending draft', async () => {
    await sendCallback(USER_A, CHAT_A, 'confirm', '11111111-1111-1111-1111-111111111111');

    expect(conversationRow(CHAT_A)).toBeUndefined();
    expect(auditTypes()).toContain('confirmation.rejected');
  });
});

describe('malformed callback handling', () => {
  it('ignores a callback with data not matching the expected format', async () => {
    await request(app)
      .post(TELEGRAM_WEBHOOK_PATH)
      .set(SECRET_TOKEN_HEADER, WEBHOOK_SECRET)
      .send({
        update_id: 1,
        callback_query: {
          id: 'cbq1',
          from: { id: USER_A, is_bot: false },
          message: { chat: { id: CHAT_A } },
          data: 'not-a-recognised-format',
        },
      });

    expect(telegram.sent).toHaveLength(0);
    expect(auditTypes()).toEqual([]);
  });

  it('ignores a callback query with no data field', async () => {
    await request(app)
      .post(TELEGRAM_WEBHOOK_PATH)
      .set(SECRET_TOKEN_HEADER, WEBHOOK_SECRET)
      .send({
        update_id: 1,
        callback_query: { id: 'cbq1', from: { id: USER_A }, message: { chat: { id: CHAT_A } } },
      });

    expect(telegram.sent).toHaveLength(0);
  });

  it('ignores a callback query missing the sender', async () => {
    await request(app)
      .post(TELEGRAM_WEBHOOK_PATH)
      .set(SECRET_TOKEN_HEADER, WEBHOOK_SECRET)
      .send({
        update_id: 1,
        callback_query: { id: 'cbq1', message: { chat: { id: CHAT_A } }, data: 'tt:confirm:x' },
      });

    expect(telegram.sent).toHaveLength(0);
  });
});
