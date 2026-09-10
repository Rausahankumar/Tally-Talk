import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runFullSync } from '../src/tally/fullSync.js';
import { readCachedMasters } from '../src/tally/cache.js';
import { silentLogger } from '../src/logger.js';
import { createTestDatabase } from './helpers/testDatabase.js';
/** Matches the `{ exportCollection }` shape every other test in this project
 * already fakes — never a real Tally connection or raw XML. */
function fakeClient(byType) {
  const calls = [];
  return {
    calls,
    async exportCollection(masterType, fields, options) {
      calls.push({ masterType, fields, options });
      if (masterType === 'Batch') return []; // no stock fixtures needed for these tests
      return byType[masterType] ?? [];
    },
  };
}
let database;
beforeEach(() => {
  database = createTestDatabase();
});
afterEach(() => {
  database.close();
});
describe('runFullSync — company discovery branching', () => {
  it('discovers the company live and caches it when no companyName is given', async () => {
    const clientCalls = [];
    const createClient = (opts) => {
      clientCalls.push(opts);
      return fakeClient({
        Company: [{ NAME: 'Acme Ltd', STATENAME: 'Delhi', GUID: 'guid-1' }],
        Ledger: [{ NAME: 'Cash', PARENT: '' }],
        StockItem: [],
        Godown: [],
        Unit: [],
        VoucherType: [],
      });
    };
    const result = await runFullSync({
      host: '127.0.0.1',
      port: 9000,
      db: database.db,
      logger: silentLogger,
      createClient,
    });
    expect(result.companyName).toBe('Acme Ltd');
    // First client built with no companyName at all (discovery), second scoped to it.
    expect(clientCalls[0].companyName).toBeUndefined();
    expect(clientCalls[1].companyName).toBe('Acme Ltd');
    const cachedCompany = readCachedMasters(database.db, 'Company');
    expect(cachedCompany[0]?.data).toMatchObject({ NAME: 'Acme Ltd', STATENAME: 'Delhi', GUID: 'guid-1' });
  });
  it('skips discovery entirely when companyName is already known — never re-picks a company', async () => {
    const clientCalls = [];
    const createClient = (opts) => {
      clientCalls.push(opts);
      return fakeClient({ Ledger: [{ NAME: 'Cash', PARENT: '' }] });
    };
    const result = await runFullSync({
      host: '127.0.0.1',
      port: 9000,
      db: database.db,
      logger: silentLogger,
      companyName: 'Nirmal FMCG Traders Ltd',
      createClient,
    });
    expect(result.companyName).toBe('Nirmal FMCG Traders Ltd');
    // Exactly one client built — no separate discovery client at all.
    expect(clientCalls).toHaveLength(1);
    expect(clientCalls[0].companyName).toBe('Nirmal FMCG Traders Ltd');
    // Company itself is never re-synced when already known — a runtime
    // refresh on a Ledger/StockItem/Godown miss has no reason to touch it.
    expect(readCachedMasters(database.db, 'Company')).toEqual([]);
  });
  it('every non-Batch master type is fetched, and results are returned in the same shape the CLI logs', async () => {
    const createClient = () =>
      fakeClient({
        Ledger: [{ NAME: 'Cash', PARENT: '' }, { NAME: 'Sales', PARENT: '' }],
        StockItem: [{ NAME: 'Widget', PARENT: '' }],
        Godown: [{ NAME: 'Main', PARENT: '' }],
        Unit: [{ NAME: 'Nos' }],
        VoucherType: [{ NAME: 'Sales', PARENT: '' }],
      });
    const result = await runFullSync({
      host: '127.0.0.1',
      port: 9000,
      db: database.db,
      logger: silentLogger,
      companyName: 'Acme Ltd',
      createClient,
    });
    const counts = Object.fromEntries(result.masterResults.map((r) => [r.type, r.count]));
    expect(counts).toEqual({ Ledger: 2, StockItem: 1, Godown: 1, Unit: 1, VoucherType: 1 });
    expect(readCachedMasters(database.db, 'StockItem').map((r) => r.name)).toEqual(['Widget']);
  });
  it('syncs stock availability per stock item just synced, using Batch/CHILDOF, never company-wide', async () => {
    const requestedTypes = [];
    const createClient = () => {
      const client = fakeClient({ StockItem: [{ NAME: 'Widget', PARENT: '' }] });
      const original = client.exportCollection.bind(client);
      client.exportCollection = async (masterType, fields, options) => {
        requestedTypes.push({ masterType, childOf: options?.childOf });
        return original(masterType, fields, options);
      };
      return client;
    };
    await runFullSync({
      host: '127.0.0.1',
      port: 9000,
      db: database.db,
      logger: silentLogger,
      companyName: 'Acme Ltd',
      createClient,
    });
    const batchCall = requestedTypes.find((c) => c.masterType === 'Batch');
    expect(batchCall?.childOf).toBe('Widget');
  });
});
