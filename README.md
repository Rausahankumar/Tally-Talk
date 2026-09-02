# TallyTalk

A conversational AI assistant for TallyPrime. Describe a transaction in plain
language on Telegram and the system creates the voucher in Tally — but only
after backend validation and your explicit confirmation.

> "Sell 100 cement bags to Ramesh at ₹500 per bag with 18% GST."

**AI understands → Backend verifies → User confirms → Tally executes.**

The LLM never writes to Tally, never performs accounting calculations, and never
causes a write on its own.

## Status

Phase 6 complete. A Telegram message now flows end to end: the webhook (secret
token + allowlist checks unchanged) hands the text to the Anthropic-backed LLM
module for structured extraction, validates the result against the cached
TallyPrime master data, tracks the draft per chat across follow-up messages
(filling in missing fields, resolving ambiguous ledger/item matches from a
plain reply), and — once everything checks out — sends a preview with explicit
Confirm/Cancel buttons. Confirming only marks the draft as approved; **nothing
is sent to Tally yet**. A separate, manual command syncs and caches TallyPrime
master data read-only. See `PROJECT_STATUS.md`.

## Requirements

- Node.js 20 or newer (developed on v24)
- TallyPrime running on the same machine or LAN, with XML/HTTP enabled
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env` — see the comments in `.env.example` for what each key does.
Never commit `.env`.

## Scripts

| Command | Purpose |
|---|---|
| `npm start` | Run the server (reads `.env`) |
| `npm run dev` | Run the server with file watching |
| `npm run tally:sync` | Sync and cache TallyPrime master data (read-only) |
| `npm test` | Run the test suite once |
| `npm run test:watch` | Run tests in watch mode |
| `npm run typecheck` | Type-check without emitting |

## Endpoints

| Route | Purpose |
|---|---|
| `GET /health` | Liveness check |
| `POST /webhook/telegram` | Telegram updates — requires a valid `X-Telegram-Bot-Api-Secret-Token` header, then an allowlisted sender |

Register the webhook with Telegram using the same secret you put in `.env`:

```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" -d "url=https://<host>/webhook/telegram" -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

## Deployment note

The backend is designed to run **on-premises, on the same LAN as TallyPrime**.
Tally's XML/HTTP interface has no authentication and must never be exposed to
the internet.

The audit log is a single SQLite file at `DATABASE_PATH` (its directory is
created on first run). It is append-only — database triggers reject any update
or delete — so back it up with the same routine that covers the Tally data
directory, and never try to prune it in place.

## Documentation

| File | Contents |
|---|---|
| `PROJECT_STATUS.md` | Current phase, task, blockers — read this first |
| `PROJECT_PLAN.md` | Architecture, MVP scope, phase roadmap |
| `DECISIONS.md` | Technical decisions with reasons and alternatives |
| `CLAUDE.md` | Working instructions for Claude Code sessions |
| `TallyChat - TallyTalk.md` | Product vision and requirements (source) |
| `snoopy-swimming-walrus.md` | Approved foundation plan (source) |
