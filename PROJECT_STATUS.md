# Project Status

_Last updated: 2026-09-02_

## Current phase

Phase 6 — Conversation state, multi-turn slot filling, preview, Confirm/Cancel.
**Complete.**

## Current task

None. Awaiting approval to begin Phase 7.

## Completed work

**Phases 0–5** — foundation, Telegram webhook with security gates, append-only
SQLite audit log, Tally master data sync, LLM structured extraction,
deterministic validation and master matching. See git history for detail.

**Phase 6 — Conversation Flow**

The full pipeline is now wired together and live in the webhook: Telegram
message → LLM extraction → Phase 5 validation → conversation state → preview →
explicit Confirm/Cancel. Nothing in this phase calls Tally.

- `src/conversation/store.ts` — `conversation_drafts` table (one row per chat,
  upserted), with `setStatusIfCurrent`: a single conditional `UPDATE` gated on
  chat, user, draft version, and expected status all matching. This one
  mechanism is what makes stale buttons, duplicate taps, and cross-chat
  callbacks all fail safely (`DECISIONS.md` #21). Expiry (15 min) is checked
  lazily on read, no scheduler needed.
- `src/conversation/merge.ts` — deterministic merge of a follow-up extraction
  into the existing draft; Phase 4's client was deliberately **not** given
  prior-draft context (`DECISIONS.md` #22).
- `src/conversation/clarification.ts` — an ambiguous match is resolved from the
  next reply via Phase 5's own `matchName`, never a second LLM call
  (`DECISIONS.md` #23).
- `src/conversation/messages.ts` — pure text builders for every outcome
  (preview, follow-up ask, clarification, confirmed, cancelled, rejected).
- `src/conversation/handleMessage.ts` / `handleCallback.ts` — the two
  orchestrators, wired into `src/channels/telegram/webhook.ts` after the
  existing, unchanged security gates.
- `src/channels/telegram/{client,types}.ts` — extended for inline keyboards,
  `answerCallbackQuery`, and callback-query parsing.
- `src/db/schema.ts` — migration 3 widens the audit event vocabulary (via
  SQLite's recreate-table pattern, `DECISIONS.md` #24); migration 4 adds
  `conversation_drafts`.
- `src/audit/events.ts` — four new event types now emitted:
  `draft.created`/`draft.updated`, `preview.shown`, `confirmation.rejected`
  (plus `user.confirmed`/`user.cancelled`, declared earlier, emitted for the
  first time here).

**Not touched:** `src/llm/` (Phase 4), `src/validation/` (Phase 5), and
`src/tally/masters.ts`/`client.ts` (Phase 3) — confirmed by diff. No Tally
write capability, no WhatsApp, no new dependency.

## Work in progress

None.

## Next task

Phase 7 — Idempotent Sales Invoice posting to Tally: a confirmed draft
(`status = 'confirmed'` in `conversation_drafts`) is posted via the Phase 3
Tally client's write path (not yet built — Phase 3 is export-only today), with
an idempotency key so a retry cannot double-post.

## Known issues / blockers

- No GitHub remote and `gh` CLI is not installed — local commits only.
- No rate limiting yet (Phase 8).
- Multi-turn continuation via a bare correction (e.g. "actually make that 200"
  with no other context) has not been verified against the real Anthropic API —
  this phase's tests use a scripted fake LLM throughout, by design. Recorded as
  a limitation, not hidden (`DECISIONS.md` #22).
- Ambiguous-candidate replies are matched with Phase 5's existing fuzzy
  threshold; a reply that doesn't clearly pick one falls through to a fresh LLM
  extraction of that same message.
- `conversation_drafts` holds only the single most recent draft per chat; there
  is no history of earlier, superseded drafts beyond what the audit log
  captured about them.

## Last important technical decision

Confirm/Cancel safety is one mechanism, not several: a `draft_version_id`
embedded in each button's callback data, checked via a single conditional SQL
`UPDATE` against the chat, user, version, and expected status all at once.
Stale buttons, duplicate taps, expired drafts, and cross-chat forgeries all
fail through the same code path with no special-casing. `DECISIONS.md` #21.
