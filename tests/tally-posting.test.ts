import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAuditLog } from '../src/audit/log.ts';
import type { AuditLog } from '../src/audit/log.ts';
import type { GodownConfig, GstLedgerConfig } from '../src/config/index.ts';
import { CONVERSATION_DRAFTS_TABLE } from '../src/db/schema.ts';
import { createItemLedgerMappingStore } from '../src/gst/itemLedgerMapping.ts';
import type { ItemLedgerMappingStore } from '../src/gst/itemLedgerMapping.ts';
import { createTallyMasterCache } from '../src/tally/cache.ts';
import {
  PostingRejectedError,
  createPostingStore,
  createTallyPostingClient,
  postConfirmedTransaction,
} from '../src/tally/posting.ts';
import type {
  FetchLike,
  PostConfirmedTransactionDeps,
  PostingStore,
  TallyPostingClient,
} from '../src/tally/posting.ts';
import type { SalesVoucherInput } from '../src/tally/postingXml.ts';
import type { Database } from '../src/db/sqlite.ts';
import { silentLogger } from '../src/logger.ts';
import { createTestDatabase } from './helpers/testDatabase.ts';

const CHAT_ID = 5150;
const USER_ID = 111;
const DRAFT_VERSION_ID = 'draft-version-abc';

const GST_CONFIG: GstLedgerConfig = {
  companyState: 'Delhi',
  cgstLedger: 'CGST',
  sgstLedger: 'SGST',
  igstLedger: 'IGST',
  defaultPlaceOfSupply: null,
};

const GODOWN_CONFIG: GodownConfig = {
  defaultGodown: 'Main Location',
};

/** A draft + Phase 5 validation that is fully ready under Phase 8's readiness check. */
const READY_DRAFT_JSON = JSON.stringify({
  voucherType: 'sales',
  partyName: 'Suresh & Sons',
  items: [{ itemName: 'Steel Rods', quantity: 100, rate: 500, godown: null }],
  gstPercent: 18,
  placeOfSupply: 'Delhi', // same as GST_CONFIG.companyState -> intrastate (CGST+SGST)
  missingFields: [],
  ambiguityNote: null,
});
const READY_VALIDATION_JSON = JSON.stringify({
  isValid: true,
  voucherTypeValid: true,
  partyMatch: { status: 'exact', matchedName: 'Suresh & Sons', candidates: [] },
  items: [
    {
      itemName: 'Steel Rods',
      stockItemMatch: { status: 'exact', matchedName: 'Steel Rods', candidates: [] },
      quantityValid: true,
      rateValid: true,
    },
  ],
  gstPercentValid: true,
  issues: [],
});

function voucherInput(): SalesVoucherInput {
  return {
    date: new Date('2026-09-02T00:00:00Z'),
    companyName: 'Test Co',
    partyLedgerName: 'Suresh & Sons',
    items: [
      {
        stockItemName: 'Steel Rods',
        quantity: 100,
        unit: 'Kg',
        rate: 500,
        amount: 50000,
        ledgerAllocation: { ledgerName: 'Sales', amount: 50000 },
        godown: 'Main Location',
      },
    ],
    taxLedgerAllocations: [{ ledgerName: 'GST', amount: 9000 }],
  };
}

function insertConfirmedDraft(
  db: Database['db'],
  status = 'confirmed',
  draftVersionId = DRAFT_VERSION_ID,
  chatId = CHAT_ID,
  draftJson = READY_DRAFT_JSON,
  validationJson = READY_VALIDATION_JSON,
): void {
  const stmt = db.prepare(`
    INSERT INTO ${CONVERSATION_DRAFTS_TABLE}
      (chat_id, telegram_user_id, draft_version_id, status, draft_json, validation_json, created_at, updated_at, expires_at)
    VALUES (@chatId, @userId, @draftVersionId, @status, @draftJson, @validationJson, @now, @now, @expires)
  `);
  stmt.run({
    chatId,
    userId: USER_ID,
    draftVersionId,
    status,
    draftJson,
    validationJson,
    now: '2026-01-01',
    expires: '2099-01-01',
  });
}

let database: Database;
let auditLog: AuditLog;
let postingStore: PostingStore;
let itemLedgerMappingStore: ItemLedgerMappingStore;

