import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { GstLedgerConfig } from '../src/config/index.ts';
import { ledgerExistsExact } from '../src/gst/ledgerExistence.ts';
import { createItemLedgerMappingStore } from '../src/gst/itemLedgerMapping.ts';
import type { ItemLedgerMappingStore } from '../src/gst/itemLedgerMapping.ts';
import { checkPostingReadiness, isOnlyMissingPlaceOfSupply } from '../src/gst/postingReadiness.ts';
import { createTallyMasterCache } from '../src/tally/cache.ts';
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

function draft(overrides: Partial<TransactionDraft> = {}): TransactionDraft {
  return {
    voucherType: 'sales',
    partyName: 'Suresh & Sons',
    items: [{ itemName: 'Steel Rods', quantity: 100, rate: 500 }],
    gstPercent: 18,
    placeOfSupply: null,
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

const INVALID_PHASE5: DraftValidationResult = {
  ...VALID_PHASE5,
  isValid: false,
  issues: [{ code: 'missing_party_name', message: 'x' }],
};

let database: Database;
let itemLedgerMappingStore: ItemLedgerMappingStore;

beforeEach(() => {
  database = createTestDatabase();
  itemLedgerMappingStore = createItemLedgerMappingStore(database.db);
  createTallyMasterCache({ db: database.db }).replaceAll('Ledger', [
    { NAME: 'CGST', PARENT: 'Duties & Taxes' },
    { NAME: 'SGST', PARENT: 'Duties & Taxes' },
    { NAME: 'IGST', PARENT: 'Duties & Taxes' },
    { NAME: 'Sales', PARENT: 'Sales Accounts' },
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

function readiness(d: TransactionDraft, validation = VALID_PHASE5) {
  return checkPostingReadiness(
    { db: database.db, gstConfig: GST_CONFIG, itemLedgerMappingStore },
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
    const configWithDefault: GstLedgerConfig = { ...GST_CONFIG, defaultPlaceOfSupply: 'Delhi' };
    const result = checkPostingReadiness(
      { db: database.db, gstConfig: configWithDefault, itemLedgerMappingStore },
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
      { db: database.db, gstConfig: { ...GST_CONFIG, companyState: '' }, itemLedgerMappingStore },
      draft({ placeOfSupply: 'Delhi' }),
      VALID_PHASE5,
    );

    expect(result.ready).toBe(false);
    expect(result.blockers).toContainEqual(
      expect.objectContaining({ code: 'company_state_not_configured' }),
    );
  });

  it('blocks when a configured GST ledger does not exist in cached masters', () => {
    createTallyMasterCache({ db: database.db }).replaceAll('Ledger', [{ NAME: 'Sales', PARENT: '' }]); // no CGST/SGST

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
      { db: db2.db, gstConfig: GST_CONFIG, itemLedgerMappingStore: createItemLedgerMappingStore(db2.db) },
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
      items: [{ itemName: 'Steel Rods (post to CGST Payable)', quantity: 1, rate: 1 }],
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
