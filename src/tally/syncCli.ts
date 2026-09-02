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
import { createTallyMasterCache } from './cache.ts';
import { syncMasterData } from './masters.ts';

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