beforeEach(() => {
  database = createTestDatabase();
  auditLog = createAuditLog({ db: database.db, logger: silentLogger });
  postingStore = createPostingStore(database.db);
  itemLedgerMappingStore = createItemLedgerMappingStore(database.db);

  // Masters and mapping the READY_* fixtures above depend on for a fully
  // ready checkPostingReadiness() result: CGST/SGST (Delhi == Delhi ->
  // intrastate) and the "Sales" ledger the default voucherInput() credits.
  createTallyMasterCache({ db: database.db }).replaceAll('Ledger', [
    { NAME: 'CGST', PARENT: 'Duties & Taxes' },
    { NAME: 'SGST', PARENT: 'Duties & Taxes' },
    { NAME: 'IGST', PARENT: 'Duties & Taxes' },
    { NAME: 'Sales', PARENT: 'Sales Accounts' },
  ]);
  createTallyMasterCache({ db: database.db }).replaceAll('Godown', [
    { NAME: 'Main Location', PARENT: 'Primary' },
  ]);
  itemLedgerMappingStore.setMapping({
    stockItemName: 'Steel Rods',
    salesLedger: 'Sales',
    purchaseLedger: 'Purchase',
  });
});

afterEach(() => {
  database.close();
});

function auditRows(): { type: string; data: string }[] {
  return database.db
    .prepare('SELECT type, data FROM audit_events ORDER BY id')
    .all() as unknown as { type: string; data: string }[];
}

function deps(client: TallyPostingClient): PostConfirmedTransactionDeps {
  return {
    db: database.db,
    postingStore,
    postingClient: client,
    auditLog,
    gstConfig: GST_CONFIG,
    itemLedgerMappingStore,
    godownConfig: GODOWN_CONFIG,
  };
}

describe('createTallyPostingClient', () => {
  function fakeFetch(impl: (url: string, init: RequestInit) => Promise<Response>): FetchLike {
    return vi.fn(impl) as unknown as FetchLike;
  }

  it('posts the exact XML given, to the configured host and port', async () => {
    const fetchImpl = fakeFetch(async () => new Response('<RESPONSE><CREATED>1</CREATED><ERRORS>0</ERRORS></RESPONSE>', { status: 200 }));
    const client = createTallyPostingClient({ host: '127.0.0.1', port: 9000, fetchImpl });

    await client.importVoucher('<ENVELOPE>test</ENVELOPE>');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:9000');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('<ENVELOPE>test</ENVELOPE>');
  });

  it('resolves a successful Tally response', async () => {
    const client = createTallyPostingClient({
      host: '127.0.0.1',
      port: 9000,
      fetchImpl: fakeFetch(async () => new Response('<RESPONSE><CREATED>1</CREATED><ERRORS>0</ERRORS><LASTVCHID>99</LASTVCHID></RESPONSE>')),
    });

    const result = await client.importVoucher('<xml/>');

    expect(result).toEqual({
      outcome: 'posted',
      message: 'Voucher created in TallyPrime',
      tallyVoucherId: '99',
      raw: '<RESPONSE><CREATED>1</CREATED><ERRORS>0</ERRORS><LASTVCHID>99</LASTVCHID></RESPONSE>',
    });
  });

  it('resolves a Tally business/validation error as failed', async () => {
    const client = createTallyPostingClient({
      host: '127.0.0.1',
      port: 9000,
      fetchImpl: fakeFetch(async () => new Response('<RESPONSE><CREATED>0</CREATED><ERRORS>1</ERRORS><LINEERROR>Bad ledger</LINEERROR></RESPONSE>')),
    });

    const result = await client.importVoucher('<xml/>');

    expect(result.outcome).toBe('failed');
    expect(result.message).toContain('Bad ledger');
  });

  it('resolves an HTTP error as uncertain, never as failed', async () => {
    const client = createTallyPostingClient({
      host: '127.0.0.1',
      port: 9000,
      fetchImpl: fakeFetch(async () => new Response('server error', { status: 500 })),
    });

    const result = await client.importVoucher('<xml/>');

    expect(result.outcome).toBe('uncertain');
  });

  it('resolves a network failure as uncertain without throwing', async () => {
    const client = createTallyPostingClient({
      host: '127.0.0.1',
      port: 9000,
      fetchImpl: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as FetchLike,
    });

    await expect(client.importVoucher('<xml/>')).resolves.toEqual(
      expect.objectContaining({ outcome: 'uncertain' }),
    );
  });

  it('resolves a timeout as uncertain', async () => {
    const client = createTallyPostingClient({
      host: '127.0.0.1',
      port: 9000,
      timeoutMs: 20,
      fetchImpl: vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      ) as unknown as FetchLike,
    });

    const result = await client.importVoucher('<xml/>');

    expect(result.outcome).toBe('uncertain');
  });
});

