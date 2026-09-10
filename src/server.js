/**
 * Process entry point.
 *
 * Configuration is validated and the database is opened and migrated before the
 * socket opens, so a misconfigured deployment fails at startup instead of at
 * the first webhook request.
 */
import { ConfigError, loadConfig } from './config/index.js';
import { TELEGRAM_WEBHOOK_PATH, createApp } from './app.js';
import { createAuditLog } from './audit/log.js';
import { createConversationStore } from './conversation/store.js';
import { openDatabase } from './db/sqlite.js';
import { createCompanyRevenueLedgerDefaultsStore } from './gst/companyRevenueLedgerDefaults.js';
import { createItemLedgerMappingStore } from './gst/itemLedgerMapping.js';
import { createStockAvailabilityCache } from './tally/stockAvailabilityCache.js';
import { createPostingStore, createTallyPostingClient } from './tally/posting.js';
import { runFullSync } from './tally/fullSync.js';
import { startupSync } from './tally/startupSync.js';
import { createSyncCoordinator } from './tally/syncCoordinator.js';
import { createAnthropicClient } from './llm/client.js';
import { createTelegramClient } from './channels/telegram/client.js';
import { consoleLogger } from './logger.js';
function loadConfigOrExit() {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      consoleLogger.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}
/** Stop accepting requests, then close the database cleanly. */
function installShutdownHandlers(server, closeDatabase) {
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    consoleLogger.info('Shutting down', { signal });
    server.close(() => {
      try {
        closeDatabase();
      } catch (error) {
        consoleLogger.error('Failed to close the database', {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
async function main() {
  const config = loadConfigOrExit();
  const database = openDatabase(config.databasePath, consoleLogger);
  consoleLogger.info('Audit database ready', { path: config.databasePath });
  const company = await startupSync(database.db, config, { logger: consoleLogger });
  // Built once, shared by every request from here on — this single instance
  // is what makes concurrent runtime refreshes coalesce into one sync
  // instead of one per request (see syncCoordinator.js). Always scoped to
  // the company startup just resolved — a runtime refresh never re-picks a
  // company (see fullSync.js's module doc).
  const syncCoordinator = createSyncCoordinator(() =>
    runFullSync({
      host: config.tally.host,
      port: config.tally.port,
      db: database.db,
      logger: consoleLogger,
      companyName: company.name,
    }),
  );
  const app = createApp({
    config,
    companyName: company.name,
    companyState: company.state,
    telegram: createTelegramClient(config.telegram.botToken),
    llm: createAnthropicClient({
      apiKey: config.llm.apiKey,
      model: config.llm.model,
      workspaceId: config.llm.workspaceId,
    }),
    db: database.db,
    conversationStore: createConversationStore(database.db),
    itemLedgerMappingStore: createItemLedgerMappingStore(database.db),
    companyRevenueLedgerDefaultsStore: createCompanyRevenueLedgerDefaultsStore(database.db),
    stockAvailabilityStore: createStockAvailabilityCache({ db: database.db }),
    postingStore: createPostingStore(database.db),
    postingClient: createTallyPostingClient({ host: config.tally.host, port: config.tally.port }),
    syncCoordinator,
    auditLog: createAuditLog({ db: database.db, logger: consoleLogger }),
    logger: consoleLogger,
  });
  const server = app.listen(config.port, () => {
    consoleLogger.info('TallyTalk listening', {
      port: config.port,
      env: config.nodeEnv,
      webhookPath: TELEGRAM_WEBHOOK_PATH,
      authorizedUsers: config.telegram.allowedUserIds.size,
    });
  });
  installShutdownHandlers(server, database.close);
}
main().catch((error) => {
  consoleLogger.error('Failed to start TallyTalk', {
    reason: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
