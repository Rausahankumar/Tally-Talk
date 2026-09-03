import { describe, expect, it } from 'vitest';

import { parseClosingBalance, syncStockAvailability } from '../src/tally/stockAvailability.ts';
import type { StockAvailabilityRow, StockAvailabilityStore } from '../src/tally/stockAvailability.ts';
import type { TallyClient } from '../src/tally/client.ts';
import type { RawMasterRecord } from '../src/tally/xml.ts';

describe('parseClosingBalance', () => {
  it('parses a decimal quantity with a multi-letter unit', () => {
    expect(parseClosingBalance(' 490.000 KG')).toEqual({ quantity: 490, unit: 'KG' });
  });

  it('parses a whole-number quantity', () => {
    expect(parseClosingBalance('198 Nos')).toEqual({ quantity: 198, unit: 'Nos' });
  });

  it('parses zero', () => {
    expect(parseClosingBalance('0 Nos')).toEqual({ quantity: 0, unit: 'Nos' });
  });

  it('parses a negative quantity — a real balance can go negative in this data', () => {
    expect(parseClosingBalance('-5 Nos')).toEqual({ quantity: -5, unit: 'Nos' });
  });

  it('tolerates no leading whitespace', () => {
    expect(parseClosingBalance('300 Nos')).toEqual({ quantity: 300, unit: 'Nos' });
  });

  it('returns null for an empty string rather than guessing a value', () => {
    expect(parseClosingBalance('')).toBeNull();
    expect(parseClosingBalance('   ')).toBeNull();
  });

  it('returns null when there is no unit at all', () => {
    expect(parseClosingBalance('490')).toBeNull();
  });

  it('returns null for non-numeric garbage', () => {
    expect(parseClosingBalance('not a quantity')).toBeNull();
  });
});

function fakeClient(byStockItem: Record<string, RawMasterRecord[]>): TallyClient {
  return {
    async exportCollection(_masterType, _fields, options) {
      const childOf = options?.childOf;
      if (childOf === undefined) return [];
      return byStockItem[childOf] ?? [];
    },
  };
}

function fakeStore(): StockAvailabilityStore & {
  calls: [string, readonly StockAvailabilityRow[]][];
} {
  const calls: [string, readonly StockAvailabilityRow[]][] = [];
  return {
    calls,
    getAvailability: () => [],
    getGodownsWithSufficientStock: () => [],
    replaceAllForItem(stockItemName, rows) {
      calls.push([stockItemName, rows]);
    },
  };
}

describe('syncStockAvailability', () => {
  it('scopes the Batch collection to each stock item via CHILDOF', async () => {
    const requested: (string | undefined)[] = [];
    const client: TallyClient = {
      async exportCollection(_masterType, _fields, options) {
        requested.push(options?.childOf);
        return [];
      },
    };

    await syncStockAvailability(client, fakeStore(), ['Apple', 'Steel Rods']);

    expect(requested).toEqual(['Apple', 'Steel Rods']);
  });

  it('parses real-shaped rows into StockAvailabilityRow entries', async () => {
    const client = fakeClient({
      Apple: [{ NAME: '1', PARENT: 'Apple', GODOWNNAME: 'Main Location', CLOSINGBALANCE: ' 490.000 KG' }],
    });
    const store = fakeStore();

    await syncStockAvailability(client, store, ['Apple']);

    expect(store.calls).toEqual([
      ['Apple', [{ batchName: '1', godownName: 'Main Location', quantity: 490, unit: 'KG' }]],
    ]);
  });

  it('handles multiple godown rows for a non-batch-tracked item (implicit "Primary Batch")', async () => {
    const client = fakeClient({
      'AMD Ryzen  Processor': [
        { NAME: 'Primary Batch', PARENT: 'AMD Ryzen  Processor', GODOWNNAME: 'Main Location', CLOSINGBALANCE: '198 Nos' },
        { NAME: 'Primary Batch', PARENT: 'AMD Ryzen  Processor', GODOWNNAME: 'Warehouse B', CLOSINGBALANCE: '0 Nos' },
      ],
    });
    const store = fakeStore();

    await syncStockAvailability(client, store, ['AMD Ryzen  Processor']);

    expect(store.calls[0]?.[1]).toEqual([
      { batchName: 'Primary Batch', godownName: 'Main Location', quantity: 198, unit: 'Nos' },
      { batchName: 'Primary Batch', godownName: 'Warehouse B', quantity: 0, unit: 'Nos' },
    ]);
  });

  it('drops an incomplete row rather than guessing a missing field', async () => {
    const client = fakeClient({
      Widget: [
        { NAME: 'Primary Batch', PARENT: 'Widget', GODOWNNAME: 'Main Location' }, // no CLOSINGBALANCE
        { NAME: 'Primary Batch', PARENT: 'Widget', CLOSINGBALANCE: '10 Nos' }, // no GODOWNNAME
        { PARENT: 'Widget', GODOWNNAME: 'Main Location', CLOSINGBALANCE: '10 Nos' }, // no NAME
      ],
    });
    const store = fakeStore();

    await syncStockAvailability(client, store, ['Widget']);

    expect(store.calls).toEqual([['Widget', []]]);
  });

  it('replaces rows for one item even when it has zero results, and continues to the next item', async () => {
    const client = fakeClient({
      Apple: [{ NAME: '1', PARENT: 'Apple', GODOWNNAME: 'Main Location', CLOSINGBALANCE: '490.000 KG' }],
      // 'Ghost Item' intentionally not in byStockItem — resolves to [].
    });
    const store = fakeStore();

    const results = await syncStockAvailability(client, store, ['Ghost Item', 'Apple']);

    expect(results).toEqual([
      { stockItemName: 'Ghost Item', count: 0 },
      { stockItemName: 'Apple', count: 1 },
    ]);
    expect(store.calls.map(([name]) => name)).toEqual(['Ghost Item', 'Apple']);
  });
});
