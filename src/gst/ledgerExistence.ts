/**
 * Exact-only existence check against the cached Tally Ledger masters.
 *
 * Deliberately not fuzzy: this answers "does the ledger this configuration
 * names actually exist in Tally", not "what did the user probably mean". A
 * near-miss here is a configuration problem to fix, never a ledger to guess
 * at and post against.
 */

import type { DatabaseSync } from 'node:sqlite';

import { readCachedMasters } from '../tally/cache.ts';

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export function ledgerExistsExact(db: DatabaseSync, ledgerName: string): boolean {
  const target = normalize(ledgerName);
  return readCachedMasters(db, 'Ledger').some((row) => normalize(row.name) === target);
}
