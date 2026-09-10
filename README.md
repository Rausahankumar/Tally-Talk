# TallyTalk

A conversational AI assistant for TallyPrime. Describe a transaction in plain
language on Telegram and the system creates the voucher in Tally — but only
after backend validation and your explicit confirmation.

> "Sell 100 cement bags to Ramesh at ₹500 per bag with 18% GST."

**AI understands → Backend verifies → User confirms → Tally executes.**

The LLM never writes to Tally, never performs accounting calculations, and never
causes a write on its own.

## Status

The full pipeline is wired end to end: Telegram → LLM extraction → deterministic
validation → GST/ledger/godown/batch readiness → preview → Confirm/Cancel →
Tally posting (`src/tally/posting.js`) — deterministic voucher XML, HTTP
Import, response parsing, exactly-once duplicate/concurrency protection. Real
sales vouchers have been posted successfully to a live TallyPrime instance.

GST determination (Company State vs. Place of Supply — never the party's
state) is fully dynamic, resolved per transaction from the cached Tally
masters (`src/gst/`) — nothing is hardcoded per client. GST is resolved **per
line item**, not once per voucher, so a sale with items at genuinely different
real GST rates resolves correctly. Sales/Purchase ledger resolution follows an
explicit precedence: an item-level override (`item_ledger_mappings`) beats a
company-level default beats automatic single-candidate resolution from Tally's
own ledger groups beats a clear block when genuinely ambiguous — a brand-new
stock item or ledger created in Tally needs no manual mapping to be usable.

A separate, manual command (`npm run tally:sync`) syncs and caches TallyPrime
master data read-only; the running server never talks to Tally except for the
final, user-confirmed posting write. See `PROJECT_STATUS.md`.

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