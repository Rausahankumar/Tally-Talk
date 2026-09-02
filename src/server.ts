/**
 * Process entry point.
 *
 * Configuration is validated and the database is opened and migrated before the
 * socket opens, so a misconfigured deployment fails at startup instead of at
 * the first webhook request.
 */

import type { Server } from 'node:http';

import { ConfigError, loadConfig } from './config/index.ts';
import type { Config } from './config/index.ts';
import { TELEGRAM_WEBHOOK_PATH, createApp } from './app.ts';
import { createAuditLog } from './audit/log.ts';
import { openDatabase } from './db/sqlite.ts';
import { createTelegramClient } from './channels/telegram/client.ts';
import { consoleLogger } from './logger.ts';

function loadConfigOrExit(): Config {
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
function installShutdownHandlers(server: Server, closeDatabase: () => void): void {
  let shuttingDown = false;

  const shutdown = (signal: string): void => {
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

function main(): void {
  const config = loadConfigOrExit();

  const database = openDatabase(config.databasePath, consoleLogger);
  consoleLogger.info('Audit database ready', { path: config.databasePath });

  const app = createApp({
    config,
    telegram: createTelegramClient(config.telegram.botToken),
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
