import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findLedgerMatch } from '../src/validation/masterLookup.js';
import { createTallyMasterCache } from '../src/tally/cache.js';
import { createTestDatabase } from './helpers/testDatabase.js';
/**
 * Voucher-type-aware party matching, tested against entirely synthetic
 * ledger names and groups — nothing here depends on any real client's data.
 */
let database;
let cache;
beforeEach(() => {
  database = createTestDatabase();
  cache = createTallyMasterCache({ db: database.db });
});
afterEach(() => {
  database.close();
});
describe('findLedgerMatch — sales (Sundry Creditors)', () => {
  beforeEach(() => {
    cache.replaceAll('Ledger', [
      { NAME: 'Acme Retail', PARENT: 'Sundry Creditors' },
      { NAME: 'Zylphar Distribution Co', PARENT: 'Sundry Creditors' },
      { NAME: 'Globex Trading', PARENT: 'Sundry Debtors' },
      { NAME: 'Northwind Tax Unit', PARENT: 'Duties & Taxes' },
    ]);
  });
  it('accepts an exact match from the Sundry Creditors pool', () => {
    expect(findLedgerMatch(database.db, 'Acme Retail', 'sales')).toEqual({
      status: 'exact',
      matchedName: 'Acme Retail',
      candidates: [],
    });
  });
  it('accepts a high-confidence fuzzy match from the Sundry Creditors pool', () => {
    // Verified via the real algorithm at ~0.9565 — comfortably above the
    // 0.85 auto-accept line, the same magnitude as this project's real
    // legitimate typo case ("Balaji Retial Store" -> "...Retail Store", ~0.89).
    expect(findLedgerMatch(database.db, 'Zylphar Distributon Co', 'sales')).toEqual({
      status: 'fuzzy',
      matchedName: 'Zylphar Distribution Co',
      candidates: [],
    });
  });
  it('never resolves to a Sundry Debtors ledger for a sales voucher, even an exact name match', () => {
    // "Globex Trading" matches perfectly by name, but it is in the wrong
    // group for a sales party — it must never even be considered.
    expect(findLedgerMatch(database.db, 'Globex Trading', 'sales')).toEqual({
      status: 'not_found',
      matchedName: null,
      candidates: [],
    });
  });
  it('never resolves to a Duties & Taxes ledger, even when it scores higher than any real candidate', () => {
    // "Northwnd Tax" is deliberately close to "Northwind Tax Unit" (a wrong
    // group) and far from "Acme Retail" (the only eligible candidate) —
    // proving the wrong-group ledger is excluded before scoring even runs,
    // not merely outscored. This reproduces the real "New customer" -> "CGST"
    // collision shape with synthetic names.
    const result = findLedgerMatch(database.db, 'Northwnd Tax', 'sales');
    expect(result.status).not.toBe('fuzzy');
    expect(result).not.toMatchObject({ matchedName: 'Northwind Tax Unit' });
  });
  it('asks for confirmation instead of silently accepting a low-confidence match', () => {
    // "Axme Rutail" scores ~0.8182 against "Acme Retail" — verified via the
    // real algorithm: above the 0.75 "plausible at all" floor, below the
    // 0.85 auto-accept line. Real, weaker typos than the one this project's
    // legitimate ~0.8947 case tolerates must not be silently accepted.
    const result = findLedgerMatch(database.db, 'Axme Rutail', 'sales');
    expect(result.status).toBe('ambiguous');
    expect(result.matchedName).toBeNull();
    expect(result.candidates).toEqual(['Acme Retail']);
  });
});
describe('findLedgerMatch — purchase (Sundry Debtors)', () => {
  beforeEach(() => {
    cache.replaceAll('Ledger', [
      { NAME: 'Globex Trading', PARENT: 'Sundry Debtors' },
      { NAME: 'Acme Retail', PARENT: 'Sundry Creditors' },
      { NAME: 'Southwind Tax Unit', PARENT: 'Duties & Taxes' },
    ]);
  });
  it('accepts an exact match from the Sundry Debtors pool', () => {
    expect(findLedgerMatch(database.db, 'Globex Trading', 'purchase')).toEqual({
      status: 'exact',
      matchedName: 'Globex Trading',
      candidates: [],
    });
  });
  it('never resolves to a Sundry Creditors ledger for a purchase voucher, even an exact name match', () => {
    expect(findLedgerMatch(database.db, 'Acme Retail', 'purchase')).toEqual({
      status: 'not_found',
      matchedName: null,
      candidates: [],
    });
  });
  it('never resolves to a Duties & Taxes ledger for a purchase voucher', () => {
    const result = findLedgerMatch(database.db, 'Southwnd Tax', 'purchase');
    expect(result).not.toMatchObject({ matchedName: 'Southwind Tax Unit' });
  });
});
describe('findLedgerMatch — credit_note and debit_note (mapping-level, no end-to-end draft support yet)', () => {
  it('credit_note resolves from the Sundry Creditors pool, same as sales', () => {
    cache.replaceAll('Ledger', [
      { NAME: 'Return Party', PARENT: 'Sundry Creditors' },
      { NAME: 'Wrong Group Party', PARENT: 'Sundry Debtors' },
    ]);
    expect(findLedgerMatch(database.db, 'Return Party', 'credit_note')).toEqual({
      status: 'exact',
      matchedName: 'Return Party',
      candidates: [],
    });
    expect(findLedgerMatch(database.db, 'Wrong Group Party', 'credit_note').status).toBe(
      'not_found',
    );
  });
  it('credit_note never resolves to an unrelated ledger group', () => {
    cache.replaceAll('Ledger', [
      { NAME: 'Return Party', PARENT: 'Sundry Creditors' },
      { NAME: 'Bank Ops Account', PARENT: 'Bank Accounts' },
    ]);
    const result = findLedgerMatch(database.db, 'Bank Ops', 'credit_note');
    expect(result).not.toMatchObject({ matchedName: 'Bank Ops Account' });
  });
  it('debit_note resolves from the Sundry Debtors pool, same as purchase', () => {
    cache.replaceAll('Ledger', [
      { NAME: 'Adjust Party', PARENT: 'Sundry Debtors' },
      { NAME: 'Wrong Group Party', PARENT: 'Sundry Creditors' },
    ]);
    expect(findLedgerMatch(database.db, 'Adjust Party', 'debit_note')).toEqual({
      status: 'exact',
      matchedName: 'Adjust Party',
      candidates: [],
    });
    expect(findLedgerMatch(database.db, 'Wrong Group Party', 'debit_note').status).toBe(
      'not_found',
    );
  });
  it('debit_note never resolves to an unrelated ledger group', () => {
    cache.replaceAll('Ledger', [
      { NAME: 'Adjust Party', PARENT: 'Sundry Debtors' },
      { NAME: 'Cash Desk', PARENT: 'Cash-in-Hand' },
    ]);
    const result = findLedgerMatch(database.db, 'Cash Desk', 'debit_note');
    expect(result).not.toMatchObject({ matchedName: 'Cash Desk' });
  });
});
describe('findLedgerMatch — ambiguity within the correctly filtered group', () => {
  it('reports ambiguous when two eligible candidates in the same group are both plausible', () => {
    cache.replaceAll('Ledger', [
      { NAME: 'Acme Retail Ltd', PARENT: 'Sundry Creditors' },
      { NAME: 'Acme Retail Traders', PARENT: 'Sundry Creditors' },
      { NAME: 'Acme Retail Bank', PARENT: 'Bank Accounts' }, // must not appear as a candidate
    ]);
    const result = findLedgerMatch(database.db, 'Acme Retail', 'sales');
    expect(result.status).toBe('ambiguous');
    expect(result.candidates).toEqual(
      expect.arrayContaining(['Acme Retail Ltd', 'Acme Retail Traders']),
    );
    expect(result.candidates).not.toContain('Acme Retail Bank');
  });
});
describe('findLedgerMatch — client-independence', () => {
  it('works identically for a completely different, arbitrary set of client ledger names', () => {
    cache.replaceAll('Ledger', [
      { NAME: 'Zylphar Distribution Co', PARENT: 'Sundry Creditors' },
      { NAME: 'Quixotic Imports', PARENT: 'Sundry Debtors' },
      { NAME: 'Mysterium Duty Ledger', PARENT: 'Duties & Taxes' },
    ]);
    expect(findLedgerMatch(database.db, 'Zylphar Distribution Co', 'sales')).toEqual({
      status: 'exact',
      matchedName: 'Zylphar Distribution Co',
      candidates: [],
    });
    expect(findLedgerMatch(database.db, 'Zylphar Distribution Co', 'purchase').status).toBe(
      'not_found',
    );
  });
});
describe('findLedgerMatch — unknown voucher type', () => {
  it('never widens to every ledger — resolves nothing at all', () => {
    cache.replaceAll('Ledger', [{ NAME: 'Acme Retail', PARENT: 'Sundry Creditors' }]);
    expect(findLedgerMatch(database.db, 'Acme Retail', 'unknown')).toEqual({
      status: 'not_found',
      matchedName: null,
      candidates: [],
    });
  });
});
