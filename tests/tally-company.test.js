import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  COMPANY_FIELDS,
  CompanyResolutionError,
  discoverCompany,
  resolveCachedCompany,
} from '../src/tally/company.js';
import { createTallyMasterCache } from '../src/tally/cache.js';
import { createTestDatabase } from './helpers/testDatabase.js';
function fakeClient(records) {
  return {
    async exportCollection() {
      return records;
    },
  };
}
describe('discoverCompany — live (fetchImpl-injected) resolution', () => {
  it('resolves the one company returned', async () => {
    const client = fakeClient([{ NAME: 'Acme Ltd', STATENAME: 'Delhi' }]);
    await expect(discoverCompany(client)).resolves.toEqual({
      name: 'Acme Ltd',
      state: 'Delhi',
      guid: null,
    });
  });
  it('fails closed when zero companies are returned', async () => {
    const client = fakeClient([]);
    await expect(discoverCompany(client)).rejects.toThrow(CompanyResolutionError);
  });
  it('fails closed when more than one company is returned — never picks one', async () => {
    const client = fakeClient([
      { NAME: 'Acme Ltd', STATENAME: 'Delhi' },
      { NAME: 'Beta Corp', STATENAME: 'Maharashtra' },
    ]);
    await expect(discoverCompany(client)).rejects.toThrow(CompanyResolutionError);
  });
  it('treats a company record with no state as an empty state, not a crash', async () => {
    const client = fakeClient([{ NAME: 'Acme Ltd' }]);
    await expect(discoverCompany(client)).resolves.toEqual({
      name: 'Acme Ltd',
      state: '',
      guid: null,
    });
  });
  it('requests GUID alongside NAME/STATENAME/GSTREGISTRATIONNUMBER — cached for future duplicate-name disambiguation, confirmed real and populated live', () => {
    expect(COMPANY_FIELDS).toContain('GUID');
  });
  it('carries the real GUID through when the record has one', async () => {
    const client = fakeClient([
      { NAME: 'Acme Ltd', STATENAME: 'Delhi', GUID: '09f68f6a-ace7-4ab4-bee8-ddea59ad0731' },
    ]);
    await expect(discoverCompany(client)).resolves.toEqual({
      name: 'Acme Ltd',
      state: 'Delhi',
      guid: '09f68f6a-ace7-4ab4-bee8-ddea59ad0731',
    });
  });
});
describe('resolveCachedCompany — cache-only resolution (never talks to Tally)', () => {
  let database;
  beforeEach(() => {
    database = createTestDatabase();
  });
  afterEach(() => {
    database.close();
  });
  it('resolves the one cached company', () => {
    createTallyMasterCache({ db: database.db }).replaceAll('Company', [
      { NAME: 'Acme Ltd', STATENAME: 'Delhi' },
    ]);
    expect(resolveCachedCompany(database.db)).toEqual({
      name: 'Acme Ltd',
      state: 'Delhi',
      guid: null,
    });
  });
  it('resolves the real cached GUID when one was synced', () => {
    createTallyMasterCache({ db: database.db }).replaceAll('Company', [
      { NAME: 'Acme Ltd', STATENAME: 'Delhi', GUID: '09f68f6a-ace7-4ab4-bee8-ddea59ad0731' },
    ]);
    expect(resolveCachedCompany(database.db).guid).toBe('09f68f6a-ace7-4ab4-bee8-ddea59ad0731');
  });
  it('fails closed when nothing has been synced yet', () => {
    expect(() => resolveCachedCompany(database.db)).toThrow(CompanyResolutionError);
  });
  it('fails closed when more than one company is cached', () => {
    createTallyMasterCache({ db: database.db }).replaceAll('Company', [
      { NAME: 'Acme Ltd', STATENAME: 'Delhi' },
      { NAME: 'Beta Corp', STATENAME: 'Maharashtra' },
    ]);
    expect(() => resolveCachedCompany(database.db)).toThrow(CompanyResolutionError);
  });
  it('works identically for an arbitrary, different client company name — nothing hardcoded', () => {
    createTallyMasterCache({ db: database.db }).replaceAll('Company', [
      { NAME: 'Zylphar Distribution Co', STATENAME: 'Karnataka' },
    ]);
    expect(resolveCachedCompany(database.db)).toEqual({
      name: 'Zylphar Distribution Co',
      state: 'Karnataka',
      guid: null,
    });
  });
});
