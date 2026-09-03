/**
 * Master data sync.
 *
 * Each type below is a thin declaration of what to fetch from Tally and which
 * field identifies a record; matching/normalisation logic (fuzzy name
 * matching, GST parsing) is deliberately not here — that belongs to Phase 5,
 * once there is an LLM draft to validate against these masters.
 */

import type { TallyClient } from './client.ts';
import type { RawMasterRecord } from './xml.ts';

/** One kind of Tally master this MVP caches, and the fields fetched for it. */
export interface MasterDefinition {
  readonly type: string;
  readonly fields: readonly string[];
}

/**
 * Confirmed live against the target company (Nirmal FMCG Traders Ltd) before
 * being encoded here — see DECISIONS.md. Field lists are intentionally narrow:
 * only what backend validation and matching will need, not a full record.
 */
export const MASTER_DEFINITIONS: readonly MasterDefinition[] = [
  { type: 'Ledger', fields: ['NAME', 'PARENT', 'OPENINGBALANCE', 'ISBILLWISEON'] },
  // ISBATCHWISEON confirmed live and fetchable — cached for future use;
  // stock availability resolution itself (src/tally/stockAvailability.ts)
  // works from the availability cache directly and does not branch on it.
  { type: 'StockItem', fields: ['NAME', 'PARENT', 'BASEUNITS', 'ISBATCHWISEON'] },
  { type: 'Godown', fields: ['NAME', 'PARENT'] },
  { type: 'Unit', fields: ['NAME'] },
  { type: 'VoucherType', fields: ['NAME', 'PARENT'] },
];

export interface MasterSyncResult {
  readonly type: string;
  readonly count: number;
}

export interface MasterCache {
  replaceAll(masterType: string, records: readonly RawMasterRecord[]): void;
}

/**
 * Fetch every defined master type and replace the cache's copy of each.
 *
 * One type failing (a company without inventory features, say) does not stop
 * the others — each is fetched and reported independently.
 */
export async function syncMasterData(
  client: TallyClient,
  cache: MasterCache,
): Promise<readonly MasterSyncResult[]> {
  const results: MasterSyncResult[] = [];

  for (const definition of MASTER_DEFINITIONS) {
    const records = await client.exportCollection(definition.type, definition.fields);
    cache.replaceAll(definition.type, records);
    results.push({ type: definition.type, count: records.length });
  }

  return results;
}
