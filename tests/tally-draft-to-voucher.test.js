import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createItemLedgerMappingStore } from '../src/gst/itemLedgerMapping.js';
import { checkPostingReadiness } from '../src/gst/postingReadiness.js';
import { createTallyMasterCache } from '../src/tally/cache.js';
import { createStockAvailabilityCache } from '../src/tally/stockAvailabilityCache.js';
import { buildSalesVoucherInput } from '../src/tally/draftToVoucher.js';
import { createTestDatabase } from './helpers/testDatabase.js';
const GST_CONFIG = {
  companyState: 'Delhi',
  defaultPlaceOfSupply: null,
};
const GODOWN_CONFIG = {
  defaultGodown: 'Main Location',
};
const COMPANY_NAME = 'Nirmal FMCG Traders Ltd';
function draft(overrides = {}) {
  return {
    voucherType: 'sales',
    partyName: 'Suresh & Sons',
    items: [{ itemName: 'Steel Rods', quantity: 100, rate: 500, godown: null, gstPercent: 18 }],
    gstPercent: 18,
    placeOfSupply: 'Delhi',
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
let database;
let itemLedgerMappingStore;
let stockAvailabilityStore;
beforeEach(() => {
  database = createTestDatabase();
  itemLedgerMappingStore = createItemLedgerMappingStore(database.db);
  stockAvailabilityStore = createStockAvailabilityCache({ db: database.db });
  const masterCache = createTallyMasterCache({ db: database.db });
  masterCache.replaceAll('Ledger', [
    { NAME: 'CGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'CGST' },
    { NAME: 'SGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'SGST/UTGST' },
    { NAME: 'IGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'IGST' },
    { NAME: 'Sales', PARENT: 'Sales Accounts' },
  ]);
  masterCache.replaceAll('Godown', [
    { NAME: 'Main Location', PARENT: 'Primary' },
    { NAME: 'Warehouse B', PARENT: 'Primary' },
  ]);
  masterCache.replaceAll('StockItem', [{ NAME: 'Steel Rods', PARENT: '', BASEUNITS: 'Kg' }]);
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
function readyResult(d, validation = VALID_PHASE5) {
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
describe('buildSalesVoucherInput — happy path', () => {
  it('builds a fully resolved SalesVoucherInput for an intrastate sale', () => {
    const d = draft();
    const readiness = readyResult(d);
    expect(readiness.ready).toBe(true); // sanity: fixture is actually ready
    const fixedDate = new Date('2026-06-01T00:00:00Z');
    const result = buildSalesVoucherInput(
      { db: database.db, companyName: COMPANY_NAME, now: () => fixedDate },
      d,
      VALID_PHASE5,
      readiness,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.voucher).toEqual({
      date: fixedDate,
      companyName: COMPANY_NAME,
      partyLedgerName: 'Suresh & Sons',
      items: [
        {
          stockItemName: 'Steel Rods',
          quantity: 100,
          unit: 'Kg',
          rate: 500,
          amount: 50000,
          gstPercent: 18,
          ledgerAllocation: { ledgerName: 'Sales', amount: 50000 },
          godown: 'Main Location',
          batchName: '1',
        },
      ],
      taxLedgerAllocations: [
        { ledgerName: 'CGST', amount: 4500 },
        { ledgerName: 'SGST', amount: 4500 },
      ],
    });
  });
  it('uses an explicit user-provided date instead of the injected "now", when validation resolved one', () => {
    const d = draft();
    const readiness = readyResult(d);
    expect(readiness.ready).toBe(true);
    const fixedToday = new Date('2026-09-07T00:00:00Z');
    const explicitDate = new Date(2026, 8, 1); // 2026-09-01, as stated by the user
    const result = buildSalesVoucherInput(
      { db: database.db, companyName: COMPANY_NAME, now: () => fixedToday },
      d,
      { ...VALID_PHASE5, parsedDate: explicitDate },
      readiness,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.voucher.date).toEqual(explicitDate);
  });
  it('splits GST as a single IGST allocation for an interstate sale', () => {
    const d = draft({ placeOfSupply: 'Uttar Pradesh' });
    const readiness = readyResult(d);
    expect(readiness.ready).toBe(true);
    const result = buildSalesVoucherInput(
      { db: database.db, companyName: COMPANY_NAME },
      d,
      VALID_PHASE5,
      readiness,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.voucher.taxLedgerAllocations).toEqual([{ ledgerName: 'IGST', amount: 9000 }]);
  });
  it('computes each item amount as quantity * rate, and mirrors it into the ledger allocation', () => {
    const d = draft({
      items: [{ itemName: 'Steel Rods', quantity: 3, rate: 33.33, godown: null, gstPercent: 18 }],
    });
    const readiness = readyResult(d);
    const result = buildSalesVoucherInput(
      { db: database.db, companyName: COMPANY_NAME },
      d,
      VALID_PHASE5,
      readiness,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.voucher.items[0]?.amount).toBeCloseTo(99.99, 2);
    expect(result.voucher.items[0]?.ledgerAllocation.amount).toBe(result.voucher.items[0]?.amount);
  });
  it('handles multiple items, each with its own godown and batch', () => {
    masterCacheForBricks();
    itemLedgerMappingStore.setMapping({
      stockItemName: 'Bricks',
      salesLedger: 'Sales',
      purchaseLedger: 'Purchase',
    });
    stockAvailabilityStore.replaceAllForItem('Bricks', [
      { batchName: 'Primary Batch', godownName: 'Warehouse B', quantity: 500, unit: 'Nos' },
    ]);
    const d = draft({
      items: [
        { itemName: 'Steel Rods', quantity: 10, rate: 500, godown: 'Main Location', gstPercent: 18 },
        { itemName: 'Bricks', quantity: 20, rate: 20, godown: 'Warehouse B', gstPercent: 18 },
      ],
    });
    const validation = {
      ...VALID_PHASE5,
      items: [
        VALID_PHASE5.items[0],
        {
          itemName: 'Bricks',
          stockItemMatch: { status: 'exact', matchedName: 'Bricks', candidates: [] },
          quantityValid: true,
          rateValid: true,
        },
      ],
    };
    const readiness = readyResult(d, validation);
    expect(readiness.ready).toBe(true);
    const result = buildSalesVoucherInput(
      { db: database.db, companyName: COMPANY_NAME },
      d,
      validation,
      readiness,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.voucher.items).toEqual([
      expect.objectContaining({
        stockItemName: 'Steel Rods',
        godown: 'Main Location',
        amount: 5000,
      }),
      expect.objectContaining({
        stockItemName: 'Bricks',
        godown: 'Warehouse B',
        batchName: 'Primary Batch',
        amount: 400,
      }),
    ]);
  });
  function masterCacheForBricks() {
    createTallyMasterCache({ db: database.db }).replaceAll('StockItem', [
      { NAME: 'Steel Rods', PARENT: '', BASEUNITS: 'Kg' },
      { NAME: 'Bricks', PARENT: '', BASEUNITS: 'Nos' },
    ]);
  }
  describe('mixed-rate vouchers (per-line GST)', () => {
    function masterCacheForShampoo() {
      createTallyMasterCache({ db: database.db }).replaceAll('StockItem', [
        { NAME: 'Steel Rods', PARENT: '', BASEUNITS: 'Kg' },
        { NAME: 'Anti-Dandruff Shampoos', PARENT: '', BASEUNITS: 'Nos' },
      ]);
    }
    function mixedRateValidation() {
      return {
        ...VALID_PHASE5,
        items: [
          VALID_PHASE5.items[0],
          {
            itemName: 'Anti-Dandruff Shampoos',
            stockItemMatch: { status: 'exact', matchedName: 'Anti-Dandruff Shampoos', candidates: [] },
            quantityValid: true,
            rateValid: true,
          },
        ],
      };
    }
    beforeEach(() => {
      masterCacheForShampoo();
      itemLedgerMappingStore.setMapping({
        stockItemName: 'Anti-Dandruff Shampoos',
        salesLedger: 'Sales',
        purchaseLedger: 'Purchase',
      });
      stockAvailabilityStore.replaceAllForItem('Anti-Dandruff Shampoos', [
        { batchName: '1', godownName: 'Main Location', quantity: 200, unit: 'Nos' },
      ]);
    });
    it('3. two items with different GST rates, interstate — two separate IGST allocations, one per rate bucket', () => {
      const d = draft({
        placeOfSupply: 'Uttar Pradesh',
        items: [
          { itemName: 'Steel Rods', quantity: 5, rate: 1000, godown: 'Main Location', gstPercent: 18 },
          {
            itemName: 'Anti-Dandruff Shampoos',
            quantity: 5,
            rate: 125,
            godown: 'Main Location',
            gstPercent: 5,
          },
        ],
      });
      const validation = mixedRateValidation();
      const readiness = readyResult(d, validation);
      expect(readiness.ready).toBe(true);
      const result = buildSalesVoucherInput(
        { db: database.db, companyName: COMPANY_NAME },
        d,
        validation,
        readiness,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Steel Rods: 5000 taxable @ 18% -> IGST 900. Shampoos: 625 taxable @
      // 5% -> IGST 31.25. Buckets are sorted by rate ascending (5% before
      // 18%) — deterministic regardless of item order in the draft.
      expect(result.voucher.taxLedgerAllocations).toEqual([
        { ledgerName: 'IGST', amount: 31.25 },
        { ledgerName: 'IGST', amount: 900 },
      ]);
    });
    it('4. two items with different GST rates, intrastate — separate CGST/SGST amounts per rate bucket', () => {
      const d = draft({
        items: [
          { itemName: 'Steel Rods', quantity: 5, rate: 1000, godown: 'Main Location', gstPercent: 18 },
          {
            itemName: 'Anti-Dandruff Shampoos',
            quantity: 5,
            rate: 125,
            godown: 'Main Location',
            gstPercent: 5,
          },
        ],
      });
      const validation = mixedRateValidation();
      const readiness = readyResult(d, validation);
      expect(readiness.ready).toBe(true);
      const result = buildSalesVoucherInput(
        { db: database.db, companyName: COMPANY_NAME },
        d,
        validation,
        readiness,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.voucher.taxLedgerAllocations).toEqual([
        { ledgerName: 'CGST', amount: 15.63 },
        { ledgerName: 'SGST', amount: 15.63 },
        { ledgerName: 'CGST', amount: 450 },
        { ledgerName: 'SGST', amount: 450 },
      ]);
    });
    it('10. a mixed-rate voucher still balances exactly to zero (credit side matches the negated party amount)', () => {
      const d = draft({
        placeOfSupply: 'Uttar Pradesh',
        items: [
          { itemName: 'Steel Rods', quantity: 5, rate: 1000, godown: 'Main Location', gstPercent: 18 },
          {
            itemName: 'Anti-Dandruff Shampoos',
            quantity: 5,
            rate: 125,
            godown: 'Main Location',
            gstPercent: 5,
          },
        ],
      });
      const validation = mixedRateValidation();
      const readiness = readyResult(d, validation);
      const result = buildSalesVoucherInput(
        { db: database.db, companyName: COMPANY_NAME },
        d,
        validation,
        readiness,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const itemsTotal = result.voucher.items.reduce((sum, item) => sum + item.amount, 0);
      const taxTotal = result.voucher.taxLedgerAllocations.reduce((sum, tax) => sum + tax.amount, 0);
      // Mirrors postingXml.js's own creditSideTotal/partyAmount computation —
      // the party entry is always exactly the negative of this sum, so as
      // long as this identity holds, the voucher balances to zero by
      // construction, regardless of how many rate buckets contributed to it.
      expect(itemsTotal + taxTotal).toBeCloseTo(5625 + 900 + 31.25, 2);
    });
    it('14. does not compute GST from the total voucher taxable amount at one rate — the pre-fix bug', () => {
      const d = draft({
        placeOfSupply: 'Uttar Pradesh',
        items: [
          { itemName: 'Steel Rods', quantity: 5, rate: 1000, godown: 'Main Location', gstPercent: 18 },
          {
            itemName: 'Anti-Dandruff Shampoos',
            quantity: 5,
            rate: 125,
            godown: 'Main Location',
            gstPercent: 5,
          },
        ],
      });
      const validation = mixedRateValidation();
      const readiness = readyResult(d, validation);
      const result = buildSalesVoucherInput(
        { db: database.db, companyName: COMPANY_NAME },
        d,
        validation,
        readiness,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const totalTax = result.voucher.taxLedgerAllocations.reduce((sum, tax) => sum + tax.amount, 0);
      // The old bug: (5000 + 625) * 18% = 1012.50, blending Shampoo's real 5%
      // into Orange's 18%. The correct, per-bucket total is 900 + 31.25 =
      // 931.25 — a different, smaller figure that proves no single blended
      // rate was used anywhere in this calculation.
      expect(totalTax).toBeCloseTo(931.25, 2);
      expect(totalTax).not.toBeCloseTo(1012.5, 2);
    });
    it('one resolvable item and one item with an unresolvable GST percent: only that item blocks, with a precise reason', () => {
      const d = draft({
        items: [
          { itemName: 'Steel Rods', quantity: 5, rate: 1000, godown: 'Main Location', gstPercent: 18 },
          {
            itemName: 'Anti-Dandruff Shampoos',
            quantity: 5,
            rate: 125,
            godown: 'Main Location',
            gstPercent: null,
          },
        ],
      });
      const validation = mixedRateValidation();
      const readiness = readyResult(d, validation);
      const result = buildSalesVoucherInput(
        { db: database.db, companyName: COMPANY_NAME },
        d,
        validation,
        readiness,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reasons).toHaveLength(1);
      expect(result.reasons[0]).toContain('Anti-Dandruff Shampoos');
      expect(result.reasons[0]).toContain('GST percent');
    });
  });
  it('builds a resolved voucher for a confirmed non-batch-tracked item with no cached stock — batch resolves to Tally\'s own implicit "Primary Batch"', () => {
    createTallyMasterCache({ db: database.db }).replaceAll('StockItem', [
      { NAME: 'Orange', PARENT: '', BASEUNITS: 'KG', ISBATCHWISEON: 'No' },
    ]);
    itemLedgerMappingStore.setMapping({
      stockItemName: 'Orange',
      salesLedger: 'Sales',
      purchaseLedger: 'Purchase',
    });
    // No stock_availability row at all for Orange — nothing was ever synced.
    const d = draft({
      items: [{ itemName: 'Orange', quantity: 5, rate: 100, godown: 'Main Location', gstPercent: 18 }],
    });
    const validation = {
      ...VALID_PHASE5,
      items: [
        {
          itemName: 'Orange',
          stockItemMatch: { status: 'exact', matchedName: 'Orange', candidates: [] },
          quantityValid: true,
          rateValid: true,
        },
      ],
    };
    const readiness = readyResult(d, validation);
    expect(readiness.ready).toBe(true);
    expect(readiness.stockWarnings).toContainEqual(
      expect.objectContaining({ itemIndex: 0, reason: 'no_data' }),
    );
    const result = buildSalesVoucherInput(
      { db: database.db, companyName: COMPANY_NAME },
      d,
      validation,
      readiness,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.voucher.items[0]).toEqual(
      expect.objectContaining({
        stockItemName: 'Orange',
        godown: 'Main Location',
        batchName: 'Primary Batch',
      }),
    );
  });
});
describe('buildSalesVoucherInput — fails closed', () => {
  it('refuses to build anything when readiness.ready is false, regardless of why', () => {
    const d = draft({ placeOfSupply: null }); // no default configured for GST_CONFIG here
    const readiness = readyResult(d);
    expect(readiness.ready).toBe(false);
    const result = buildSalesVoucherInput(
      { db: database.db, companyName: COMPANY_NAME },
      d,
      VALID_PHASE5,
      readiness,
    );
    expect(result.ok).toBe(false);
  });
  it('refuses a purchase voucher — this adapter only builds Sales vouchers', () => {
    createTallyMasterCache({ db: database.db }).replaceAll('Ledger', [
      { NAME: 'CGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'CGST' },
      { NAME: 'SGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'SGST/UTGST' },
      { NAME: 'IGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'IGST' },
      { NAME: 'Sales', PARENT: 'Sales Accounts' },
      { NAME: 'Purchase', PARENT: 'Purchase Accounts' },
    ]);
    itemLedgerMappingStore.setMapping({
      stockItemName: 'Steel Rods',
      salesLedger: 'Sales',
      purchaseLedger: 'Purchase',
    });
    const d = draft({ voucherType: 'purchase' });
    const readiness = readyResult(d);
    expect(readiness.ready).toBe(true); // readiness itself doesn't care about the direction
    const result = buildSalesVoucherInput(
      { db: database.db, companyName: COMPANY_NAME },
      d,
      VALID_PHASE5,
      readiness,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasons.join(' ')).toContain('Sales');
  });
  function fullyReadyResult() {
    return {
      ready: true,
      placeOfSupply: 'Delhi',
      gstTreatment: {
        type: 'intrastate',
        placeOfSupply: 'Delhi',
        ledgers: [
          { ledgerName: 'CGST', share: 0.5 },
          { ledgerName: 'SGST', share: 0.5 },
        ],
      },
      itemLedgers: [{ itemIndex: 0, salesLedger: 'Sales', purchaseLedger: 'Purchase' }],
      itemGodowns: [{ itemIndex: 0, godown: 'Main Location' }],
      itemStock: [
        { itemIndex: 0, resolvedBatch: '1', availableQuantity: 1000, alternativeGodowns: [] },
      ],
      blockers: [],
    };
  }
  it('refuses when the party could not be resolved, even though readiness claims ready', () => {
    const d = draft();
    const validation = { ...VALID_PHASE5, partyMatch: null };
    const result = buildSalesVoucherInput(
      { db: database.db, companyName: COMPANY_NAME },
      d,
      validation,
      fullyReadyResult(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasons.some((r) => r.includes('party'))).toBe(true);
  });
  it('refuses when an item has no resolved stock item name', () => {
    const d = draft();
    const validation = {
      ...VALID_PHASE5,
      items: [
        {
          itemName: 'Steel Rods',
          stockItemMatch: { status: 'not_found', matchedName: null, candidates: [] },
          quantityValid: true,
          rateValid: true,
        },
      ],
    };
    const result = buildSalesVoucherInput(
      { db: database.db, companyName: COMPANY_NAME },
      d,
      validation,
      fullyReadyResult(),
    );
    expect(result.ok).toBe(false);
  });
  it('refuses when an item has no quantity or rate', () => {
    const d = draft({
      items: [{ itemName: 'Steel Rods', quantity: null, rate: 500, godown: null }],
    });
    const result = buildSalesVoucherInput(
      { db: database.db, companyName: COMPANY_NAME },
      d,
      VALID_PHASE5,
      fullyReadyResult(),
    );
    expect(result.ok).toBe(false);
  });
  it('refuses when no Sales ledger was resolved for an item', () => {
    const d = draft();
    const readiness = {
      ...fullyReadyResult(),
      itemLedgers: [{ itemIndex: 0, salesLedger: null, purchaseLedger: null }],
    };
    const result = buildSalesVoucherInput(
      { db: database.db, companyName: COMPANY_NAME },
      d,
      VALID_PHASE5,
      readiness,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasons.some((r) => r.includes('Sales ledger'))).toBe(true);
  });
  it('refuses when no godown was resolved for an item', () => {
    const d = draft();
    const readiness = {
      ...fullyReadyResult(),
      itemGodowns: [{ itemIndex: 0, godown: null }],
    };
    const result = buildSalesVoucherInput(
      { db: database.db, companyName: COMPANY_NAME },
      d,
      VALID_PHASE5,
      readiness,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasons.some((r) => r.includes('godown'))).toBe(true);
  });
  it('still refuses a confirmed batch-tracked item with no cached stock — the non-batch fallback never applies to it', () => {
    createTallyMasterCache({ db: database.db }).replaceAll('StockItem', [
      { NAME: 'Apple', PARENT: '', BASEUNITS: 'KG', ISBATCHWISEON: 'Yes' },
    ]);
    itemLedgerMappingStore.setMapping({
      stockItemName: 'Apple',
      salesLedger: 'Sales',
      purchaseLedger: 'Purchase',
    });
    const d = draft({
      items: [{ itemName: 'Apple', quantity: 5, rate: 100, godown: 'Main Location' }],
    });
    const validation = {
      ...VALID_PHASE5,
      items: [
        {
          itemName: 'Apple',
          stockItemMatch: { status: 'exact', matchedName: 'Apple', candidates: [] },
          quantityValid: true,
          rateValid: true,
        },
      ],
    };
    const readiness = readyResult(d, validation);
    expect(readiness.ready).toBe(true); // stock is still only a warning
    expect(readiness.itemStock[0]?.resolvedBatch).toBeNull();
    const result = buildSalesVoucherInput(
      { db: database.db, companyName: COMPANY_NAME },
      d,
      validation,
      readiness,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasons.some((r) => r.includes('batch'))).toBe(true);
  });
  it('refuses when no batch was resolved for an item — never falls back to a default batch name', () => {
    const d = draft();
    const readiness = {
      ...fullyReadyResult(),
      itemStock: [
        { itemIndex: 0, resolvedBatch: null, availableQuantity: null, alternativeGodowns: [] },
      ],
    };
    const result = buildSalesVoucherInput(
      { db: database.db, companyName: COMPANY_NAME },
      d,
      VALID_PHASE5,
      readiness,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasons.some((r) => r.includes('batch'))).toBe(true);
  });
  it('refuses when the stock item has no cached base unit', () => {
    createTallyMasterCache({ db: database.db }).replaceAll('StockItem', []); // no base unit cached
    const d = draft();
    const result = buildSalesVoucherInput(
      { db: database.db, companyName: COMPANY_NAME },
      d,
      VALID_PHASE5,
      fullyReadyResult(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasons.some((r) => r.includes('base unit'))).toBe(true);
  });
  it('refuses when GST treatment is missing', () => {
    const d = draft();
    const readiness = { ...fullyReadyResult(), gstTreatment: null };
    const result = buildSalesVoucherInput(
      { db: database.db, companyName: COMPANY_NAME },
      d,
      VALID_PHASE5,
      readiness,
    );
    expect(result.ok).toBe(false);
  });
  it('refuses when GST percent is missing for an item — GST is resolved per item, never a voucher-wide gate', () => {
    const d = draft({
      items: [{ itemName: 'Steel Rods', quantity: 100, rate: 500, godown: null, gstPercent: null }],
    });
    const result = buildSalesVoucherInput(
      { db: database.db, companyName: COMPANY_NAME },
      d,
      VALID_PHASE5,
      fullyReadyResult(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasons.some((r) => r.includes('GST percent'))).toBe(true);
  });
  it('collects every problem in one pass rather than stopping at the first', () => {
    const d = draft({
      items: [{ itemName: 'Steel Rods', quantity: 100, rate: 500, godown: null, gstPercent: null }],
    });
    const validation = { ...VALID_PHASE5, partyMatch: null };
    const readiness = { ...fullyReadyResult(), gstTreatment: null };
    const result = buildSalesVoucherInput(
      { db: database.db, companyName: COMPANY_NAME },
      d,
      validation,
      readiness,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasons.length).toBeGreaterThanOrEqual(3);
  });
});
