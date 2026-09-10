import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createItemLedgerMappingStore } from '../src/gst/itemLedgerMapping.js';
import { createTallyMasterCache } from '../src/tally/cache.js';
import { createStockAvailabilityCache } from '../src/tally/stockAvailabilityCache.js';
import {
  resolveDraftWithRefresh,
  resolveReadinessWithRefresh,
} from '../src/tally/masterResolutionRefresh.js';
import { checkPostingReadiness } from '../src/gst/postingReadiness.js';
import { createTestDatabase } from './helpers/testDatabase.js';
const GST_CONFIG = { companyState: 'Delhi', defaultPlaceOfSupply: 'Delhi' };
const GODOWN_CONFIG = { defaultGodown: 'Main Location' };
function draft(overrides = {}) {
  return {
    voucherType: 'sales',
    partyName: 'New',
    items: [{ itemName: 'Steel Rods', quantity: 10, rate: 500, godown: null, gstPercent: 18 }],
    gstPercent: null,
    placeOfSupply: 'Delhi',
    missingFields: [],
    ambiguityNote: null,
    ...overrides,
  };
}
/** A syncCoordinator whose "refresh" is scripted: it applies `applyFn` to the
 * live db (simulating exactly what a real Tally sync would leave behind)
 * before reporting success — or reports failure outright. Never touches
 * real Tally; this is what lets the exact incident scenario ("New" appears
 * only after a refresh) be reproduced deterministically. */
