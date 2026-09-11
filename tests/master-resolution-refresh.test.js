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
describe('resolveDraftWithRefresh — stale cached selling price on an exact-matched StockItem (the "Test Item" incident)', () => {
  function priceDraft(overrides = {}) {
    return draft({
      partyName: 'Itworks',
      items: [{ itemName: 'Steel Rods', quantity: 10, rate: null, godown: null, gstPercent: 18 }],
      ...overrides,
    });
  }
  beforeEach(() => {
    cache.replaceAll('Ledger', [
      { NAME: 'CGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'CGST' },
      { NAME: 'SGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'SGST/UTGST' },
      { NAME: 'Sales', PARENT: 'Sales Accounts' },
      { NAME: 'Itworks', PARENT: 'Sundry Creditors' },
    ]);
    // No item_ledger_mappings salesRate configured for this test group —
    // rate must come from Tally's own standardPriceHistory or nowhere.
    itemLedgerMappingStore.setMapping({ stockItemName: 'Steel Rods', salesLedger: 'Sales', purchaseLedger: 'Purchase' });
  });
  it('1. cached price already present, exact name match — resolves immediately, no sync at all', async () => {
    cache.replaceAll('StockItem', [
      { NAME: 'Steel Rods', PARENT: '', BASEUNITS: 'Kg', standardPriceHistory: [{ date: '2026-01-01', rate: 500, unit: 'Kg' }] },
    ]);
    const result = await resolveDraftWithRefresh(baseDeps(neverCalledSyncCoordinator()), priceDraft());
    expect(result.refreshAttempted).toBe(false);
    expect(result.validation.items[0]).toMatchObject({ rateValid: true, resolvedRate: 500 });
  });
  it('2. price only just set in Tally, cache still has none — refresh brings it in and resolves', async () => {
    cache.replaceAll('StockItem', [{ NAME: 'Steel Rods', PARENT: '', BASEUNITS: 'Kg' }]); // no price history yet
    const syncCoordinator = scriptedSyncCoordinator({
      succeeds: true,
      applyFn: () =>
        cache.replaceAll('StockItem', [
          { NAME: 'Steel Rods', PARENT: '', BASEUNITS: 'Kg', standardPriceHistory: [{ date: '2026-01-01', rate: 500, unit: 'Kg' }] },
        ]),
    });
    const result = await resolveDraftWithRefresh(baseDeps(syncCoordinator), priceDraft());
    expect(syncCoordinator.callCount).toBe(1);
    expect(result.refreshAttempted).toBe(true);
    expect(result.validation.items[0]).toMatchObject({ rateValid: true, resolvedRate: 500 });
  });
  it('4. still no applicable price even after refresh — blocks, never guesses', async () => {
    cache.replaceAll('StockItem', [{ NAME: 'Steel Rods', PARENT: '', BASEUNITS: 'Kg' }]);
    const syncCoordinator = scriptedSyncCoordinator({ succeeds: true }); // nothing changes
    const result = await resolveDraftWithRefresh(baseDeps(syncCoordinator), priceDraft());
    expect(syncCoordinator.callCount).toBe(1);
    expect(result.refreshAttempted).toBe(true);
    expect(result.validation.items[0]).toMatchObject({ rateValid: false, resolvedRate: null });
    expect(result.validation.issues.some((i) => i.code === 'missing_rate')).toBe(true);
    expect(result.validation.isValid).toBe(false);
  });
  it('5. user explicitly states a rate — used as-is, no sync, existing precedence untouched', async () => {
    cache.replaceAll('StockItem', [{ NAME: 'Steel Rods', PARENT: '', BASEUNITS: 'Kg' }]); // no price history at all
    const result = await resolveDraftWithRefresh(
      baseDeps(neverCalledSyncCoordinator()),
      priceDraft({ items: [{ itemName: 'Steel Rods', quantity: 10, rate: 999, godown: null, gstPercent: 18 }] }),
    );
    expect(result.refreshAttempted).toBe(false);
    expect(result.validation.items[0]).toMatchObject({ rateValid: true, resolvedRate: 999 });
  });
  it('6. user states an invalid rate — never triggers a Tally sync, since no sync could fix bad user input', async () => {
    const result = await resolveDraftWithRefresh(
      baseDeps(neverCalledSyncCoordinator()),
      priceDraft({ items: [{ itemName: 'Steel Rods', quantity: 10, rate: 'abc', godown: null, gstPercent: 18 }] }),
    );
    expect(result.refreshAttempted).toBe(false);
    expect(result.validation.items[0].rateValid).toBe(false);
    expect(result.validation.issues.some((i) => i.code === 'invalid_rate')).toBe(true);
  });
  it('7. Tally unreachable during the refresh — blocks safely, never guesses a price', async () => {
    cache.replaceAll('StockItem', [{ NAME: 'Steel Rods', PARENT: '', BASEUNITS: 'Kg' }]);
    const syncCoordinator = scriptedSyncCoordinator({ succeeds: false });
    const result = await resolveDraftWithRefresh(baseDeps(syncCoordinator), priceDraft());
    expect(result.refreshAttempted).toBe(true);
    expect(result.refreshFailed).toBe(true);
  });
  it('a missing_rate on a purchase voucher never triggers a sync — Tally standard rate is never consulted for purchases anyway', async () => {
    cache.replaceAll('StockItem', [{ NAME: 'Steel Rods', PARENT: '', BASEUNITS: 'Kg' }]);
    // Purchase vouchers match a party against Sundry Debtors, not Sundry
    // Creditors (see VOUCHER_TYPE_PARTY_GROUP in masterLookup.js) — reseed
    // "Itworks" under the group this voucher type actually requires.
    cache.replaceAll('Ledger', [
      { NAME: 'CGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'CGST' },
      { NAME: 'SGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'SGST/UTGST' },
      { NAME: 'Purchase', PARENT: 'Purchase Accounts' },
      { NAME: 'Itworks', PARENT: 'Sundry Debtors' },
    ]);
    itemLedgerMappingStore.setMapping({ stockItemName: 'Steel Rods', salesLedger: 'Sales', purchaseLedger: 'Purchase' }); // no purchaseRate configured
    const result = await resolveDraftWithRefresh(
      baseDeps(neverCalledSyncCoordinator()),
      priceDraft({ voucherType: 'purchase' }),
    );
    expect(result.refreshAttempted).toBe(false);
    expect(result.validation.items[0].rateValid).toBe(false);
  });
});
describe('resolveDraftWithRefresh — stale cached GST rate on an exact-matched StockItem (the "Samsung" incident)', () => {
  // An explicit, valid rate on every draft here isolates GST resolution —
  // otherwise a missing_rate issue (already covered above) would also
  // trigger a refresh, making these assertions ambiguous about *why*.
  function gstDraft(overrides = {}) {
    return draft({
      partyName: 'Itworks',
      items: [{ itemName: 'Samsung', quantity: 2, rate: 55000, godown: null, gstPercent: null }],
      gstPercent: null,
      ...overrides,
    });
  }
  beforeEach(() => {
    cache.replaceAll('Ledger', [
      { NAME: 'CGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'CGST' },
      { NAME: 'SGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'SGST/UTGST' },
      { NAME: 'Sales', PARENT: 'Sales Accounts' },
      { NAME: 'Itworks', PARENT: 'Sundry Creditors' },
    ]);
    itemLedgerMappingStore.setMapping({ stockItemName: 'Samsung', salesLedger: 'Sales', purchaseLedger: 'Purchase' }); // no gstPercent override configured
  });
  it('cached GST rate already usable, exact name match — resolves immediately, no sync at all', async () => {
    cache.replaceAll('StockItem', [
      {
        NAME: 'Samsung',
        PARENT: '',
        BASEUNITS: 'PCS',
        gstRateHistory: [{ applicableFrom: '2025-04-01', states: [{ state: 'Any', cgst: 9, sgst: 9, igst: 18 }] }],
      },
    ]);
    const result = await resolveDraftWithRefresh(baseDeps(neverCalledSyncCoordinator()), gstDraft());
    expect(result.refreshAttempted).toBe(false);
    expect(result.validation.items[0]).toMatchObject({ gstPercentValid: true, resolvedGstPercent: 18 });
  });
  it('cached GST entry has no usable percentages (real "Samsung" shape) — refresh brings in the real rate Tally now has', async () => {
    cache.replaceAll('StockItem', [
      {
        NAME: 'Samsung',
        PARENT: '',
        BASEUNITS: 'PCS',
        gstRateHistory: [{ applicableFrom: '2025-04-01', states: [{ state: 'Any', cgst: null, sgst: null, igst: null }] }],
      },
    ]);
    const syncCoordinator = scriptedSyncCoordinator({
      succeeds: true,
      applyFn: () =>
        cache.replaceAll('StockItem', [
          {
            NAME: 'Samsung',
            PARENT: '',
            BASEUNITS: 'PCS',
            gstRateHistory: [
              { applicableFrom: '2025-04-01', states: [{ state: 'Any', cgst: null, sgst: null, igst: null }] },
              { applicableFrom: '2026-09-01', states: [{ state: 'Any', cgst: 9, sgst: 9, igst: 18 }] },
            ],
          },
        ]),
    });
    const result = await resolveDraftWithRefresh(baseDeps(syncCoordinator), gstDraft({ date: '2026-09-01' }));
    expect(syncCoordinator.callCount).toBe(1);
    expect(result.refreshAttempted).toBe(true);
    expect(result.validation.items[0]).toMatchObject({ gstPercentValid: true, resolvedGstPercent: 18 });
  });
  it('still unresolved after refresh — blocks, never guesses a GST rate', async () => {
    cache.replaceAll('StockItem', [{ NAME: 'Samsung', PARENT: '', BASEUNITS: 'PCS' }]); // no gstRateHistory at all
    const syncCoordinator = scriptedSyncCoordinator({ succeeds: true }); // nothing changes
    const result = await resolveDraftWithRefresh(baseDeps(syncCoordinator), gstDraft());
    expect(syncCoordinator.callCount).toBe(1);
    expect(result.refreshAttempted).toBe(true);
    expect(result.validation.items[0]).toMatchObject({ gstPercentValid: false, resolvedGstPercent: null });
    expect(result.validation.issues.some((i) => i.code === 'missing_gst_percent')).toBe(true);
  });
  it('user explicitly states a GST percent — used as-is, no sync', async () => {
    cache.replaceAll('StockItem', [{ NAME: 'Samsung', PARENT: '', BASEUNITS: 'PCS' }]); // no gstRateHistory at all
    const result = await resolveDraftWithRefresh(
      baseDeps(neverCalledSyncCoordinator()),
      gstDraft({ items: [{ itemName: 'Samsung', quantity: 2, rate: 55000, godown: null, gstPercent: 18 }] }),
    );
    expect(result.refreshAttempted).toBe(false);
    expect(result.validation.items[0]).toMatchObject({ gstPercentValid: true, resolvedGstPercent: 18 });
  });
  it('user states an invalid GST percent — never triggers a sync, since no sync could fix bad user input', async () => {
    cache.replaceAll('StockItem', [{ NAME: 'Samsung', PARENT: '', BASEUNITS: 'PCS' }]);
    const result = await resolveDraftWithRefresh(
      baseDeps(neverCalledSyncCoordinator()),
      gstDraft({ items: [{ itemName: 'Samsung', quantity: 2, rate: 55000, godown: null, gstPercent: 999 }] }),
    );
    expect(result.refreshAttempted).toBe(false);
    expect(result.validation.items[0].gstPercentValid).toBe(false);
    expect(result.validation.issues.some((i) => i.code === 'invalid_gst_percent')).toBe(true);
  });
  it('applies on a purchase voucher too — Tally GST history is consulted for every voucher type, unlike rate', async () => {
    cache.replaceAll('StockItem', [{ NAME: 'Samsung', PARENT: '', BASEUNITS: 'PCS' }]);
    cache.replaceAll('Ledger', [
      { NAME: 'CGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'CGST' },
      { NAME: 'SGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'SGST/UTGST' },
      { NAME: 'Purchase', PARENT: 'Purchase Accounts' },
      { NAME: 'Itworks', PARENT: 'Sundry Debtors' }, // purchase matches against Sundry Debtors
    ]);
    const syncCoordinator = scriptedSyncCoordinator({
      succeeds: true,
      applyFn: () =>
        cache.replaceAll('StockItem', [
          {
            NAME: 'Samsung',
            PARENT: '',
            BASEUNITS: 'PCS',
            gstRateHistory: [{ applicableFrom: '2025-04-01', states: [{ state: 'Any', cgst: 9, sgst: 9, igst: 18 }] }],
          },
        ]),
    });
    const result = await resolveDraftWithRefresh(baseDeps(syncCoordinator), gstDraft({ voucherType: 'purchase' }));
    expect(syncCoordinator.callCount).toBe(1);
    expect(result.refreshAttempted).toBe(true);
    expect(result.validation.items[0]).toMatchObject({ gstPercentValid: true, resolvedGstPercent: 18 });
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
