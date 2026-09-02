# Project Status

_Last updated: 2026-09-02_

## Current phase

Phase 7 — Tally posting mechanism. **Posting mechanism complete and tested.
Not yet wired to a real confirmed conversation draft** — blocked on a schema
decision, reported below, awaiting approval.

## Current task

Awaiting your decision on the reported schema gap (see below) before wiring
`postConfirmedTransaction` to the Phase 6 confirmation flow.

## Completed work

**Phases 0–6** — foundation through conversation flow with preview and
Confirm/Cancel. See git history for detail.

**Phase 7 — Tally Posting Mechanism**
- `src/tally/postingXml.ts` — `buildSalesVoucherXml` (deterministic, pure) and
  `parseImportResponse`. The party-ledger sign convention (negative,
  `ISDEEMEDPOSITIVE=Yes`) and every field name were confirmed against a real
  Sales voucher captured during Phase 3 discovery, not assumed.
- `src/tally/posting.ts` — `createTallyPostingClient` (HTTP Import, injectable
  fetch, never throws — every failure resolves to an outcome), `createPostingStore`
  (SQLite-backed, atomic duplicate/concurrency protection via a primary-key
  `INSERT`), and `postConfirmedTransaction` (the orchestrator: confirms the
  draft is actually `confirmed` in `conversation_drafts`, claims the posting
  attempt exactly once, posts, records the outcome, audits every step).
- Migration 5 adds `tally_postings`; migration 6 widens the audit vocabulary
  for `tally.posting.rejected`.
- **Phase 3's read-only client (`client.ts`, `xml.ts`, `masters.ts`,
  `cache.ts`) is untouched** — confirmed by diff. Phase 4 and Phase 5 are also
  untouched. No new HTTP route or endpoint exists anywhere for posting.

## ⚠️ Schema gap — reported per your instructions, awaiting your decision

The existing `TransactionDraft` + `DraftValidationResult` do not carry enough
information to safely build a *correct* real Tally voucher. Building anything
further here would mean guessing at a live accounting system, which is exactly
what was ruled out. Specifics:

| Missing | Why it's required | What would need to grow |
|---|---|---|
| **Sales ledger name** for each line's accounting allocation (e.g. "Sales", "GST Sales" — the real captured sample used a company-specific name, not a generic one) | Every inventory line in a Tally voucher must credit a specific income ledger; there is no way to infer which one from an item name alone | Either a new config default, or an extension to Phase 3's `StockItem` master fields |
| **GST ledger names and the CGST+SGST vs. IGST split** | The split depends on whether the transaction is intra-state or inter-state, which depends on the party's registered state vs. the company's — neither is captured anywhere today. The one real sample found (`DECISIONS.md`) used a single "SGST" line with no CGST/IGST counterpart, so even the existing data doesn't reveal a reliable pattern | Party state and company state would need to be captured (Phase 3 `Ledger` fields, and/or config); the tax-ledger-name mapping itself is a business decision, not inferable |
| **Godown/warehouse** | This specific company has godown tracking enabled (12 godowns synced in Phase 3) and real captured vouchers include a godown allocation per line; omitting it risks Tally rejecting the voucher outright | `TransactionDraft`/validation would need a godown field, or a fixed default godown decision |

**Not blocking** (handled inside Phase 7 without touching the schema):
unit of measure (read from the already-cached `StockItem.BASEUNITS`), voucher
date (defaults to posting time), voucher number (omitted — Tally auto-numbers).

**Also flagged, not blocking:** Purchase vouchers are out of scope for now —
no real captured Purchase sample exists to confirm its sign convention against
(`DECISIONS.md` #27). Only Sales is implemented.

**What I built instead of guessing:** `postConfirmedTransaction` takes a fully
resolved `SalesVoucherInput` — the caller supplies the sales/tax ledger
allocations explicitly. The entire posting mechanism (XML building, HTTP
Import, response parsing, duplicate/concurrency protection, state, audit) is
complete and tested against that contract. What remains is deciding how the
missing fields above get sourced, then writing the (small) piece of code that
turns a confirmed `TransactionDraft` into a `SalesVoucherInput` and calls
`postConfirmedTransaction` — deliberately not done yet.

## Work in progress

None — waiting on your decision above before proceeding.

## Next task

Once the ledger-mapping question is resolved: write the adapter from a
confirmed `TransactionDraft` to `SalesVoucherInput`, wire it into
`handleCallbackQuery`'s confirm path, and — only after that, and only with
explicit approval — send the first real Tally Import request.

## Known issues / blockers

- **Blocking:** the schema gap above.
- No GitHub remote and `gh` CLI is not installed — local commits only.
- No rate limiting yet (Phase 8).
- Purchase vouchers unimplemented (`DECISIONS.md` #27).
- `parseImportResponse`'s response format is the standard, documented Tally
  Import shape (`<RESPONSE><CREATED>/<ERRORS>/<LINEERROR>`) but has **not**
  been confirmed against this specific TallyPrime instance — no real Import
  request has been sent. This is exactly what the first approved, controlled
  real Tally test is for.

## Last important technical decision

Duplicate and concurrent posting protection is a single primary-key `INSERT`
on `tally_postings.draft_version_id` — whichever caller's insert wins proceeds,
every other caller (duplicate callback, concurrent request, blind retry) gets
the existing row back. Once a row exists at all, no second attempt is ever
made for that draft version, even if it ended in `failed` or `uncertain` —
because a local failure does not prove Tally never processed the request, and
automatic retry risks a real duplicate voucher. `DECISIONS.md` #25.