function scriptedSyncCoordinator({ succeeds, applyFn }) {
  let calls = 0;
  return {
    get callCount() {
      return calls;
    },
    async ensureFreshSync() {
      calls += 1;
      if (!succeeds) return { ok: false, error: new Error('Tally unreachable') };
      if (applyFn !== undefined) applyFn();
      return { ok: true, result: {} };
    },
  };
}
function neverCalledSyncCoordinator() {
  return {
    async ensureFreshSync() {
      throw new Error('ensureFreshSync should never be called for an exact cache hit');
    },
  };
}
let database;
let itemLedgerMappingStore;
let stockAvailabilityStore;
let cache;
beforeEach(() => {
  database = createTestDatabase();
  cache = createTallyMasterCache({ db: database.db });
  itemLedgerMappingStore = createItemLedgerMappingStore(database.db);
  stockAvailabilityStore = createStockAvailabilityCache({ db: database.db });
  cache.replaceAll('StockItem', [{ NAME: 'Steel Rods', PARENT: '', BASEUNITS: 'Kg' }]);
  cache.replaceAll('Godown', [{ NAME: 'Main Location', PARENT: 'Primary' }]);
  cache.replaceAll('VoucherType', [{ NAME: 'Sales', PARENT: '' }]);
  itemLedgerMappingStore.setMapping({
    stockItemName: 'Steel Rods',
    salesLedger: 'Sales',
    purchaseLedger: 'Purchase',
  });
  stockAvailabilityStore.replaceAllForItem('Steel Rods', [
    { batchName: '1', godownName: 'Main Location', quantity: 1000, unit: 'Kg' },
  ]);
});
afterEach(() => {
  database.close();
});
function baseDeps(syncCoordinator) {
  return {
    db: database.db,
    gstConfig: GST_CONFIG,
    itemLedgerMappingStore,
    godownConfig: GODOWN_CONFIG,
    stockAvailabilityStore,
    syncCoordinator,
  };
}
/** Seeds the cache to reproduce the real "New" vs "New Customer" ledger set. */
function seedLedgersWithoutNew() {
  cache.replaceAll('Ledger', [
    { NAME: 'CGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'CGST' },
    { NAME: 'SGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'SGST/UTGST' },
    { NAME: 'Sales', PARENT: 'Sales Accounts' },
    { NAME: 'New Customer', PARENT: 'Sundry Creditors' },
    { NAME: 'New Sale Ledger', PARENT: 'Sales Accounts' },
  ]);
}
function addNewLedgerToCache() {
  cache.replaceAll('Ledger', [
    { NAME: 'CGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'CGST' },
    { NAME: 'SGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'SGST/UTGST' },
    { NAME: 'Sales', PARENT: 'Sales Accounts' },
    { NAME: 'New Customer', PARENT: 'Sundry Creditors' },
    { NAME: 'New Sale Ledger', PARENT: 'Sales Accounts' },
    { NAME: 'New', PARENT: 'Sundry Creditors' }, // just created in Tally
  ]);
}
describe('resolveDraftWithRefresh — 1. exact cache hit needs no refresh at all', () => {
  it('resolves immediately, never calls the sync coordinator', async () => {
    addNewLedgerToCache(); // "New" already cached — no staleness at all
    const result = await resolveDraftWithRefresh(baseDeps(neverCalledSyncCoordinator()), draft());
    expect(result.refreshAttempted).toBe(false);
    expect(result.refreshFailed).toBe(false);
    expect(result.validation.partyMatch).toMatchObject({ status: 'exact', matchedName: 'New' });
  });
});
describe('resolveDraftWithRefresh — 2 & 4. a master created in Tally after the last sync is found by refresh, never the misleading stale fuzzy candidate', () => {
  it('this is the real incident, reproduced exactly: cache has "New Customer" but not "New" — refresh brings in "New", which is what gets used', async () => {
    seedLedgersWithoutNew(); // exact state of the cache at the moment of the real incident
    const syncCoordinator = scriptedSyncCoordinator({ succeeds: true, applyFn: addNewLedgerToCache });
    const result = await resolveDraftWithRefresh(baseDeps(syncCoordinator), draft({ partyName: 'new' }));
    expect(syncCoordinator.callCount).toBe(1);
    expect(result.refreshAttempted).toBe(true);
    expect(result.refreshFailed).toBe(false);
    // The whole point: resolves to the real "New" ledger...
    expect(result.validation.partyMatch).toMatchObject({ status: 'exact', matchedName: 'New' });
    // ...and NEVER the misleading stale fuzzy candidate that caused the real
    // wrong posting.
    expect(result.validation.partyMatch.matchedName).not.toBe('New Customer');
  });
  it('without the refresh mechanism, the same stale cache really would fuzzy-match to "New Customer" — confirms this is a genuine regression test, not a tautology', async () => {
    seedLedgersWithoutNew();
    const validation = (
      await import('../src/validation/validateDraft.js')
    ).validateTransactionDraft(database.db, draft({ partyName: 'new' }), itemLedgerMappingStore);
    expect(validation.partyMatch?.matchedName).toBe('New Customer');
  });
});
describe('resolveDraftWithRefresh — 3. still missing after refresh blocks, never guesses', () => {
  it('refresh runs, genuinely finds nothing new, party stays not_found', async () => {
    seedLedgersWithoutNew();
    const syncCoordinator = scriptedSyncCoordinator({ succeeds: true }); // no applyFn — nothing changes
    const result = await resolveDraftWithRefresh(
      baseDeps(syncCoordinator),
      draft({ partyName: 'Totally Nonexistent Party Zzz' }),
    );
    expect(syncCoordinator.callCount).toBe(1);
    expect(result.refreshAttempted).toBe(true);
    expect(result.refreshFailed).toBe(false);
    expect(result.validation.partyMatch?.status).toBe('not_found');
    expect(result.validation.isValid).toBe(false);
  });
});
describe('resolveDraftWithRefresh — 5. genuine ambiguity is never silently resolved, refresh or not', () => {
  it('two real, equally-plausible candidates stay ambiguous after a refresh that changes nothing about the collision', async () => {
    cache.replaceAll('Ledger', [
      { NAME: 'CGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'CGST' },
      { NAME: 'SGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'SGST/UTGST' },
      { NAME: 'Sales', PARENT: 'Sales Accounts' },
      { NAME: 'Ramesh Traders', PARENT: 'Sundry Creditors' },
      { NAME: 'Ramesh Exports', PARENT: 'Sundry Creditors' },
    ]);
    const syncCoordinator = scriptedSyncCoordinator({ succeeds: true }); // nothing new to find
    const result = await resolveDraftWithRefresh(baseDeps(syncCoordinator), draft({ partyName: 'Ramesh' }));
    expect(syncCoordinator.callCount).toBe(1); // still tried — non-exact always tries once
    expect(result.validation.partyMatch?.status).toBe('ambiguous');
    expect(result.validation.partyMatch?.matchedName).toBeNull();
    expect(result.validation.isValid).toBe(false);
  });
});
describe('resolveDraftWithRefresh — 6. Tally unavailable during refresh blocks safely, never trusts the stale attempt', () => {
  it('refresh fails outright — refreshFailed is the caller\'s signal to block with "couldn\'t verify", not to reuse the stale result as final', async () => {
    seedLedgersWithoutNew();
    const syncCoordinator = scriptedSyncCoordinator({ succeeds: false });
    const result = await resolveDraftWithRefresh(baseDeps(syncCoordinator), draft({ partyName: 'new' }));
    expect(syncCoordinator.callCount).toBe(1);
    expect(result.refreshAttempted).toBe(true);
    expect(result.refreshFailed).toBe(true);
    // The stale attempt is still attached (a caller could log it), but the
    // contract is that refreshFailed must be checked FIRST — never treated
    // as a safe "not found" or silently posted against.
    expect(result.validation.partyMatch?.matchedName).toBe('New Customer');
  });
});
describe('resolveReadinessWithRefresh — the confirm-time / pre-write re-check path', () => {
  function fullDeps(syncCoordinator, extra = {}) {
    return { ...baseDeps(syncCoordinator), companyName: 'Test Co', ...extra };
  }
  const VALIDATION = {
    isValid: true,
    partyMatch: { status: 'exact', matchedName: 'Itworks', candidates: [] },
    items: [
      {
        itemName: 'Steel Rods',
        stockItemMatch: { status: 'exact', matchedName: 'Steel Rods', candidates: [] },
        quantityValid: true,
        rateValid: true,
      },
    ],
  };
  function readyDraft() {
    return draft({ partyName: 'Itworks' });
  }
  beforeEach(() => {
    cache.replaceAll('Ledger', [
      { NAME: 'CGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'CGST' },
      { NAME: 'SGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'SGST/UTGST' },
      { NAME: 'Sales', PARENT: 'Sales Accounts' },
      { NAME: 'Itworks', PARENT: 'Sundry Creditors' },
    ]);
  });
  it('godown removed from Tally since confirmation — refresh restores it if it is still really there', async () => {
    cache.replaceAll('Godown', []); // simulates "gone from the cache"
    const syncCoordinator = scriptedSyncCoordinator({
      succeeds: true,
      applyFn: () => cache.replaceAll('Godown', [{ NAME: 'Main Location', PARENT: 'Primary' }]),
    });
    const result = await resolveReadinessWithRefresh(fullDeps(syncCoordinator), readyDraft(), VALIDATION);
    expect(syncCoordinator.callCount).toBe(1);
    expect(result.refreshAttempted).toBe(true);
    expect(result.readiness.ready).toBe(true);
  });
  it('godown genuinely gone — blocks after refresh confirms it, never guesses another godown', async () => {
    cache.replaceAll('Godown', []);
    const syncCoordinator = scriptedSyncCoordinator({ succeeds: true }); // nothing restored
    const result = await resolveReadinessWithRefresh(fullDeps(syncCoordinator), readyDraft(), VALIDATION);
    expect(result.readiness.ready).toBe(false);
    // GODOWN_CONFIG configures a default ("Main Location"), so the blocker
    // is "the configured godown isn't in the cache", not "no godown at all".
    expect(result.readiness.blockers.some((b) => b.code === 'godown_not_found_in_masters')).toBe(true);
  });
  it('Tally unreachable at the pre-write re-check — blocks, never posts against a stale readiness result', async () => {
    cache.replaceAll('Godown', []);
    const syncCoordinator = scriptedSyncCoordinator({ succeeds: false });
    const result = await resolveReadinessWithRefresh(fullDeps(syncCoordinator), readyDraft(), VALIDATION);
    expect(result.refreshFailed).toBe(true);
  });
  it('an already-ready draft needs no refresh at all — the common, fast path stays fast', async () => {
    const result = await resolveReadinessWithRefresh(
      fullDeps(neverCalledSyncCoordinator()),
      readyDraft(),
      VALIDATION,
    );
    expect(result.refreshAttempted).toBe(false);
    expect(result.readiness.ready).toBe(true);
  });
  it('reproduces the exact same readiness checkPostingReadiness alone would give, when no refresh is needed', async () => {
    const direct = checkPostingReadiness(fullDeps(neverCalledSyncCoordinator()), readyDraft(), VALIDATION);
    const wrapped = await resolveReadinessWithRefresh(
      fullDeps(neverCalledSyncCoordinator()),
      readyDraft(),
      VALIDATION,
    );
    expect(wrapped.readiness).toEqual(direct);
  });
});
