/**
 * Company discovery: identifying which Tally company this deployment talks
 * to, without hardcoding its name.
 *
 * Confirmed live against the target instance (see DECISIONS.md): querying
 * `TYPE=Company` with no `SVCURRENTCOMPANY` scope at all still returns
 * exactly one row for a deployment with one company open, with real,
 * populated `NAME`/`STATENAME` fields. `GSTREGISTRATIONNUMBER` is a real
 * field name but was empty on the verified instance — never assumed present.
 *
 * Two entry points, for the two places this is needed:
 *   - `discoverCompany` — a live, read-only Tally query. Used once by the
 *     sync CLI to learn the company name before scoping every other sync
 *     query to it, and to cache the result.
 *   - `resolveCachedCompany` — reads the cache the sync step already wrote.
 *     Used by the running server at startup, which (like every other part of
 *     this project outside the sync step and the final posting write) never
 *     talks to Tally directly.
 *
 * Both fail closed the same way: zero or more than one company is never
 * guessed at — it is a configuration problem to fix (run the sync, or fix
 * however many companies are open in Tally), never silently picked.
 */
import { readCachedMasters } from './cache.js';
export const COMPANY_FIELDS = ['NAME', 'STATENAME', 'GSTREGISTRATIONNUMBER'];
export class CompanyResolutionError extends Error {
  constructor(reason) {
    super(`Could not resolve exactly one Tally company: ${reason}`);
    this.name = 'CompanyResolutionError';
  }
}
/** Shared by both entry points: turn N raw records into one resolved company or throw. */
function resolveOne(records, sourceDescription) {
  if (records.length === 0) {
    throw new CompanyResolutionError(`no company data was found (${sourceDescription})`);
  }
  if (records.length > 1) {
    throw new CompanyResolutionError(
      `${records.length} companies were found (${sourceDescription}); exactly one is required`,
    );
  }
  const record = records[0];
  const name = record.NAME;
  if (!name) {
    throw new CompanyResolutionError(`the company record has no NAME (${sourceDescription})`);
  }
  return { name, state: record.STATENAME ?? '' };
}
/**
 * Live discovery, with no company name known yet — the client used here must
 * be constructed without a `companyName` (see `tally/client.js`).
 */
export async function discoverCompany(client) {
  const records = await client.exportCollection('Company', COMPANY_FIELDS);
  return resolveOne(records, 'live Tally query');
}
/** Cache-only resolution — never talks to Tally. Used by the running server. */
export function resolveCachedCompany(db) {
  const rows = readCachedMasters(db, 'Company');
  return resolveOne(
    rows.map((row) => row.data),
    'cached — run npm run tally:sync',
  );
}
