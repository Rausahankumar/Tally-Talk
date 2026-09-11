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
import { TELEGRAM_WEBHOOK_PATH, createApp } from '../src/app.js';
import { SECRET_TOKEN_HEADER } from '../src/channels/telegram/webhook.js';
import { buildCallbackData } from '../src/channels/telegram/types.js';
import { createAuditLog } from '../src/audit/log.js';
import { CONVERSATION_DRAFTS_TABLE } from '../src/db/schema.js';
import { createConversationStore } from '../src/conversation/store.js';
import { createTallyMasterCache } from '../src/tally/cache.js';
import { createStockAvailabilityCache } from '../src/tally/stockAvailabilityCache.js';
import { createItemLedgerMappingStore } from '../src/gst/itemLedgerMapping.js';
import { createPostingStore } from '../src/tally/posting.js';
import { silentLogger } from '../src/logger.js';
import { createTestDatabase } from './helpers/testDatabase.js';
const WEBHOOK_SECRET = 'correct-webhook-secret';
const USER_A = 111;
const USER_B = 222;
const UNAUTHORIZED_USER = 999;
const CHAT_A = 5150;
const CHAT_B = 6250;
/**
 * A real syncCoordinator talks to Tally live — never appropriate here. This
 * fake always reports success without touching the cache at all, so a
 * refresh-and-retry (see masterResolutionRefresh.js) is a harmless no-op:
 * whatever the fixture already seeded is still exactly what the retry sees,
 * preserving every existing assertion in this file unchanged. Dedicated
 * coverage of the refresh mechanism itself lives in its own test file.
 */
