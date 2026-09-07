/**
 * Resolve a free-text name against one cached Tally master collection.
 *
 * Reads only the Phase 3 SQLite cache (`readCachedMasters`) — never calls
 * Tally directly, and never sends any of these names to an LLM.
 */
import { readCachedMasters } from '../tally/cache.js';
import { matchName } from './fuzzyMatch.js';
function cachedNames(db, masterType) {
  return readCachedMasters(db, masterType).map((row) => row.name);
}
export function findLedgerMatch(db, partyName) {
  return matchName(partyName, cachedNames(db, 'Ledger'));
}
export function findStockItemMatch(db, itemName) {
  return matchName(itemName, cachedNames(db, 'StockItem'));
}
/**
 * Voucher type names are Tally configuration, not free text a user typed —
 * exact match only. A fuzzy match here would risk silently posting a "Sales"
 * transaction against a renamed or unrelated voucher type.
 */
export function findVoucherTypeMatch(db, voucherTypeName) {
  const names = cachedNames(db, 'VoucherType');
  const normalized = voucherTypeName.trim().toLowerCase();
  const exactMatches = names.filter((name) => name.trim().toLowerCase() === normalized);
  if (exactMatches.length === 1) {
    return { status: 'exact', matchedName: exactMatches[0], candidates: [] };
  }
  if (exactMatches.length > 1) {
    return { status: 'ambiguous', matchedName: null, candidates: exactMatches };
  }
  return { status: 'not_found', matchedName: null, candidates: [] };
}
