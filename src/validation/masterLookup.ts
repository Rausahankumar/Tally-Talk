/**
 * Resolve a free-text name against one cached Tally master collection.
 *
 * Reads only the Phase 3 SQLite cache (`readCachedMasters`) — never calls
 * Tally directly, and never sends any of these names to an LLM.
 */

import type { DatabaseSync } from 'node:sqlite';

import { readCachedMasters } from '../tally/cache.ts';
import { matchName } from './fuzzyMatch.ts';
import type { MasterMatchResult } from './types.ts';

function cachedNames(db: DatabaseSync, masterType: string): readonly string[] {
  return readCachedMasters(db, masterType).map((row) => row.name);
}

export function findLedgerMatch(db: DatabaseSync, partyName: string): MasterMatchResult {
  return matchName(partyName, cachedNames(db, 'Ledger'));
}

export function findStockItemMatch(db: DatabaseSync, itemName: string): MasterMatchResult {
  return matchName(itemName, cachedNames(db, 'StockItem'));
}

/**
 * Voucher type names are Tally configuration, not free text a user typed —
 * exact match only. A fuzzy match here would risk silently posting a "Sales"
 * transaction against a renamed or unrelated voucher type.
 */
export function findVoucherTypeMatch(db: DatabaseSync, voucherTypeName: string): MasterMatchResult {
  const names = cachedNames(db, 'VoucherType');
  const normalized = voucherTypeName.trim().toLowerCase();
  const exactMatches = names.filter((name) => name.trim().toLowerCase() === normalized);

  if (exactMatches.length === 1) {
    return { status: 'exact', matchedName: exactMatches[0]!, candidates: [] };
  }
  if (exactMatches.length > 1) {
    return { status: 'ambiguous', matchedName: null, candidates: exactMatches };
  }
  return { status: 'not_found', matchedName: null, candidates: [] };
}
