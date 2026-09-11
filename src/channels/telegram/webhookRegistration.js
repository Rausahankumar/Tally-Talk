/**
 * Startup Telegram webhook registration.
 *
 * Skipped entirely when `PUBLIC_WEBHOOK_URL` isn't configured — local
 * development without a stable public URL (e.g. a tunnel that gets a new
 * address on every restart) keeps registering the webhook by hand, exactly
 * as it always has; nothing about that workflow changes.
 *
 * Idempotent by construction: Telegram's own `setWebhook` API is a safe
 * no-op when called again with the same url/secret it already has on file,
 * so this needs no "is it already registered?" check of its own — safe to
 * run unconditionally on every application startup, service restart, or
 * machine reboot.
 *
 * Never fails closed: an unreachable Telegram API at boot is logged clearly
 * but does not stop the HTTP server from serving requests. If the webhook
 * was already registered from an earlier successful boot, Telegram keeps
 * delivering to it regardless of whether this particular attempt succeeded —
 * the same reasoning `startupSync.js` already applies to a failed Tally
 * sync when a usable cache exists.
 *
 * Kept in its own module (not inline in server.js) so it can be imported and
 * unit tested without a real Telegram client or process side effects.
 */
export async function registerWebhook(telegram, config, webhookPath, logger) {
  const baseUrl = config.telegram.publicWebhookUrl;
  if (baseUrl === null) {
    logger.info('PUBLIC_WEBHOOK_URL not configured — skipping automatic Telegram webhook registration');
    return;
  }
  const url = `${baseUrl}${webhookPath}`;
  try {
    await telegram.setWebhook(url, config.telegram.webhookSecret);
    logger.info('Telegram webhook registered', { url });
  } catch (error) {
    logger.error(
      'Failed to register Telegram webhook — Telegram keeps using whatever was previously registered, if anything',
      { reason: error instanceof Error ? error.message : String(error) },
    );
  }
}
