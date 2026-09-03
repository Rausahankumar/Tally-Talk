import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { GodownConfig, GstLedgerConfig } from '../src/config/index.ts';
import { createItemLedgerMappingStore } from '../src/gst/itemLedgerMapping.ts';
import type { ItemLedgerMappingStore } from '../src/gst/itemLedgerMapping.ts';
import { checkPostingReadiness } from '../src/gst/postingReadiness.ts';
import type { PostingReadinessResult } from '../src/gst/postingReadiness.ts';
import { createTallyMasterCache } from '../src/tally/cache.ts';
import { createStockAvailabilityCache } from '../src/tally/stockAvailabilityCache.ts';
import type { StockAvailabilityStore } from '../src/tally/stockAvailability.ts';
import { buildSalesVoucherInput } from '../src/tally/draftToVoucher.ts';
import type { TransactionDraft } from '../src/llm/schema.ts';
import type { DraftValidationResult } from '../src/validation/types.ts';
import type { Database } from '../src/db/sqlite.ts';
import { createTestDatabase } from './helpers/testDatabase.ts';

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

const COMPANY_NAME = 'Nirmal FMCG Traders Ltd';

function draft(overrides: Partial<TransactionDraft> = {}): TransactionDraft {
  return {
    voucherType: 'sales',
    partyName: 'Suresh & Sons',
    items: [{ itemName: 'Steel Rods', quantity: 100, rate: 500, godown: null }],
    gstPercent: 18,
    placeOfSupply: 'Delhi',
    missingFields: [],
    ambiguityNote: null,
    ...overrides,
  };
}

