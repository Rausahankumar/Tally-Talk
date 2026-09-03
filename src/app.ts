/**
 * Express application wiring.
 *
 * Kept separate from `server.ts` so tests can build an app with injected
 * dependencies and no listening socket.
 */

import type { DatabaseSync } from 'node:sqlite';
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';

import type { AuditLog } from './audit/log.ts';
import type { Config } from './config/index.ts';
import type { ConversationStore } from './conversation/store.ts';
import type { ItemLedgerMappingStore } from './gst/itemLedgerMapping.ts';
import type { StockAvailabilityStore } from './tally/stockAvailability.ts';
import type { PostingStore, TallyPostingClient } from './tally/posting.ts';
import type { LLMClient } from './llm/client.ts';
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
  readonly llm: LLMClient;
  readonly db: DatabaseSync;
  readonly conversationStore: ConversationStore;
  readonly itemLedgerMappingStore: ItemLedgerMappingStore;
  readonly stockAvailabilityStore: StockAvailabilityStore;
  readonly postingStore: PostingStore;
  readonly postingClient: TallyPostingClient;
  readonly auditLog: AuditLog;
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
      llm: deps.llm,
      db: deps.db,
      conversationStore: deps.conversationStore,
      gstConfig: deps.config.gst,
      itemLedgerMappingStore: deps.itemLedgerMappingStore,
      godownConfig: deps.config.godown,
      stockAvailabilityStore: deps.stockAvailabilityStore,
      companyName: deps.config.tally.companyName,
      postingStore: deps.postingStore,
      postingClient: deps.postingClient,
      auditLog: deps.auditLog,
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
