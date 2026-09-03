import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createStockAvailabilityCache } from '../src/tally/stockAvailabilityCache.ts';
import type { StockAvailabilityStore } from '../src/tally/stockAvailability.ts';
import type { Database } from '../src/db/sqlite.ts';
import { createTestDatabase } from './helpers/testDatabase.ts';

let database: Database;
let store: StockAvailabilityStore;

beforeEach(() => {
  database = createTestDatabase();
  store = createStockAvailabilityCache({ db: database.db });
});

afterEach(() => {
  database.close();
});

describe('getAvailability', () => {
  it('returns the single cached row for an exact stock item + godown', () => {
    store.replaceAllForItem('Apple', [
      { batchName: '1', godownName: 'Main Location', quantity: 490, unit: 'KG' },
    ]);

    expect(store.getAvailability('Apple', 'Main Location')).toEqual([
      { batchName: '1', godownName: 'Main Location', quantity: 490, unit: 'KG' },
    ]);
  });

  it('returns an empty array when nothing is cached — stale/missing data, never guessed', () => {
    expect(store.getAvailability('Nonexistent Item', 'Main Location')).toEqual([]);
  });

  it('returns multiple rows when more than one batch exists for the same item + godown', () => {
    store.replaceAllForItem('Steel Rods', [
      { batchName: '1', godownName: 'Main Location', quantity: 50, unit: 'Kg' },
      { batchName: '2', godownName: 'Main Location', quantity: 200, unit: 'Kg' },
    ]);

    expect(store.getAvailability('Steel Rods', 'Main Location')).toHaveLength(2);
  });

  it('does not fuzzy-match — a near-miss stock item name returns nothing', () => {
    store.replaceAllForItem('Steel Rods', [
      { batchName: 'Primary Batch', godownName: 'Main Location', quantity: 1000, unit: 'Kg' },
    ]);

    expect(store.getAvailability('Steel Rod', 'Main Location')).toEqual([]);
    expect(store.getAvailability('steel rods', 'Main Location')).toEqual([]); // case-sensitive too
  });

  it('does not fuzzy-match — a near-miss godown name returns nothing', () => {
    store.replaceAllForItem('Steel Rods', [
      { batchName: 'Primary Batch', godownName: 'Main Location', quantity: 1000, unit: 'Kg' },
    ]);

    expect(store.getAvailability('Steel Rods', 'Main Locatio')).toEqual([]);
  });

  it('scopes strictly to the requested godown — a row in another godown is not returned', () => {
    store.replaceAllForItem('Steel Rods', [
      { batchName: 'Primary Batch', godownName: 'Main Location', quantity: 1000, unit: 'Kg' },
      { batchName: 'Primary Batch', godownName: 'Warehouse B', quantity: 500, unit: 'Kg' },
    ]);

    expect(store.getAvailability('Steel Rods', 'Main Location')).toEqual([
      { batchName: 'Primary Batch', godownName: 'Main Location', quantity: 1000, unit: 'Kg' },
    ]);
  });
});

describe('getGodownsWithSufficientStock', () => {
  it('returns godowns whose total quantity meets the requirement, excluding the given godown', () => {
    store.replaceAllForItem('Steel Rods', [
      { batchName: 'Primary Batch', godownName: 'Main Location', quantity: 50, unit: 'Kg' },
      { batchName: 'Primary Batch', godownName: 'Warehouse B', quantity: 500, unit: 'Kg' },
    ]);

    expect(store.getGodownsWithSufficientStock('Steel Rods', 100, 'Main Location')).toEqual([
      { godown: 'Warehouse B', availableQuantity: 500 },
    ]);
  });

  it('sums multiple batches within one godown', () => {
    store.replaceAllForItem('Steel Rods', [
      { batchName: '1', godownName: 'Warehouse B', quantity: 40, unit: 'Kg' },
      { batchName: '2', godownName: 'Warehouse B', quantity: 40, unit: 'Kg' },
    ]);

    // Neither batch alone reaches 60, but their sum does.
    expect(store.getGodownsWithSufficientStock('Steel Rods', 60, 'Main Location')).toEqual([
      { godown: 'Warehouse B', availableQuantity: 80 },
    ]);
  });

  it('excludes a godown whose total is still short of what is required', () => {
    store.replaceAllForItem('Steel Rods', [
      { batchName: 'Primary Batch', godownName: 'Warehouse B', quantity: 10, unit: 'Kg' },
    ]);

    expect(store.getGodownsWithSufficientStock('Steel Rods', 100, 'Main Location')).toEqual([]);
  });

  it('returns an empty array when there is no other godown at all', () => {
    store.replaceAllForItem('Steel Rods', [
      { batchName: 'Primary Batch', godownName: 'Main Location', quantity: 1000, unit: 'Kg' },
    ]);

    expect(store.getGodownsWithSufficientStock('Steel Rods', 1, 'Main Location')).toEqual([]);
  });
});

describe('replaceAllForItem', () => {
  it('replaces every prior row for the item, not just adding to them', () => {
    store.replaceAllForItem('Apple', [
      { batchName: '1', godownName: 'Main Location', quantity: 490, unit: 'KG' },
    ]);
    store.replaceAllForItem('Apple', [
      { batchName: '1', godownName: 'Main Location', quantity: 300, unit: 'KG' },
    ]);

    expect(store.getAvailability('Apple', 'Main Location')).toEqual([
      { batchName: '1', godownName: 'Main Location', quantity: 300, unit: 'KG' },
    ]);
  });

  it('can replace with zero rows, clearing all cached availability for that item', () => {
    store.replaceAllForItem('Apple', [
      { batchName: '1', godownName: 'Main Location', quantity: 490, unit: 'KG' },
    ]);
    store.replaceAllForItem('Apple', []);

    expect(store.getAvailability('Apple', 'Main Location')).toEqual([]);
  });

  it('leaves other stock items untouched', () => {
    store.replaceAllForItem('Apple', [
      { batchName: '1', godownName: 'Main Location', quantity: 490, unit: 'KG' },
    ]);
    store.replaceAllForItem('Steel Rods', [
      { batchName: 'Primary Batch', godownName: 'Main Location', quantity: 1000, unit: 'Kg' },
    ]);

    store.replaceAllForItem('Apple', []);

    expect(store.getAvailability('Steel Rods', 'Main Location')).toHaveLength(1);
  });
});
