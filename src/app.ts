/**
 * Express application wiring.
 *
 * Kept separate from `server.ts` so tests can build an app with injected
 * dependencies and no listening socket.
 */

import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';

import type { Config } from './config/index.ts';
import type { Logger } from './logger.ts';
import { consoleLogger } from './logger.ts';
import type { TelegramClient } from './channels/telegram/client.ts';
import { createTelegramWebhookRouter } from './channels/telegram/webhook.ts';

export const TELEGRAM_WEBHOOK_PATH = '/webhook/telegram';

/** Telegram updates are small; a tight cap limits cheap abuse. */
const MAX_BODY_SIZE = '64kb';

export interface AppDeps {
  readonly config: Config;
  readonly telegram: TelegramClient;
  readonly logger?: Logger;
}

export function createApp(deps: AppDeps): Express {
  const logger = deps.logger ?? consoleLogger;
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: MAX_BODY_SIZE }));

  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });

  app.use(
    TELEGRAM_WEBHOOK_PATH,
    createTelegramWebhookRouter({
      webhookSecret: deps.config.telegram.webhookSecret,
      allowedUserIds: deps.config.telegram.allowedUserIds,
      telegram: deps.telegram,
      logger,
    }),
  );

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found' });
  });

  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('Unhandled error while serving request', { message: error.message });
    // Never leak internals to the caller.
    if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
