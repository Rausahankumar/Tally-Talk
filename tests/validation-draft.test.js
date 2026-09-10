import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createItemLedgerMappingStore } from '../src/gst/itemLedgerMapping.js';
import { createTallyMasterCache } from '../src/tally/cache.js';
import { validateTransactionDraft } from '../src/validation/validateDraft.js';
import { createTestDatabase } from './helpers/testDatabase.js';
let database;
let cache;
beforeEach(() => {
  database = createTestDatabase();
  cache = createTallyMasterCache({ db: database.db });
  cache.replaceAll('Ledger', [
    // Sales parties are Sundry Creditors, purchase parties are Sundry
    // Debtors under this deployment's corrected voucher-type/group mapping
    // (see masterLookup.js). "Ramesh Kumar Enterprises"/"Ramesh Traders"
    // serve the purchase-voucher tests below; "Ramesh Exports"/"Ramesh
    // Imports" are a separate pair serving the sales-ambiguity test, so
    // neither scenario's fixture depends on the other's group.
    { NAME: 'Ramesh Kumar Enterprises', PARENT: 'Sundry Debtors' },
    { NAME: 'Ramesh Traders', PARENT: 'Sundry Debtors' },
    { NAME: 'Ramesh Exports', PARENT: 'Sundry Creditors' },
    { NAME: 'Ramesh Imports', PARENT: 'Sundry Creditors' },
    { NAME: 'Suresh & Sons', PARENT: 'Sundry Creditors' },
    { NAME: 'Balaji Retail Store', PARENT: 'Sundry Creditors' },
  ]);
  cache.replaceAll('StockItem', [
    { NAME: 'ACC Cement OPC 43 Grade', PARENT: 'Building Materials', BASEUNITS: 'Bags' },
    { NAME: 'Cement Bags', PARENT: 'Building Materials', BASEUNITS: 'Bags' },
    { NAME: 'Steel Rods', PARENT: 'Building Materials', BASEUNITS: 'Kg' },
  ]);
  cache.replaceAll('VoucherType', [
    { NAME: 'Sales', PARENT: '' },
    { NAME: 'Purchase', PARENT: '' },
    { NAME: 'Payment', PARENT: '' },
  ]);
});
afterEach(() => {
  database.close();
});
/** A draft with every field filled in and known to resolve cleanly. */
function validDraft(overrides = {}) {
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
describe('validateTransactionDraft - a fully valid draft', () => {
  it('passes with no issues', () => {
    const result = validateTransactionDraft(database.db, validDraft());
    expect(result.isValid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.voucherTypeValid).toBe(true);
    expect(result.partyMatch).toEqual({
      status: 'exact',
      matchedName: 'Suresh & Sons',
      candidates: [],
    });
    expect(result.gstPercentValid).toBe(true);
    expect(result.items[0]?.stockItemMatch.status).toBe('exact');
    expect(result.items[0]?.quantityValid).toBe(true);
    expect(result.items[0]?.rateValid).toBe(true);
  });
  it('accepts a purchase voucher the same way', () => {
    const result = validateTransactionDraft(
      database.db,
      validDraft({ voucherType: 'purchase', partyName: 'Ramesh Kumar Enterprises' }),
    );
    expect(result.isValid).toBe(true);
  });
  it('leaves parsedDate null and raises no issue when the draft has no date', () => {
    const result = validateTransactionDraft(database.db, validDraft());
    expect(result.parsedDate).toBeNull();
    expect(result.issues).toEqual([]);
  });
});
describe('validateTransactionDraft - explicit date', () => {
  it('parses an explicit ISO date into the corresponding calendar date', () => {
    const result = validateTransactionDraft(database.db, validDraft({ date: '2026-09-01' }));
    expect(result.isValid).toBe(true);
    expect(result.parsedDate).toEqual(new Date(2026, 8, 1));
  });
  it('rejects a date that does not correspond to a real calendar day', () => {
    const result = validateTransactionDraft(database.db, validDraft({ date: '2026-02-30' }));
    expect(result.isValid).toBe(false);
    expect(result.parsedDate).toBeNull();
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'invalid_date' }),
    );
  });
});
describe('validateTransactionDraft - exact matches', () => {
  it('resolves an exact ledger match', () => {
    const result = validateTransactionDraft(
      database.db,
      validDraft({ partyName: 'Balaji Retail Store' }),
    );
    expect(result.partyMatch?.status).toBe('exact');
    expect(result.partyMatch?.matchedName).toBe('Balaji Retail Store');
  });
  it('resolves an exact stock item match', () => {
    const result = validateTransactionDraft(
      database.db,
      validDraft({ items: [{ itemName: 'Cement Bags', quantity: 10, rate: 400, godown: null }] }),
    );
    expect(result.items[0]?.stockItemMatch).toEqual({
      status: 'exact',
      matchedName: 'Cement Bags',
      candidates: [],
    });
  });
});
describe('validateTransactionDraft - required fields', () => {
  it('flags a missing party name regardless of what the LLM self-reported', () => {
    const result = validateTransactionDraft(
      database.db,
      // The model claims nothing is missing, but partyName is null anyway -
      // the backend must not trust that self-report.
      validDraft({ partyName: null, missingFields: [] }),
    );
    expect(result.isValid).toBe(false);
    expect(result.partyMatch).toBeNull();
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'missing_party_name' }));
  });
  it('flags an empty items array', () => {
    const result = validateTransactionDraft(database.db, validDraft({ items: [] }));
    expect(result.isValid).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'missing_items' }));
  });
  it('flags a missing GST percent', () => {
    const result = validateTransactionDraft(database.db, validDraft({ gstPercent: null }));
    expect(result.gstPercentValid).toBe(false);
    expect(result.resolvedGstPercent).toBeNull();
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'missing_gst_percent' }));
  });
});
describe('validateTransactionDraft - unknown masters', () => {
  it('reports party_not_found for a ledger that does not exist', () => {
    const result = validateTransactionDraft(
      database.db,
      validDraft({ partyName: 'Totally Unknown Traders' }),
    );
    expect(result.isValid).toBe(false);
    expect(result.partyMatch?.status).toBe('not_found');
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'party_not_found' }));
  });
  it('reports stock_item_not_found for an item that does not exist', () => {
    const result = validateTransactionDraft(
      database.db,
      validDraft({
        items: [{ itemName: 'Unobtainium Ingots', quantity: 1, rate: 1, godown: null }],
      }),
    );
    expect(result.isValid).toBe(false);
    expect(result.items[0]?.stockItemMatch.status).toBe('not_found');
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'stock_item_not_found', itemIndex: 0 }),
    );
  });
});
describe('validateTransactionDraft - fuzzy matching', () => {
  it('resolves a fuzzy party match and still counts the draft valid', () => {
    const result = validateTransactionDraft(
      database.db,
      validDraft({ partyName: 'Balaji Retial Store' }),
    );
    expect(result.partyMatch).toEqual({
      status: 'fuzzy',
      matchedName: 'Balaji Retail Store',
      candidates: [],
    });
    expect(result.isValid).toBe(true);
  });
  it('resolves a fuzzy stock item match for a short name against a long real one', () => {
    const result = validateTransactionDraft(
      database.db,
      validDraft({ items: [{ itemName: 'Steel Rod', quantity: 5, rate: 50, godown: null }] }),
    );
    expect(result.items[0]?.stockItemMatch.status).toBe('fuzzy');
  });
});
describe('validateTransactionDraft - ambiguous matches', () => {
  it('reports party_ambiguous instead of guessing between two similar ledgers', () => {
    const result = validateTransactionDraft(database.db, validDraft({ partyName: 'Ramesh' }));
    expect(result.isValid).toBe(false);
    expect(result.partyMatch?.status).toBe('ambiguous');
    const issue = result.issues.find((i) => i.code === 'party_ambiguous');
    expect(issue?.candidates).toEqual(expect.arrayContaining(['Ramesh Exports', 'Ramesh Imports']));
  });
  it('reports stock_item_ambiguous instead of guessing between two similar items', () => {
    const result = validateTransactionDraft(
      database.db,
      validDraft({ items: [{ itemName: 'Cement', quantity: 10, rate: 400, godown: null }] }),
    );
    expect(result.isValid).toBe(false);
    expect(result.items[0]?.stockItemMatch.status).toBe('ambiguous');
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'stock_item_ambiguous', itemIndex: 0 }),
    );
  });
  it('never returns the whole master list as candidates', () => {
    const result = validateTransactionDraft(database.db, validDraft({ partyName: 'Ramesh' }));
    const issue = result.issues.find((i) => i.code === 'party_ambiguous');
    expect(issue?.candidates?.length ?? 0).toBeLessThan(4); // fewer than the full ledger cache
  });
});
describe('validateTransactionDraft - quantity and rate', () => {
  it('flags an invalid (zero) quantity', () => {
    const result = validateTransactionDraft(
      database.db,
      validDraft({ items: [{ itemName: 'Steel Rods', quantity: 0, rate: 500, godown: null }] }),
    );
    expect(result.isValid).toBe(false);
    expect(result.items[0]?.quantityValid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'invalid_quantity', itemIndex: 0 }),
    );
  });
  it('flags a negative quantity', () => {
    const result = validateTransactionDraft(
      database.db,
      validDraft({ items: [{ itemName: 'Steel Rods', quantity: -5, rate: 500, godown: null }] }),
    );
    expect(result.items[0]?.quantityValid).toBe(false);
  });
  it('flags an invalid (negative) rate', () => {
    const result = validateTransactionDraft(
      database.db,
      validDraft({ items: [{ itemName: 'Steel Rods', quantity: 100, rate: -500, godown: null }] }),
    );
    expect(result.isValid).toBe(false);
    expect(result.items[0]?.rateValid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'invalid_rate', itemIndex: 0 }),
    );
  });
  it('flags a missing quantity distinctly from an invalid one', () => {
    const result = validateTransactionDraft(
      database.db,
      validDraft({ items: [{ itemName: 'Steel Rods', quantity: null, rate: 500, godown: null }] }),
    );
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'missing_quantity', itemIndex: 0 }),
    );
  });
});
describe('validateTransactionDraft - voucher type', () => {
  it('rejects "unknown" as an unsupported voucher type', () => {
    const result = validateTransactionDraft(database.db, validDraft({ voucherType: 'unknown' }));
    expect(result.isValid).toBe(false);
    expect(result.voucherTypeValid).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'invalid_voucher_type' }));
  });
  it('flags a voucher type whose Tally master does not exist', () => {
    cache.replaceAll('VoucherType', [{ NAME: 'Payment', PARENT: '' }]); // no "Sales" master
    const result = validateTransactionDraft(database.db, validDraft({ voucherType: 'sales' }));
    expect(result.isValid).toBe(false);
    expect(result.voucherTypeValid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'voucher_type_master_not_found' }),
    );
  });
});
describe('validateTransactionDraft - GST rate', () => {
  it('flags a GST rate that is not a recognised slab', () => {
    const result = validateTransactionDraft(database.db, validDraft({ gstPercent: 15 }));
    expect(result.isValid).toBe(false);
    expect(result.gstPercentValid).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'invalid_gst_percent' }));
  });
  it('accepts every documented GST slab as valid', () => {
    for (const rate of [0, 5, 12, 18, 28]) {
      const result = validateTransactionDraft(database.db, validDraft({ gstPercent: rate }));
      expect(result.gstPercentValid).toBe(true);
    }
  });
});
describe('validateTransactionDraft - resolving rate/GST from trusted configuration', () => {
  let itemLedgerMappingStore;
  beforeEach(() => {
    itemLedgerMappingStore = createItemLedgerMappingStore(database.db);
  });
  it('leaves rate/GST unresolved (and asks) when no mapping store is passed at all — existing callers unaffected', () => {
    const result = validateTransactionDraft(
      database.db,
      validDraft({ items: [{ itemName: 'Steel Rods', quantity: 10, rate: null, godown: null }], gstPercent: null }),
    );
    expect(result.items[0]?.resolvedRate).toBeNull();
    expect(result.resolvedGstPercent).toBeNull();
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'missing_rate' }));
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'missing_gst_percent' }));
  });
  it('resolves a missing rate from the trusted per-item mapping', () => {
    itemLedgerMappingStore.setMapping({
      stockItemName: 'Steel Rods',
      salesLedger: 'Sales',
      purchaseLedger: 'Purchase',
      salesRate: 550,
    });
    const result = validateTransactionDraft(
      database.db,
      validDraft({ items: [{ itemName: 'Steel Rods', quantity: 10, rate: null, godown: null }] }),
      itemLedgerMappingStore,
    );
    expect(result.items[0]?.rateValid).toBe(true);
    expect(result.items[0]?.resolvedRate).toBe(550);
    expect(result.resolvedDraft.items[0]?.rate).toBe(550);
    expect(result.issues.some((i) => i.code === 'missing_rate')).toBe(false);
  });
  it('an explicitly stated rate overrides the configured default', () => {
    itemLedgerMappingStore.setMapping({
      stockItemName: 'Steel Rods',
      salesLedger: 'Sales',
      purchaseLedger: 'Purchase',
      salesRate: 550,
    });
    const result = validateTransactionDraft(
      database.db,
      validDraft({ items: [{ itemName: 'Steel Rods', quantity: 10, rate: 700, godown: null }] }),
      itemLedgerMappingStore,
    );
    expect(result.items[0]?.resolvedRate).toBe(700);
    expect(result.resolvedDraft.items[0]?.rate).toBe(700);
  });
  it('does not invent a rate when neither stated nor configured', () => {
    itemLedgerMappingStore.setMapping({
      stockItemName: 'Steel Rods',
      salesLedger: 'Sales',
      purchaseLedger: 'Purchase',
      // no salesRate configured
    });
    const result = validateTransactionDraft(
      database.db,
      validDraft({ items: [{ itemName: 'Steel Rods', quantity: 10, rate: null, godown: null }] }),
      itemLedgerMappingStore,
    );
    expect(result.items[0]?.rateValid).toBe(false);
    expect(result.items[0]?.resolvedRate).toBeNull();
    expect(result.resolvedDraft.items[0]?.rate).toBeNull();
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'missing_rate' }));
  });
  it('resolves a missing GST percent from the trusted per-item mapping', () => {
    itemLedgerMappingStore.setMapping({
      stockItemName: 'Steel Rods',
      salesLedger: 'Sales',
      purchaseLedger: 'Purchase',
      gstPercent: 18,
    });
    const result = validateTransactionDraft(
      database.db,
      validDraft({ gstPercent: null }),
      itemLedgerMappingStore,
    );
    expect(result.gstPercentValid).toBe(true);
    expect(result.resolvedGstPercent).toBe(18);
    expect(result.resolvedDraft.gstPercent).toBe(18);
    expect(result.issues.some((i) => i.code === 'missing_gst_percent')).toBe(false);
  });
  it('an explicitly stated GST percent is validated, not silently replaced by a configured default', () => {
    itemLedgerMappingStore.setMapping({
      stockItemName: 'Steel Rods',
      salesLedger: 'Sales',
      purchaseLedger: 'Purchase',
      gstPercent: 12,
    });
    const result = validateTransactionDraft(
      database.db,
      validDraft({ gstPercent: 18 }),
      itemLedgerMappingStore,
    );
    expect(result.resolvedGstPercent).toBe(18);
    expect(result.resolvedDraft.gstPercent).toBe(18);
  });
});
describe('validateTransactionDraft - resolving rate/GST from Tally-cached history', () => {
  // Real numbers, captured live against this project's own TallyPrime
  // instance (see tests/fixtures/tally/stockitem-gst-pricing-response.xml
  // for the raw XML these were parsed from) — never invented for this test.
  const ORANGE_GST_HISTORY = [
    { applicableFrom: '2025-04-01', states: [{ state: 'Any', cgst: 9, sgst: 9, igst: 18 }] },
  ];
  const ORANGE_PRICE_HISTORY = [{ date: '2026-04-01', rate: 1000, unit: 'KG' }];
  function cacheOrange(overrides = {}) {
    cache.replaceAll('StockItem', [
      { NAME: 'ACC Cement OPC 43 Grade', PARENT: 'Building Materials', BASEUNITS: 'Bags' },
      { NAME: 'Cement Bags', PARENT: 'Building Materials', BASEUNITS: 'Bags' },
      { NAME: 'Steel Rods', PARENT: 'Building Materials', BASEUNITS: 'Kg' },
      {
        NAME: 'Orange',
        PARENT: 'Primary',
        BASEUNITS: 'KG',
        gstRateHistory: ORANGE_GST_HISTORY,
        standardPriceHistory: ORANGE_PRICE_HISTORY,
        ...overrides,
      },
    ]);
  }
  function orangeDraft(overrides = {}) {
    return validDraft({
      items: [{ itemName: 'Orange', quantity: 5, rate: null, godown: null }],
      gstPercent: null,
      date: '2026-09-01',
      ...overrides,
    });
  }
  it('resolves GST from Tally when neither explicit nor configured GST is present', () => {
    cacheOrange();
    const result = validateTransactionDraft(database.db, orangeDraft());
    expect(result.gstPercentValid).toBe(true);
    expect(result.resolvedGstPercent).toBe(18);
    expect(result.issues.some((i) => i.code === 'missing_gst_percent')).toBe(false);
  });
  it('chooses the correct effective-dated GST entry, ignoring an earlier one that no longer applies', () => {
    cacheOrange({
      gstRateHistory: [
        { applicableFrom: '2020-01-01', states: [{ state: 'Any', cgst: 2.5, sgst: 2.5, igst: 5 }] },
        { applicableFrom: '2025-04-01', states: [{ state: 'Any', cgst: 9, sgst: 9, igst: 18 }] },
      ],
    });
    const result = validateTransactionDraft(database.db, orangeDraft());
    expect(result.resolvedGstPercent).toBe(18);
  });
  it('ignores a future-dated GST entry — ie transaction date is before it takes effect', () => {
    cacheOrange({
      gstRateHistory: [{ applicableFrom: '2030-01-01', states: [{ state: 'Any', cgst: 9, sgst: 9, igst: 18 }] }],
    });
    const result = validateTransactionDraft(database.db, orangeDraft());
    expect(result.resolvedGstPercent).toBeNull();
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'missing_gst_percent' }));
  });
  it('fails closed on a GST record whose CGST+SGST does not equal IGST, rather than trusting either number', () => {
    cacheOrange({
      gstRateHistory: [
        { applicableFrom: '2025-04-01', states: [{ state: 'Any', cgst: 9, sgst: 9, igst: 12 }] },
      ],
    });
    const result = validateTransactionDraft(database.db, orangeDraft());
    expect(result.resolvedGstPercent).toBeNull();
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'missing_gst_percent' }));
  });
  it('resolves rate from Tally Standard Price when neither explicit nor configured rate is present', () => {
    cacheOrange();
    const result = validateTransactionDraft(database.db, orangeDraft());
    expect(result.items[0]?.rateValid).toBe(true);
    expect(result.items[0]?.resolvedRate).toBe(1000);
    expect(result.issues.some((i) => i.code === 'missing_rate')).toBe(false);
  });
  it('ignores a future-dated Standard Price entry', () => {
    cacheOrange({ standardPriceHistory: [{ date: '2030-01-01', rate: 1000, unit: 'KG' }] });
    const result = validateTransactionDraft(database.db, orangeDraft());
    expect(result.items[0]?.resolvedRate).toBeNull();
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'missing_rate' }));
  });
  it('an explicit rate beats both configured and Tally Standard Price', () => {
    cacheOrange();
    const store = createItemLedgerMappingStore(database.db);
    store.setMapping({ stockItemName: 'Orange', salesLedger: 'Sales', purchaseLedger: 'Purchase', salesRate: 100 });
    const result = validateTransactionDraft(
      database.db,
      orangeDraft({ items: [{ itemName: 'Orange', quantity: 5, rate: 100, godown: null }] }),
      store,
    );
    expect(result.items[0]?.resolvedRate).toBe(100);
  });
  it('a configured sales_rate beats Tally Standard Price — the ₹100 vs ₹1000 real-world case', () => {
    cacheOrange();
    const store = createItemLedgerMappingStore(database.db);
    store.setMapping({ stockItemName: 'Orange', salesLedger: 'Sales', purchaseLedger: 'Purchase', salesRate: 100 });
    const result = validateTransactionDraft(database.db, orangeDraft(), store);
    expect(result.items[0]?.resolvedRate).toBe(100); // not Tally's 1000
  });
  it('a configured gst_percent is still used when Tally has no GST record at all for the item', () => {
    cache.replaceAll('StockItem', [
      { NAME: 'Steel Rods', PARENT: 'Building Materials', BASEUNITS: 'Kg' }, // no gstRateHistory
    ]);
    const store = createItemLedgerMappingStore(database.db);
    store.setMapping({ stockItemName: 'Steel Rods', salesLedger: 'Sales', purchaseLedger: 'Purchase', gstPercent: 12 });
    const result = validateTransactionDraft(database.db, validDraft({ gstPercent: null }), store);
    expect(result.resolvedGstPercent).toBe(12);
  });
  it('Tally GST beats a configured gst_percent when both are available', () => {
    cacheOrange();
    const store = createItemLedgerMappingStore(database.db);
    store.setMapping({ stockItemName: 'Orange', salesLedger: 'Sales', purchaseLedger: 'Purchase', gstPercent: 5 });
    const result = validateTransactionDraft(database.db, orangeDraft(), store);
    expect(result.resolvedGstPercent).toBe(18); // Tally's rate, not the configured 5
  });
  it('existing missing-rate/missing-GST behaviour is unaffected for an item with no Tally history at all', () => {
    const result = validateTransactionDraft(
      database.db,
      validDraft({ items: [{ itemName: 'Steel Rods', quantity: 10, rate: null, godown: null }], gstPercent: null }),
    );
    expect(result.items[0]?.resolvedRate).toBeNull();
    expect(result.resolvedGstPercent).toBeNull();
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'missing_rate' }));
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'missing_gst_percent' }));
  });
});
describe('validateTransactionDraft - per-line GST resolution (mixed-rate vouchers)', () => {
  // Real numbers: Orange is 18% (see ORANGE_GST_HISTORY above), a shampoo
  // genuinely taxed at 5% is a different stock item entirely — this mirrors
  // the real "Orange 18% + Anti-Dandruff Shampoos 5%" case that motivated
  // per-line GST in the first place.
  const ORANGE_GST_HISTORY = [
    { applicableFrom: '2025-04-01', states: [{ state: 'Any', cgst: 9, sgst: 9, igst: 18 }] },
  ];
  const SHAMPOO_GST_HISTORY = [
    { applicableFrom: '2025-08-01', states: [{ state: 'Any', cgst: 2.5, sgst: 2.5, igst: 5 }] },
  ];
  function cacheOrangeAndShampoo() {
    cache.replaceAll('StockItem', [
      { NAME: 'ACC Cement OPC 43 Grade', PARENT: 'Building Materials', BASEUNITS: 'Bags' },
      { NAME: 'Cement Bags', PARENT: 'Building Materials', BASEUNITS: 'Bags' },
      { NAME: 'Steel Rods', PARENT: 'Building Materials', BASEUNITS: 'Kg' },
      { NAME: 'Orange', PARENT: 'Primary', BASEUNITS: 'KG', gstRateHistory: ORANGE_GST_HISTORY },
      {
        NAME: 'Anti-Dandruff Shampoos',
        PARENT: 'Primary',
        BASEUNITS: 'Nos',
        gstRateHistory: SHAMPOO_GST_HISTORY,
      },
    ]);
  }
  function mixedRateDraft(overrides = {}) {
    return validDraft({
      items: [
        { itemName: 'Orange', quantity: 5, rate: 1000, godown: null },
        { itemName: 'Anti-Dandruff Shampoos', quantity: 5, rate: 125, godown: null },
      ],
      gstPercent: null,
      date: '2026-09-01',
      ...overrides,
    });
  }
  it('1 & 3. two items with different Tally-derived GST rates each resolve their own rate, no forced single value', () => {
    cacheOrangeAndShampoo();
    const result = validateTransactionDraft(database.db, mixedRateDraft());
    expect(result.isValid).toBe(true);
    expect(result.items[0]?.gstPercentValid).toBe(true);
    expect(result.items[0]?.resolvedGstPercent).toBe(18);
    expect(result.items[1]?.gstPercentValid).toBe(true);
    expect(result.items[1]?.resolvedGstPercent).toBe(5);
    // Draft-level resolvedGstPercent cannot express two different values —
    // it stays null (never one item's rate silently applied to the other).
    expect(result.resolvedGstPercent).toBeNull();
    expect(result.issues.some((i) => i.code === 'missing_gst_percent')).toBe(false);
  });
  it('resolvedDraft carries each item\'s own resolved GST percent', () => {
    cacheOrangeAndShampoo();
    const result = validateTransactionDraft(database.db, mixedRateDraft());
    expect(result.resolvedDraft.items[0]?.gstPercent).toBe(18);
    expect(result.resolvedDraft.items[1]?.gstPercent).toBe(5);
  });
  it('2. two items that happen to share the same Tally-derived rate resolve identically to the pre-existing single-rate path', () => {
    cache.replaceAll('StockItem', [
      { NAME: 'ACC Cement OPC 43 Grade', PARENT: 'Building Materials', BASEUNITS: 'Bags' },
      { NAME: 'Cement Bags', PARENT: 'Building Materials', BASEUNITS: 'Bags' },
      { NAME: 'Steel Rods', PARENT: 'Building Materials', BASEUNITS: 'Kg' },
      { NAME: 'Orange', PARENT: 'Primary', BASEUNITS: 'KG', gstRateHistory: ORANGE_GST_HISTORY },
      { NAME: 'Apple', PARENT: 'Primary', BASEUNITS: 'Nos', gstRateHistory: ORANGE_GST_HISTORY }, // also 18%
    ]);
    const result = validateTransactionDraft(
      database.db,
      mixedRateDraft({
        items: [
          { itemName: 'Orange', quantity: 5, rate: 1000, godown: null },
          { itemName: 'Apple', quantity: 5, rate: 50, godown: null },
        ],
      }),
    );
    expect(result.items[0]?.resolvedGstPercent).toBe(18);
    expect(result.items[1]?.resolvedGstPercent).toBe(18);
    // Both items agree, so the draft-level summary can still express one value.
    expect(result.resolvedGstPercent).toBe(18);
  });
  it('5. an explicit per-item GST override wins over Tally for that item only', () => {
    cacheOrangeAndShampoo();
    const result = validateTransactionDraft(
      database.db,
      mixedRateDraft({
        items: [
          { itemName: 'Orange', quantity: 5, rate: 1000, godown: null, gstPercent: 28 }, // explicit override
          { itemName: 'Anti-Dandruff Shampoos', quantity: 5, rate: 125, godown: null },
        ],
      }),
    );
    expect(result.items[0]?.resolvedGstPercent).toBe(28); // override, not Tally's 18
    expect(result.items[1]?.resolvedGstPercent).toBe(5); // untouched, still from Tally
  });
  it('6. an explicit voucher-wide GST override resolves every item that did not state its own', () => {
    cacheOrangeAndShampoo();
    const result = validateTransactionDraft(database.db, mixedRateDraft({ gstPercent: 12 }));
    expect(result.items[0]?.resolvedGstPercent).toBe(12);
    expect(result.items[1]?.resolvedGstPercent).toBe(12);
    expect(result.resolvedGstPercent).toBe(12);
  });
  it('7. an item-level override still wins even when a voucher-wide GST value is also stated', () => {
    cacheOrangeAndShampoo();
    const result = validateTransactionDraft(
      database.db,
      mixedRateDraft({
        gstPercent: 12,
        items: [
          { itemName: 'Orange', quantity: 5, rate: 1000, godown: null, gstPercent: 28 },
          { itemName: 'Anti-Dandruff Shampoos', quantity: 5, rate: 125, godown: null },
        ],
      }),
    );
    expect(result.items[0]?.resolvedGstPercent).toBe(28); // item override beats voucher-wide
    expect(result.items[1]?.resolvedGstPercent).toBe(12); // sibling falls back to voucher-wide
  });
  it('8. one resolvable item and one genuinely unresolved item: only the unresolved one is reported', () => {
    cache.replaceAll('StockItem', [
      { NAME: 'ACC Cement OPC 43 Grade', PARENT: 'Building Materials', BASEUNITS: 'Bags' },
      { NAME: 'Cement Bags', PARENT: 'Building Materials', BASEUNITS: 'Bags' },
      { NAME: 'Steel Rods', PARENT: 'Building Materials', BASEUNITS: 'Kg' }, // no gstRateHistory
      { NAME: 'Orange', PARENT: 'Primary', BASEUNITS: 'KG', gstRateHistory: ORANGE_GST_HISTORY },
    ]);
    const result = validateTransactionDraft(
      database.db,
      mixedRateDraft({
        items: [
          { itemName: 'Orange', quantity: 5, rate: 1000, godown: null }, // resolves from Tally
          { itemName: 'Steel Rods', quantity: 5, rate: 500, godown: null }, // no history, no config
        ],
      }),
    );
    expect(result.items[0]?.gstPercentValid).toBe(true);
    expect(result.items[0]?.resolvedGstPercent).toBe(18);
    expect(result.items[1]?.gstPercentValid).toBe(false);
    expect(result.items[1]?.resolvedGstPercent).toBeNull();
    const gstIssues = result.issues.filter((i) => i.code === 'missing_gst_percent');
    expect(gstIssues).toHaveLength(1);
    expect(gstIssues[0]).toMatchObject({ itemIndex: 1 });
  });
  it('an invalid explicit per-item GST rate blocks only that item, with no fallback attempted for it', () => {
    cacheOrangeAndShampoo();
    const result = validateTransactionDraft(
      database.db,
      mixedRateDraft({
        items: [
          { itemName: 'Orange', quantity: 5, rate: 1000, godown: null, gstPercent: 45 }, // not a real slab
          { itemName: 'Anti-Dandruff Shampoos', quantity: 5, rate: 125, godown: null },
        ],
      }),
    );
    expect(result.items[0]?.gstPercentValid).toBe(false);
    expect(result.items[0]?.resolvedGstPercent).toBeNull();
    expect(result.items[1]?.resolvedGstPercent).toBe(5); // sibling unaffected
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'invalid_gst_percent', itemIndex: 0 }),
    );
  });
  it('an invalid voucher-wide GST value is reported once and does not silently force every item to fail without trying Tally', () => {
    cacheOrangeAndShampoo();
    const result = validateTransactionDraft(database.db, mixedRateDraft({ gstPercent: 45 }));
    // Exactly one invalid_gst_percent, draft-level (no itemIndex) — never
    // repeated per item.
    const invalidIssues = result.issues.filter((i) => i.code === 'invalid_gst_percent');
    expect(invalidIssues).toHaveLength(1);
    expect(invalidIssues[0].itemIndex).toBeUndefined();
    // Per the original short-circuit behaviour, an invalid voucher-wide value
    // is treated as unusable — it does not proceed past the original
    // immediate-return semantics for items with no item-level override.
    expect(result.items[0]?.gstPercentValid).toBe(false);
    expect(result.items[1]?.gstPercentValid).toBe(false);
  });
});
describe('validateTransactionDraft - multiple issues at once', () => {
  it('reports every problem in a single pass rather than stopping at the first', () => {
    const result = validateTransactionDraft(database.db, {
      voucherType: 'unknown',
      partyName: null,
      items: [{ itemName: '', quantity: -1, rate: 0, godown: null }],
      gstPercent: 99,
      placeOfSupply: null,
      missingFields: [],
      ambiguityNote: null,
    });
    expect(result.isValid).toBe(false);
    const codes = result.issues.map((i) => i.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'invalid_voucher_type',
        'missing_party_name',
        'missing_item_name',
        'invalid_quantity',
        'invalid_rate',
        'invalid_gst_percent',
      ]),
    );
  });
});
