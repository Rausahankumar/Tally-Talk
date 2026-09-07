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
import { createItemLedgerMappingStore } from './gst/itemLedgerMapping.js';
import { createStockAvailabilityCache } from './tally/stockAvailabilityCache.js';
import { createPostingStore, createTallyPostingClient } from './tally/posting.js';
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
function main() {
  const config = loadConfigOrExit();
  const database = openDatabase(config.databasePath, consoleLogger);
  consoleLogger.info('Audit database ready', { path: config.databasePath });
  const app = createApp({
    config,
    telegram: createTelegramClient(config.telegram.botToken),
    llm: createAnthropicClient({
      apiKey: config.llm.apiKey,
      model: config.llm.model,
      workspaceId: config.llm.workspaceId,
    }),
    db: database.db,
    conversationStore: createConversationStore(database.db),
    itemLedgerMappingStore: createItemLedgerMappingStore(database.db),
    stockAvailabilityStore: createStockAvailabilityCache({ db: database.db }),
    postingStore: createPostingStore(database.db),
    postingClient: createTallyPostingClient({ host: config.tally.host, port: config.tally.port }),
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
try {
  main();
} catch (error) {
  consoleLogger.error('Failed to start TallyTalk', {
    reason: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
}
