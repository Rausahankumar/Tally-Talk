# Project Status

_Last updated: 2026-09-02_

## Current phase

Phase 4 — LLM structured extraction. **Complete.**

## Current task

None. Awaiting approval to begin Phase 5.

## Completed work

**Phases 0–3** — foundation, Telegram webhook with security gates, append-only
SQLite audit log, Tally master data sync. See git history for detail.

**Phase 4 — LLM Structured Extraction**
- `src/llm/schema.ts` — `TransactionDraft` type, the JSON Schema handed to
  Anthropic as a forced tool signature, and `parseTransactionDraft`: a strict,
  no-coercion runtime validator that re-checks every field regardless of the
  forced schema. No total, GST amount, or subtotal field exists in the draft —
  the model states facts, it does not compute.
- `src/llm/prompts.ts` — the extraction system prompt, kept as its own module.
- `src/llm/client.ts` — `createAnthropicClient`, one call per message via the
  Messages API with `tool_choice` forcing `record_transaction_draft`, combining
  intent (`voucherType`) and field extraction. `exportCollection`-style
  injectable `fetch`; `LLMConnectionError` / `LLMResponseError` for network and
  shape failures.
- Config: `LLM_PROVIDER` (must be `anthropic`), `LLM_API_KEY` (required),
  `LLM_MODEL` (defaults to `claude-sonnet-5`).
- Not wired into the webhook yet — Phase 4 is the module in isolation. Nothing
  in `src/llm/` references Tally, sends a Telegram reply, or has any
  confirmation or write path.

## Work in progress

None.

## Next task

Phase 5 — Validation + fuzzy matching + GST calculation: match a draft's
`partyName` and item names against the Phase 3 master cache, compute GST/totals
in backend code, and produce a validation result. Still no confirmation flow,
still no Tally write.

## Known issues / blockers

- No GitHub remote and `gh` CLI is not installed — local commits only.
- No rate limiting yet (Phase 8).
- `LLM_API_KEY` requires a real Anthropic key to run live; all Phase 4 automated
  tests use an injected fake `fetch` and need no key. A real end-to-end call has
  not been made — see the Phase 4 completion report for what that would need.

## Last important technical decision

Extraction uses Anthropic's forced `tool_choice` for structured output, but the
runtime validator (`parseTransactionDraft`) still re-checks the result from
scratch rather than trusting the tool schema match — matching this project's
rule that the backend never trusts LLM output. `DECISIONS.md` #16–17.
