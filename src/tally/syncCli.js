/**
 * Entry point for `npm run tally:sync`.
 *
 * Manual, on-demand master data sync — still the primary way to fully
 * re-populate the cache from scratch (e.g. after a long time offline, or to
 * force-refresh everything at once). The running server also syncs, both at
 * startup and on-demand when a posting-critical name can't be safely
 * resolved from the cache (see `fullSync.js`'s module doc) — this CLI and the
 * server both call the exact same `runFullSync`, never their own copy.
 * Read-only against Tally: only `exportCollection` is ever called.
 */
import { ConfigError, loadConfig } from '../config/index.js';
import { consoleLogger } from '../logger.js';
import { openDatabase } from '../db/sqlite.js';
import { runFullSync } from './fullSync.js';
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
  try {
    await runFullSync({
      host: config.tally.host,
      port: config.tally.port,
      db: database.db,
      logger: consoleLogger,
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
