import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTallyMasterCache } from '../src/tally/cache.js';
import { validateTransactionDraft } from '../src/validation/validateDraft.js';
import { createTestDatabase } from './helpers/testDatabase.js';
let database;
let cache;
beforeEach(() => {
  database = createTestDatabase();
  cache = createTallyMasterCache({ db: database.db });
  cache.replaceAll('Ledger', [
    { NAME: 'Ramesh Kumar Enterprises', PARENT: 'Sundry Debtors' },
    { NAME: 'Ramesh Traders', PARENT: 'Sundry Debtors' },
    { NAME: 'Suresh & Sons', PARENT: 'Sundry Creditors' },
    { NAME: 'Balaji Retail Store', PARENT: 'Sundry Debtors' },
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
    expect(result.gstPercentValid).toBeNull();
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
    expect(issue?.candidates).toEqual(
      expect.arrayContaining(['Ramesh Kumar Enterprises', 'Ramesh Traders']),
    );
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
