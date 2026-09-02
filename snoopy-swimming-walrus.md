# Tally-Bot: Project Foundation Plan

## Context

The goal is a conversational AI system where users message Telegram (WhatsApp later) in natural language to create TallyPrime transactions (Sales Invoice first, Purchase Voucher if cheap to add). No transaction may reach Tally without explicit user confirmation and backend validation; the LLM never talks to Tally directly. This is a **foundation-only** planning pass per `claude.md` — no application code, just requirements, architecture decisions, MVP scope, folder layout, and doc files. The directory currently contains only `claude.md`.

User decisions already made:
- **Deployment topology:** Express backend runs on-prem / same LAN as TallyPrime (not cloud+tunnel). This avoids exposing Tally's unauthenticated XML/HTTP port to the internet and avoids tunnel/VPN infra cost.
- **LLM provider:** not decided yet — keep the LLM call isolated behind one module/interface so the provider can be swapped later without touching the rest of the flow.

---

## 1. Understanding

Build a Telegram bot backed by an Express server that: extracts structured transaction data from natural language via an LLM, validates it deterministically against live Tally master data, shows the user a preview, requires explicit confirmation, then posts the voucher to TallyPrime's XML/HTTP interface and writes an audit log entry. Everything Tally-facing and calculation-facing lives in the backend, never the LLM.

## 2. What's Missing / Better Opportunities

**Architecture: drop "OpenClaw" as a separate hop.** For a Telegram-only MVP, a dedicated gateway service adds a network hop, a deployment unit, and a failure mode for no current benefit — Telegram's own Bot API webhook can POST directly into the Express backend. Recommendation: **Telegram webhook → Express backend → LLM module (in-process) → Tally XML client**. If/when WhatsApp is added later, handle it as a second channel adapter inside the same backend (shared conversation/validation/Tally logic), not a separate gateway service. Only revisit a gateway if a real multi-channel abstraction need shows up.

**Master data sync & fuzzy matching (missing).** The LLM can't reliably map free text ("Ramesh", "cement bags") to real Tally ledger/stock item names. Need a backend-side cache of Tally masters (ledgers, stock items, godowns, tax ledgers/GST rates, units) synced via Tally's XML export, refreshed periodically or on-demand. Match candidates deterministically (fuzzy string match) in the backend; only send the LLM a short list of candidates when disambiguation is genuinely needed — not the whole master list.

**Multi-turn conversation state (missing).** Real requests are rarely complete in one message ("missing: rate, GST ledger, godown"). Need per-chat session state holding the structured draft-in-progress, with a timeout/reset, so follow-up replies fill in gaps instead of restarting.

**Authorization allowlist (missing).** The bot must not act for arbitrary Telegram users. Need a static mapping of approved Telegram user IDs → the single Tally company (MVP), checked before any LLM call or Tally write.

**Idempotency (missing).** Guard against duplicate voucher creation from double-taps on "Confirm" or retried requests (e.g., a per-draft idempotency key checked before posting to Tally).

**Audit log storage (missing).** Needs an actual durable store — SQLite is sufficient for MVP single-tenant, append-only: raw message, LLM structured output, validation result, user confirmation, Tally response.

**Tally connectivity failure handling (missing).** Tally may be closed, busy, or unreachable — define a clear user-facing error and retry/backoff behavior; do not silently drop confirmed transactions.

## 3. Security Concerns

- **Tally's XML/HTTP interface has no built-in auth** — never expose it beyond localhost/LAN (confirmed: on-prem topology addresses this).
- **Telegram webhook must verify origin** — use the `X-Telegram-Bot-Api-Secret-Token` header (or a secret path) so arbitrary internet requests can't hit the bot endpoint.
- **User allowlist required** — reject any Telegram user ID not explicitly authorized.
- **Prompt injection** — a user's free-text message could try to steer the LLM into producing an oversized/wrong-ledger draft. Mitigation: LLM output is a constrained structured draft only (schema-validated), backend re-validates ledger/item existence, GST math, and sane amount bounds regardless of what the LLM returned; nothing is ever executed from LLM text directly.
- **Secrets** (Telegram bot token, LLM API key, any Tally credentials) via `.env`, never committed; `.env.example` documents required keys.
- **Audit log integrity** — append-only, never edited/deleted by the app itself.
- **Rate limiting** — cap messages/LLM calls per user per minute to bound cost and abuse.
- **Data minimization to the LLM** — don't send full ledger/customer lists (financial data exposure to a third-party API); send only what's needed for the current extraction/disambiguation step.

