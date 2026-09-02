# Project Status

_Last updated: 2026-09-02_

## Current phase

Phase 3 — Tally XML client and master data sync. **Complete.**

## Current task

None. Awaiting approval to begin Phase 4.

## Completed work

**Phases 0–2** — foundation, Telegram webhook with secret + allowlist gates,
append-only SQLite audit log. See git history for detail.

**Phase 3 — Tally Master Data Sync**
- `src/tally/xml.ts` — builds the TDL `COLLECTION` export request and parses the
  response into raw string-valued records. Distinguishes a legitimately empty
  collection, a rejected request (`<RESPONSE>Unknown Request...</RESPONSE>`),
  and a non-success `STATUS` — three cases that look similar but mean different
  things.
- `src/tally/client.ts` — `TallyClient.exportCollection` only. **Export, never
  Import** — there is no method here capable of writing to Tally, by design.
  Injectable `fetch` and a 10s timeout so a closed TallyPrime fails fast.
- `src/tally/masters.ts` — declares the five MVP master types (Ledger,
  StockItem, Godown, Unit, VoucherType) and their field lists, and
  `syncMasterData` to fetch and cache all of them.
- `src/tally/cache.ts` + migration 2 (`tally_masters` table) — a resync
  transactionally replaces one master type's rows; readers never see a
  half-updated set.
- `npm run tally:sync` — manual, on-demand sync CLI (no scheduled sync in this
  phase, per MVP scope).
- Every request shape and edge case was confirmed **live against the target
  company** (Nirmal FMCG Traders Ltd) before being written into code; a real
  captured response is the test fixture for the parser. Full sync run twice
  live: 29 ledgers, 23 stock items, 12 godowns, 4 units, 27 voucher types, and
  confirmed idempotent (95 rows both times, no duplication).

## Work in progress

None.

## Next task

Phase 4 — LLM module: provider-agnostic client, structured extraction schema,
single call combining intent detection and field extraction. No validation or
Tally posting yet; extraction output is not sent anywhere near Tally.

## Known issues / blockers

- No GitHub remote and `gh` CLI is not installed — local commits only.
- `node:sqlite` remains experimental (accepted, `DECISIONS.md` #11).
- No rate limiting yet (Phase 8).
- LLM provider still undecided (deliberate, `DECISIONS.md` #3).
- Master field lists are intentionally narrow (e.g. `Ledger` has no GST fields
  yet); Phase 5 (validation) is expected to add fields as real validation rules
  need them, not before.

## Last important technical decision

An ad-hoc `COLLECTION` export via Tally's TDL request shape was confirmed live
to be the correct approach — the more obvious named-report shape (the one behind
Tally's own "All Masters" file export) returns `Unknown Request, cannot be
processed` for a custom collection; TDL's `<TYPE>COLLECTION</TYPE>` +
`<TDL><TDLMESSAGE><COLLECTION>` shape is required. Also: the HTTP interface
responds in plain UTF-8, unlike Tally's UTF-16LE file exports. `DECISIONS.md`
#13.
