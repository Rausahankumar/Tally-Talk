# Project Status

_Last updated: 2026-09-09_

## Current phase

Phase 11 — Stock availability becomes advisory, not a hard blocker.
**Complete.**

## Current task

None.

## Completed work

**Phases 0–9** — see git history and `DECISIONS.md`.

**Phase 11 — Stock availability is a warning, not a blocker**
- `src/gst/postingReadiness.js` — `checkPostingReadiness` no longer pushes
  `stock_data_missing`/`stock_insufficient` to `blockers`; both are now
  entries in a new `stockWarnings` array (`{ itemIndex, itemName,
  requestedQuantity, requestedUnit, availableQuantity, availableUnit, reason:
  'no_data' | 'insufficient' }`), so `ready` is no longer `false` for either
  reason. `stock_batch_ambiguous` is unchanged (still a hard blocker — a real
  data ambiguity, not a quantity question). `availableQuantity: null` always
  means "not cached", distinct from a real `0` — never conflated.
- `src/conversation/messages.js` — `buildPreviewText` renders each
  `stockWarnings` entry as a `⚠️ Stock Warning: …` line before the
  Confirm/Cancel prompt; wording matches the two required cases exactly
  ("unavailable/not cached" vs "exceeds cached stock by X").
- Godown *selection* is unaffected: an item with no stated/default godown and
  no godown with sufficient stock still asks the user to choose, or blocks as
  `godown_missing` if none can be identified at all — that is a "which
  godown" question, not a stock-quantity warning, and was out of scope.
- No batch-name fallback was added for the zero-cached-data case: `postingXml.js`
  already documents that guessing "Primary Batch" for every item was a past,
  reverted mistake (some non-batch-tracked items use it, batch-tracked ones
  never do). `draftToVoucher.js`'s existing fail-closed check
  (`batchName === null` -> reject) is untouched and still applies at the
  moment of an actual Confirm if an item has zero cached batch data — see
  Known issues.
- Tests: `gst-posting-readiness.test.js` updated (insufficient/no-data cases
  now assert `ready: true` + a `stockWarnings` entry instead of a blocker);
  `tally-posting.test.js`'s confirm-then-stock-drops-below-requested case now
  asserts the post still succeeds; new `conversation-messages.test.js` cases
  assert the exact warning wording for both cases and that Confirm/Cancel
  guidance is never suppressed by a warning. Full suite: 466/466 passing.

**Phase 10 — Dynamic party/company/GST resolution**
- `src/validation/masterLookup.js` — `findLedgerMatch` is now voucher-type
  aware: candidates are filtered by `Ledger.PARENT` *before* `matchName` runs
  (sales/credit note → Sundry Creditors, purchase/debit note → Sundry
  Debtors — the corrected mapping for this deployment's accounting
  convention, confirmed against real data). A `fuzzy` result below a new,
  stricter confidence bar is downgraded to a single-candidate `ambiguous`
  rather than silently accepted.
- `src/validation/fuzzyMatch.js` — new `AUTO_ACCEPT_THRESHOLD` (0.85),
  calibrated against two real, verified data points: a genuine typo
  (~0.8947, must keep auto-accepting) and a coincidental cross-group
  collision (0.75, must not). `matchName` itself is unchanged.
- `src/tally/company.js` (new) — company name/state discovered from Tally's
  `Company` collection (confirmed live: works with no `SVCURRENTCOMPANY`
  scope at all), not hardcoded. `discoverCompany` (live, used once by the
  sync CLI) and `resolveCachedCompany` (cache-only, used by the running
  server at startup) both fail closed on zero or more than one company.
- `src/gst/gstLedgerResolution.js` (new) — CGST/SGST/IGST resolved per
  transaction from each Ledger's `TAXTYPE`/`GSTDUTYHEAD` fields (confirmed
  live: real CGST/SGST ledgers carry these; a same-group `VAT` ledger does
  not — proving `PARENT` alone can't distinguish them). Fails closed on zero
  or more than one match per duty head; never fuzzy-matched.
- `src/tally/masters.js`/`syncCli.js` — `Ledger` sync now also fetches
  `TAXTYPE`/`GSTDUTYHEAD`; `Company` is discovered first (no company name
  assumed) and cached, then used to scope every other sync query.
- `src/config/index.js` — `TALLY_COMPANY_NAME`, `COMPANY_STATE`,
  `CGST_LEDGER`, `SGST_LEDGER`, `IGST_LEDGER`, `DEFAULT_GODOWN` are no longer
  read or required. `DEFAULT_PLACE_OF_SUPPLY` remains (no Tally master data
  source exists for Place of Supply — it's a transaction fact, not a master).
- `src/server.js` — resolves the company from cache at startup and exits
  (fails closed) if it isn't exactly one, the same way a missing bot token
  already does.
- 40 new tests across 3 new files (`tally-company`, `gst-ledger-resolution`,
  `masterlookup-party-matching`) plus updates to existing fixtures that
  conflicted with the corrected group mapping. Full suite: 462/462 passing.

## Work in progress

None.

## Next task

None assigned. Not done in this phase (not asked for): full Credit
Note/Debit Note voucher support end-to-end (the party-group mapping exists
and is tested at the unit level, but `TransactionDraft.voucherType` still
only accepts sales/purchase/unknown).

## Known issues / blockers

- No GitHub remote and `gh` CLI is not installed — local commits only.
- Purchase vouchers remain unimplemented in the XML builder (`DECISIONS.md`
  #27, unchanged).
- IGST duty-head resolution (`GSTDUTYHEAD="IGST"`) is implemented generically
  from the same confirmed mechanism as CGST/SGST, but has not been observed
  against a real IGST ledger (this deployment has never posted an interstate
  sale) — worth a live check the first time one is configured.
- Company state discovery depends on `Company.STATENAME` being populated in
  Tally; if it's ever blank, posting correctly blocks
  (`company_state_not_configured`) rather than guessing, same as before.
- An item with genuinely zero cached batch/stock data (e.g. "Orange" — see
  the live investigation this phase followed from) can now reach Confirm with
  a warning shown, but if it is still uncached at the moment of Confirm,
  `draftToVoucher.js` will refuse to build the voucher (`no resolved batch`)
  rather than invent a batch name — the user sees a clear posting-failed
  message, not a silent wrong post. Fix is operational (sync real stock/batch
  data for that item in Tally), not a code change.

## Last important technical decision

Stock availability is informational only: `checkPostingReadiness` never
fails readiness because of missing or insufficient cached stock (that is a
`stockWarnings` entry, shown to the user before Confirm), only because of a
genuine ambiguity (`stock_batch_ambiguous`, multiple real batches with no
rule to choose between them) or because the required Tally XML batch name is
still unresolvable at the moment of posting. This is deliberately narrower
than "stock never blocks anything" — it does not touch godown *selection*
(still a real "which godown" question, unaffected) and does not fabricate a
batch name, since this codebase already reverted that exact mistake once
(see `postingXml.js`'s module doc).

Previous decision (still current): the party/voucher-type group mapping is
**Sales → Sundry Creditors, Purchase → Sundry Debtors** (Credit Note →
Sundry Creditors, Debit Note → Sundry Debtors) — the reverse of the generic
textbook assumption, but confirmed as this deployment's actual accounting
convention and consistent with real cached data (e.g. "Balaji Retail Store",
the party behind every successful posted sale so far, is filed under Sundry
Creditors).
