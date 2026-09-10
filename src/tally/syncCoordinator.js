/**
 * Coalesces concurrent "please sync now" requests into a single Tally sync.
 *
 * Node's request handling is single-threaded for JS execution, so
 * "concurrent" here means multiple in-flight async requests (two Telegram
 * updates processed close together, or Confirm racing a follow-up message)
 * that all hit a cache miss around the same time — without coalescing, each
 * would kick off its own full sync, hammering Tally with duplicate requests
 * for no benefit. One shared coordinator instance, built once at server
 * startup and threaded through every request, is what makes the coalescing
 * work: every caller shares the same `inFlight` promise, so only the first
 * one to call `ensureFreshSync()` actually starts a sync; everyone else who
 * calls it while that sync is still running gets the exact same pending
 * promise back, and all of them resolve together once it completes.
 *
 * Deliberately just a promise held in a closure — no Redis, no external lock
 * service, no new dependency. This is the standard, sufficient mechanism for
 * a single Node process; a multi-process deployment would need a different
 * approach, but this project runs as one process (see DECISIONS.md).
 */
export function createSyncCoordinator(syncFn) {
  let inFlight = null;
  return {
    /**
     * @returns `{ ok: true, result }` on success, `{ ok: false, error }` on
     * failure — never throws, so a caller can always safely `await` it and
     * check `.ok` without a try/catch.
     */
    async ensureFreshSync() {
      if (inFlight !== null) return inFlight;
      inFlight = syncFn()
        .then((result) => ({ ok: true, result }))
        .catch((error) => ({ ok: false, error }))
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };
}
