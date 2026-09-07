/**
 * Exact-only existence check against the cached Tally Ledger masters.
 *
 * Deliberately not fuzzy: this answers "does the ledger this configuration
 * names actually exist in Tally", not "what did the user probably mean". A
 * near-miss here is a configuration problem to fix, never a ledger to guess
 * at and post against.
 */
import { readCachedMasters } from '../tally/cache.js';
function normalize(value) {
  return value.trim().toLowerCase();
}
export function ledgerExistsExact(db, ledgerName) {
  const target = normalize(ledgerName);
  return readCachedMasters(db, 'Ledger').some((row) => normalize(row.name) === target);
}
