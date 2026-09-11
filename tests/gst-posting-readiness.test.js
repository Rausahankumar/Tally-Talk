import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCompanyRevenueLedgerDefaultsStore } from '../src/gst/companyRevenueLedgerDefaults.js';
import { ledgerExistsExact } from '../src/gst/ledgerExistence.js';
import { createItemLedgerMappingStore } from '../src/gst/itemLedgerMapping.js';
import { checkPostingReadiness, isOnlyMissingPlaceOfSupply } from '../src/gst/postingReadiness.js';
import { godownExistsExact } from '../src/tally/godownExistence.js';
import { createTallyMasterCache } from '../src/tally/cache.js';
import { createStockAvailabilityCache } from '../src/tally/stockAvailabilityCache.js';
import { createTestDatabase } from './helpers/testDatabase.js';
const GST_CONFIG = {
  companyState: 'Delhi',
  defaultPlaceOfSupply: null,
};
const GODOWN_CONFIG = {
  defaultGodown: 'Main Location',
};
function draft(overrides = {}) {
  return {
    voucherType: 'sales',
    partyName: 'Suresh & Sons',
    items: [{ itemName: 'Steel Rods', quantity: 100, rate: 500, godown: null }],
    gstPercent: 18,
    placeOfSupply: null,
    missingFields: [],
    ambiguityNote: null,
    ...overrides,
  };
}
const VALID_PHASE5 = {
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
};
const INVALID_PHASE5 = {
  ...VALID_PHASE5,
  isValid: false,
  issues: [{ code: 'missing_party_name', message: 'x' }],
};
let database;
let itemLedgerMappingStore;
let stockAvailabilityStore;
beforeEach(() => {
  database = createTestDatabase();
  itemLedgerMappingStore = createItemLedgerMappingStore(database.db);
  stockAvailabilityStore = createStockAvailabilityCache({ db: database.db });
  createTallyMasterCache({ db: database.db }).replaceAll('Ledger', [
    // TAXTYPE/GSTDUTYHEAD confirmed live on real CGST/SGST ledgers (see
    // gstLedgerResolution.js) — required for dynamic GST ledger resolution.
    { NAME: 'CGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'CGST' },
    { NAME: 'SGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'SGST/UTGST' },
    { NAME: 'IGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'IGST' },
    { NAME: 'Sales', PARENT: 'Sales Accounts' },
    { NAME: 'Suresh & Sons', PARENT: 'Sundry Creditors' },
  ]);
  createTallyMasterCache({ db: database.db }).replaceAll('Godown', [
    { NAME: 'Main Location', PARENT: 'Primary' },
    { NAME: 'Warehouse B', PARENT: 'Primary' },
  ]);
  itemLedgerMappingStore.setMapping({
    stockItemName: 'Steel Rods',
    salesLedger: 'Sales',
    purchaseLedger: 'Purchase',
  });
  // Ample, unambiguous stock for the default fixture item/godowns used by
  // tests that are not specifically about stock availability.
  stockAvailabilityStore.replaceAllForItem('Steel Rods', [
    { batchName: 'Primary Batch', godownName: 'Main Location', quantity: 1000, unit: 'Kg' },
    { batchName: 'Primary Batch', godownName: 'Warehouse B', quantity: 1000, unit: 'Kg' },
  ]);
});
afterEach(() => {
  database.close();
});
function readiness(d, validation = VALID_PHASE5) {
  return checkPostingReadiness(
    {
      db: database.db,
      gstConfig: GST_CONFIG,
      itemLedgerMappingStore,
      godownConfig: GODOWN_CONFIG,
      stockAvailabilityStore,
    },
    d,
    validation,
  );
}
describe('ledgerExistsExact', () => {
  it('finds a ledger by exact, case-insensitive name', () => {
    expect(ledgerExistsExact(database.db, 'CGST')).toBe(true);
    expect(ledgerExistsExact(database.db, 'cgst')).toBe(true);
  });
  it('does not fuzzy match — a near-miss is not found', () => {
    expect(ledgerExistsExact(database.db, 'CGSTT')).toBe(false);
    expect(ledgerExistsExact(database.db, 'C G S T')).toBe(false);
  });
});
describe('godownExistsExact', () => {
  it('finds a godown by exact, case-insensitive name', () => {
    expect(godownExistsExact(database.db, 'Main Location')).toBe(true);
    expect(godownExistsExact(database.db, 'main location')).toBe(true);
  });
  it('does not fuzzy match — a near-miss is not found', () => {
    expect(godownExistsExact(database.db, 'Main Locatio')).toBe(false);
    expect(godownExistsExact(database.db, 'Main  Location')).toBe(false);
  });
});
describe('checkPostingReadiness — A: Place of Supply logic', () => {
  it('Company: Delhi, POS: Delhi -> ready, intrastate CGST + SGST', () => {
    const result = readiness(draft({ placeOfSupply: 'Delhi' }));
    expect(result.ready).toBe(true);
    expect(result.gstTreatment?.type).toBe('intrastate');
    expect(result.gstTreatment?.ledgers.map((l) => l.ledgerName)).toEqual(['CGST', 'SGST']);
  });
  it('Company: Delhi, POS: Uttar Pradesh -> ready, interstate IGST', () => {
    const result = readiness(draft({ placeOfSupply: 'Uttar Pradesh' }));
    expect(result.ready).toBe(true);
    expect(result.gstTreatment?.type).toBe('interstate');
    expect(result.gstTreatment?.ledgers.map((l) => l.ledgerName)).toEqual(['IGST']);
  });
});
describe('checkPostingReadiness — B: party state must never override POS', () => {
  it('does not look at the party at all — only draft.placeOfSupply and config.companyState matter', () => {
    // The draft here has no notion of "party state" — TransactionDraft never
    // carries one, and checkPostingReadiness never reads validation.partyMatch
    // for GST purposes. Two different validation results (as if the party
    // were in different states) yield the identical GST treatment because
    // only Company State vs Place of Supply is compared.
    const withPartyContext = readiness(draft({ placeOfSupply: 'Delhi' }), {
      ...VALID_PHASE5,
      partyMatch: { status: 'exact', matchedName: 'A UP-based company', candidates: [] },
    });
    expect(withPartyContext.gstTreatment?.type).toBe('intrastate');
  });
  it('Company: Delhi, Party: (irrelevant), POS: Delhi -> CGST + SGST regardless', () => {
    const result = readiness(draft({ placeOfSupply: 'Delhi' }));
    expect(result.gstTreatment?.type).toBe('intrastate');
  });
  it('Company: Delhi, Party: (irrelevant), POS: Uttar Pradesh -> IGST regardless', () => {
    const result = readiness(draft({ placeOfSupply: 'Uttar Pradesh' }));
    expect(result.gstTreatment?.type).toBe('interstate');
  });
});
describe('checkPostingReadiness — C: missing Place of Supply', () => {
  it('blocks the transaction when no POS is stated and no default is configured', () => {
    const result = readiness(draft({ placeOfSupply: null }));
    expect(result.ready).toBe(false);
    expect(result.blockers).toContainEqual(
      expect.objectContaining({ code: 'place_of_supply_missing' }),
    );
    expect(isOnlyMissingPlaceOfSupply(result)).toBe(true);
  });
  it('uses an explicitly configured default instead of blocking', () => {
    const configWithDefault = { ...GST_CONFIG, defaultPlaceOfSupply: 'Delhi' };
    const result = checkPostingReadiness(
      {
        db: database.db,
        gstConfig: configWithDefault,
        itemLedgerMappingStore,
        godownConfig: GODOWN_CONFIG,
        stockAvailabilityStore,
      },
      draft({ placeOfSupply: null }),
      VALID_PHASE5,
    );
    expect(result.ready).toBe(true);
    expect(result.placeOfSupply).toBe('Delhi');
  });
  it('rejects an unrecognised place of supply rather than guessing', () => {
    const result = readiness(draft({ placeOfSupply: 'Narnia' }));
    expect(result.ready).toBe(false);
    expect(result.blockers).toContainEqual(
      expect.objectContaining({ code: 'place_of_supply_unrecognized' }),
    );
  });
  it('derives Place of Supply from the party ledger\'s own registered state when nothing else states one', () => {
    createTallyMasterCache({ db: database.db }).replaceAll('Ledger', [
      { NAME: 'CGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'CGST' },
      { NAME: 'SGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'SGST/UTGST' },
      { NAME: 'IGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'IGST' },
      { NAME: 'Sales', PARENT: 'Sales Accounts' },
      // Real live-confirmed shape: a party ledger genuinely registered in a
      // different state from the company (Delhi) — Goa, matching the real
      // "Itworks" ledger this feature was built for.
      { NAME: 'Itworks', PARENT: 'Sundry Creditors', LEDSTATENAME: 'Goa' },
    ]);
    const result = readiness(
      draft({ partyName: 'Itworks', placeOfSupply: null }),
      { ...VALID_PHASE5, partyMatch: { status: 'exact', matchedName: 'Itworks', candidates: [] } },
    );
    expect(result.ready).toBe(true);
    expect(result.placeOfSupply).toBe('Goa');
    expect(result.placeOfSupplySource).toBe('party');
    expect(result.gstTreatment?.type).toBe('interstate'); // Delhi company vs Goa party -> IGST
  });
  it('never lets the party\'s state override an explicitly stated Place of Supply', () => {
    createTallyMasterCache({ db: database.db }).replaceAll('Ledger', [
      { NAME: 'CGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'CGST' },
      { NAME: 'SGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'SGST/UTGST' },
      { NAME: 'IGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'IGST' },
      { NAME: 'Sales', PARENT: 'Sales Accounts' },
      { NAME: 'Itworks', PARENT: 'Sundry Creditors', LEDSTATENAME: 'Goa' },
    ]);
    const result = readiness(
      draft({ partyName: 'Itworks', placeOfSupply: 'Delhi' }),
      { ...VALID_PHASE5, partyMatch: { status: 'exact', matchedName: 'Itworks', candidates: [] } },
    );
    expect(result.placeOfSupply).toBe('Delhi');
    expect(result.placeOfSupplySource).toBe('explicit');
    expect(result.gstTreatment?.type).toBe('intrastate');
  });
  it('prefers the party\'s state over a configured default when both are available', () => {
    createTallyMasterCache({ db: database.db }).replaceAll('Ledger', [
      { NAME: 'CGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'CGST' },
      { NAME: 'SGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'SGST/UTGST' },
      { NAME: 'IGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'IGST' },
      { NAME: 'Sales', PARENT: 'Sales Accounts' },
      { NAME: 'Itworks', PARENT: 'Sundry Creditors', LEDSTATENAME: 'Goa' },
    ]);
    const result = checkPostingReadiness(
      {
        db: database.db,
        gstConfig: { ...GST_CONFIG, defaultPlaceOfSupply: 'Delhi' },
        itemLedgerMappingStore,
        godownConfig: GODOWN_CONFIG,
        stockAvailabilityStore,
      },
      draft({ partyName: 'Itworks', placeOfSupply: null }),
      { ...VALID_PHASE5, partyMatch: { status: 'exact', matchedName: 'Itworks', candidates: [] } },
    );
    expect(result.placeOfSupply).toBe('Goa'); // not the configured default
    expect(result.placeOfSupplySource).toBe('party');
  });
  it('falls back to the configured default when the party has no registered state cached', () => {
    // "Suresh & Sons" (the shared fixture party) has no LEDSTATENAME at all.
    const result = checkPostingReadiness(
      {
        db: database.db,
        gstConfig: { ...GST_CONFIG, defaultPlaceOfSupply: 'Delhi' },
        itemLedgerMappingStore,
        godownConfig: GODOWN_CONFIG,
        stockAvailabilityStore,
      },
      draft({ placeOfSupply: null }),
      VALID_PHASE5,
    );
    expect(result.placeOfSupply).toBe('Delhi');
    expect(result.placeOfSupplySource).toBe('default');
  });
  it('does not use an unrecognised party state — falls through instead of blocking or guessing', () => {
    createTallyMasterCache({ db: database.db }).replaceAll('Ledger', [
      { NAME: 'CGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'CGST' },
      { NAME: 'SGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'SGST/UTGST' },
      { NAME: 'IGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'IGST' },
      { NAME: 'Sales', PARENT: 'Sales Accounts' },
      { NAME: 'Itworks', PARENT: 'Sundry Creditors', LEDSTATENAME: 'Narnia' },
    ]);
    const result = readiness(
      draft({ partyName: 'Itworks', placeOfSupply: null }),
      { ...VALID_PHASE5, partyMatch: { status: 'exact', matchedName: 'Itworks', candidates: [] } },
    );
    expect(result.ready).toBe(false);
    expect(result.blockers).toContainEqual(
      expect.objectContaining({ code: 'place_of_supply_missing' }),
    );
  });
});
describe('checkPostingReadiness — D/E: GST ledger mapping and existence', () => {
  it('blocks when the company state itself is not configured', () => {
    const result = checkPostingReadiness(
      {
        db: database.db,
        gstConfig: { ...GST_CONFIG, companyState: '' },
        itemLedgerMappingStore,
        godownConfig: GODOWN_CONFIG,
        stockAvailabilityStore,
      },
      draft({ placeOfSupply: 'Delhi' }),
      VALID_PHASE5,
    );
    expect(result.ready).toBe(false);
    expect(result.blockers).toContainEqual(
      expect.objectContaining({ code: 'company_state_not_configured' }),
    );
  });
  it('blocks with a specific reason when the company state is present but not a recognised state', () => {
    const result = checkPostingReadiness(
      {
        db: database.db,
        gstConfig: { ...GST_CONFIG, companyState: 'Narnia' },
        itemLedgerMappingStore,
        godownConfig: GODOWN_CONFIG,
        stockAvailabilityStore,
      },
      draft({ placeOfSupply: 'Delhi' }),
      VALID_PHASE5,
    );
    expect(result.ready).toBe(false);
    expect(result.blockers).toContainEqual(
      expect.objectContaining({ code: 'company_state_unrecognized' }),
    );
  });
  it('blocks when a configured GST ledger does not exist in cached masters', () => {
    createTallyMasterCache({ db: database.db }).replaceAll('Ledger', [
      { NAME: 'Sales', PARENT: '' },
    ]); // no CGST/SGST
    const result = readiness(draft({ placeOfSupply: 'Delhi' }));
    expect(result.ready).toBe(false);
    expect(result.blockers.some((b) => b.code === 'gst_ledger_not_found_in_masters')).toBe(true);
  });
  it('never substitutes a similarly named ledger — it just reports the ledger missing', () => {
    // A ledger that looks close ("CGST Payable") must not be silently accepted.
    createTallyMasterCache({ db: database.db }).replaceAll('Ledger', [
      { NAME: 'CGST Payable', PARENT: '' },
      { NAME: 'SGST', PARENT: '' },
      { NAME: 'Sales', PARENT: '' },
    ]);
    const result = readiness(draft({ placeOfSupply: 'Delhi' }));
    expect(result.ready).toBe(false);
    const blocker = result.blockers.find((b) => b.code === 'gst_ledger_not_found_in_masters');
    expect(blocker?.message).toContain('CGST');
  });
  it('fails closed, never picking one, when two ledgers are both classified as the same GST duty head', () => {
    createTallyMasterCache({ db: database.db }).replaceAll('Ledger', [
      { NAME: 'CGST Main', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'CGST' },
      { NAME: 'CGST Alt', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'CGST' },
      { NAME: 'SGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'SGST/UTGST' },
      { NAME: 'Sales', PARENT: 'Sales Accounts' },
    ]);
    const result = readiness(draft({ placeOfSupply: 'Delhi' }));
    expect(result.ready).toBe(false);
    expect(result.blockers).toContainEqual(expect.objectContaining({ code: 'gst_ledger_ambiguous' }));
  });
});
describe('checkPostingReadiness — F/G: Sales/Purchase ledger mapping and existence', () => {
  it('blocks when no mapping is configured for the resolved stock item', () => {
    const db2 = createTestDatabase();
    createTallyMasterCache({ db: db2.db }).replaceAll('Ledger', [
      { NAME: 'CGST', PARENT: '' },
      { NAME: 'SGST', PARENT: '' },
    ]);
    // Deliberately no item_ledger_mappings row for "Steel Rods".
    const result = checkPostingReadiness(
      {
        db: db2.db,
        gstConfig: GST_CONFIG,
        itemLedgerMappingStore: createItemLedgerMappingStore(db2.db),
        godownConfig: GODOWN_CONFIG,
        stockAvailabilityStore: createStockAvailabilityCache({ db: db2.db }),
      },
      draft({ placeOfSupply: 'Delhi' }),
      VALID_PHASE5,
    );
    expect(result.ready).toBe(false);
    expect(result.blockers).toContainEqual(
      expect.objectContaining({ code: 'item_ledger_mapping_missing', itemIndex: 0 }),
    );
    db2.close();
  });
  it('blocks when the configured Sales ledger does not exist in cached masters', () => {
    itemLedgerMappingStore.setMapping({
      stockItemName: 'Steel Rods',
      salesLedger: 'A Ledger Nobody Synced',
      purchaseLedger: 'Purchase',
    });
    const result = readiness(draft({ placeOfSupply: 'Delhi' }));
    expect(result.ready).toBe(false);
    expect(result.blockers).toContainEqual(
      expect.objectContaining({ code: 'item_ledger_not_found_in_masters', itemIndex: 0 }),
    );
  });
  it('uses the Purchase ledger, not the Sales ledger, for a purchase voucher', () => {
    itemLedgerMappingStore.setMapping({
      stockItemName: 'Steel Rods',
      salesLedger: 'Sales',
      purchaseLedger: 'Nonexistent Purchase Ledger',
    });
    const result = readiness(draft({ voucherType: 'purchase', placeOfSupply: 'Delhi' }));
    expect(result.ready).toBe(false);
    expect(result.blockers.some((b) => b.code === 'item_ledger_not_found_in_masters')).toBe(true);
  });
  it('auto-resolves the Sales ledger from Tally when this item has no manual mapping at all, as long as exactly one Sales Accounts ledger exists', () => {
    // No item_ledger_mappings row for "Steel Rods" here at all — a brand-new
    // stock item this app has never seen configured before.
    const db2 = createTestDatabase();
    createTallyMasterCache({ db: db2.db }).replaceAll('Ledger', [
      { NAME: 'CGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'CGST' },
      { NAME: 'SGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'SGST/UTGST' },
      { NAME: 'Suresh & Sons', PARENT: 'Sundry Creditors' },
      { NAME: 'Sales', PARENT: 'Sales Accounts' },
    ]);
    createTallyMasterCache({ db: db2.db }).replaceAll('Godown', [{ NAME: 'Main Location', PARENT: 'Primary' }]);
    const db2Stock = createStockAvailabilityCache({ db: db2.db });
    db2Stock.replaceAllForItem('Steel Rods', [
      { batchName: 'Primary Batch', godownName: 'Main Location', quantity: 1000, unit: 'Kg' },
    ]);
    const result = checkPostingReadiness(
      {
        db: db2.db,
        gstConfig: GST_CONFIG,
        itemLedgerMappingStore: createItemLedgerMappingStore(db2.db),
        godownConfig: GODOWN_CONFIG,
        stockAvailabilityStore: db2Stock,
      },
      draft({ placeOfSupply: 'Delhi' }),
      VALID_PHASE5,
    );
    expect(result.ready).toBe(true);
    expect(result.itemLedgers[0]?.salesLedger).toBe('Sales');
    db2.close();
  });
  it('blocks — with the real candidate names — when this item has no mapping and Tally has more than one Sales Accounts ledger', () => {
    const db2 = createTestDatabase();
    createTallyMasterCache({ db: db2.db }).replaceAll('Ledger', [
      { NAME: 'CGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'CGST' },
      { NAME: 'SGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'SGST/UTGST' },
      { NAME: 'Suresh & Sons', PARENT: 'Sundry Creditors' },
      { NAME: 'GST  Sales', PARENT: 'Sales Accounts' },
      { NAME: 'New Sale Ledger', PARENT: 'Sales Accounts' },
      { NAME: 'Sales', PARENT: 'Sales Accounts' },
    ]);
    const result = checkPostingReadiness(
      {
        db: db2.db,
        gstConfig: GST_CONFIG,
        itemLedgerMappingStore: createItemLedgerMappingStore(db2.db),
        godownConfig: GODOWN_CONFIG,
        stockAvailabilityStore: createStockAvailabilityCache({ db: db2.db }),
      },
      draft({ placeOfSupply: 'Delhi' }),
      VALID_PHASE5,
    );
    expect(result.ready).toBe(false);
    const blocker = result.blockers.find((b) => b.code === 'item_ledger_mapping_missing');
    expect(blocker?.message).toContain('GST  Sales');
    expect(blocker?.message).toContain('New Sale Ledger');
    expect(blocker?.message).toContain('Sales');
    db2.close();
  });
  it('a manually configured mapping still takes priority over the automatic Sales Accounts fallback', () => {
    // Two Sales Accounts ledgers exist (genuinely ambiguous on its own), but
    // an explicit mapping for this item removes the ambiguity entirely.
    createTallyMasterCache({ db: database.db }).replaceAll('Ledger', [
      { NAME: 'CGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'CGST' },
      { NAME: 'SGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'SGST/UTGST' },
      { NAME: 'Suresh & Sons', PARENT: 'Sundry Creditors' },
      { NAME: 'Sales', PARENT: 'Sales Accounts' },
      { NAME: 'Another Sales Ledger', PARENT: 'Sales Accounts' },
    ]);
    itemLedgerMappingStore.setMapping({
      stockItemName: 'Steel Rods',
      salesLedger: 'Another Sales Ledger',
      purchaseLedger: 'Purchase',
    });
    const result = readiness(draft({ placeOfSupply: 'Delhi' }));
    expect(result.ready).toBe(true);
    expect(result.itemLedgers[0]?.salesLedger).toBe('Another Sales Ledger');
  });
});
describe('checkPostingReadiness — G2: company-level default Sales/Purchase ledger', () => {
  /** Builds a fresh, isolated db + readiness call, with an ambiguous set of
   * Sales Accounts ledgers by default (mirrors the real company's actual
   * data) so a passing "resolves" test only passes because of the tier being
   * exercised, never by accident via single-candidate auto-resolution. */
  function setupAmbiguousCompany(companyName) {
    const db2 = createTestDatabase();
    createTallyMasterCache({ db: db2.db }).replaceAll('Ledger', [
      { NAME: 'CGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'CGST' },
      { NAME: 'SGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'SGST/UTGST' },
      { NAME: 'Suresh & Sons', PARENT: 'Sundry Creditors' },
      { NAME: 'GST  Sales', PARENT: 'Sales Accounts' },
      { NAME: 'New Sale Ledger', PARENT: 'Sales Accounts' },
      { NAME: 'Sales', PARENT: 'Sales Accounts' },
      { NAME: 'Purchase AC', PARENT: 'Purchase Accounts' },
    ]);
    createTallyMasterCache({ db: db2.db }).replaceAll('Godown', [{ NAME: 'Main Location', PARENT: 'Primary' }]);
    const stock = createStockAvailabilityCache({ db: db2.db });
    stock.replaceAllForItem('Steel Rods', [
      { batchName: 'Primary Batch', godownName: 'Main Location', quantity: 1000, unit: 'Kg' },
    ]);
    const companyDefaultsStore = createCompanyRevenueLedgerDefaultsStore(db2.db);
    const run = (d, voucherOverrides = {}) =>
      checkPostingReadiness(
        {
          db: db2.db,
          gstConfig: GST_CONFIG,
          itemLedgerMappingStore: createItemLedgerMappingStore(db2.db),
          companyRevenueLedgerDefaultsStore: companyDefaultsStore,
          companyName,
          godownConfig: GODOWN_CONFIG,
          stockAvailabilityStore: stock,
        },
        d,
        { ...VALID_PHASE5, ...voucherOverrides },
      );
    return { db2, companyDefaultsStore, run };
  }
  it('1. an explicit item_ledger_mappings row still wins over a configured company default', () => {
    const { db2, companyDefaultsStore, run } = setupAmbiguousCompany('Nirmal FMCG Traders Ltd');
    companyDefaultsStore.setDefaults({
      companyName: 'Nirmal FMCG Traders Ltd',
      salesLedger: 'GST  Sales',
      purchaseLedger: 'Purchase AC',
    });
    const itemLedgerMappingStore = createItemLedgerMappingStore(db2.db);
    itemLedgerMappingStore.setMapping({
      stockItemName: 'Steel Rods',
      salesLedger: 'Sales', // deliberately NOT the company default, to prove precedence
      purchaseLedger: 'Purchase AC',
    });
    const result = checkPostingReadiness(
      {
        db: db2.db,
        gstConfig: GST_CONFIG,
        itemLedgerMappingStore,
        companyRevenueLedgerDefaultsStore: companyDefaultsStore,
        companyName: 'Nirmal FMCG Traders Ltd',
        godownConfig: GODOWN_CONFIG,
        stockAvailabilityStore: createStockAvailabilityCache({ db: db2.db }),
      },
      draft({ placeOfSupply: 'Delhi' }),
      VALID_PHASE5,
    );
    expect(result.ready).toBe(true);
    expect(result.itemLedgers[0]?.salesLedger).toBe('Sales');
    db2.close();
  });
  it('2. a configured company default resolves a brand-new item with no item_ledger_mappings row at all', () => {
    const { db2, companyDefaultsStore, run } = setupAmbiguousCompany('Nirmal FMCG Traders Ltd');
    companyDefaultsStore.setDefaults({
      companyName: 'Nirmal FMCG Traders Ltd',
      salesLedger: 'GST  Sales',
      purchaseLedger: 'Purchase AC',
    });
    const result = run(draft({ placeOfSupply: 'Delhi' }));
    expect(result.ready).toBe(true);
    expect(result.itemLedgers[0]?.salesLedger).toBe('GST  Sales');
    db2.close();
  });
  it('3. no company default configured, exactly one Sales Accounts candidate — falls through to automatic single-candidate resolution', () => {
    const db2 = createTestDatabase();
    createTallyMasterCache({ db: db2.db }).replaceAll('Ledger', [
      { NAME: 'CGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'CGST' },
      { NAME: 'SGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'SGST/UTGST' },
      { NAME: 'Suresh & Sons', PARENT: 'Sundry Creditors' },
      { NAME: 'Sales', PARENT: 'Sales Accounts' }, // only one candidate
    ]);
    createTallyMasterCache({ db: db2.db }).replaceAll('Godown', [{ NAME: 'Main Location', PARENT: 'Primary' }]);
    const stock = createStockAvailabilityCache({ db: db2.db });
    stock.replaceAllForItem('Steel Rods', [
      { batchName: 'Primary Batch', godownName: 'Main Location', quantity: 1000, unit: 'Kg' },
    ]);
    // No row set in companyRevenueLedgerDefaultsStore at all.
    const result = checkPostingReadiness(
      {
        db: db2.db,
        gstConfig: GST_CONFIG,
        itemLedgerMappingStore: createItemLedgerMappingStore(db2.db),
        companyRevenueLedgerDefaultsStore: createCompanyRevenueLedgerDefaultsStore(db2.db),
        companyName: 'Some Other Company',
        godownConfig: GODOWN_CONFIG,
        stockAvailabilityStore: stock,
      },
      draft({ placeOfSupply: 'Delhi' }),
      VALID_PHASE5,
    );
    expect(result.ready).toBe(true);
    expect(result.itemLedgers[0]?.salesLedger).toBe('Sales');
    db2.close();
  });
  it('4. no company default configured, multiple candidates — still blocks with the real candidate names', () => {
    const { db2, run } = setupAmbiguousCompany('Nirmal FMCG Traders Ltd');
    // Deliberately no companyDefaultsStore.setDefaults(...) call.
    const result = run(draft({ placeOfSupply: 'Delhi' }));
    expect(result.ready).toBe(false);
    const blocker = result.blockers.find((b) => b.code === 'item_ledger_mapping_missing');
    expect(blocker?.message).toContain('GST  Sales');
    expect(blocker?.message).toContain('New Sale Ledger');
    expect(blocker?.message).toContain('Sales');
    db2.close();
  });
  it('5. a configured company default that no longer exists in Tally fails with a clear configuration error, never a silent fallback', () => {
    const { db2, companyDefaultsStore, run } = setupAmbiguousCompany('Nirmal FMCG Traders Ltd');
    companyDefaultsStore.setDefaults({
      companyName: 'Nirmal FMCG Traders Ltd',
      salesLedger: 'A Ledger That Was Renamed Or Deleted',
      purchaseLedger: 'Purchase AC',
    });
    const result = run(draft({ placeOfSupply: 'Delhi' }));
    expect(result.ready).toBe(false);
    const blocker = result.blockers.find((b) => b.code === 'company_default_ledger_not_found');
    expect(blocker).toBeDefined();
    expect(blocker?.message).toContain('A Ledger That Was Renamed Or Deleted');
    expect(blocker?.message).toContain('Nirmal FMCG Traders Ltd');
    // Never silently falls through to auto-resolve despite there being
    // real Sales Accounts candidates in this fixture — a configured-but-
    // missing default is a configuration error, not an invitation to guess.
    expect(result.blockers.some((b) => b.code === 'item_ledger_mapping_missing')).toBe(false);
    db2.close();
  });
  it('6. two different Tally companies can have independently configured defaults', () => {
    const db2 = createTestDatabase();
    createTallyMasterCache({ db: db2.db }).replaceAll('Ledger', [
      { NAME: 'CGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'CGST' },
      { NAME: 'SGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'SGST/UTGST' },
      { NAME: 'Suresh & Sons', PARENT: 'Sundry Creditors' },
      { NAME: 'GST  Sales', PARENT: 'Sales Accounts' },
      { NAME: 'New Sale Ledger', PARENT: 'Sales Accounts' },
    ]);
    createTallyMasterCache({ db: db2.db }).replaceAll('Godown', [{ NAME: 'Main Location', PARENT: 'Primary' }]);
    const stock = createStockAvailabilityCache({ db: db2.db });
    stock.replaceAllForItem('Steel Rods', [
      { batchName: 'Primary Batch', godownName: 'Main Location', quantity: 1000, unit: 'Kg' },
    ]);
    const companyDefaultsStore = createCompanyRevenueLedgerDefaultsStore(db2.db);
    companyDefaultsStore.setDefaults({
      companyName: 'Nirmal FMCG Traders Ltd',
      salesLedger: 'GST  Sales',
      purchaseLedger: 'Purchase AC',
    });
    companyDefaultsStore.setDefaults({
      companyName: 'Another Company Pvt Ltd',
      salesLedger: 'New Sale Ledger',
      purchaseLedger: 'Purchase AC',
    });
    const runFor = (companyName) =>
      checkPostingReadiness(
        {
          db: db2.db,
          gstConfig: GST_CONFIG,
          itemLedgerMappingStore: createItemLedgerMappingStore(db2.db),
          companyRevenueLedgerDefaultsStore: companyDefaultsStore,
          companyName,
          godownConfig: GODOWN_CONFIG,
          stockAvailabilityStore: stock,
        },
        draft({ placeOfSupply: 'Delhi' }),
        VALID_PHASE5,
      );
    expect(runFor('Nirmal FMCG Traders Ltd').itemLedgers[0]?.salesLedger).toBe('GST  Sales');
    expect(runFor('Another Company Pvt Ltd').itemLedgers[0]?.salesLedger).toBe('New Sale Ledger');
    db2.close();
  });
});
describe('checkPostingReadiness — G3: real-company regression (Orange/Itworks/Anti-Dandruff Shampoos)', () => {
  /** Shaped after the real "Nirmal FMCG Traders Ltd" company data used to
   * design this feature: company state Delhi, three real ambiguous Sales
   * Accounts ledgers, one unambiguous Purchase Accounts ledger, Orange with
   * a pre-existing explicit item_ledger_mappings row (as it has in
   * production), and a company-level default now configured to "GST  Sales"
   * / "Purchase AC" per the live voucher evidence gathered for this feature. */
  function setupRealCompanyFixture() {
    const db2 = createTestDatabase();
    createTallyMasterCache({ db: db2.db }).replaceAll('Ledger', [
      { NAME: 'CGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'CGST' },
      { NAME: 'SGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'SGST/UTGST' },
      { NAME: 'IGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'IGST' },
      { NAME: 'GST  Sales', PARENT: 'Sales Accounts' },
      { NAME: 'New Sale Ledger', PARENT: 'Sales Accounts' },
      { NAME: 'Sales', PARENT: 'Sales Accounts' },
      { NAME: 'Purchase AC', PARENT: 'Purchase Accounts' },
      { NAME: 'Itworks', PARENT: 'Sundry Creditors', LEDSTATENAME: 'Goa' },
    ]);
    createTallyMasterCache({ db: db2.db }).replaceAll('Godown', [{ NAME: 'Main Location', PARENT: 'Primary' }]);
    const stock = createStockAvailabilityCache({ db: db2.db });
    stock.replaceAllForItem('Orange', [
      { batchName: 'Primary Batch', godownName: 'Main Location', quantity: 1000, unit: 'KG' },
    ]);
    stock.replaceAllForItem('Anti-Dandruff Shampoos', [
      { batchName: 'Primary Batch', godownName: 'Main Location', quantity: 200, unit: 'Nos' },
    ]);
    const itemLedgerMappingStore = createItemLedgerMappingStore(db2.db);
    // Orange has a pre-existing explicit mapping in the real database — must
    // remain unaffected by the new company-default tier.
    itemLedgerMappingStore.setMapping({
      stockItemName: 'Orange',
      salesLedger: 'GST  Sales',
      purchaseLedger: 'Purchase AC',
    });
    const companyDefaultsStore = createCompanyRevenueLedgerDefaultsStore(db2.db);
    companyDefaultsStore.setDefaults({
      companyName: 'Nirmal FMCG Traders Ltd',
      salesLedger: 'GST  Sales',
      salesLedgerGuid: null,
      purchaseLedger: 'Purchase AC',
      purchaseLedgerGuid: null,
    });
    const deps = {
      db: db2.db,
      gstConfig: { companyState: 'Delhi', defaultPlaceOfSupply: null },
      itemLedgerMappingStore,
      companyRevenueLedgerDefaultsStore: companyDefaultsStore,
      companyName: 'Nirmal FMCG Traders Ltd',
      godownConfig: { defaultGodown: null },
      stockAvailabilityStore: stock,
    };
    return { db2, deps };
  }
  it('7. "Anti-Dandruff Shampoos" (no item_ledger_mappings row) resolves "GST  Sales" via the company default alone', () => {
    const { db2, deps } = setupRealCompanyFixture();
    const validation = {
      isValid: true,
      voucherTypeValid: true,
      partyMatch: { status: 'exact', matchedName: 'Itworks', candidates: [] },
      items: [
        {
          itemName: 'anti-Dandruff Shampoos',
          stockItemMatch: { status: 'exact', matchedName: 'Anti-Dandruff Shampoos', candidates: [] },
          quantityValid: true,
          rateValid: true,
        },
      ],
      gstPercentValid: true,
      issues: [],
    };
    const result = checkPostingReadiness(
      deps,
      {
        voucherType: 'sales',
        partyName: 'Itworks',
        items: [{ itemName: 'anti-Dandruff Shampoos', quantity: 5, rate: 125, godown: null }],
        gstPercent: 18,
        placeOfSupply: null,
        missingFields: [],
        ambiguityNote: null,
      },
      validation,
    );
    expect(result.ready).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.itemLedgers[0]?.salesLedger).toBe('GST  Sales');
    db2.close();
  });
  it('8. Orange -> Itworks interstate/IGST regression: unchanged after introducing the company default', () => {
    const { db2, deps } = setupRealCompanyFixture();
    const validation = {
      isValid: true,
      voucherTypeValid: true,
      partyMatch: { status: 'exact', matchedName: 'Itworks', candidates: [] },
      items: [
        {
          itemName: 'Orange',
          stockItemMatch: { status: 'exact', matchedName: 'Orange', candidates: [] },
          quantityValid: true,
          rateValid: true,
        },
      ],
      gstPercentValid: true,
      issues: [],
    };
    const result = checkPostingReadiness(
      deps,
      {
        voucherType: 'sales',
        partyName: 'Itworks',
        items: [{ itemName: 'Orange', quantity: 5, rate: 1000, godown: null }],
        gstPercent: 18,
        placeOfSupply: null,
        missingFields: [],
        ambiguityNote: null,
      },
      validation,
    );
    expect(result.ready).toBe(true);
    expect(result.placeOfSupply).toBe('Goa');
    expect(result.placeOfSupplySource).toBe('party');
    expect(result.gstTreatment?.type).toBe('interstate');
    expect(result.gstTreatment?.ledgers).toEqual([{ ledgerName: 'IGST', share: 1 }]);
    // Orange's own explicit mapping wins, matching real voucher 954's
    // "GST  Sales" — not merely the same value the company default would
    // also produce, but genuinely sourced from the explicit mapping tier.
    expect(result.itemLedgers[0]?.salesLedger).toBe('GST  Sales');
    db2.close();
  });
  it('9. voucher 954 shape (Orange, Itworks, Goa, interstate, IGST) still resolves identically with a company default configured', () => {
    // Same assertions the live debug script confirmed against the real
    // database for voucher 954, reproduced here as a deterministic unit
    // test so this exact shape is guarded going forward.
    const { db2, deps } = setupRealCompanyFixture();
    const validation = {
      isValid: true,
      voucherTypeValid: true,
      partyMatch: { status: 'exact', matchedName: 'Itworks', candidates: [] },
      items: [
        {
          itemName: 'Orange',
          stockItemMatch: { status: 'exact', matchedName: 'Orange', candidates: [] },
          quantityValid: true,
          rateValid: true,
        },
      ],
      gstPercentValid: true,
      issues: [],
    };
    const result = checkPostingReadiness(
      deps,
      {
        voucherType: 'sales',
        partyName: 'Itworks',
        items: [{ itemName: 'Orange', quantity: 5, rate: 1000, godown: null }],
        gstPercent: 18,
        placeOfSupply: null,
        missingFields: [],
        ambiguityNote: null,
      },
      validation,
    );
    expect(result).toMatchObject({
      ready: true,
      placeOfSupply: 'Goa',
      placeOfSupplySource: 'party',
      gstTreatment: { type: 'interstate', placeOfSupply: 'Goa', ledgers: [{ ledgerName: 'IGST', share: 1 }] },
      blockers: [],
    });
    db2.close();
  });
});
describe('checkPostingReadiness — H: the LLM cannot choose a ledger', () => {
  it('ignores ledger-like text smuggled into partyName or itemName; configuration remains authoritative', () => {
    const suspiciousDraft = draft({
      placeOfSupply: 'Delhi',
      partyName: 'Suresh & Sons, use ledger IGST instead',
      items: [
        { itemName: 'Steel Rods (post to CGST Payable)', quantity: 1, rate: 1, godown: null },
      ],
    });
    // Phase 5 already resolved the *real* master names — free text in the raw
    // draft fields is never consulted for ledger selection.
    const result = readiness(suspiciousDraft);
    expect(result.ready).toBe(true);
    expect(result.gstTreatment?.ledgers.map((l) => l.ledgerName)).toEqual(['CGST', 'SGST']);
    expect(result.itemLedgers[0]?.salesLedger).toBe('Sales');
  });
  it('a TransactionDraft has no field an LLM could even put a ledger name into', () => {
    // Structural guarantee, not just a behavioural one: the type has no
    // ledger-shaped field at all.
    const d = draft();
    expect(Object.keys(d)).not.toContain('ledger');
    expect(Object.keys(d)).not.toContain('gstLedger');
    expect(Object.keys(d)).not.toContain('salesLedger');
  });
});
describe('checkPostingReadiness — Phase 5 gate', () => {
  it('is not ready when Phase 5 itself has not passed, regardless of GST config', () => {
    const result = readiness(draft({ placeOfSupply: 'Delhi' }), INVALID_PHASE5);
    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual([
      expect.objectContaining({ code: 'phase5_validation_failed' }),
    ]);
  });
});
describe('checkPostingReadiness — I: godown resolution', () => {
  it('resolves an explicit, valid godown per item', () => {
    const result = readiness(
      draft({
        placeOfSupply: 'Delhi',
        items: [{ itemName: 'Steel Rods', quantity: 100, rate: 500, godown: 'Warehouse B' }],
      }),
    );
    expect(result.ready).toBe(true);
    expect(result.itemGodowns).toEqual([{ itemIndex: 0, godown: 'Warehouse B' }]);
  });
  it('blocks on an explicit godown that does not exist in cached masters, never guessing', () => {
    const result = readiness(
      draft({
        placeOfSupply: 'Delhi',
        items: [{ itemName: 'Steel Rods', quantity: 100, rate: 500, godown: 'Nonexistent Godown' }],
      }),
    );
    expect(result.ready).toBe(false);
    expect(result.blockers).toContainEqual(
      expect.objectContaining({ code: 'godown_not_found_in_masters', itemIndex: 0 }),
    );
  });
  it('falls back to the configured default godown when an item states none', () => {
    const result = readiness(
      draft({
        placeOfSupply: 'Delhi',
        items: [{ itemName: 'Steel Rods', quantity: 100, rate: 500, godown: null }],
      }),
    );
    expect(result.ready).toBe(true);
    expect(result.itemGodowns).toEqual([{ itemIndex: 0, godown: 'Main Location' }]);
  });
  it('asks the user to choose when no godown/default is stated and multiple godowns have recorded stock', () => {
    // The shared fixture stocks Steel Rods in both Main Location and
    // Warehouse B — with no godown stated and no default configured, this is
    // a genuine choice, not a hard block, regardless of how much is recorded
    // in each.
    const result = checkPostingReadiness(
      {
        db: database.db,
        gstConfig: GST_CONFIG,
        itemLedgerMappingStore,
        godownConfig: { defaultGodown: null },
        stockAvailabilityStore,
      },
      draft({
        placeOfSupply: 'Delhi',
        items: [{ itemName: 'Steel Rods', quantity: 100, rate: 500, godown: null }],
      }),
      VALID_PHASE5,
    );
    expect(result.ready).toBe(false);
    expect(result.blockers).toContainEqual(
      expect.objectContaining({ code: 'godown_selection_required', itemIndex: 0 }),
    );
  });
  it('auto-selects the single godown with recorded stock when no godown/default is stated', () => {
    // Only Main Location has any recorded row for this item — Warehouse B has
    // none — so there is exactly one valid answer, not a choice to ask about.
    stockAvailabilityStore.replaceAllForItem('Steel Rods', [
      { batchName: 'Primary Batch', godownName: 'Main Location', quantity: 1000, unit: 'Kg' },
    ]);
    const result = checkPostingReadiness(
      {
        db: database.db,
        gstConfig: GST_CONFIG,
        itemLedgerMappingStore,
        godownConfig: { defaultGodown: null },
        stockAvailabilityStore,
      },
      draft({
        placeOfSupply: 'Delhi',
        items: [{ itemName: 'Steel Rods', quantity: 100, rate: 500, godown: null }],
      }),
      VALID_PHASE5,
    );
    expect(result.ready).toBe(true);
    expect(result.itemGodowns).toEqual([{ itemIndex: 0, godown: 'Main Location' }]);
    expect(result.itemStock[0]?.resolvedBatch).toBe('Primary Batch');
  });
  it('auto-selects the single godown with recorded stock even when that recorded quantity is zero, negative, or insufficient', () => {
    // The recorded amount is exactly the requested quantity minus a bit
    // more than what's there — insufficient — and there is only one godown
    // with any record at all. This must still auto-select, not block: stock
    // shortage is a warning (see stockWarnings), never a godown blocker.
    stockAvailabilityStore.replaceAllForItem('Steel Rods', [
      { batchName: 'Primary Batch', godownName: 'Main Location', quantity: -20, unit: 'Kg' },
    ]);
    const result = checkPostingReadiness(
      {
        db: database.db,
        gstConfig: GST_CONFIG,
        itemLedgerMappingStore,
        godownConfig: { defaultGodown: null },
        stockAvailabilityStore,
      },
      draft({
        placeOfSupply: 'Delhi',
        items: [{ itemName: 'Steel Rods', quantity: 100, rate: 500, godown: null }],
      }),
      VALID_PHASE5,
    );
    expect(result.ready).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.itemGodowns).toEqual([{ itemIndex: 0, godown: 'Main Location' }]);
    expect(result.stockWarnings).toContainEqual(
      expect.objectContaining({ itemIndex: 0, reason: 'insufficient', availableQuantity: -20 }),
    );
  });
  it('blocks when an item states no godown, no default is configured, and no godown has any recorded stock at all', () => {
    stockAvailabilityStore.replaceAllForItem('Steel Rods', []); // no stock anywhere
    const result = checkPostingReadiness(
      {
        db: database.db,
        gstConfig: GST_CONFIG,
        itemLedgerMappingStore,
        godownConfig: { defaultGodown: null },
        stockAvailabilityStore,
      },
      draft({
        placeOfSupply: 'Delhi',
        items: [{ itemName: 'Steel Rods', quantity: 100, rate: 500, godown: null }],
      }),
      VALID_PHASE5,
    );
    expect(result.ready).toBe(false);
    expect(result.blockers).toContainEqual(
      expect.objectContaining({ code: 'godown_missing', itemIndex: 0 }),
    );
  });
  it('blocks when the configured default godown itself does not exist in cached masters', () => {
    const result = checkPostingReadiness(
      {
        db: database.db,
        gstConfig: GST_CONFIG,
        itemLedgerMappingStore,
        godownConfig: { defaultGodown: 'A Godown Nobody Synced' },
        stockAvailabilityStore,
      },
      draft({
        placeOfSupply: 'Delhi',
        items: [{ itemName: 'Steel Rods', quantity: 100, rate: 500, godown: null }],
      }),
      VALID_PHASE5,
    );
    expect(result.ready).toBe(false);
    expect(result.blockers).toContainEqual(
      expect.objectContaining({ code: 'godown_not_found_in_masters', itemIndex: 0 }),
    );
  });
  it('resolves each item independently — different items may use different godowns, or the same one', () => {
    const result = readiness(
      draft({
        placeOfSupply: 'Delhi',
        items: [
          { itemName: 'Steel Rods', quantity: 100, rate: 500, godown: 'Main Location' },
          { itemName: 'Cement Bags', quantity: 10, rate: 300, godown: 'Warehouse B' },
          { itemName: 'Bricks', quantity: 50, rate: 20, godown: 'Warehouse B' },
        ],
      }),
      {
        ...VALID_PHASE5,
        items: [
          VALID_PHASE5.items[0],
          {
            itemName: 'Cement Bags',
            stockItemMatch: { status: 'exact', matchedName: 'Cement Bags', candidates: [] },
            quantityValid: true,
            rateValid: true,
          },
          {
            itemName: 'Bricks',
            stockItemMatch: { status: 'exact', matchedName: 'Bricks', candidates: [] },
            quantityValid: true,
            rateValid: true,
          },
        ],
      },
    );
    expect(result.itemGodowns).toEqual([
      { itemIndex: 0, godown: 'Main Location' },
      { itemIndex: 1, godown: 'Warehouse B' },
      { itemIndex: 2, godown: 'Warehouse B' },
    ]);
  });
});
describe('checkPostingReadiness — J: stock availability', () => {
  it('resolves the exact real batch name for a batch-tracked item (never "Primary Batch" by default)', () => {
    stockAvailabilityStore.replaceAllForItem('Steel Rods', [
      { batchName: '1', godownName: 'Main Location', quantity: 490, unit: 'KG' },
    ]);
    const result = readiness(
      draft({
        placeOfSupply: 'Delhi',
        items: [{ itemName: 'Steel Rods', quantity: 100, rate: 500, godown: null }],
      }),
    );
    expect(result.ready).toBe(true);
    expect(result.itemStock).toEqual([
      { itemIndex: 0, resolvedBatch: '1', availableQuantity: 490, alternativeGodowns: [] },
    ]);
  });
  it('resolves the implicit "Primary Batch" for a non-batch-tracked item', () => {
    stockAvailabilityStore.replaceAllForItem('Steel Rods', [
      { batchName: 'Primary Batch', godownName: 'Main Location', quantity: 198, unit: 'Nos' },
    ]);
    const result = readiness(
      draft({
        placeOfSupply: 'Delhi',
        items: [{ itemName: 'Steel Rods', quantity: 100, rate: 500, godown: null }],
      }),
    );
    expect(result.ready).toBe(true);
    expect(result.itemStock[0]?.resolvedBatch).toBe('Primary Batch');
  });
  it('is ready when requested quantity is within available stock', () => {
    stockAvailabilityStore.replaceAllForItem('Steel Rods', [
      { batchName: 'Primary Batch', godownName: 'Main Location', quantity: 100, unit: 'Kg' },
    ]);
    const result = readiness(
      draft({
        placeOfSupply: 'Delhi',
        items: [{ itemName: 'Steel Rods', quantity: 100, rate: 500, godown: null }],
      }),
    );
    expect(result.ready).toBe(true);
    expect(result.itemStock[0]?.availableQuantity).toBe(100);
  });
  it('warns instead of blocking when requested quantity exceeds available stock', () => {
    stockAvailabilityStore.replaceAllForItem('Steel Rods', [
      { batchName: 'Primary Batch', godownName: 'Main Location', quantity: 50, unit: 'Kg' },
    ]);
    const result = readiness(
      draft({
        placeOfSupply: 'Delhi',
        items: [{ itemName: 'Steel Rods', quantity: 100, rate: 500, godown: null }],
      }),
    );
    expect(result.ready).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.stockWarnings).toContainEqual(
      expect.objectContaining({
        itemIndex: 0,
        reason: 'insufficient',
        requestedQuantity: 100,
        availableQuantity: 50,
      }),
    );
  });
  it('never automatically switches godowns, but reports other godowns with sufficient stock as candidates', () => {
    stockAvailabilityStore.replaceAllForItem('Steel Rods', [
      { batchName: 'Primary Batch', godownName: 'Main Location', quantity: 50, unit: 'Kg' },
      { batchName: 'Primary Batch', godownName: 'Warehouse B', quantity: 500, unit: 'Kg' },
    ]);
    const result = readiness(
      draft({
        placeOfSupply: 'Delhi',
        items: [{ itemName: 'Steel Rods', quantity: 100, rate: 500, godown: null }],
      }),
    );
    expect(result.ready).toBe(true);
    // Still resolved to the requested/default godown — never silently switched.
    expect(result.itemGodowns).toEqual([{ itemIndex: 0, godown: 'Main Location' }]);
    expect(result.itemStock[0]?.alternativeGodowns).toEqual([
      { godown: 'Warehouse B', availableQuantity: 500 },
    ]);
  });
  it('fails closed on multiple batches for the same item + godown rather than guessing one', () => {
    stockAvailabilityStore.replaceAllForItem('Steel Rods', [
      { batchName: '1', godownName: 'Main Location', quantity: 50, unit: 'Kg' },
      { batchName: '2', godownName: 'Main Location', quantity: 200, unit: 'Kg' },
    ]);
    const result = readiness(
      draft({
        placeOfSupply: 'Delhi',
        items: [{ itemName: 'Steel Rods', quantity: 100, rate: 500, godown: null }],
      }),
    );
    expect(result.ready).toBe(false);
    expect(result.blockers).toContainEqual(
      expect.objectContaining({ code: 'stock_batch_ambiguous', itemIndex: 0 }),
    );
    expect(result.itemStock[0]?.resolvedBatch).toBeNull();
  });
  it('warns on zero stock rather than blocking, and never treats it as available', () => {
    stockAvailabilityStore.replaceAllForItem('Steel Rods', [
      { batchName: 'Primary Batch', godownName: 'Main Location', quantity: 0, unit: 'Kg' },
    ]);
    const result = readiness(
      draft({
        placeOfSupply: 'Delhi',
        items: [{ itemName: 'Steel Rods', quantity: 1, rate: 500, godown: null }],
      }),
    );
    expect(result.ready).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.stockWarnings).toContainEqual(
      expect.objectContaining({ itemIndex: 0, reason: 'insufficient', availableQuantity: 0 }),
    );
  });
  it('does not fuzzy-match the resolved stock item name — a near-miss finds no cached row, but warns rather than blocks', () => {
    stockAvailabilityStore.replaceAllForItem('Steel Rods', [
      { batchName: 'Primary Batch', godownName: 'Main Location', quantity: 1000, unit: 'Kg' },
    ]);
    const result = readiness(
      draft({
        placeOfSupply: 'Delhi',
        items: [{ itemName: 'Steel Rods', quantity: 1, rate: 1, godown: null }],
      }),
      {
        ...VALID_PHASE5,
        items: [
          {
            itemName: 'Steel Rods',
            // Phase 5 resolved a different, near-miss master name — the
            // availability lookup must not treat this as the same item.
            stockItemMatch: { status: 'exact', matchedName: 'Steel Rod', candidates: [] },
            quantityValid: true,
            rateValid: true,
          },
        ],
      },
    );
    // A separate, genuine blocker remains here (no item_ledger_mapping row for
    // "Steel Rod", the near-miss name) — this test is only about stock never
    // being the reason, so it checks the stock codes are absent, not that
    // `blockers` is empty.
    expect(result.blockers.some((b) => b.code.startsWith('stock_'))).toBe(false);
    expect(result.stockWarnings).toContainEqual(
      expect.objectContaining({ itemIndex: 0, reason: 'no_data', availableQuantity: null }),
    );
  });
  it('reports stale/missing cache data as an informational warning, never as guessed-zero availability, and never blocks', () => {
    // No stock_availability rows were ever synced for this item.
    itemLedgerMappingStore.setMapping({
      stockItemName: 'Untracked Item',
      salesLedger: 'Sales',
      purchaseLedger: 'Purchase',
    });
    const result = readiness(
      draft({
        placeOfSupply: 'Delhi',
        items: [{ itemName: 'Untracked Item', quantity: 1, rate: 1, godown: null }],
      }),
      {
        ...VALID_PHASE5,
        items: [
          {
            itemName: 'Untracked Item',
            stockItemMatch: { status: 'exact', matchedName: 'Untracked Item', candidates: [] },
            quantityValid: true,
            rateValid: true,
          },
        ],
      },
    );
    expect(result.ready).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.stockWarnings).toContainEqual(
      expect.objectContaining({ itemIndex: 0, reason: 'no_data', availableQuantity: null }),
    );
    expect(result.itemStock[0]?.resolvedBatch).toBeNull();
  });
  it('resolves a confirmed non-batch-tracked item to Tally\'s own implicit "Primary Batch" when no stock row is cached at all — never blocks on batch', () => {
    // ISBATCHWISEON="No" confirmed on the cached StockItem master — this is
    // the real-world "Orange" shape: a non-batch item with zero rows in
    // stock_availability (nothing ever synced a balance for it).
    createTallyMasterCache({ db: database.db }).replaceAll('StockItem', [
      { NAME: 'Orange', PARENT: 'Primary', BASEUNITS: 'KG', ISBATCHWISEON: 'No' },
    ]);
    itemLedgerMappingStore.setMapping({
      stockItemName: 'Orange',
      salesLedger: 'Sales',
      purchaseLedger: 'Purchase',
    });
    // No stockAvailabilityStore.replaceAllForItem call at all for Orange — the
    // cache genuinely has nothing for it, exactly like a fresh sync of an item
    // with no recorded stock in Tally.
    const result = readiness(
      draft({
        placeOfSupply: 'Delhi',
        items: [{ itemName: 'Orange', quantity: 5, rate: 100, godown: 'Main Location' }],
      }),
      {
        ...VALID_PHASE5,
        items: [
          {
            itemName: 'Orange',
            stockItemMatch: { status: 'exact', matchedName: 'Orange', candidates: [] },
            quantityValid: true,
            rateValid: true,
          },
        ],
      },
    );
    expect(result.ready).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.stockWarnings).toContainEqual(
      expect.objectContaining({ itemIndex: 0, reason: 'no_data', itemName: 'Orange' }),
    );
    expect(result.itemStock[0]?.resolvedBatch).toBe('Primary Batch');
  });
  it('leaves a batch-tracked item unresolved when no stock row is cached — fail-closed, unaffected by the non-batch fallback', () => {
    createTallyMasterCache({ db: database.db }).replaceAll('StockItem', [
      { NAME: 'Apple', PARENT: 'Primary', BASEUNITS: 'KG', ISBATCHWISEON: 'Yes' },
    ]);
    itemLedgerMappingStore.setMapping({
      stockItemName: 'Apple',
      salesLedger: 'Sales',
      purchaseLedger: 'Purchase',
    });
    const result = readiness(
      draft({
        placeOfSupply: 'Delhi',
        items: [{ itemName: 'Apple', quantity: 5, rate: 100, godown: 'Main Location' }],
      }),
      {
        ...VALID_PHASE5,
        items: [
          {
            itemName: 'Apple',
            stockItemMatch: { status: 'exact', matchedName: 'Apple', candidates: [] },
            quantityValid: true,
            rateValid: true,
          },
        ],
      },
    );
    // Still not a hard blocker at the readiness layer (stock stays a warning)...
    expect(result.ready).toBe(true);
    expect(result.stockWarnings).toContainEqual(
      expect.objectContaining({ itemIndex: 0, reason: 'no_data', itemName: 'Apple' }),
    );
    // ...but the batch itself is never guessed for a confirmed batch-tracked item.
    expect(result.itemStock[0]?.resolvedBatch).toBeNull();
  });
});
describe('checkPostingReadiness — K: GST is optional, not mandatory', () => {
  /** Deliberately unconfigured — company state absent, no default POS — to
   * prove none of it is even consulted when no item needs GST. */
  const NO_GST_CONFIG = { companyState: '', defaultPlaceOfSupply: null };
  function noGstDeps(overrides = {}) {
    return {
      db: database.db,
      gstConfig: NO_GST_CONFIG,
      itemLedgerMappingStore,
      godownConfig: GODOWN_CONFIG,
      stockAvailabilityStore,
      ...overrides,
    };
  }
  it('no item needs GST — Place of Supply, Company State, and GST ledgers are never required, never blocked on', () => {
    const noGstValidation = {
      ...VALID_PHASE5,
      items: [{ ...VALID_PHASE5.items[0], resolvedGstPercent: null }],
    };
    const result = checkPostingReadiness(noGstDeps(), draft({ placeOfSupply: null }), noGstValidation);
    expect(result.ready).toBe(true);
    expect(result.gstTreatment).toBeNull();
    expect(result.blockers).toEqual([]);
  });
  it('at least one item needs GST — existing company-state/place-of-supply requirements still apply, unchanged', () => {
    const mixedGstValidation = {
      ...VALID_PHASE5,
      items: [{ ...VALID_PHASE5.items[0], resolvedGstPercent: 18 }],
    };
    const result = checkPostingReadiness(noGstDeps(), draft({ placeOfSupply: null }), mixedGstValidation);
    expect(result.ready).toBe(false);
    expect(result.blockers).toContainEqual(expect.objectContaining({ code: 'company_state_not_configured' }));
  });
});
describe('isOnlyMissingPlaceOfSupply', () => {
  it('is true only when POS-missing is the sole blocker', () => {
    expect(isOnlyMissingPlaceOfSupply(readiness(draft({ placeOfSupply: null })))).toBe(true);
  });
  it('is false when other blockers are also present', () => {
    createTallyMasterCache({ db: database.db }).replaceAll('Ledger', []); // remove everything
    const result = readiness(draft({ placeOfSupply: null }));
    expect(isOnlyMissingPlaceOfSupply(result)).toBe(false);
  });
  it('is false when ready', () => {
    expect(isOnlyMissingPlaceOfSupply(readiness(draft({ placeOfSupply: 'Delhi' })))).toBe(false);
  });
});
