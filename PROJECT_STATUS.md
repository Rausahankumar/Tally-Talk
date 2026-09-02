# Project Status

_Last updated: 2026-09-02_

## Current phase

Phase 5 — Deterministic validation and Tally master matching. **Complete.**

## Current task

None. Awaiting approval to begin Phase 6.

## Completed work

**Phases 0–4** — foundation, Telegram webhook with security gates, append-only
SQLite audit log, Tally master data sync, LLM structured extraction. See git
history for detail.

**Phase 5 — Deterministic Validation and Master Matching**
- `src/validation/types.ts` — shared result types: `MatchStatus`
  (`exact`/`fuzzy`/`ambiguous`/`not_found`), `MasterMatchResult`,
  `ValidationIssue` (16-code vocabulary), `DraftValidationResult`.
- `src/validation/fuzzyMatch.ts` — `matchName`: exact match first
  (case/whitespace-insensitive), then deterministic fuzzy matching combining
  whole-string edit distance with a sliding-window partial match (needed
  because real Tally names are long and compound — see `DECISIONS.md` #18),
  then ambiguity detection when two candidates are both plausible and close in
  score, then `not_found`.
- `src/validation/masterLookup.ts` — `findLedgerMatch`, `findStockItemMatch`
  (fuzzy-enabled, read from the Phase 3 SQLite cache only), `findVoucherTypeMatch`
  (exact-only — voucher types are configuration, not user free text).
- `src/validation/rules.ts` — pure checks: `isValidQuantity`, `isValidRate`
  (positive, finite), `isValidGstPercent` (against a fixed slab list; see
  `DECISIONS.md` #19 for the limitation this implies).
- `src/validation/validateDraft.ts` — `validateTransactionDraft(db, draft)`:
  orchestrates all of the above into one `DraftValidationResult`. Re-derives
  every required-field check from the draft's actual values — never trusts the
  LLM's self-reported `missingFields`.
- Not wired into the webhook — this phase is the validation module in
  isolation, exactly as Phase 4 was for extraction. No Telegram, no
  confirmation flow, no Tally write path anywhere in `src/validation/` (a
  type-only import of `TransactionDraft` is the only connection to `src/llm/`).

## Work in progress

None.

## Next task

Phase 6 — Conversation state and multi-turn slot filling: per-chat session
holding the draft-in-progress, so a `DraftValidationResult`'s missing/ambiguous
fields can be resolved by a follow-up message instead of restarting.

## Known issues / blockers

- No GitHub remote and `gh` CLI is not installed — local commits only.
- No rate limiting yet (Phase 8).
- GST validity is a plausibility check against known slabs, not a per-item rate
  lookup — the Phase 3 master cache does not carry GST/HSN fields yet
  (`DECISIONS.md` #19). A stated rate that is a real slab but wrong for the
  specific item will pass.
- No total/tax **amount** computation exists yet — this phase validates that a
  stated GST rate is plausible, it does not compute what tax is owed. Amount
  computation belongs with Phase 7 (voucher posting), where a computed total is
  actually needed.
- Ambiguous-match candidates are capped at 5; a master list with many
  similarly-named entries could still hide a plausible match past the cap.

## Last important technical decision

Master-name matching combines whole-string edit distance with a sliding-window
partial match, not edit distance alone — a short LLM-extracted name like
"cement" scores only 0.26 against a real Tally name like "ACC Cement OPC 43
Grade" on whole-string similarity, which would have made ordinary Tally data
nearly unmatchable. Measured before being fixed, not assumed. `DECISIONS.md`
#18.
