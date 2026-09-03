# Project Status

_Last updated: 2026-09-02_

## Current phase

Phase 8 — Deterministic GST determination and application-side ledger mapping.
**Complete.**

## Current task

None. Phase 7's remaining gap (see below) is smaller than before but not
closed — awaiting direction on the two items still open.

## Completed work

**Phases 0–7** — foundation through the Tally posting mechanism (not yet
wired to a real confirmed draft). See git history for detail.

**Phase 8 — GST and Ledger Configuration**
- `src/gst/states.ts` — the 36 GST-registered Indian states/UTs, exact match
  only (no fuzzy matching on state names — a near-miss here flips the GST
  treatment entirely, not just a candidate list).
- `src/gst/treatment.ts` — `determineGstTreatment`: Company State vs. Place of
  Supply only, never the party's state, never guessed (`DECISIONS.md` #28).
- `src/gst/itemLedgerMapping.ts` + migration 7 (`item_ledger_mappings`) —
  application-side Sales/Purchase ledger mapping per stock item, exact-match
  lookup only. Never reads or writes Tally masters.
- `src/gst/ledgerExistence.ts` — exact-only existence check against the
  cached `Ledger` masters (no fuzzy matching for a posting decision).
- `src/gst/postingReadiness.ts` — `checkPostingReadiness`: the single function
  combining all of the above, run after Phase 5 passes, producing a full
  blocker list or a resolved `GstTreatment`.
- `src/llm/schema.ts` / `prompts.ts` — `TransactionDraft.placeOfSupply` added:
  extracted only when the user explicitly states one, never inferred. The
  model decides nothing about what it means.
- `src/conversation/` — a missing Place of Supply is asked for and resolved
  from the next reply deterministically (exact state-name match, no LLM
  call); any other readiness failure (missing/absent ledger mapping) is
  reported as a configuration error, never a question. The preview now shows
  the resolved GST treatment and ledgers.
- `src/tally/posting.ts` — `postConfirmedTransaction` re-runs
  `checkPostingReadiness` against the stored draft immediately before
  building the voucher XML, closing the window between confirmation and
  posting (`DECISIONS.md` #30). Migration 6 adds `gst.determination.completed`
  to the audit vocabulary.
- Not touched: Phase 3 read-only Tally client/masters/cache, Phase 4/5 logic
  beyond the additive `placeOfSupply` field, existing Tally data of any kind.

## ⚠️ Phase 7 gap — narrowed, not closed

Phase 7 flagged three missing pieces to safely build a real voucher. Phase 8
resolves two of them:

| Gap (Phase 7) | Status after Phase 8 |
|---|---|
| Sales/purchase ledger name per item | ✅ Resolved — `item_ledger_mappings` |
| GST ledger names + intrastate/interstate split | ✅ Resolved — `src/gst/treatment.ts` |
| Godown/warehouse | ❌ Still open — out of Phase 8's stated scope |

**Also still open:** no adapter exists yet converting a confirmed
`TransactionDraft` + `checkPostingReadiness` result into the `SalesVoucherInput`
`postConfirmedTransaction` expects, and `postConfirmedTransaction` is still not
called from the real confirm callback. Building that adapter is small, but
deliberately not done in this phase — it wasn't asked for, and doing it without
also deciding godown would still leave posting unusable for this company (which
has godown tracking enabled).

## Work in progress

None.

## Next task

Either: decide the godown question and build the draft→voucher adapter (closes
Phase 7 fully), or proceed to Phase 9 (hardening) with posting still
deliberately unwired.

## Known issues / blockers

- No GitHub remote and `gh` CLI is not installed — local commits only.
- Godown is not modelled anywhere in the schema (Phase 7's original gap,
  unchanged).
- **`.env.example` currently contains what appear to be real Telegram
  credentials** (a bot token, webhook secret, and user ID) rather than
  placeholders. This file is committed to the repository as a template — if
  these are genuine, committing them would leak a live credential into git
  history. Left untouched pending your confirmation; flagged prominently in
  this phase's completion report.
- Purchase vouchers remain unimplemented (`DECISIONS.md` #27, unchanged).

## Last important technical decision

GST treatment compares only `COMPANY_STATE` against a transaction's Place of
Supply — never the party's registered state, which `TransactionDraft` does not
even carry a field for. A party can receive goods at a different location than
where it's registered; assuming otherwise silently produces the wrong
CGST+SGST/IGST split. `DECISIONS.md` #28.
