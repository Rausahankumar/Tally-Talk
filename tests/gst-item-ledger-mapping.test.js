import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createItemLedgerMappingStore } from '../src/gst/itemLedgerMapping.js';
import { createTestDatabase } from './helpers/testDatabase.js';
let database;
let store;
beforeEach(() => {
  database = createTestDatabase();
  store = createItemLedgerMappingStore(database.db);
});
afterEach(() => {
  database.close();
});
describe('ItemLedgerMappingStore', () => {
  it('returns null when nothing is configured for an item', () => {
    expect(store.getMapping('Steel Rods')).toBeNull();
  });
  it('stores and returns a mapping', () => {
    store.setMapping({
      stockItemName: 'ACC Cement OPC 43 Grade',
      salesLedger: 'Sales @ 18%',
      purchaseLedger: 'Purchase @ 18%',
    });
    expect(store.getMapping('ACC Cement OPC 43 Grade')).toEqual({
      stockItemName: 'ACC Cement OPC 43 Grade',
      salesLedger: 'Sales @ 18%',
      purchaseLedger: 'Purchase @ 18%',
    });
  });
  it('looks up by exact name only, not fuzzily', () => {
    store.setMapping({
      stockItemName: 'ACC Cement OPC 43 Grade',
      salesLedger: 'Sales @ 18%',
      purchaseLedger: 'Purchase @ 18%',
    });
    expect(store.getMapping('acc cement opc 43 grade')).toBeNull();
    expect(store.getMapping('Cement')).toBeNull();
  });
  it('replaces an existing mapping rather than erroring or duplicating', () => {
    store.setMapping({
      stockItemName: 'Steel Rods',
      salesLedger: 'Sales A',
      purchaseLedger: 'Purchase A',
    });
    store.setMapping({
      stockItemName: 'Steel Rods',
      salesLedger: 'Sales B',
      purchaseLedger: 'Purchase B',
    });
    expect(store.getMapping('Steel Rods')).toEqual({
      stockItemName: 'Steel Rods',
      salesLedger: 'Sales B',
      purchaseLedger: 'Purchase B',
    });
    const count = database.db
      .prepare('SELECT COUNT(*) c FROM item_ledger_mappings WHERE stock_item_name = ?')
      .get('Steel Rods');
    expect(count.c).toBe(1);
  });
  it('never touches Tally masters — this is purely an application-side table', () => {
    store.setMapping({
      stockItemName: 'Steel Rods',
      salesLedger: 'Sales',
      purchaseLedger: 'Purchase',
    });
    const tallyTables = database.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all();
    expect(tallyTables.map((t) => t.name)).toContain('tally_masters');
    // The mapping table is entirely separate from tally_masters — setting a
    // mapping does not write any row there.
    expect(database.db.prepare('SELECT COUNT(*) c FROM tally_masters').get().c).toBe(0);
  });
  it('keeps different items independent', () => {
    store.setMapping({
      stockItemName: 'Steel Rods',
      salesLedger: 'Sales A',
      purchaseLedger: 'Purchase A',
    });
    store.setMapping({
      stockItemName: 'Cement Bags',
      salesLedger: 'Sales B',
      purchaseLedger: 'Purchase B',
    });
    expect(store.getMapping('Steel Rods')?.salesLedger).toBe('Sales A');
    expect(store.getMapping('Cement Bags')?.salesLedger).toBe('Sales B');
  });
});
