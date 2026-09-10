/**
 * Resolve a free-text name against one cached Tally master collection.
 *
 * Reads only the Phase 3 SQLite cache (`readCachedMasters`) — never calls
 * Tally directly, and never sends any of these names to an LLM.
 */
import { readCachedMasters } from '../tally/cache.js';
import { isHighConfidenceMatch, matchName } from './fuzzyMatch.js';
function cachedNames(db, masterType) {
  return readCachedMasters(db, masterType).map((row) => row.name);
}
/**
 * Which Ledger group a voucher's party must belong to — the accounting
 * convention this deployment uses (confirmed, not the generic textbook
 * assumption): a Sales/Credit Note party is a Sundry Creditor, a
 * Purchase/Debit Note party is a Sundry Debtor. `unknown` has no group at
 * all, so it never widens to "every ledger" — a voucher type that can't be
 * determined blocks on `invalid_voucher_type` before a party match would
 * matter anyway.
 */
const VOUCHER_TYPE_PARTY_GROUP = {
  sales: 'Sundry Creditors',
  purchase: 'Sundry Debtors',
  credit_note: 'Sundry Creditors',
  debit_note: 'Sundry Debtors',
};
/**
 * Ledger names eligible as a party for this voucher type — filtered by
 * `PARENT` *before* any name matching runs, so a ledger from an unrelated
 * group (a tax ledger, a bank account, a capital account, ...) is never even
 * scored, let alone fuzzy-matched. Every name is discovered dynamically from
 * the synced cache; nothing here is a specific client's ledger name.
 */
function eligiblePartyLedgerNames(db, voucherType) {
  const requiredGroup = VOUCHER_TYPE_PARTY_GROUP[voucherType];
  if (requiredGroup === undefined) return [];
  return readCachedMasters(db, 'Ledger')
    .filter((row) => row.data.PARENT === requiredGroup)
    .map((row) => row.name);
}
/**
 * `voucherType` determines the eligible candidate pool (see
 * `eligiblePartyLedgerNames`). A `fuzzy` result below the high-confidence bar
 * is downgraded to a single-candidate `ambiguous` — asked for confirmation
 * rather than silently accepted, exactly like a genuine multi-candidate
 * ambiguity already is.
 */
export function findLedgerMatch(db, partyName, voucherType) {
  const result = matchName(partyName, eligiblePartyLedgerNames(db, voucherType));
  if (result.status === 'fuzzy' && !isHighConfidenceMatch(partyName, result.matchedName)) {
    return { status: 'ambiguous', matchedName: null, candidates: [result.matchedName] };
  }
  return result;
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