const VALID_PHASE5: DraftValidationResult = {
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

let database: Database;
let itemLedgerMappingStore: ItemLedgerMappingStore;
let stockAvailabilityStore: StockAvailabilityStore;

beforeEach(() => {
  database = createTestDatabase();
  itemLedgerMappingStore = createItemLedgerMappingStore(database.db);
  stockAvailabilityStore = createStockAvailabilityCache({ db: database.db });

  const masterCache = createTallyMasterCache({ db: database.db });
  masterCache.replaceAll('Ledger', [
    { NAME: 'CGST', PARENT: 'Duties & Taxes' },
    { NAME: 'SGST', PARENT: 'Duties & Taxes' },
    { NAME: 'IGST', PARENT: 'Duties & Taxes' },
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

function readyResult(d: TransactionDraft, validation = VALID_PHASE5): PostingReadinessResult {
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
    const d = draft({ items: [{ itemName: 'Steel Rods', quantity: 3, rate: 33.33, godown: null }] });
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
    itemLedgerMappingStore.setMapping({ stockItemName: 'Bricks', salesLedger: 'Sales', purchaseLedger: 'Purchase' });
    stockAvailabilityStore.replaceAllForItem('Bricks', [
      { batchName: 'Primary Batch', godownName: 'Warehouse B', quantity: 500, unit: 'Nos' },
    ]);

    const d = draft({
      items: [
        { itemName: 'Steel Rods', quantity: 10, rate: 500, godown: 'Main Location' },
        { itemName: 'Bricks', quantity: 20, rate: 20, godown: 'Warehouse B' },
      ],
    });
    const validation: DraftValidationResult = {
      ...VALID_PHASE5,
      items: [
        VALID_PHASE5.items[0]!,
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
      expect.objectContaining({ stockItemName: 'Steel Rods', godown: 'Main Location', amount: 5000 }),
      expect.objectContaining({ stockItemName: 'Bricks', godown: 'Warehouse B', batchName: 'Primary Batch', amount: 400 }),
    ]);
  });

  function masterCacheForBricks(): void {
    createTallyMasterCache({ db: database.db }).replaceAll('StockItem', [
      { NAME: 'Steel Rods', PARENT: '', BASEUNITS: 'Kg' },
      { NAME: 'Bricks', PARENT: '', BASEUNITS: 'Nos' },
    ]);
  }
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
      { NAME: 'CGST', PARENT: 'Duties & Taxes' },
      { NAME: 'SGST', PARENT: 'Duties & Taxes' },
      { NAME: 'IGST', PARENT: 'Duties & Taxes' },
      { NAME: 'Sales', PARENT: 'Sales Accounts' },
      { NAME: 'Purchase', PARENT: 'Purchase Accounts' },
    ]);
    itemLedgerMappingStore.setMapping({ stockItemName: 'Steel Rods', salesLedger: 'Sales', purchaseLedger: 'Purchase' });
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

  function fullyReadyResult(): PostingReadinessResult {
    return {
      ready: true,
      placeOfSupply: 'Delhi',
      gstTreatment: { type: 'intrastate', placeOfSupply: 'Delhi', ledgers: [{ ledgerName: 'CGST', share: 0.5 }, { ledgerName: 'SGST', share: 0.5 }] },
      itemLedgers: [{ itemIndex: 0, salesLedger: 'Sales', purchaseLedger: 'Purchase' }],
      itemGodowns: [{ itemIndex: 0, godown: 'Main Location' }],
      itemStock: [{ itemIndex: 0, resolvedBatch: '1', availableQuantity: 1000, alternativeGodowns: [] }],
      blockers: [],
    };
  }

  it('refuses when the party could not be resolved, even though readiness claims ready', () => {
    const d = draft();
    const validation: DraftValidationResult = { ...VALID_PHASE5, partyMatch: null };

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
    const validation: DraftValidationResult = {
      ...VALID_PHASE5,
      items: [{ itemName: 'Steel Rods', stockItemMatch: { status: 'not_found', matchedName: null, candidates: [] }, quantityValid: true, rateValid: true }],
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
    const d = draft({ items: [{ itemName: 'Steel Rods', quantity: null, rate: 500, godown: null }] });

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
    const readiness: PostingReadinessResult = {
      ...fullyReadyResult(),
      itemLedgers: [{ itemIndex: 0, salesLedger: null, purchaseLedger: null }],
    };

    const result = buildSalesVoucherInput({ db: database.db, companyName: COMPANY_NAME }, d, VALID_PHASE5, readiness);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasons.some((r) => r.includes('Sales ledger'))).toBe(true);
  });

  it('refuses when no godown was resolved for an item', () => {
    const d = draft();
    const readiness: PostingReadinessResult = {
      ...fullyReadyResult(),
      itemGodowns: [{ itemIndex: 0, godown: null }],
    };

    const result = buildSalesVoucherInput({ db: database.db, companyName: COMPANY_NAME }, d, VALID_PHASE5, readiness);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasons.some((r) => r.includes('godown'))).toBe(true);
  });

  it('refuses when no batch was resolved for an item — never falls back to a default batch name', () => {
    const d = draft();
    const readiness: PostingReadinessResult = {
      ...fullyReadyResult(),
      itemStock: [{ itemIndex: 0, resolvedBatch: null, availableQuantity: null, alternativeGodowns: [] }],
    };

    const result = buildSalesVoucherInput({ db: database.db, companyName: COMPANY_NAME }, d, VALID_PHASE5, readiness);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasons.some((r) => r.includes('batch'))).toBe(true);
  });

  it('refuses when the stock item has no cached base unit', () => {
    createTallyMasterCache({ db: database.db }).replaceAll('StockItem', []); // no base unit cached
    const d = draft();

    const result = buildSalesVoucherInput({ db: database.db, companyName: COMPANY_NAME }, d, VALID_PHASE5, fullyReadyResult());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasons.some((r) => r.includes('base unit'))).toBe(true);
  });

  it('refuses when GST treatment is missing', () => {
    const d = draft();
    const readiness: PostingReadinessResult = { ...fullyReadyResult(), gstTreatment: null };

    const result = buildSalesVoucherInput({ db: database.db, companyName: COMPANY_NAME }, d, VALID_PHASE5, readiness);

    expect(result.ok).toBe(false);
  });

  it('refuses when GST percent is missing from the draft', () => {
    const d = draft({ gstPercent: null });

    const result = buildSalesVoucherInput({ db: database.db, companyName: COMPANY_NAME }, d, VALID_PHASE5, fullyReadyResult());

    expect(result.ok).toBe(false);
  });

  it('collects every problem in one pass rather than stopping at the first', () => {
    const d = draft({ gstPercent: null });
    const validation: DraftValidationResult = { ...VALID_PHASE5, partyMatch: null };
    const readiness: PostingReadinessResult = { ...fullyReadyResult(), gstTreatment: null };

    const result = buildSalesVoucherInput({ db: database.db, companyName: COMPANY_NAME }, d, validation, readiness);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasons.length).toBeGreaterThanOrEqual(3);
  });
});
