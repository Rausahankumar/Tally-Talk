/**
 * Entry point for `npm run tally:sync`.
 *
 * Manual, on-demand master data sync (per the approved MVP scope — no
 * automatic/scheduled sync in Phase 3). Read-only against Tally: only
 * `exportCollection` is ever called.
 */
import { ConfigError, loadConfig } from '../config/index.js';
import { consoleLogger } from '../logger.js';
import { openDatabase } from '../db/sqlite.js';
import { discoverCompany } from './company.js';
import { createTallyClient } from './client.js';
import { createTallyMasterCache, readCachedMasters } from './cache.js';
import { syncMasterData } from './masters.js';
import { createStockAvailabilityCache } from './stockAvailabilityCache.js';
import { syncStockAvailability } from './stockAvailability.js';
async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      consoleLogger.error(error.message);
      process.exit(1);
    }
    throw error;
  }
  const database = openDatabase(config.databasePath, consoleLogger);
  const cache = createTallyMasterCache({ db: database.db });
  try {
    // Discover the company first, with no company name assumed at all —
    // confirmed live that TYPE=Company with no SVCURRENTCOMPANY scope still
    // returns exactly one row for a single-company deployment. Every other
    // query below is then explicitly scoped to the discovered name.
    consoleLogger.info('Discovering Tally company', {
      host: config.tally.host,
      port: config.tally.port,
    });
    const discoveryClient = createTallyClient({ host: config.tally.host, port: config.tally.port });
    const company = await discoverCompany(discoveryClient);
    cache.replaceAll('Company', [
      { NAME: company.name, STATENAME: company.state, GUID: company.guid },
    ]);
    consoleLogger.info('Discovered Tally company', { name: company.name, state: company.state });
    const client = createTallyClient({
      host: config.tally.host,
      port: config.tally.port,
      companyName: company.name,
    });
    consoleLogger.info('Syncing Tally master data', {
      host: config.tally.host,
      port: config.tally.port,
      company: company.name,
    });
    const results = await syncMasterData(client, cache);
    for (const result of results) {
      consoleLogger.info('Synced master type', { type: result.type, count: result.count });
    }
    // Batch cannot be enumerated company-wide (confirmed live: TYPE=Batch
    // with no CHILDOF returns zero rows even when batches exist) — sync it
    // per stock item, using the names the master sync above just cached.
    const stockItemNames = readCachedMasters(database.db, 'StockItem').map((row) => row.name);
    const stockAvailabilityStore = createStockAvailabilityCache({ db: database.db });
    consoleLogger.info('Syncing stock availability (batch + godown + closing quantity)', {
      stockItemCount: stockItemNames.length,
    });
    const availabilityResults = await syncStockAvailability(
      client,
      stockAvailabilityStore,
      stockItemNames,
    );
    const totalAvailabilityRows = availabilityResults.reduce((sum, r) => sum + r.count, 0);
    consoleLogger.info('Synced stock availability', {
      stockItemsSynced: availabilityResults.length,
      totalRows: totalAvailabilityRows,
    });
  } finally {
    database.close();
  }
}
main().catch((error) => {
  consoleLogger.error('Tally master sync failed', {
    reason: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