## 4. Token & Cost Optimization

- One LLM call per user turn: combine intent detection + field extraction into a single structured-output/function-calling call (avoid separate "classify" then "extract" calls).
- Never send full master data to the LLM — backend fuzzy-matches locally, sends only top-N candidates when disambiguation is needed.
- Send the running structured draft + latest message to the LLM each turn, not the full chat transcript.
- Prefer a small/cheap model for this narrow extraction task (defer exact model choice; keep the LLM call behind one interface so this is a config change, not a redesign).
- Use provider-level prompt caching for the static system prompt/schema instructions where supported.
- Do all calculation (GST, totals, rounding) in backend code — never ask the LLM to compute.
- No LLM call at all for the confirm/cancel step — that's a deterministic backend action on a button press.

## 5. Unnecessary Complexity to Avoid in MVP

- Separate "OpenClaw" gateway service (see §2).
- WhatsApp channel, multi-company support, multi-user RBAC beyond a simple allowlist.
- Vector DB/embeddings for name matching — plain fuzzy string matching against the cached master list first; revisit only if it proves insufficient.
- Message queues (Kafka/RabbitMQ) or microservices — a single Express process is enough at this scale.
- Voucher editing/cancellation, analytics, reporting.
- Abstracting the LLM provider beyond "one isolated module" — no plugin framework needed yet.

## 6. Recommended MVP Scope

- Telegram bot (webhook) with a fixed allowlist of authorized user IDs, single Tally company, on-prem deployment alongside TallyPrime.
- Sales Invoice creation; add Purchase Voucher only if it reuses the same posting/validation path without extra design work (likely yes — same XML posting mechanism, different voucher type and ledger roles).
- Backend-cached Tally master data (ledgers, stock items, godowns, tax ledgers) with periodic/on-demand sync and local fuzzy matching.
- One LLM call per turn for structured extraction; per-chat session state for multi-turn slot-filling.
- Deterministic backend validation (schema, ledger/item existence, GST calc, amount sanity, missing-field detection).
- Preview message with explicit Confirm/Cancel (Telegram inline buttons), idempotent posting to Tally on confirm.
- SQLite-backed append-only audit log.
- Secrets via `.env`.

**Explicitly out of MVP (later):** WhatsApp, multi-company, additional voucher types (Payment/Receipt/Journal/Debit-Credit Note), voucher edit/cancel, reporting/analytics, embeddings-based matching, multi-user RBAC, horizontal scaling, admin dashboard, any gateway/OpenClaw-style abstraction.

## 7. Recommended Folder Structure

```
tally-bot/
  CLAUDE.md
  README.md
  PROJECT_STATUS.md
  PROJECT_PLAN.md
  DECISIONS.md
  .env.example
  .gitignore
  package.json
  src/
    server.ts               # Express app entry, Telegram webhook route
    config/                 # env/config loading
    channels/
      telegram/             # webhook handler, message/keyboard formatting
    llm/
      client.ts             # provider-agnostic LLM call wrapper
      schema.ts             # structured output schema for draft extraction
      prompts/               # system prompt template(s)
    tally/
      client.ts             # Tally XML/HTTP client
      masters.ts             # master data sync + cache
      vouchers/
        salesInvoice.ts
        purchaseVoucher.ts    # only if added
    validation/              # schema + business-rule validation
    conversation/             # per-chat session/draft state
    audit/                    # audit log writer
    db/                       # SQLite setup/migrations
  tests/
```

## 8. Documentation Files to Create Now

Per `CLAUDE.md`'s own documentation rules, only:
- `README.md` — setup/run instructions (practical necessity, not covered by CLAUDE.md's list but needed to run the project).
- `PROJECT_STATUS.md` — current phase/task/next task, kept short.
- `PROJECT_PLAN.md` — this foundation (architecture, MVP scope, decisions) as the living plan doc.
- `DECISIONS.md` — first entries: "on-prem deployment over cloud+tunnel," "no separate OpenClaw gateway for MVP," "LLM provider deferred, isolated behind one module."
- `.env.example` — documents required secrets (Telegram bot token, LLM API key, Tally connection settings) without values.

No additional docs (no ARCHITECTURE.md, no API docs, no CONTRIBUTING.md) at this stage.

## Next Step After Approval

Create the folder skeleton and the five documentation files listed above (content only — no application logic yet), seeded with this plan's decisions. No `src/` code is written until a follow-up planning pass for the first vertical slice (Telegram webhook receiving a message).
