# TallyTalk

A conversational AI assistant for TallyPrime. Describe a transaction in plain
language on Telegram and the system creates the voucher in Tally — but only
after backend validation and your explicit confirmation.

> "Sell 100 cement bags to Ramesh at ₹500 per bag with 18% GST."

**AI understands → Backend verifies → User confirms → Tally executes.**

The LLM never writes to Tally, never performs accounting calculations, and never
causes a write on its own.

## Status

Phase 0 (foundation) complete — documentation, Git, and the TypeScript + Vitest
toolchain. No application code yet. See `PROJECT_STATUS.md`.

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
| `npm test` | Run the test suite once |
| `npm run test:watch` | Run tests in watch mode |
| `npm run typecheck` | Type-check without emitting |

## Deployment note

The backend is designed to run **on-premises, on the same LAN as TallyPrime**.
Tally's XML/HTTP interface has no authentication and must never be exposed to
the internet.

## Documentation

| File | Contents |
|---|---|
| `PROJECT_STATUS.md` | Current phase, task, blockers — read this first |
| `PROJECT_PLAN.md` | Architecture, MVP scope, phase roadmap |
| `DECISIONS.md` | Technical decisions with reasons and alternatives |
| `CLAUDE.md` | Working instructions for Claude Code sessions |
| `TallyChat - TallyTalk.md` | Product vision and requirements (source) |
| `snoopy-swimming-walrus.md` | Approved foundation plan (source) |
