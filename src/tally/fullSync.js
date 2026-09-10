/**
 * The reusable core of a full Tally master + stock-availability sync.
 *
 * Extracted from what `syncCli.js` used to do inline, so the exact same
 * sequence can be called from two places: the manual `npm run tally:sync`
 * CLI, and the running server (startup sync, and the runtime refresh-on-miss
 * mechanism — see `syncCoordinator.js`/`masterResolutionRefresh.js`). There is
 * deliberately only one implementation of "how to sync" — the CLI and the
 * server both call this, never their own copy.
 *
 * Company scoping (DECISIONS.md, Phase 10): when `companyName` is already
 * known (the running server always knows it, once resolved at startup), this
 * skips company discovery entirely and scopes every query directly to that
 * name — it never re-picks a company, and never re-litigates the "exactly one
 * company must be open" question on every runtime refresh. That question is
 * answered once, either by a fresh `discoverCompany` call (no `companyName`
 * given — the CLI's own case, and the server's first startup attempt) or by
 * whatever already resolved it before this function was ever called.
 */
import { discoverCompany } from './company.js';
import { createTallyClient } from './client.js';
import { createTallyMasterCache, readCachedMasters } from './cache.js';
import { syncMasterData } from './masters.js';
import { createStockAvailabilityCache } from './stockAvailabilityCache.js';
import { syncStockAvailability } from './stockAvailability.js';
/**
 * @param options.host, options.port Tally's HTTP/JSON endpoint.
 * @param options.db The SQLite connection to sync into.
 * @param options.logger Same shape as `consoleLogger`/`silentLogger`.
 * @param options.companyName Optional. When omitted, this discovers the
 *   company live first (fails closed — see `company.js` — if Tally has zero
 *   or more than one company open) and caches it. When given, company
 *   discovery is skipped entirely and every query is scoped directly to this
 *   name.
 * @param options.createClient Optional, defaults to the real
 *   `createTallyClient`. Injectable so tests can supply a fake client
 *   (matching the same `{ exportCollection }` shape every other test in this
 *   project already fakes) instead of a real Tally connection.
 * @returns `{ companyName, masterResults, availabilityResults }` — the same
 *   shape the CLI already logged, just returned instead of only printed.
 */
export async function runFullSync(options) {
  const {
    host,
    port,
    db,
    logger,
    companyName: knownCompanyName,
    createClient = createTallyClient,
  } = options;
  const cache = createTallyMasterCache({ db });
  let companyName = knownCompanyName;
  if (companyName === undefined) {
    logger.info('Discovering Tally company', { host, port });
    const discoveryClient = createClient({ host, port });
    const company = await discoverCompany(discoveryClient);
    cache.replaceAll('Company', [
      { NAME: company.name, STATENAME: company.state, GUID: company.guid },
    ]);
    logger.info('Discovered Tally company', { name: company.name, state: company.state });
    companyName = company.name;
  }
  const client = createClient({ host, port, companyName });
  logger.info('Syncing Tally master data', { host, port, company: companyName });
  const masterResults = await syncMasterData(client, cache);
  for (const result of masterResults) {
    logger.info('Synced master type', { type: result.type, count: result.count });
  }
  // Batch cannot be enumerated company-wide (confirmed live: TYPE=Batch with
  // no CHILDOF returns zero rows even when batches exist) — sync it per stock
  // item, using the names the master sync above just cached.
  const stockItemNames = readCachedMasters(db, 'StockItem').map((row) => row.name);
  const stockAvailabilityStore = createStockAvailabilityCache({ db });
  logger.info('Syncing stock availability (batch + godown + closing quantity)', {
    stockItemCount: stockItemNames.length,
  });
  const availabilityResults = await syncStockAvailability(client, stockAvailabilityStore, stockItemNames);
  const totalAvailabilityRows = availabilityResults.reduce((sum, r) => sum + r.count, 0);
  logger.info('Synced stock availability', {
    stockItemsSynced: availabilityResults.length,
    totalRows: totalAvailabilityRows,
  });
  return { companyName, masterResults, availabilityResults };
}
