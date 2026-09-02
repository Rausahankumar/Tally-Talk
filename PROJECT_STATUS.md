# Project Status

_Last updated: 2026-09-02_

## Current phase

Phase 1 — Telegram Webhook Vertical Slice. **Complete.**

## Current task

None. Awaiting approval to begin Phase 2.

## Completed work

**Phase 0 — Foundation & Toolchain**
- Git initialised; documentation set (`CLAUDE.md`, `README.md`, `PROJECT_PLAN.md`,
  `DECISIONS.md`, this file), `.env.example`, `.gitignore`.
- TypeScript 5.9 strict + Vitest 4; toolchain test.

**Phase 1 — Telegram Webhook Vertical Slice**
- `src/config/` — loads and validates env at startup; aggregates every problem
  into one `ConfigError` and exits before the socket opens.
- `src/channels/telegram/` — defensive update parser, outbound Bot API client
  (injectable `fetch`), and the webhook route.
- `src/app.ts` / `src/server.ts` — Express 5 app with `/health`, the webhook at
  `POST /webhook/telegram`, 64 kB body cap, JSON 404 and error handlers.
- Security gates, in order: constant-time `X-Telegram-Bot-Api-Secret-Token`
  check → 401; then allowlist check → acknowledged and dropped silently.
- `npm start` / `npm run dev` run TypeScript directly on Node — no build step.

## Work in progress

None.

## Next task

Phase 2 — Config completion, SQLite setup and the append-only audit log:
`src/db/` schema and migration, `src/audit/` writer, and audit records for
inbound messages and authorization outcomes.

## Known issues / blockers

- **No GitHub remote and `gh` CLI is not installed** — push and pull-request
  workflow unavailable. All commits are local only.
- `main` branch still has no commits; history is on the phase branches.
- Nothing is persisted yet — rejected and accepted messages are logged to stdout
  only. Phase 2 addresses this.
- No rate limiting yet (planned for Phase 8).
- LLM provider still undecided (deliberate — `DECISIONS.md` #3).

## Last important technical decision

Unauthorized Telegram users are dropped silently rather than told they are
blocked: replying would confirm to a prober that a live accounting bot sits
behind the endpoint, while HTTP 200 stops Telegram retrying. See `DECISIONS.md`
#9; the no-build-step TypeScript decision is #8.