describe('createPostingStore', () => {
  it('claims a fresh draft version and lets a second call see it as already attempted', () => {
    const first = postingStore.beginPosting(DRAFT_VERSION_ID, '<xml/>');
    expect(first).toEqual({ started: true });

    const second = postingStore.beginPosting(DRAFT_VERSION_ID, '<xml/>');
    expect(second.started).toBe(false);
    if (!second.started) {
      expect(second.existing.status).toBe('posting');
      expect(second.existing.requestXml).toBe('<xml/>');
    }
  });

  it('records a terminal outcome and makes it visible to a subsequent claim attempt', () => {
    postingStore.beginPosting(DRAFT_VERSION_ID, '<xml/>');
    postingStore.recordOutcome(DRAFT_VERSION_ID, { status: 'posted', message: 'ok', tallyVoucherId: '42' }, '<RESPONSE/>');

    const record = postingStore.getPosting(DRAFT_VERSION_ID);
    expect(record?.status).toBe('posted');
    expect(record?.tallyVoucherId).toBe('42');
    expect(record?.completedAt).toBeInstanceOf(Date);

    const retry = postingStore.beginPosting(DRAFT_VERSION_ID, '<xml/>');
    expect(retry.started).toBe(false);
    if (!retry.started) expect(retry.existing.status).toBe('posted');
  });

  it('keeps different draft versions independent', () => {
    postingStore.beginPosting('draft-a', '<xml/>');
    const other = postingStore.beginPosting('draft-b', '<xml/>');
    expect(other).toEqual({ started: true });
  });

  it('returns null for a draft version with no posting attempt', () => {
    expect(postingStore.getPosting('never-attempted')).toBeNull();
  });
});

