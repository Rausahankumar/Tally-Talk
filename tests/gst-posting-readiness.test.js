import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ledgerExistsExact } from '../src/gst/ledgerExistence.js';
import { createItemLedgerMappingStore } from '../src/gst/itemLedgerMapping.js';
import { checkPostingReadiness, isOnlyMissingPlaceOfSupply } from '../src/gst/postingReadiness.js';
import { godownExistsExact } from '../src/tally/godownExistence.js';
import { createTallyMasterCache } from '../src/tally/cache.js';
import { createStockAvailabilityCache } from '../src/tally/stockAvailabilityCache.js';
import { createTestDatabase } from './helpers/testDatabase.js';
const GST_CONFIG = {
  companyState: 'Delhi',
  cgstLedger: 'CGST',
  sgstLedger: 'SGST',
  igstLedger: 'IGST',
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
    { NAME: 'CGST', PARENT: 'Duties & Taxes' },
    { NAME: 'SGST', PARENT: 'Duties & Taxes' },
    { NAME: 'IGST', PARENT: 'Duties & Taxes' },
    { NAME: 'Sales', PARENT: 'Sales Accounts' },
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
  it('blocks when an item states no godown and no default is configured', () => {
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
  it('blocks when requested quantity exceeds available stock', () => {
    stockAvailabilityStore.replaceAllForItem('Steel Rods', [
      { batchName: 'Primary Batch', godownName: 'Main Location', quantity: 50, unit: 'Kg' },
    ]);
    const result = readiness(
      draft({
        placeOfSupply: 'Delhi',
        items: [{ itemName: 'Steel Rods', quantity: 100, rate: 500, godown: null }],
      }),
    );
    expect(result.ready).toBe(false);
    expect(result.blockers).toContainEqual(
      expect.objectContaining({ code: 'stock_insufficient', itemIndex: 0 }),
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
    expect(result.ready).toBe(false);
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
  it('blocks on zero stock rather than treating it as available', () => {
    stockAvailabilityStore.replaceAllForItem('Steel Rods', [
      { batchName: 'Primary Batch', godownName: 'Main Location', quantity: 0, unit: 'Kg' },
    ]);
    const result = readiness(
      draft({
        placeOfSupply: 'Delhi',
        items: [{ itemName: 'Steel Rods', quantity: 1, rate: 500, godown: null }],
      }),
    );
    expect(result.ready).toBe(false);
    expect(result.blockers).toContainEqual(
      expect.objectContaining({ code: 'stock_insufficient', itemIndex: 0 }),
    );
  });
  it('does not fuzzy-match the resolved stock item name — a near-miss finds no cached row', () => {
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
    expect(result.ready).toBe(false);
    expect(result.blockers).toContainEqual(
      expect.objectContaining({ code: 'stock_data_missing', itemIndex: 0 }),
    );
  });
  it('reports stale/missing cache data as a blocker, never as guessed-zero availability', () => {
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
    expect(result.ready).toBe(false);
    expect(result.blockers).toContainEqual(
      expect.objectContaining({ code: 'stock_data_missing', itemIndex: 0 }),
    );
    expect(result.itemStock[0]?.resolvedBatch).toBeNull();
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