const noOpSyncCoordinator = { ensureFreshSync: async () => ({ ok: true, result: {} }) };
const config = {
  port: 3000,
  nodeEnv: 'test',
  telegram: {
    botToken: '123456789:AAEEabcdefghijklmnopqrstuvwxyz0123456',
    webhookSecret: WEBHOOK_SECRET,
    allowedUserIds: new Set([USER_A, USER_B]),
  },
  gst: {
    // A default is configured for the shared fixture so tests unrelated to
    // GST (extraction, merge, ambiguity, confirm/cancel) keep reaching
    // preview exactly as before. The dedicated "Phase 8" tests below build
    // their own app with no default to test the "must ask" behaviour.
    defaultPlaceOfSupply: 'Delhi',
  },
  databasePath: ':memory:',
  tally: { host: '127.0.0.1', port: 9000 },
  llm: {
    provider: 'anthropic',
    apiKey: 'test-api-key',
    model: 'claude-sonnet-5',
    workspaceId: null,
  },
};
function createFakeTelegramClient() {
  const sent = [];
  const answeredCallbacks = [];
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
function createControllableLLMClient() {
  let next = null;
  const state = {
    callCount: 0,
    setNextResponse(draft) {
      next = draft;
    },
    async extractTransactionDraft() {
      state.callCount += 1;
      if (next === null) throw new Error('test bug: no LLM response scripted for this call');
      return next;
    },
  };
  return state;
}
const DEFAULT_POST_OUTCOME = {
  outcome: 'posted',
  message: 'Voucher created in TallyPrime',
  tallyVoucherId: 'TV-1',
  raw: '<RESPONSE><CREATED>1</CREATED><ERRORS>0</ERRORS></RESPONSE>',
};
/** Lets each test script exactly what a "TallyPrime Import request" returns, without any real network call. */
function createControllableTallyPostingClient() {
  let next = DEFAULT_POST_OUTCOME;
  const calls = [];
  return {
    calls,
    setNextResult(result) {
      next = result;
    },
    async importVoucher(xml) {
      calls.push(xml);
      return next;
    },
  };
}
function draft(overrides = {}) {
  return {
    voucherType: 'sales',
    partyName: null,
    items: [],
    gstPercent: null,
    placeOfSupply: null,
    missingFields: [],
    ambiguityNote: null,
    ...overrides,
  };
}
function messageUpdate(userId, chatId, text) {
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
  userId,
  chatId,
  action,
  draftVersionId,
  callbackQueryId = `cbq-${Math.floor(Math.random() * 1_000_000)}`,
) {
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
let telegram;
let llm;
let database;
let auditLog;
let conversationStore;
let itemLedgerMappingStore;
let stockAvailabilityStore;
let postingStore;
let postingClient;
let app;
beforeEach(() => {
  telegram = createFakeTelegramClient();
  llm = createControllableLLMClient();
  database = createTestDatabase();
  auditLog = createAuditLog({ db: database.db, logger: silentLogger });
  conversationStore = createConversationStore(database.db);
  const masterCache = createTallyMasterCache({ db: database.db });
  masterCache.replaceAll('Ledger', [
    // Sales parties are Sundry Creditors under this deployment's corrected
    // voucher-type/group mapping (see masterLookup.js) — both fixtures below
    // are used in sales-voucher scenarios.
    { NAME: 'Ramesh Kumar Enterprises', PARENT: 'Sundry Creditors' },
    { NAME: 'Ramesh Traders', PARENT: 'Sundry Creditors' },
    { NAME: 'Suresh & Sons', PARENT: 'Sundry Creditors' },
    // TAXTYPE/GSTDUTYHEAD confirmed live on real CGST/SGST ledgers (see
    // gstLedgerResolution.js) — required for dynamic GST ledger resolution.
    { NAME: 'CGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'CGST' },
    { NAME: 'SGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'SGST/UTGST' },
    { NAME: 'IGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'IGST' },
    { NAME: 'Sales', PARENT: 'Sales Accounts' },
    { NAME: 'Purchase', PARENT: 'Purchase Accounts' },
  ]);
  masterCache.replaceAll('StockItem', [
    { NAME: 'ACC Cement OPC 43 Grade', PARENT: 'Building Materials', BASEUNITS: 'Bags' },
    { NAME: 'Cement Bags', PARENT: 'Building Materials', BASEUNITS: 'Bags' },
    { NAME: 'Steel Rods', PARENT: 'Building Materials', BASEUNITS: 'Kg' },
  ]);
  masterCache.replaceAll('VoucherType', [
    { NAME: 'Sales', PARENT: '' },
    { NAME: 'Purchase', PARENT: '' },
  ]);
  masterCache.replaceAll('Godown', [{ NAME: 'Main Location', PARENT: 'Primary' }]);
  itemLedgerMappingStore = createItemLedgerMappingStore(database.db);
  stockAvailabilityStore = createStockAvailabilityCache({ db: database.db });
  for (const stockItemName of ['ACC Cement OPC 43 Grade', 'Cement Bags', 'Steel Rods']) {
    itemLedgerMappingStore.setMapping({
      stockItemName,
      salesLedger: 'Sales',
      purchaseLedger: 'Purchase',
    });
    // Ample, unambiguous stock so tests unrelated to stock availability keep
    // reaching preview exactly as before.
    stockAvailabilityStore.replaceAllForItem(stockItemName, [
      { batchName: 'Primary Batch', godownName: 'Main Location', quantity: 100000, unit: 'Nos' },
    ]);
  }
  postingStore = createPostingStore(database.db);
  postingClient = createControllableTallyPostingClient();
  app = createApp({
    config,
    // Discovered from Tally at real startup (tally/company.js) — passed
    // directly here, matching what server.js does.
    companyName: 'Test Company',
    companyState: 'Delhi',
    telegram,
    llm,
    db: database.db,
    conversationStore,
    itemLedgerMappingStore,
    stockAvailabilityStore,
    postingStore,
    postingClient,
    syncCoordinator: noOpSyncCoordinator,
    auditLog,
    logger: silentLogger,
  });
});
afterEach(() => {
  database.close();
});
async function sendMessage(userId, chatId, text) {
  await request(app)
    .post(TELEGRAM_WEBHOOK_PATH)
    .set(SECRET_TOKEN_HEADER, WEBHOOK_SECRET)
    .send(messageUpdate(userId, chatId, text));
}
async function sendCallback(userId, chatId, action, draftVersionId, callbackQueryId) {
  await request(app)
    .post(TELEGRAM_WEBHOOK_PATH)
    .set(SECRET_TOKEN_HEADER, WEBHOOK_SECRET)
    .send(
      callbackQueryId === undefined
        ? callbackUpdate(userId, chatId, action, draftVersionId)
        : callbackUpdate(userId, chatId, action, draftVersionId, callbackQueryId),
    );
}
function auditTypes() {
  return database.db
    .prepare('SELECT type FROM audit_events ORDER BY id')
    .all()
    .map((r) => r.type);
}
function conversationRow(chatId) {
  return database.db
    .prepare(`SELECT status, draft_version_id FROM ${CONVERSATION_DRAFTS_TABLE} WHERE chat_id = ?`)
    .get(chatId);
}
describe('a valid transaction request reaches preview', () => {
  it('shows the resolved party, items, quantity, rate, GST, and a no-Tally disclaimer', async () => {
    llm.setNextResponse(
      draft({
        partyName: 'Suresh & Sons',
        items: [{ itemName: 'Steel Rods', quantity: 100, rate: 500, godown: null }],
        gstPercent: 18,
      }),
    );
    await sendMessage(USER_A, CHAT_A, 'Sell 100 steel rods to Suresh & Sons at 500 each, 18% GST');
    expect(telegram.sent).toHaveLength(1);
    const preview = telegram.sent[0];
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
    // Rate is genuinely missing (Steel Rods has no configured/Tally rate).
    // GST is deliberately left unstated too — Steel Rods has no Tally GST
    // data either, but GST is optional, not mandatory (unlike rate), so it
    // must resolve silently to no-GST and never appear in the follow-up.
    llm.setNextResponse(
      draft({
        partyName: 'Suresh & Sons',
        items: [{ itemName: 'Steel Rods', quantity: 100, rate: null, godown: null }],
      }),
    );
    await sendMessage(USER_A, CHAT_A, 'Sell 100 steel rods to Suresh & Sons');
    expect(telegram.sent).toHaveLength(1);
    expect(telegram.sent[0]?.text).toMatch(/rate per unit/i);
    expect(telegram.sent[0]?.text).not.toMatch(/GST rate/i);
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
      draft({
        items: [{ itemName: 'Steel Rods', quantity: 10, rate: 50, godown: null }],
        gstPercent: 18,
      }),
    );
    await sendMessage(USER_A, CHAT_A, '10 steel rods at 50 each, 18% GST');
    expect(telegram.sent).toHaveLength(2);
    const preview = telegram.sent[1];
    expect(preview.text).toContain('Suresh & Sons'); // preserved from turn 1
    expect(preview.text).toContain('Steel Rods'); // added in turn 2
    expect(conversationRow(CHAT_A)?.status).toBe('ready_for_confirmation');
  });
});
describe('an ambiguous master match requires clarification', () => {
  it('shows only the relevant candidates and never guesses', async () => {
    llm.setNextResponse(
      draft({
        partyName: 'Ramesh',
        items: [{ itemName: 'Steel Rods', quantity: 1, rate: 1, godown: null }],
        gstPercent: 18,
      }),
    );
    await sendMessage(USER_A, CHAT_A, 'Sell to Ramesh: 1 steel rod at ₹1, 18% GST');
    expect(telegram.sent).toHaveLength(1);
    const clarification = telegram.sent[0].text;
    expect(clarification).toContain('Ramesh Kumar Enterprises');
    expect(clarification).toContain('Ramesh Traders');
    expect(clarification).not.toContain('Suresh & Sons'); // not a plausible candidate — must not appear
    expect(conversationRow(CHAT_A)?.status).toBe('collecting');
  });
  it('resolves the ambiguity from a plain reply, deterministically, with no extra LLM call', async () => {
    llm.setNextResponse(
      draft({
        partyName: 'Ramesh',
        items: [{ itemName: 'Steel Rods', quantity: 1, rate: 1, godown: null }],
        gstPercent: 18,
      }),
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
    llm.setNextResponse(
      draft({ items: [{ itemName: 'Steel Rods', quantity: 5, rate: 50, godown: null }] }),
    );
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
  async function reachPreview() {
    llm.setNextResponse(
      draft({
        partyName: 'Suresh & Sons',
        items: [{ itemName: 'Steel Rods', quantity: 100, rate: 500, godown: null }],
        gstPercent: 18,
      }),
    );
    await sendMessage(USER_A, CHAT_A, 'Sell 100 steel rods to Suresh & Sons at 500, 18% GST');
    return conversationRow(CHAT_A).draft_version_id;
  }
  it('confirms, posts to TallyPrime, and reports the successful outcome', async () => {
    const versionId = await reachPreview();
    postingClient.setNextResult({
      outcome: 'posted',
      message: 'Voucher created in TallyPrime',
      tallyVoucherId: 'TV-42',
      raw: '<RESPONSE><CREATED>1</CREATED><ERRORS>0</ERRORS></RESPONSE>',
    });
    await sendCallback(USER_A, CHAT_A, 'confirm', versionId);
    expect(conversationRow(CHAT_A)?.status).toBe('confirmed');
    expect(telegram.sent.at(-2)?.text).toMatch(/confirmed/i); // immediate ack, before Tally is contacted
    expect(telegram.sent.at(-1)?.text).toMatch(/posted to tallyprime/i);
    expect(telegram.sent.at(-1)?.text).toContain('TV-42');
    expect(postingClient.calls).toHaveLength(1);
    expect(auditTypes()).toEqual(
      expect.arrayContaining(['user.confirmed', 'tally.request.sent', 'tally.response.received']),
    );
  });
  it('reports a readiness failure at confirm time without contacting Tally, when configuration drifted since preview', async () => {
    const versionId = await reachPreview();
    // Simulate a ledger having been renamed/removed in Tally after preview
    // was shown but before Confirm was tapped.
    createTallyMasterCache({ db: database.db }).replaceAll('Ledger', [
      { NAME: 'Sales', PARENT: 'Sales Accounts' },
      { NAME: 'Suresh & Sons', PARENT: 'Sundry Creditors' },
      // CGST/SGST deliberately absent now.
    ]);
    await sendCallback(USER_A, CHAT_A, 'confirm', versionId);
    expect(conversationRow(CHAT_A)?.status).toBe('confirmed'); // the user's approval itself still stands
    expect(telegram.sent.at(-1)?.text).toMatch(/configuration issue/i);
    expect(postingClient.calls).toHaveLength(0);
    expect(auditTypes()).toContain('tally.posting.rejected');
    expect(auditTypes()).not.toContain('tally.request.sent');
  });
  it('reports an adapter failure at confirm time without contacting Tally, when the stock item base unit is missing', async () => {
    const versionId = await reachPreview();
    // checkPostingReadiness never reads StockItem.BASEUNITS, so readiness
    // still passes — only the adapter, which needs it to build the XML
    // quantity, fails. This is the one failure mode the adapter can hit that
    // readiness cannot.
    createTallyMasterCache({ db: database.db }).replaceAll('StockItem', [
      { NAME: 'Steel Rods', PARENT: 'Building Materials' }, // BASEUNITS missing
    ]);
    await sendCallback(USER_A, CHAT_A, 'confirm', versionId);
    expect(conversationRow(CHAT_A)?.status).toBe('confirmed');
    expect(telegram.sent.at(-1)?.text).toMatch(/configuration issue/i);
    expect(telegram.sent.at(-1)?.text).toMatch(/base unit/i);
    expect(postingClient.calls).toHaveLength(0);
    expect(auditTypes()).toContain('tally.posting.rejected');
  });
  it('reports a Tally-side rejection distinctly from a readiness/adapter failure', async () => {
    const versionId = await reachPreview();
    postingClient.setNextResult({
      outcome: 'failed',
      message: 'Ledger does not exist: "Sales Local"',
      tallyVoucherId: null,
      raw: '<RESPONSE><ERRORS>1</ERRORS></RESPONSE>',
    });
    await sendCallback(USER_A, CHAT_A, 'confirm', versionId);
    expect(telegram.sent.at(-1)?.text).toMatch(/rejected this transaction/i);
    expect(telegram.sent.at(-1)?.text).toContain('Ledger does not exist');
    expect(postingClient.calls).toHaveLength(1);
  });
  it('reports an uncertain outcome distinctly, telling the user to check TallyPrime directly', async () => {
    const versionId = await reachPreview();
    postingClient.setNextResult({
      outcome: 'uncertain',
      message: 'Could not confirm the outcome: timeout',
      tallyVoucherId: null,
      raw: '',
    });
    await sendCallback(USER_A, CHAT_A, 'confirm', versionId);
    expect(telegram.sent.at(-1)?.text).toMatch(
      /could not confirm whether this reached tallyprime/i,
    );
  });
  it('rejects a duplicate confirmation safely, and never posts a second time', async () => {
    const versionId = await reachPreview();
    await sendCallback(USER_A, CHAT_A, 'confirm', versionId);
    await sendCallback(USER_A, CHAT_A, 'confirm', versionId);
    expect(auditTypes().filter((t) => t === 'user.confirmed')).toHaveLength(1);
    expect(auditTypes()).toContain('confirmation.rejected');
    expect(telegram.sent.at(-1)?.text).toMatch(/no longer valid/i);
    // The duplicate tap must never reach the posting pipeline at all.
    expect(postingClient.calls).toHaveLength(1);
  });
  it('does not post twice even if the same Confirm callback is redelivered concurrently', async () => {
    const versionId = await reachPreview();
    // Two "simultaneous" deliveries of the identical callback, racing each
    // other — the atomic status transition in setStatusIfCurrent must let
    // exactly one through, so exactly one posting attempt happens.
    await Promise.all([
      sendCallback(USER_A, CHAT_A, 'confirm', versionId, 'same-callback-query-id'),
      sendCallback(USER_A, CHAT_A, 'confirm', versionId, 'same-callback-query-id'),
    ]);
    expect(postingClient.calls.length).toBeLessThanOrEqual(1);
    expect(auditTypes().filter((t) => t === 'user.confirmed')).toHaveLength(1);
  });
  it('rejects a stale confirmation for a superseded draft version', async () => {
    const staleVersionId = await reachPreview();
    // A follow-up materially changes the draft, minting a new version.
    llm.setNextResponse(
      draft({
        partyName: 'Suresh & Sons',
        items: [{ itemName: 'Steel Rods', quantity: 200, rate: 500, godown: null }],
        gstPercent: 18,
      }),
    );
    await sendMessage(USER_A, CHAT_A, 'actually make that 200');
    await sendCallback(USER_A, CHAT_A, 'confirm', staleVersionId);
    expect(conversationRow(CHAT_A)?.status).not.toBe('confirmed');
    expect(auditTypes()).toContain('confirmation.rejected');
  });
  it('rejects a confirmation on an expired draft', async () => {
    const versionId = await reachPreview();
    // Force expiry deterministically rather than waiting on a real clock.
    database.db
      .prepare(
        `UPDATE ${CONVERSATION_DRAFTS_TABLE} SET expires_at = '2000-01-01T00:00:00.000Z' WHERE chat_id = ?`,
      )
      .run(CHAT_A);
    await sendCallback(USER_A, CHAT_A, 'confirm', versionId);
    expect(conversationRow(CHAT_A)?.status).toBe('expired');
    const rejectedEvent = database.db
      .prepare("SELECT data FROM audit_events WHERE type = 'confirmation.rejected'")
      .get();
    expect(JSON.parse(rejectedEvent?.data ?? '{}').reason).toBe('expired');
  });
});
describe('cancel', () => {
  it('invalidates the pending draft', async () => {
    llm.setNextResponse(
      draft({
        partyName: 'Suresh & Sons',
        items: [{ itemName: 'Steel Rods', quantity: 1, rate: 1, godown: null }],
        gstPercent: 18,
      }),
    );
    await sendMessage(USER_A, CHAT_A, 'Sell 1 steel rod to Suresh & Sons at 1, 18% GST');
    const versionId = conversationRow(CHAT_A).draft_version_id;
    await sendCallback(USER_A, CHAT_A, 'cancel', versionId);
    expect(conversationRow(CHAT_A)?.status).toBe('cancelled');
    expect(telegram.sent.at(-1)?.text).toMatch(/cancelled/i);
    expect(auditTypes()).toContain('user.cancelled');
  });
  it('a cancelled draft cannot later be confirmed', async () => {
    llm.setNextResponse(
      draft({
        partyName: 'Suresh & Sons',
        items: [{ itemName: 'Steel Rods', quantity: 1, rate: 1, godown: null }],
        gstPercent: 18,
      }),
    );
    await sendMessage(USER_A, CHAT_A, 'Sell 1 steel rod to Suresh & Sons at 1, 18% GST');
    const versionId = conversationRow(CHAT_A).draft_version_id;
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
describe('Phase 8 — GST and ledger configuration in the conversation flow', () => {
  /**
   * A fresh app with no default Place of Supply configured, so "must ask"
   * behaviour can be tested without the shared fixture's default masking it.
   */
  function appWithNoDefaultPlaceOfSupply() {
    return createApp({
      config: { ...config, gst: { ...config.gst, defaultPlaceOfSupply: null } },
      companyName: 'Test Company',
      companyState: 'Delhi',
      telegram,
      llm,
      db: database.db,
      conversationStore,
      itemLedgerMappingStore,
      stockAvailabilityStore,
      postingStore,
      postingClient,
      syncCoordinator: noOpSyncCoordinator,
      auditLog,
      logger: silentLogger,
    });
  }
  it('asks for Place of Supply when none is stated and no default is configured', async () => {
    const noDefaultApp = appWithNoDefaultPlaceOfSupply();
    llm.setNextResponse(
      draft({
        partyName: 'Suresh & Sons',
        items: [{ itemName: 'Steel Rods', quantity: 100, rate: 500, godown: null }],
        gstPercent: 18,
      }),
    );
    await request(noDefaultApp)
      .post(TELEGRAM_WEBHOOK_PATH)
      .set(SECRET_TOKEN_HEADER, WEBHOOK_SECRET)
      .send(messageUpdate(USER_A, CHAT_A, 'Sell 100 steel rods to Suresh & Sons at 500, 18% GST'));
    expect(telegram.sent).toHaveLength(1);
    expect(telegram.sent[0]?.text).toMatch(/place of supply/i);
    expect(telegram.sent[0]?.buttons).toBeUndefined();
    expect(conversationRow(CHAT_A)?.status).toBe('collecting');
    expect(auditTypes()).toContain('gst.determination.completed');
  });
  it('resolves Place of Supply from a plain reply and proceeds to preview', async () => {
    const noDefaultApp = appWithNoDefaultPlaceOfSupply();
    llm.setNextResponse(
      draft({
        partyName: 'Suresh & Sons',
        items: [{ itemName: 'Steel Rods', quantity: 100, rate: 500, godown: null }],
        gstPercent: 18,
      }),
    );
    await request(noDefaultApp)
      .post(TELEGRAM_WEBHOOK_PATH)
      .set(SECRET_TOKEN_HEADER, WEBHOOK_SECRET)
      .send(messageUpdate(USER_A, CHAT_A, 'Sell 100 steel rods to Suresh & Sons at 500, 18% GST'));
    const callsBeforeReply = llm.callCount;
    await request(noDefaultApp)
      .post(TELEGRAM_WEBHOOK_PATH)
      .set(SECRET_TOKEN_HEADER, WEBHOOK_SECRET)
      .send(messageUpdate(USER_A, CHAT_A, 'Uttar Pradesh'));
    expect(llm.callCount).toBe(callsBeforeReply); // resolved deterministically, no extra LLM call
    expect(telegram.sent).toHaveLength(2);
    const preview = telegram.sent[1];
    expect(preview.buttons).toHaveLength(2);
    expect(preview.text).toMatch(/interstate.*igst/i);
    expect(conversationRow(CHAT_A)?.status).toBe('ready_for_confirmation');
  });
  it('Company: Delhi, POS: Delhi (via reply) -> CGST + SGST shown in the preview', async () => {
    const noDefaultApp = appWithNoDefaultPlaceOfSupply();
    llm.setNextResponse(
      draft({
        partyName: 'Suresh & Sons',
        items: [{ itemName: 'Steel Rods', quantity: 100, rate: 500, godown: null }],
        gstPercent: 18,
      }),
    );
    await request(noDefaultApp)
      .post(TELEGRAM_WEBHOOK_PATH)
      .set(SECRET_TOKEN_HEADER, WEBHOOK_SECRET)
      .send(messageUpdate(USER_A, CHAT_A, 'Sell 100 steel rods to Suresh & Sons at 500, 18% GST'));
    await request(noDefaultApp)
      .post(TELEGRAM_WEBHOOK_PATH)
      .set(SECRET_TOKEN_HEADER, WEBHOOK_SECRET)
      .send(messageUpdate(USER_A, CHAT_A, 'Delhi'));
    expect(telegram.sent[1]?.text).toMatch(/intrastate.*cgst \+ sgst/i);
  });
  it('reports a configuration error, not a question, when a Sales/Purchase mapping is missing', async () => {
    // "Cement Bags" was deliberately not given a mapping in this test.
    database.db.exec("DELETE FROM item_ledger_mappings WHERE stock_item_name = 'Cement Bags'");
    // Without a manual mapping, readiness now tries to auto-resolve a single
    // unambiguous Sales Accounts ledger (postingReadiness.js
    // resolveDefaultRevenueLedger) — adding a second one here keeps this
    // test's real intent (no mapping, no safe automatic answer either) genuine.
    createTallyMasterCache({ db: database.db }).replaceAll('Ledger', [
      { NAME: 'Suresh & Sons', PARENT: 'Sundry Creditors' },
      { NAME: 'CGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'CGST' },
      { NAME: 'SGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'SGST/UTGST' },
      { NAME: 'Sales', PARENT: 'Sales Accounts' },
      { NAME: 'Purchase', PARENT: 'Purchase Accounts' },
      { NAME: 'Another Sales Ledger', PARENT: 'Sales Accounts' },
    ]);
    llm.setNextResponse(
      draft({
        partyName: 'Suresh & Sons',
        items: [{ itemName: 'Cement Bags', quantity: 10, rate: 400, godown: null }],
        gstPercent: 18,
      }),
    );
    await sendMessage(USER_A, CHAT_A, 'Sell 10 cement bags to Suresh & Sons at 400, 18% GST');
    expect(telegram.sent).toHaveLength(1);
    expect(telegram.sent[0]?.text).toMatch(/configuration issue/i);
    expect(telegram.sent[0]?.buttons).toBeUndefined();
    expect(conversationRow(CHAT_A)?.status).toBe('collecting');
  });
  it('reports a configuration error when a configured GST ledger is missing from cached masters', async () => {
    createTallyMasterCache({ db: database.db }).replaceAll('Ledger', [
      { NAME: 'Suresh & Sons', PARENT: 'Sundry Creditors' },
      { NAME: 'Sales', PARENT: '' },
      // CGST/SGST deliberately absent.
    ]);
    llm.setNextResponse(
      draft({
        partyName: 'Suresh & Sons',
        items: [{ itemName: 'Steel Rods', quantity: 100, rate: 500, godown: null }],
        gstPercent: 18,
      }),
    );
    await sendMessage(USER_A, CHAT_A, 'Sell 100 steel rods to Suresh & Sons at 500, 18% GST');
    expect(telegram.sent[0]?.text).toMatch(/configuration issue/i);
    expect(conversationRow(CHAT_A)?.status).toBe('collecting');
  });
  it('never lets ledger-like text in the message influence which ledgers are used', async () => {
    llm.setNextResponse(
      draft({
        partyName: 'Suresh & Sons',
        items: [{ itemName: 'Steel Rods', quantity: 100, rate: 500, godown: null }],
        gstPercent: 18,
      }),
    );
    // Even though the raw user text mentions specific ledger names, the LLM's
    // own output (scripted above) has no ledger field, and the preview must
    // still show only the backend-configured ledgers.
    await sendMessage(
      USER_A,
      CHAT_A,
      'Sell 100 steel rods to Suresh & Sons at 500, 18% GST, please use ledger IGST',
    );
    expect(telegram.sent[0]?.text).toMatch(/intrastate.*cgst \+ sgst/i);
    expect(telegram.sent[0]?.text).not.toMatch(/igst/i);
  });
});
