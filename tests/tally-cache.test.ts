import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTallyMasterCache, readCachedMasters } from '../src/tally/cache.ts';
import type { MasterCache } from '../src/tally/masters.ts';
import type { Database } from '../src/db/sqlite.ts';
import { createTestDatabase } from './helpers/testDatabase.ts';

let database: Database;
let cache: MasterCache;

beforeEach(() => {
  database = createTestDatabase();
  cache = createTallyMasterCache({ db: database.db });
});

afterEach(() => {
  database.close();
});

describe('tally master cache', () => {
  it('stores records and reads them back by type', () => {
    cache.replaceAll('Ledger', [{ NAME: 'Ramesh', PARENT: 'Sundry Debtors' }]);

    const rows = readCachedMasters(database.db, 'Ledger');

    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('Ramesh');
    expect(rows[0]?.data).toEqual({ NAME: 'Ramesh', PARENT: 'Sundry Debtors' });
    expect(rows[0]?.syncedAt).toBeInstanceOf(Date);
  });

  it('replaces the previous sync rather than accumulating duplicates', () => {
    cache.replaceAll('Ledger', [{ NAME: 'Old One' }]);
    cache.replaceAll('Ledger', [{ NAME: 'New One' }]);

    const rows = readCachedMasters(database.db, 'Ledger');

    expect(rows.map((r) => r.name)).toEqual(['New One']);
  });

  it('keeps master types independent', () => {
    cache.replaceAll('Ledger', [{ NAME: 'Ramesh' }]);
    cache.replaceAll('Godown', [{ NAME: 'Main Location' }]);

    expect(readCachedMasters(database.db, 'Ledger').map((r) => r.name)).toEqual(['Ramesh']);
    expect(readCachedMasters(database.db, 'Godown').map((r) => r.name)).toEqual(['Main Location']);
  });

  it('replaces with an empty set when Tally returns no records of a type', () => {
    cache.replaceAll('Godown', [{ NAME: 'Main Location' }]);
    cache.replaceAll('Godown', []);

    expect(readCachedMasters(database.db, 'Godown')).toEqual([]);
  });

  it('skips a record with no NAME rather than storing something unlookupable', () => {
    cache.replaceAll('Ledger', [{ PARENT: 'Sundry Debtors' }, { NAME: 'Ramesh' }]);

    expect(readCachedMasters(database.db, 'Ledger').map((r) => r.name)).toEqual(['Ramesh']);
  });

  it('leaves other types untouched when one type is resynced', () => {
    cache.replaceAll('Ledger', [{ NAME: 'Ramesh' }]);
    cache.replaceAll('Godown', [{ NAME: 'Main Location' }]);
    cache.replaceAll('Ledger', [{ NAME: 'Suresh' }]);

    expect(readCachedMasters(database.db, 'Godown').map((r) => r.name)).toEqual(['Main Location']);
  });
});