describe('postConfirmedTransaction', () => {
  function scriptedClient(result: { outcome: 'posted' | 'failed' | 'uncertain'; message: string; tallyVoucherId: string | null; raw: string }): TallyPostingClient {
    return { async importVoucher() { return result; } };
  }

  it('rejects posting a draft that was never confirmed', async () => {
    insertConfirmedDraft(database.db, 'ready_for_confirmation');
    const client = scriptedClient({ outcome: 'posted', message: 'ok', tallyVoucherId: '1', raw: '' });

    await expect(
      postConfirmedTransaction(deps(client), { draftVersionId: DRAFT_VERSION_ID, voucher: voucherInput() }),
    ).rejects.toThrow(PostingRejectedError);

    expect(postingStore.getPosting(DRAFT_VERSION_ID)).toBeNull(); // no attempt was ever started
    expect(auditRows().map((r) => r.type)).toContain('tally.posting.rejected');
  });

  it('rejects posting a draft version that does not exist at all', async () => {
    const client = scriptedClient({ outcome: 'posted', message: 'ok', tallyVoucherId: '1', raw: '' });

    await expect(
      postConfirmedTransaction(deps(client), { draftVersionId: 'no-such-version', voucher: voucherInput() }),
    ).rejects.toThrow(PostingRejectedError);
  });

  it('posts a confirmed draft successfully and records the outcome', async () => {
    insertConfirmedDraft(database.db);
    const client = scriptedClient({ outcome: 'posted', message: 'Voucher created in TallyPrime', tallyVoucherId: '77', raw: '<RESPONSE/>' });

    const result = await postConfirmedTransaction(deps(client), {
      draftVersionId: DRAFT_VERSION_ID,
      voucher: voucherInput(),
    });

    expect(result).toEqual({ status: 'posted', message: 'Voucher created in TallyPrime', tallyVoucherId: '77' });
    expect(postingStore.getPosting(DRAFT_VERSION_ID)?.status).toBe('posted');
    expect(auditRows().map((r) => r.type)).toEqual(
      expect.arrayContaining(['tally.request.sent', 'tally.response.received']),
    );
  });

  it('records a Tally business error as failed, distinctly from uncertain', async () => {
    insertConfirmedDraft(database.db);
    const client = scriptedClient({ outcome: 'failed', message: 'Ledger does not exist', tallyVoucherId: null, raw: '<RESPONSE/>' });

    const result = await postConfirmedTransaction(deps(client), {
      draftVersionId: DRAFT_VERSION_ID,
      voucher: voucherInput(),
    });

    expect(result.status).toBe('failed');
    expect(postingStore.getPosting(DRAFT_VERSION_ID)?.status).toBe('failed');
  });

  it('records a network/timeout outcome as uncertain, never as failed', async () => {
    insertConfirmedDraft(database.db);
    const client = scriptedClient({ outcome: 'uncertain', message: 'Could not confirm the outcome: timeout', tallyVoucherId: null, raw: '' });

    const result = await postConfirmedTransaction(deps(client), {
      draftVersionId: DRAFT_VERSION_ID,
      voucher: voucherInput(),
    });

    expect(result.status).toBe('uncertain');
    expect(postingStore.getPosting(DRAFT_VERSION_ID)?.status).toBe('uncertain');
  });

  it('preserves the request XML and response for manual investigation of an uncertain outcome', async () => {
    insertConfirmedDraft(database.db);
    const client = scriptedClient({ outcome: 'uncertain', message: 'HTTP 500', tallyVoucherId: null, raw: 'raw body' });

    await postConfirmedTransaction(deps(client), { draftVersionId: DRAFT_VERSION_ID, voucher: voucherInput() });

    const record = postingStore.getPosting(DRAFT_VERSION_ID);
    expect(record?.requestXml).toContain('<ENVELOPE>');
    expect(record?.responseRaw).toBe('raw body');
    expect(record?.message).toBe('HTTP 500');
  });

  it('never posts a second time for an already-posted transaction', async () => {
    insertConfirmedDraft(database.db);
    const client = scriptedClient({ outcome: 'posted', message: 'ok', tallyVoucherId: '1', raw: '' });
    const d = deps(client);

    await postConfirmedTransaction(d, { draftVersionId: DRAFT_VERSION_ID, voucher: voucherInput() });
    const importSpy = vi.spyOn(client, 'importVoucher');

    const second = await postConfirmedTransaction(d, { draftVersionId: DRAFT_VERSION_ID, voucher: voucherInput() });

    expect(importSpy).not.toHaveBeenCalled();
    expect(second).toEqual({ status: 'posted', message: 'ok', tallyVoucherId: '1' });
  });

  it('does not retry a prior failed attempt automatically', async () => {
    insertConfirmedDraft(database.db);
    const firstClient = scriptedClient({ outcome: 'failed', message: 'Bad ledger', tallyVoucherId: null, raw: '' });
    await postConfirmedTransaction(deps(firstClient), {
      draftVersionId: DRAFT_VERSION_ID,
      voucher: voucherInput(),
    });

    const secondClient = scriptedClient({ outcome: 'posted', message: 'ok', tallyVoucherId: '1', raw: '' });
    const importSpy = vi.spyOn(secondClient, 'importVoucher');

    const result = await postConfirmedTransaction(deps(secondClient), {
      draftVersionId: DRAFT_VERSION_ID,
      voucher: voucherInput(),
    });

    expect(importSpy).not.toHaveBeenCalled();
    expect(result.status).toBe('failed'); // the original, preserved outcome — not silently retried
  });

  it('does not retry a prior uncertain attempt automatically', async () => {
    insertConfirmedDraft(database.db);
    const firstClient = scriptedClient({ outcome: 'uncertain', message: 'timeout', tallyVoucherId: null, raw: '' });
    await postConfirmedTransaction(deps(firstClient), {
      draftVersionId: DRAFT_VERSION_ID,
      voucher: voucherInput(),
    });

    const secondClient = scriptedClient({ outcome: 'posted', message: 'ok', tallyVoucherId: '1', raw: '' });
    const importSpy = vi.spyOn(secondClient, 'importVoucher');

    const result = await postConfirmedTransaction(deps(secondClient), {
      draftVersionId: DRAFT_VERSION_ID,
      voucher: voucherInput(),
    });

    expect(importSpy).not.toHaveBeenCalled();
    expect(result.status).toBe('uncertain');
  });

  it('rejects a concurrent second attempt for the same draft version while the first is still in flight', async () => {
    insertConfirmedDraft(database.db);
    let resolveFirst!: (value: { outcome: 'posted'; message: string; tallyVoucherId: string; raw: string }) => void;
    const firstClient: TallyPostingClient = {
      importVoucher: () =>
        new Promise((resolve) => {
          resolveFirst = resolve as typeof resolveFirst;
        }),
    };

    const firstCall = postConfirmedTransaction(deps(firstClient), {
      draftVersionId: DRAFT_VERSION_ID,
      voucher: voucherInput(),
    });

    // The row now exists with status 'posting' — a concurrent second attempt
    // must see that and refuse, synchronously, before the first ever resolves.
    const secondClient = scriptedClient({ outcome: 'posted', message: 'ok', tallyVoucherId: 'x', raw: '' });
    const importSpy = vi.spyOn(secondClient, 'importVoucher');
    const secondResult = await postConfirmedTransaction(deps(secondClient), {
      draftVersionId: DRAFT_VERSION_ID,
      voucher: voucherInput(),
    });

    expect(importSpy).not.toHaveBeenCalled();
    expect(secondResult.status).toBe('posting');

    resolveFirst({ outcome: 'posted', message: 'ok', tallyVoucherId: '1', raw: '' });
    const firstResult = await firstCall;
    expect(firstResult.status).toBe('posted');
  });

  it('records an audit event for every posting outcome kind', async () => {
    for (const [index, outcome] of (['posted', 'failed', 'uncertain'] as const).entries()) {
      const versionId = `${DRAFT_VERSION_ID}-${outcome}`;
      insertConfirmedDraft(database.db, 'confirmed', versionId, CHAT_ID + index + 1);
      const client = scriptedClient({ outcome, message: outcome, tallyVoucherId: null, raw: '' });

      await postConfirmedTransaction(deps(client), { draftVersionId: versionId, voucher: voucherInput() });
    }

    const types = auditRows().map((r) => r.type);
    expect(types.filter((t) => t === 'tally.request.sent')).toHaveLength(3);
    expect(types.filter((t) => t === 'tally.response.received')).toHaveLength(3);
  });

  it('threads a supplied correlation id through the audit trail instead of minting a new one', async () => {
    insertConfirmedDraft(database.db);
    const client = scriptedClient({ outcome: 'posted', message: 'ok', tallyVoucherId: '1', raw: '' });

    await postConfirmedTransaction(deps(client), {
      draftVersionId: DRAFT_VERSION_ID,
      voucher: voucherInput(),
      correlationId: 'existing-correlation-id',
    });

    const events = auditLog.findByCorrelationId('existing-correlation-id');
    expect(events.length).toBeGreaterThan(0);
  });

  describe('GST/ledger readiness gate (Phase 8)', () => {
    it('rejects posting when the stored draft has no GST/ledger readiness at all', async () => {
      insertConfirmedDraft(database.db, 'confirmed', DRAFT_VERSION_ID, CHAT_ID, '{}', '{}');
      const client = scriptedClient({ outcome: 'posted', message: 'ok', tallyVoucherId: '1', raw: '' });
      const importSpy = vi.spyOn(client, 'importVoucher');

      await expect(
        postConfirmedTransaction(deps(client), { draftVersionId: DRAFT_VERSION_ID, voucher: voucherInput() }),
      ).rejects.toThrow(PostingRejectedError);

      expect(importSpy).not.toHaveBeenCalled();
      expect(postingStore.getPosting(DRAFT_VERSION_ID)).toBeNull();
      expect(auditRows().map((r) => r.type)).toContain('tally.posting.rejected');
    });

    it('rejects posting when a configured GST ledger no longer exists in the cache', async () => {
      insertConfirmedDraft(database.db);
      // Simulate the ledger having been renamed/removed in Tally since confirmation.
      createTallyMasterCache({ db: database.db }).replaceAll('Ledger', [{ NAME: 'Sales', PARENT: '' }]);
      const client = scriptedClient({ outcome: 'posted', message: 'ok', tallyVoucherId: '1', raw: '' });
      const importSpy = vi.spyOn(client, 'importVoucher');

      await expect(
        postConfirmedTransaction(deps(client), { draftVersionId: DRAFT_VERSION_ID, voucher: voucherInput() }),
      ).rejects.toThrow(PostingRejectedError);

      expect(importSpy).not.toHaveBeenCalled();
    });

    it('rejects posting when the item ledger mapping was removed after confirmation', async () => {
      insertConfirmedDraft(database.db);
      database.db.exec("DELETE FROM item_ledger_mappings WHERE stock_item_name = 'Steel Rods'");
      const client = scriptedClient({ outcome: 'posted', message: 'ok', tallyVoucherId: '1', raw: '' });
      const importSpy = vi.spyOn(client, 'importVoucher');

      await expect(
        postConfirmedTransaction(deps(client), { draftVersionId: DRAFT_VERSION_ID, voucher: voucherInput() }),
      ).rejects.toThrow(PostingRejectedError);

      expect(importSpy).not.toHaveBeenCalled();
    });

    it('rejects posting when the configured default godown no longer exists in the cache', async () => {
      insertConfirmedDraft(database.db);
      // Simulate the godown having been renamed/removed in Tally since confirmation.
      createTallyMasterCache({ db: database.db }).replaceAll('Godown', []);
      const client = scriptedClient({ outcome: 'posted', message: 'ok', tallyVoucherId: '1', raw: '' });
      const importSpy = vi.spyOn(client, 'importVoucher');

      await expect(
        postConfirmedTransaction(deps(client), { draftVersionId: DRAFT_VERSION_ID, voucher: voucherInput() }),
      ).rejects.toThrow(PostingRejectedError);

      expect(importSpy).not.toHaveBeenCalled();
    });
  });
});
