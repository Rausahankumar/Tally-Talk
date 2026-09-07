import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createConversationStore } from '../src/conversation/store.js';
import { createTestDatabase } from './helpers/testDatabase.js';
const FAKE_DRAFT = {
  voucherType: 'sales',
  partyName: 'Ramesh',
  items: [],
  gstPercent: 18,
  placeOfSupply: null,
  missingFields: [],
  ambiguityNote: null,
};
const FAKE_VALIDATION = {
  isValid: true,
  voucherTypeValid: true,
  partyMatch: null,
  items: [],
  gstPercentValid: true,
  issues: [],
};
let database;
let store;
beforeEach(() => {
  database = createTestDatabase();
  store = createConversationStore(database.db);
});
afterEach(() => {
  database.close();
});
describe('getActiveDraft', () => {
  it('returns null when nothing is stored for the chat', () => {
    expect(store.getActiveDraft(1)).toBeNull();
  });
  it('returns a stored draft with a matching round-tripped payload', () => {
    store.saveDraft({
      chatId: 1,
      telegramUserId: 5,
      status: 'collecting',
      draft: FAKE_DRAFT,
      validation: FAKE_VALIDATION,
      pending: null,
    });
    const row = store.getActiveDraft(1);
    expect(row?.draft).toEqual(FAKE_DRAFT);
    expect(row?.validation).toEqual(FAKE_VALIDATION);
    expect(row?.status).toBe('collecting');
  });
  it('lazily expires a row past its expiry and persists that', () => {
    store.saveDraft({
      chatId: 1,
      telegramUserId: 5,
      status: 'ready_for_confirmation',
      draft: FAKE_DRAFT,
      validation: FAKE_VALIDATION,
      pending: null,
    });
    database.db
      .prepare(
        "UPDATE conversation_drafts SET expires_at = '2000-01-01T00:00:00.000Z' WHERE chat_id = 1",
      )
      .run();
    const row = store.getActiveDraft(1);
    expect(row?.status).toBe('expired');
    // The expiry is written back, not just reported once.
    const rawStatus = database.db
      .prepare('SELECT status FROM conversation_drafts WHERE chat_id = 1')
      .get();
    expect(rawStatus.status).toBe('expired');
  });
  it('does not re-expire an already-resolved draft even if its old expiry has passed', () => {
    store.saveDraft({
      chatId: 1,
      telegramUserId: 5,
      status: 'confirmed',
      draft: FAKE_DRAFT,
      validation: FAKE_VALIDATION,
      pending: null,
    });
    database.db
      .prepare(
        "UPDATE conversation_drafts SET expires_at = '2000-01-01T00:00:00.000Z' WHERE chat_id = 1",
      )
      .run();
    expect(store.getActiveDraft(1)?.status).toBe('confirmed');
  });
});
describe('saveDraft', () => {
  it('mints a new draftVersionId on every save', () => {
    const first = store.saveDraft({
      chatId: 1,
      telegramUserId: 5,
      status: 'collecting',
      draft: FAKE_DRAFT,
      validation: FAKE_VALIDATION,
      pending: null,
    });
    const second = store.saveDraft({
      chatId: 1,
      telegramUserId: 5,
      status: 'collecting',
      draft: FAKE_DRAFT,
      validation: FAKE_VALIDATION,
      pending: null,
    });
    expect(second.draftVersionId).not.toBe(first.draftVersionId);
  });
  it('replaces the previous draft for the chat rather than keeping both', () => {
    store.saveDraft({
      chatId: 1,
      telegramUserId: 5,
      status: 'collecting',
      draft: FAKE_DRAFT,
      validation: FAKE_VALIDATION,
      pending: null,
    });
    store.saveDraft({
      chatId: 1,
      telegramUserId: 5,
      status: 'ready_for_confirmation',
      draft: { ...FAKE_DRAFT, partyName: 'Suresh' },
      validation: FAKE_VALIDATION,
      pending: null,
    });
    const count = database.db
      .prepare('SELECT COUNT(*) c FROM conversation_drafts WHERE chat_id = 1')
      .get();
    expect(count.c).toBe(1);
    expect(store.getActiveDraft(1)?.draft.partyName).toBe('Suresh');
  });
  it('keeps different chats independent', () => {
    store.saveDraft({
      chatId: 1,
      telegramUserId: 5,
      status: 'collecting',
      draft: FAKE_DRAFT,
      validation: FAKE_VALIDATION,
      pending: null,
    });
    store.saveDraft({
      chatId: 2,
      telegramUserId: 9,
      status: 'collecting',
      draft: FAKE_DRAFT,
      validation: FAKE_VALIDATION,
      pending: null,
    });
    expect(store.getActiveDraft(1)?.telegramUserId).toBe(5);
    expect(store.getActiveDraft(2)?.telegramUserId).toBe(9);
  });
});
describe('setStatusIfCurrent', () => {
  it('succeeds when chat, user, version and expected status all match', () => {
    const saved = store.saveDraft({
      chatId: 1,
      telegramUserId: 5,
      status: 'ready_for_confirmation',
      draft: FAKE_DRAFT,
      validation: FAKE_VALIDATION,
      pending: null,
    });
    const result = store.setStatusIfCurrent({
      chatId: 1,
      telegramUserId: 5,
      draftVersionId: saved.draftVersionId,
      expectedCurrentStatus: 'ready_for_confirmation',
      newStatus: 'confirmed',
    });
    expect(result?.status).toBe('confirmed');
  });
  it('fails on a version mismatch', () => {
    store.saveDraft({
      chatId: 1,
      telegramUserId: 5,
      status: 'ready_for_confirmation',
      draft: FAKE_DRAFT,
      validation: FAKE_VALIDATION,
      pending: null,
    });
    const result = store.setStatusIfCurrent({
      chatId: 1,
      telegramUserId: 5,
      draftVersionId: 'wrong-version',
      expectedCurrentStatus: 'ready_for_confirmation',
      newStatus: 'confirmed',
    });
    expect(result).toBeNull();
  });
  it('fails when the current status does not match what was expected', () => {
    const saved = store.saveDraft({
      chatId: 1,
      telegramUserId: 5,
      status: 'collecting',
      draft: FAKE_DRAFT,
      validation: FAKE_VALIDATION,
      pending: null,
    });
    const result = store.setStatusIfCurrent({
      chatId: 1,
      telegramUserId: 5,
      draftVersionId: saved.draftVersionId,
      expectedCurrentStatus: 'ready_for_confirmation',
      newStatus: 'confirmed',
    });
    expect(result).toBeNull();
  });
  it('fails for the wrong user, even with the correct chat and version', () => {
    const saved = store.saveDraft({
      chatId: 1,
      telegramUserId: 5,
      status: 'ready_for_confirmation',
      draft: FAKE_DRAFT,
      validation: FAKE_VALIDATION,
      pending: null,
    });
    const result = store.setStatusIfCurrent({
      chatId: 1,
      telegramUserId: 999,
      draftVersionId: saved.draftVersionId,
      expectedCurrentStatus: 'ready_for_confirmation',
      newStatus: 'confirmed',
    });
    expect(result).toBeNull();
  });
  it('a second call with the same version fails once the first has already transitioned it', () => {
    const saved = store.saveDraft({
      chatId: 1,
      telegramUserId: 5,
      status: 'ready_for_confirmation',
      draft: FAKE_DRAFT,
      validation: FAKE_VALIDATION,
      pending: null,
    });
    const args = {
      chatId: 1,
      telegramUserId: 5,
      draftVersionId: saved.draftVersionId,
      expectedCurrentStatus: 'ready_for_confirmation',
      newStatus: 'confirmed',
    };
    expect(store.setStatusIfCurrent(args)?.status).toBe('confirmed');
    expect(store.setStatusIfCurrent(args)).toBeNull(); // duplicate confirmation
  });
  it('fails for a chat with no draft at all', () => {
    expect(
      store.setStatusIfCurrent({
        chatId: 404,
        telegramUserId: 5,
        draftVersionId: 'anything',
        expectedCurrentStatus: 'ready_for_confirmation',
        newStatus: 'confirmed',
      }),
    ).toBeNull();
  });
});
