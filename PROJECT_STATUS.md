# Project Status

_Last updated: 2026-09-02_

## Current phase

Phase 2 — SQLite append-only audit log. **Complete.**

## Current task

None. Awaiting approval to begin Phase 3.

## Completed work

**Phase 0 — Foundation & Toolchain**
- Git, documentation set, TypeScript 5.9 strict + Vitest 4.

**Phase 1 — Telegram Webhook Vertical Slice**
- `src/config/` startup validation; `src/channels/telegram/` webhook, parser and
  Bot API client; Express 5 app with `/health` and `POST /webhook/telegram`.
- Gates in order: constant-time secret-token check → 401; allowlist check →
  acknowledged and dropped silently.

**Phase 2 — Audit Log**
- `src/db/schema.ts` — `audit_events` table, three indexes, CHECK constraints
  covering the whole event vocabulary, and `BEFORE UPDATE`/`BEFORE DELETE`
  triggers that abort. Migrations tracked via `PRAGMA user_version`.
- `src/db/sqlite.ts` — opens the database on Node's built-in `node:sqlite`,
  sets WAL and busy-timeout pragmas, creates the parent directory, migrates.
- `src/audit/events.ts` — one envelope for every event; `data` is a JSON column
  so later phases record richer payloads with no schema change.
- `src/audit/log.ts` — `record` and `findByCorrelationId` only. A failed write is
  logged loudly but never breaks request handling.
- Webhook now records `webhook.rejected`, `message.received`, and
  `authorization.granted` / `authorization.denied`, all under one
  `correlationId` per inbound update.

## Work in progress

None.

## Next task

Phase 3 — Tally XML/HTTP client and master data sync: connect to TallyPrime on
the LAN, export ledgers, stock items, godowns and tax ledgers, and cache them
locally for fuzzy matching. No LLM yet.

## Known issues / blockers

- **No GitHub remote and `gh` CLI is not installed** — push and pull-request
  workflow unavailable. All commits are local only.
- `main` branch still has no commits; history is on the phase branches.
- `node:sqlite` is still marked experimental in Node; accepted deliberately
  (`DECISIONS.md` #11) and prints no warning in Node 24.
- No rate limiting yet (planned for Phase 8).
- LLM provider still undecided (deliberate — `DECISIONS.md` #3).

## Last important technical decision

SQLite was **kept** for the audit log after a proposed switch to MongoDB was
evaluated and reverted: on-prem deployment next to TallyPrime makes a plain file
— nothing to install, no service, no open port, backup by file copy — worth more
than a document store's modelling convenience at this scale. Recorded as
`DECISIONS.md` #10, with #11 (built-in `node:sqlite`, no native addon) and #12
(append-only enforced by database triggers) following from it.
