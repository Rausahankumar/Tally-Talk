/**
 * Entry point for `npm run tally:sync`.
 *
 * Manual, on-demand master data sync (per the approved MVP scope — no
 * automatic/scheduled sync in Phase 3). Read-only against Tally: only
 * `exportCollection` is ever called.
 */

import { ConfigError, loadConfig } from '../config/index.ts';
import { consoleLogger } from '../logger.ts';
import { openDatabase } from '../db/sqlite.ts';
import { createTallyClient } from './client.ts';
import { createTallyMasterCache, readCachedMasters } from './cache.ts';
import { syncMasterData } from './masters.ts';
import { createStockAvailabilityCache } from './stockAvailabilityCache.ts';
import { syncStockAvailability } from './stockAvailability.ts';

async function main(): Promise<void> {
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
  const client = createTallyClient({
    host: config.tally.host,
    port: config.tally.port,
    companyName: config.tally.companyName,
  });
  const cache = createTallyMasterCache({ db: database.db });

  try {
    consoleLogger.info('Syncing Tally master data', {
      host: config.tally.host,
      port: config.tally.port,
      company: config.tally.companyName,
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
    const availabilityResults = await syncStockAvailability(client, stockAvailabilityStore, stockItemNames);
    const totalAvailabilityRows = availabilityResults.reduce((sum, r) => sum + r.count, 0);
    consoleLogger.info('Synced stock availability', {
      stockItemsSynced: availabilityResults.length,
      totalRows: totalAvailabilityRows,
    });
  } finally {
    database.close();
  }
}

main().catch((error: unknown) => {
  consoleLogger.error('Tally master sync failed', {
    reason: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
