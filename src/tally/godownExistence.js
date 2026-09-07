/**
 * Exact-only existence check against the cached Tally Godown masters.
 *
 * Same rule as ledger existence (`../gst/ledgerExistence.js`): a near-miss on
 * a godown name is a configuration or user-input problem to surface, never a
 * godown to guess at and post a stock movement against.
 */
import { readCachedMasters } from './cache.js';
function normalize(value) {
  return value.trim().toLowerCase();
}
export function godownExistsExact(db, godownName) {
  const target = normalize(godownName);
  return readCachedMasters(db, 'Godown').some((row) => normalize(row.name) === target);
}
