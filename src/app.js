/**
 * Express application wiring.
 *
 * Kept separate from `server.js` so tests can build an app with injected
 * dependencies and no listening socket.
 */
import express from 'express';
import { consoleLogger } from './logger.js';
import { createTelegramWebhookRouter } from './channels/telegram/webhook.js';
export const TELEGRAM_WEBHOOK_PATH = '/webhook/telegram';
/** Telegram updates are small; a tight cap limits cheap abuse. */
const MAX_BODY_SIZE = '64kb';
export function createApp(deps) {
  const logger = deps.logger ?? consoleLogger;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: MAX_BODY_SIZE }));
  app.get('/health', (_req, res) => {
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
      // companyState comes from the Tally company discovered at startup
      // (tally/company.js), never from client-specific config.
      gstConfig: { companyState: deps.companyState, defaultPlaceOfSupply: deps.config.gst.defaultPlaceOfSupply },
      itemLedgerMappingStore: deps.itemLedgerMappingStore,
      companyRevenueLedgerDefaultsStore: deps.companyRevenueLedgerDefaultsStore,
      // Sourced from DEFAULT_GODOWN (config/index.js); when an item states no
      // godown, this is what checkPostingReadiness (postingReadiness.js)
      // falls back to — resolved against the live Tally Godown cache on every
      // request, never silently replaced if it turns out not to exist there.
      godownConfig: { defaultGodown: deps.config.godown.defaultGodown },
      stockAvailabilityStore: deps.stockAvailabilityStore,
      companyName: deps.companyName,
      postingStore: deps.postingStore,
      postingClient: deps.postingClient,
      syncCoordinator: deps.syncCoordinator,
      auditLog: deps.auditLog,
      logger,
    }),
  );
  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });
  app.use((error, _req, res, _next) => {
    logger.error('Unhandled error while serving request', { message: error.message });
    // Never leak internals to the caller.
    if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
  });
  return app;
}
