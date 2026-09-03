/**
 * Stock availability sync: batch + godown scoped closing quantity per stock
 * item.
 *
 * Unlike the flat masters in masters.ts, `Batch` cannot be enumerated
 * company-wide — `TYPE=Batch` alone returns zero rows even when real batches
 * exist (confirmed live). Batches are only enumerable scoped to one stock
 * item via `CHILDOF`, so this syncs one stock item at a time, given the
 * stock item names already cached from the regular master sync.
 *
 * Confirmed live query shape and response semantics (see DECISIONS.md):
 *   TYPE=Batch, CHILDOF=<exact stock item name>, FETCH=NAME, PARENT,
 *   GODOWNNAME, CLOSINGBALANCE
 * returns one row per (item, godown, batch) combination that currently holds
 * a balance, e.g. NAME="1", PARENT="Apple", GODOWNNAME="Main Location",
 * CLOSINGBALANCE=" 490.000 KG". A non-batch-tracked item's stock still comes
 * back this way, under Tally's implicit "Primary Batch".
 */

import type { TallyClient } from './client.ts';
import type { RawMasterRecord } from './xml.ts';

const STOCK_AVAILABILITY_FIELDS = ['NAME', 'PARENT', 'GODOWNNAME', 'CLOSINGBALANCE'] as const;

/** One cached (batch, godown) balance for a stock item known from context. */
export interface StockAvailabilityRow {
  readonly batchName: string;
  readonly godownName: string;
  readonly quantity: number;
  readonly unit: string;
}

export interface GodownAvailability {
  readonly godown: string;
  readonly availableQuantity: number;
}

export interface StockAvailabilityStore {
  /**
   * Every cached row for one exact stock item + godown — 0 (no data cached),
   * 1 (resolvable), or more (ambiguous: which batch is never guessed).
   */
  getAvailability(stockItemName: string, godownName: string): readonly StockAvailabilityRow[];
  /**
   * Godowns other than `excludeGodown` where this item's total cached
   * quantity (summed across whatever batches exist there) meets
   * `requiredQuantity` — deterministic candidates only, never auto-selected.
   */
  getGodownsWithSufficientStock(
    stockItemName: string,
    requiredQuantity: number,
    excludeGodown: string,
  ): readonly GodownAvailability[];
  /** Replace every cached row for one stock item. Never touches Tally. */
  replaceAllForItem(stockItemName: string, rows: readonly StockAvailabilityRow[]): void;
}

export interface StockAvailabilitySyncResult {
  readonly stockItemName: string;
  readonly count: number;
}

/**
 * Parse Tally's raw `CLOSINGBALANCE` string (e.g. `" 490.000 KG"`, `"-5
 * Nos"`, `"0 Nos"`) into a plain number and its unit. The raw string is never
 * used for quantity comparison directly — see `RawMasterRecord`'s own doc in
 * xml.ts for why.
 */
export function parseClosingBalance(raw: string): { readonly quantity: number; readonly unit: string } | null {
  const match = /^\s*(-?[\d.]+)\s+(\S.*?)\s*$/.exec(raw);
  if (match === null) return null;

  const quantity = Number(match[1]);
  const unit = match[2]!;
  if (!Number.isFinite(quantity)) return null;

  return { quantity, unit };
}

function toAvailabilityRow(record: RawMasterRecord): StockAvailabilityRow | null {
  const batchName = record.NAME;
  const godownName = record.GODOWNNAME;
  const closingBalance = record.CLOSINGBALANCE;
  if (!batchName || !godownName || closingBalance === undefined) return null; // Incomplete — never guessed.

  const parsed = parseClosingBalance(closingBalance);
  if (parsed === null) return null;

  return { batchName, godownName, quantity: parsed.quantity, unit: parsed.unit };
}

/**
 * Sync stock availability for every given stock item name. One item failing
 * (e.g. a stale name no longer in Tally) does not stop the others — each is
 * fetched and reported independently, the same pattern as `syncMasterData`.
 */
export async function syncStockAvailability(
  client: TallyClient,
  store: StockAvailabilityStore,
  stockItemNames: readonly string[],
): Promise<readonly StockAvailabilitySyncResult[]> {
  const results: StockAvailabilitySyncResult[] = [];

  for (const stockItemName of stockItemNames) {
    const records = await client.exportCollection('Batch', [...STOCK_AVAILABILITY_FIELDS], {
      childOf: stockItemName,
    });
    const rows = records.map(toAvailabilityRow).filter((row): row is StockAvailabilityRow => row !== null);
    store.replaceAllForItem(stockItemName, rows);
    results.push({ stockItemName, count: rows.length });
  }

  return results;
}
