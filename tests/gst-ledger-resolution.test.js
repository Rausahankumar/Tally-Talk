import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveGstLedger, resolveGstLedgers } from '../src/gst/gstLedgerResolution.js';
import { createTallyMasterCache } from '../src/tally/cache.js';
import { createTestDatabase } from './helpers/testDatabase.js';
let database;
let cache;
beforeEach(() => {
  database = createTestDatabase();
  cache = createTallyMasterCache({ db: database.db });
});
afterEach(() => {
  database.close();
});
describe('resolveGstLedger — exact TAXTYPE + GSTDUTYHEAD classification', () => {
  it('resolves CGST', () => {
    cache.replaceAll('Ledger', [
      { NAME: 'CGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'CGST' },
    ]);
    expect(resolveGstLedger(database.db, 'CGST')).toEqual({
      status: 'resolved',
      ledgerName: 'CGST',
      candidates: [],
    });
  });
  it('resolves SGST/UTGST', () => {
    cache.replaceAll('Ledger', [
      { NAME: 'SGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'SGST/UTGST' },
    ]);
    expect(resolveGstLedger(database.db, 'SGST/UTGST')).toEqual({
      status: 'resolved',
      ledgerName: 'SGST',
      candidates: [],
    });
  });
  it('resolves IGST generically — never a hardcoded or guessed name, the same mechanism as CGST/SGST', () => {
    cache.replaceAll('Ledger', [
      { NAME: 'Interstate Tax Ledger', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'IGST' },
    ]);
    expect(resolveGstLedger(database.db, 'IGST')).toEqual({
      status: 'resolved',
      ledgerName: 'Interstate Tax Ledger',
      candidates: [],
    });
  });
  it('rejects a ledger with the right duty head but the wrong TAXTYPE', () => {
    cache.replaceAll('Ledger', [
      { NAME: 'VAT', PARENT: 'Duties & Taxes', TAXTYPE: 'VAT', GSTDUTYHEAD: 'CGST' }, // contrived: wrong TAXTYPE
    ]);
    expect(resolveGstLedger(database.db, 'CGST').status).toBe('not_found');
  });
  it('rejects a ledger with the right TAXTYPE but no GSTDUTYHEAD at all — proves PARENT/TAXTYPE alone is insufficient', () => {
    // Mirrors the real verified case: a VAT ledger sits in the same "Duties &
    // Taxes" group as CGST/SGST but carries TAXTYPE=VAT and no GSTDUTYHEAD.
    cache.replaceAll('Ledger', [{ NAME: 'VAT', PARENT: 'Duties & Taxes', TAXTYPE: 'VAT' }]);
    expect(resolveGstLedger(database.db, 'CGST').status).toBe('not_found');
  });
  it('never mistakes a VAT ledger in the same group for a GST ledger', () => {
    cache.replaceAll('Ledger', [
      { NAME: 'CGST', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'CGST' },
      { NAME: 'VAT', PARENT: 'Duties & Taxes', TAXTYPE: 'VAT' },
    ]);
    const result = resolveGstLedger(database.db, 'CGST');
    expect(result.ledgerName).toBe('CGST');
    expect(result.ledgerName).not.toBe('VAT');
  });
  it('fails closed on zero matching ledgers, never inventing one', () => {
    cache.replaceAll('Ledger', []);
    expect(resolveGstLedger(database.db, 'CGST')).toEqual({
      status: 'not_found',
      ledgerName: null,
      candidates: [],
    });
  });
  it('fails closed on more than one ledger classified with the same duty head — never picks one', () => {
    cache.replaceAll('Ledger', [
      { NAME: 'CGST Main', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'CGST' },
      { NAME: 'CGST Alt', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'CGST' },
    ]);
    const result = resolveGstLedger(database.db, 'CGST');
    expect(result.status).toBe('ambiguous');
    expect(result.ledgerName).toBeNull();
    expect(result.candidates).toEqual(expect.arrayContaining(['CGST Main', 'CGST Alt']));
  });
});
describe('resolveGstLedgers — all three duty heads in one pass', () => {
  it('resolves all three independently, using an arbitrary client naming scheme', () => {
    cache.replaceAll('Ledger', [
      { NAME: 'Central GST Payable', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'CGST' },
      { NAME: 'State GST Payable', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'SGST/UTGST' },
      { NAME: 'Integrated GST Payable', PARENT: 'Duties & Taxes', TAXTYPE: 'GST', GSTDUTYHEAD: 'IGST' },
    ]);
    const resolved = resolveGstLedgers(database.db);
    expect(resolved.cgst).toEqual({ status: 'resolved', ledgerName: 'Central GST Payable', candidates: [] });
    expect(resolved.sgst).toEqual({ status: 'resolved', ledgerName: 'State GST Payable', candidates: [] });
    expect(resolved.igst).toEqual({ status: 'resolved', ledgerName: 'Integrated GST Payable', candidates: [] });
  });
});
