import { describe, expect, it } from 'vitest';
import { MASTER_DEFINITIONS, syncMasterData } from '../src/tally/masters.js';
function fakeClient(byType) {
  return {
    async exportCollection(masterType) {
      return byType[masterType] ?? [];
    },
  };
}
function fakeCache() {
  const calls = [];
  return {
    calls,
    replaceAll(masterType, records) {
      calls.push([masterType, records]);
    },
  };
}
describe('syncMasterData', () => {
  it('syncs every defined master type', async () => {
    const client = fakeClient({
      Ledger: [{ NAME: 'Ramesh' }, { NAME: 'Suresh' }],
      StockItem: [{ NAME: 'Cement' }],
      Godown: [],
      Unit: [{ NAME: 'KG' }],
      VoucherType: [{ NAME: 'Sales' }],
    });
    const cache = fakeCache();
    const results = await syncMasterData(client, cache);
    expect(results).toEqual(
      MASTER_DEFINITIONS.map((d) => ({
        type: d.type,
        count: { Ledger: 2, StockItem: 1, Godown: 0, Unit: 1, VoucherType: 1 }[d.type],
      })),
    );
    expect(cache.calls.map(([type]) => type)).toEqual(MASTER_DEFINITIONS.map((d) => d.type));
  });
  it('caches an empty result rather than skipping the type', async () => {
    const client = fakeClient({});
    const cache = fakeCache();
    await syncMasterData(client, cache);
    for (const [, records] of cache.calls) {
      expect(records).toEqual([]);
    }
  });
  it('fetches the fields declared for each master type', async () => {
    const requested = [];
    const client = {
      async exportCollection(masterType, fields) {
        requested.push([masterType, fields]);
        return [];
      },
    };
    await syncMasterData(client, fakeCache());
    for (const definition of MASTER_DEFINITIONS) {
      const call = requested.find(([type]) => type === definition.type);
      expect(call?.[1]).toEqual(definition.fields);
    }
  });
  it('passes StockItem\'s specialised parser through to exportCollection, and no other type\'s', async () => {
    const requestedOptions = [];
    const client = {
      async exportCollection(masterType, _fields, exportOptions) {
        requestedOptions.push([masterType, exportOptions]);
        return [];
      },
    };
    await syncMasterData(client, fakeCache());
    const stockItemDefinition = MASTER_DEFINITIONS.find((d) => d.type === 'StockItem');
    for (const [type, exportOptions] of requestedOptions) {
      if (type === 'StockItem') {
        expect(exportOptions).toEqual({ parse: stockItemDefinition.parse });
      } else {
        expect(exportOptions).toBeUndefined();
      }
    }
  });
});
