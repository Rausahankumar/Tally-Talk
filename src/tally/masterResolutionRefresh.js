/**
 * Refresh-on-miss: the safety mechanism that closes the exact gap that
 * caused a real wrong posting (see the "New" vs "New Customer" incident).
 *
 * `validateTransactionDraft`/`checkPostingReadiness` (unchanged, still
 * synchronous, still the only place any of this is actually decided) answer
 * "does this resolve against the cache *right now*". Neither of them talks
 * to Tally. That's exactly what let a stale cache silently fuzzy-match "new"
 * to the wrong real ledger: the true match ("New") had been created in Tally
 * after the last sync, so it was never in the candidate pool fuzzy scoring
 * ran against at all — the failure was staleness, not a defect in the
 * matching algorithm itself (a fresh cache resolves "new" to "New" via the
 * *exact*-match tier, before fuzzy scoring is ever reached).
 *
 * The fix is not to weaken fuzzy matching — it's to never trust a NON-exact
 * result without first giving the cache one chance to catch up with Tally:
 *
 *   resolve against cache
 *     -> exact match? use it, no Tally call at all (the common, fast path)
 *     -> anything else (fuzzy / ambiguous / not_found / a "not found in
 *        masters" readiness blocker) -> one coordinated live refresh
 *        (`syncCoordinator`, so concurrent callers share one sync, never
 *        one each) -> resolve again against the now-current cache -> THAT
 *        result is what the caller acts on, whatever it is.
 *
 * If the refresh itself fails (Tally unreachable), the caller must never
 * fall back to trusting the stale first attempt as if it were final —
 * `refreshFailed: true` says exactly that, so the caller can block with a
 * "couldn't verify with Tally right now" message instead of silently
 * proceeding (or silently reporting "not found", which would be a different,
 * false claim — it might well exist, we just couldn't check).
 */
import { checkPostingReadiness } from '../gst/postingReadiness.js';
import { validateTransactionDraft } from '../validation/validateDraft.js';
/**
 * Readiness blockers meaning "a specific expected name wasn't found in the
 * cache" — the exact shape of staleness this exists to catch. Deliberately
 * excludes genuine multi-candidate ambiguity (`*_ambiguous`,
 * `godown_selection_required`, `item_ledger_mapping_missing` with real
 * candidates) — refreshing cannot resolve a real ambiguity between masters
 * that already exist, so retrying there would only add latency for nothing.
 */
const REFRESH_WORTHY_BLOCKER_CODES = new Set([
  'godown_missing',
  'godown_not_found_in_masters',
  'item_ledger_not_found_in_masters',
  'company_default_ledger_not_found',
  'gst_ledger_not_found_in_masters',
]);
function validationNeedsRefresh(validation) {
  if (validation.partyMatch !== null && validation.partyMatch.status !== 'exact') return true;
  return validation.items.some((item) => item.stockItemMatch.status !== 'exact');
}
function readinessNeedsRefresh(readiness) {
  if (readiness === null) return false;
  return readiness.blockers.some((blocker) => REFRESH_WORTHY_BLOCKER_CODES.has(blocker.code));
}
/**
 * Full first-understanding path: validation + readiness together, with one
 * refresh-and-retry if either comes back non-exact/unsafe. Used where a
 * draft's party/item names haven't been resolved yet at all (`handleMessage.js`).
 *
 * @param deps Everything `checkPostingReadiness` already takes (db, gstConfig,
 *   itemLedgerMappingStore, companyRevenueLedgerDefaultsStore, companyName,
 *   godownConfig, stockAvailabilityStore) plus `syncCoordinator`.
 */
export async function resolveDraftWithRefresh(deps, draft) {
  const runOnce = () => {
    const validation = validateTransactionDraft(deps.db, draft, deps.itemLedgerMappingStore);
    const readiness = validation.isValid
      ? checkPostingReadiness(deps, validation.resolvedDraft, validation)
      : null;
    return { validation, readiness };
  };
  const first = runOnce();
  if (!validationNeedsRefresh(first.validation) && !readinessNeedsRefresh(first.readiness)) {
    return { ...first, refreshAttempted: false, refreshFailed: false };
  }
  const syncOutcome = await deps.syncCoordinator.ensureFreshSync();
  if (!syncOutcome.ok) {
    return { ...first, refreshAttempted: true, refreshFailed: true };
  }
  const second = runOnce();
  return { ...second, refreshAttempted: true, refreshFailed: false };
}
/**
 * Re-check-only path: an already-validated draft (party/item names already
 * resolved earlier, stored on the conversation) just needs readiness
 * re-verified fresh — used at Confirm time (`handleCallback.js`) and
 * immediately before the actual Tally write (`posting.js`), where
 * `checkPostingReadiness` was already being re-run fresh; this only adds the
 * refresh-and-retry around that existing re-check, never re-matches
 * party/item names again (that re-match, if ever wanted, is a separate,
 * larger behaviour change this project has not made).
 */
export async function resolveReadinessWithRefresh(deps, draft, validation) {
  const first = checkPostingReadiness(deps, draft, validation);
  if (!readinessNeedsRefresh(first)) {
    return { readiness: first, refreshAttempted: false, refreshFailed: false };
  }
  const syncOutcome = await deps.syncCoordinator.ensureFreshSync();
  if (!syncOutcome.ok) {
    return { readiness: first, refreshAttempted: true, refreshFailed: true };
  }
  const second = checkPostingReadiness(deps, draft, validation);
  return { readiness: second, refreshAttempted: true, refreshFailed: false };
}
