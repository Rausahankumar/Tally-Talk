# TallyTalk — Project Plan

Living plan. Seeded from the approved foundation plan (`snoopy-swimming-walrus.md`)
and the product spec (`TallyChat - TallyTalk.md`). Update only on architecture
changes, major requirement changes, or completion of a major phase.

## Goal

Users message a Telegram bot in natural language ("Sell 100 cement bags to Ramesh
at ₹500 per bag with 18% GST"); the system extracts structured data with an LLM,
validates it deterministically in the backend against live Tally master data,
shows a preview, requires explicit confirmation, then posts the voucher to
TallyPrime and writes an audit record.

**AI understands → Backend verifies → User confirms → Tally executes.**

## Architecture

```
Telegram webhook
      ↓
Express backend  ──→ LLM module (in-process, provider-agnostic)
      ↓
Backend validation + fuzzy match against cached Tally masters
      ↓
Preview → Confirm / Cancel (inline buttons)
      ↓
Tally XML/HTTP client  →  SQLite audit log
```

Single Express process, deployed **on-prem on the same LAN as TallyPrime**. No
separate gateway service. Later channels (e.g. WhatsApp) become additional
channel adapters inside the same backend, sharing conversation, validation and
Tally logic.

## Planned module layout

Directories are created only when a phase needs them.

| Path | Responsibility |
|---|---|
| `src/server.ts` | Express entry, webhook route |
| `src/config/` | Env loading and validation |
| `src/channels/telegram/` | Webhook handler, message and keyboard formatting |
| `src/llm/` | Provider-agnostic LLM call, output schema, prompts |
| `src/tally/` | XML/HTTP client, master data sync + cache, voucher builders |
| `src/validation/` | Schema and business-rule validation |
| `src/conversation/` | Per-chat session and draft state |
| `src/audit/` | Append-only audit log writer |
| `src/db/` | SQLite setup and migrations |
| `tests/` | Test suite |

## MVP scope

In scope:
- Telegram bot via webhook, secret-token verified, fixed user allowlist
- Single Tally company, on-prem deployment
- Sales Invoice creation (Purchase Voucher only if it reuses the same path)
- Cached Tally master data (ledgers, stock items, godowns, tax ledgers, units)
  with periodic/on-demand sync and local fuzzy matching
- One LLM call per user turn; multi-turn slot filling via per-chat session state
- Deterministic backend validation: schema, ledger/item existence, GST math,
  amount sanity, missing-field detection
- Preview with Confirm/Cancel; idempotent posting on confirm
- SQLite append-only audit log
- Secrets via `.env`

Out of MVP (later): WhatsApp, multi-company, Payment/Receipt/Journal/Credit &
Debit Note vouchers, voucher edit/cancel, reporting and analytics,
embeddings-based matching, multi-user RBAC, horizontal scaling, admin dashboard,
any gateway/OpenClaw-style abstraction.

## Security requirements

- Tally XML/HTTP reachable on localhost/LAN only, never internet-exposed
- Verify `X-Telegram-Bot-Api-Secret-Token` on every webhook request
- Allowlist check before any LLM call or Tally write
- Backend re-validates everything independently of LLM output (prompt injection)
- Secrets in `.env` only; `.env.example` documents required keys
- Append-only audit log
- Per-user rate limiting on messages and LLM calls
- Data minimisation: never send full master data or chat history to the LLM

## Cost controls

One LLM call per turn (intent + extraction combined); send only the running draft
plus the latest message; send only top-N fuzzy-match candidates when
disambiguating; all arithmetic in backend code; no LLM call for Confirm/Cancel;
small/cheap model behind a swappable interface; prompt caching where supported.

## Phase roadmap

| Phase | Scope | Status |
|---|---|---|
| 0 | Foundation: docs, git, TypeScript + Vitest toolchain | ✅ Complete |
| 1 | Telegram webhook slice: secret verification, allowlist, echo reply | Next |
| 2 | Config module, SQLite setup, append-only audit log | Planned |
| 3 | Tally XML client + master data sync and cache | Planned |
| 4 | LLM module: structured extraction schema and single-call extraction | Planned |
| 5 | Validation + fuzzy matching + GST calculation | Planned |
| 6 | Conversation state and multi-turn slot filling | Planned |
| 7 | Preview, Confirm/Cancel, idempotent Sales Invoice posting | Planned |
| 8 | Hardening: rate limiting, Tally failure handling, retries | Planned |

Phase boundaries may be adjusted as work proceeds; each phase requires explicit
user approval before it starts.
