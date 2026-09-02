/**
 * Process entry point.
 *
 * Configuration is validated before the socket opens, so a misconfigured
 * deployment fails at startup instead of at the first webhook request.
 */

import { ConfigError, loadConfig } from './config/index.ts';
import { createApp } from './app.ts';
import { TELEGRAM_WEBHOOK_PATH } from './app.ts';
import { createTelegramClient } from './channels/telegram/client.ts';
import { consoleLogger } from './logger.ts';

function main(): void {
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

  const app = createApp({
    config,
    telegram: createTelegramClient(config.telegram.botToken),
    logger: consoleLogger,
  });

  app.listen(config.port, () => {
    consoleLogger.info('TallyTalk listening', {
      port: config.port,
      env: config.nodeEnv,
      webhookPath: TELEGRAM_WEBHOOK_PATH,
      authorizedUsers: config.telegram.allowedUserIds.size,
    });
  });
}

main();
