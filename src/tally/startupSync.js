/**
 * Startup Tally sync: connect and fully sync masters + stock availability
 * before the server accepts any request, so a brand-new deployment (or one
 * that's been offline a while) never starts serving traffic against an
 * empty or badly stale cache. Company identity/state come from whatever
 * this sync resolves — never a hardcoded value, never re-queried per
 * request afterward (see fullSync.js's module doc on company scoping).
 *
 * Failure handling, deliberately not just "crash":
 *   - Live sync succeeds -> fresh cache, proceed normally.
 *   - Live sync fails, but a Company was already cached from some earlier
 *     sync -> log the failure clearly, start anyway in degraded mode using
 *     that (possibly stale) cache. This is safe because posting never
 *     trusts a stale, non-exact resolution silently — the runtime
 *     refresh-on-miss mechanism (masterResolutionRefresh.js) still tries to
 *     self-heal on the first real request that needs it, and blocks
 *     cleanly if Tally is still unreachable then.
 *   - Live sync fails AND nothing has ever been cached -> fail closed, the
 *     same way a missing TELEGRAM_BOT_TOKEN already does. There is nothing
 *     safe to fall back to: this deployment has never known which company
 *     it serves.
 *
 * Kept in its own module (not inline in server.js) so it can be imported and
 * unit tested without triggering server.js's own top-level process startup.
 */
import { CompanyResolutionError, resolveCachedCompany } from './company.js';
import { runFullSync } from './fullSync.js';
/**
 * `runSync`/`resolveCompany`/`logger`/`exit` are injectable so this
 * branching logic can be unit tested without a real Tally connection and
 * without actually terminating the process — production callers pass none
 * of these and get the real defaults.
 */
export async function startupSync(db, config, deps = {}) {
  const runSync = deps.runSync ?? runFullSync;
  const resolveCompany = deps.resolveCompany ?? resolveCachedCompany;
  const logger = deps.logger;
  const exit = deps.exit ?? process.exit;
  try {
    const result = await runSync({
      host: config.tally.host,
      port: config.tally.port,
      db,
      logger,
    });
    const company = resolveCompany(db);
    logger.info('Startup Tally sync complete', {
      company: result.companyName,
      state: company.state,
    });
    return company;
  } catch (error) {
    logger.error('Startup Tally sync failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
    try {
      const company = resolveCompany(db);
      logger.error(
        'Starting in degraded mode using previously cached Tally masters — not freshly synced',
        { company: company.name, state: company.state },
      );
      return company;
    } catch (cacheError) {
      if (cacheError instanceof CompanyResolutionError) {
        logger.error('No cached Tally masters available either — cannot start', {
          reason: cacheError.message,
        });
        exit(1);
        return undefined;
      }
      throw cacheError;
    }
  }
}
