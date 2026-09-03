/**
 * Exact-only existence check against the cached Tally Godown masters.
 *
 * Same rule as ledger existence (`../gst/ledgerExistence.ts`): a near-miss on
 * a godown name is a configuration or user-input problem to surface, never a
 * godown to guess at and post a stock movement against.
 */

import type { DatabaseSync } from 'node:sqlite';

import { readCachedMasters } from './cache.ts';

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export function godownExistsExact(db: DatabaseSync, godownName: string): boolean {
  const target = normalize(godownName);
  return readCachedMasters(db, 'Godown').some((row) => normalize(row.name) === target);
}
