# Technical Decisions

Important decisions only. Newest last.

---

### 1. Deploy on-prem on the same LAN as TallyPrime

- **Decision:** The Express backend runs on-premises alongside TallyPrime rather
  than in the cloud with a tunnel back to Tally.
- **Reason:** Tally's XML/HTTP interface has no authentication. Keeping it on the
  LAN means it is never internet-reachable, and there is no tunnel/VPN cost.
- **Alternatives considered:** Cloud backend + reverse tunnel/VPN to the Tally
  machine — rejected as more infrastructure and a larger attack surface.
- **Date:** 2026-09-02

### 2. No separate OpenClaw / gateway service in the MVP

- **Decision:** Telegram webhook posts directly into the Express backend; the
  LLM module runs in-process.
- **Reason:** For a Telegram-only MVP a gateway adds a network hop, a deployment
  unit and a failure mode with no current benefit.
- **Alternatives considered:** Dedicated gateway service — deferred; if WhatsApp
  is added it becomes a second channel adapter inside the same backend, sharing
  conversation, validation and Tally logic.
- **Date:** 2026-09-02

### 3. LLM provider deferred, isolated behind one module

- **Decision:** No provider chosen yet. All LLM access goes through a single
  provider-agnostic module.
- **Reason:** The task is narrow structured extraction; a small/cheap model is
  likely sufficient. Isolating the call makes the provider a config change
  rather than a redesign.
- **Alternatives considered:** Committing to a provider now — premature; a
  plugin/abstraction framework — unnecessary complexity for one call site.
- **Date:** 2026-09-02

### 4. Repository root is the project root

- **Decision:** The project lives directly in `D:\Tally-Talk`, not in a nested
  `tally-bot/` subdirectory as sketched in the approved plan.
- **Reason:** The repository contains only this project; an extra nesting level
  adds path noise without separating anything.
- **Alternatives considered:** Nested `tally-bot/` folder per the plan sketch.
- **Date:** 2026-09-02

### 5. TypeScript + Vitest toolchain established in Phase 0

- **Decision:** Stand up TypeScript (strict) and Vitest with a toolchain test in
  Phase 0, before any application code.
- **Reason:** Project rules forbid completing a phase without running tests. The
  planned Phase 0 produced no executable code, so there would have been nothing
  to run. Proving the harness now means feature phases start with a working
  `npm test` instead of debugging tooling mid-feature.
- **Alternatives considered:** Deferring the test harness to Phase 1 — would have
  made Phase 0 unverifiable and mixed tooling setup into feature work.
- **Date:** 2026-09-02

### 6. No advance scaffolding of the `src/` tree

- **Decision:** Directories and files are created only when an approved phase
  actually needs them. Phase 0 creates no `src/` tree.
- **Reason:** Empty directories and placeholder files are noise: they carry no
  information, cannot be tested, and drift from the design as it evolves. The
  intended layout is documented in `PROJECT_PLAN.md` instead.
- **Alternatives considered:** Creating the full skeleton with `.gitkeep`
  placeholders up front, as sketched in the approved plan.
- **Date:** 2026-09-02

### 7. Vitest 4 rather than the initially pinned Vitest 2

- **Decision:** Use Vitest 4.x.
- **Reason:** Vitest 2.1.x pulled a vite/esbuild chain carrying five advisories,
  one critical and one high (all dev-only). Vitest 4 resolves them —
  `npm audit` reports zero vulnerabilities.
- **Alternatives considered:** Staying on Vitest 2 and accepting dev-only
  advisories; pinning overrides for the transitive `vite`/`esbuild` versions —
  both worse than simply using a current major.
- **Date:** 2026-09-02

### 8. Run TypeScript directly on Node, with no build step

- **Decision:** Source runs as `.ts` via Node 24's native type stripping
  (`node src/server.ts`). No bundler, no `tsx`, no `tsc` emit. `tsconfig.json`
  sets `erasableSyntaxOnly` and `allowImportingTsExtensions`, and relative
  imports carry explicit `.ts` extensions. `tsc` is used only for type checking.
- **Reason:** Removes a build tool, a build step and a class of
  source-map/output-drift problems from a project that deploys on-prem to a
  single machine. Node 20+ is already a stated requirement.
- **Alternatives considered:** `tsx` in development plus `tsc` emit for
  production — a second toolchain and an extra dependency for no benefit at this
  scale; bundling — unnecessary for a server that is not distributed.
- **Consequence:** `erasableSyntaxOnly` forbids TypeScript enums and constructor
  parameter properties. Both have plain equivalents already in use.
- **Date:** 2026-09-02

### 9. Unauthorized Telegram users are dropped silently, not told they are blocked

- **Decision:** A message from a user who is not on the allowlist is
  acknowledged with HTTP 200 and discarded. No reply is sent to that user; the
  attempt is logged with the user ID.
- **Reason:** Replying confirms to an unknown prober that a live accounting bot
  sits behind the endpoint. Acknowledging with 200 stops Telegram from retrying
  the update. The log entry still lets an operator notice a genuine user who
  needs adding.
- **Alternatives considered:** Replying "you are not authorized" — friendlier for
  legitimate users but leaks the bot's existence and purpose; returning a non-2xx
  status — would make Telegram retry the same rejected update repeatedly.
- **Date:** 2026-09-02

### 10. SQLite retained for the audit log; MongoDB evaluated and rejected

- **Decision:** The append-only audit log stays on SQLite, as in the approved
  foundation plan. A switch to MongoDB was proposed, implemented far enough to
  evaluate, and then reverted.
- **Reason:** The deciding factor is the deployment model. This runs on-premises
  on the same Windows machine as TallyPrime, maintained by whoever maintains
  Tally — not by an ops team. SQLite is a file: nothing to install, no service to
  keep running, no port to leave unauthenticated on the LAN, and a backup is a
  file copy. MongoDB would have added a second server process to install,
  secure, monitor and back up, for a single-tenant workload of a few events per
  transaction.
- **Alternatives considered:** MongoDB — a document store fits heterogeneous
  event payloads naturally and the tooling was already on the development
  machine. Rejected because a JSON column in SQLite covers the same
  heterogeneity, and the operational cost outweighed the modelling convenience
  at this scale. Revisit if the deployment ever becomes multi-tenant or moves
  off a single box.
- **Date:** 2026-09-02

### 11. Use Node's built-in `node:sqlite` rather than a native SQLite package

- **Decision:** Persistence uses the `node:sqlite` module built into Node 24. No
  SQLite package is added to `package.json`.
- **Reason:** `better-sqlite3` and friends are native addons requiring a C++
  toolchain, or a matching prebuilt binary, on the target machine — a real
  burden on a Windows box that is meant to just run the thing. The built-in
  module needs neither, which keeps the no-build-step property from decision #8.
- **Alternatives considered:** `better-sqlite3` — faster and more featureful,
  but the compile/prebuild dependency is exactly the deployment friction SQLite
  was chosen to avoid; `node:sqlite` is still marked experimental, which is the
  accepted trade-off.
- **Date:** 2026-09-02

### 12. Append-only is enforced by the database, not by convention

- **Decision:** `BEFORE UPDATE` and `BEFORE DELETE` triggers on `audit_events`
  raise `ABORT`, so no connection can rewrite or remove an event — including the
  application's own. The `AuditLog` interface additionally exposes no update or
  delete method.
- **Reason:** An audit trail that the application could quietly edit is not
  evidence of anything. The triggers make immutability a property of the file
  itself, so it survives future code that has forgotten the rule.
- **Alternatives considered:** Relying on code review and a narrow interface
  alone — leaves history editable by anything holding the connection; a
  hash-chain over rows — meaningful tamper *detection*, but unnecessary
  complexity for an MVP whose file is already inside the trusted perimeter.
- **Date:** 2026-09-02

### 13. Tally requests use the TDL COLLECTION shape, not a named-report export

- **Decision:** Master data is fetched with `TALLYREQUEST=EXPORT`, `TYPE=COLLECTION`,
  and an inline `<TDL><TDLMESSAGE><COLLECTION>...` body naming exact fields — not
  the `EXPORTDATA/REQUESTDESC/REPORTNAME` shape used by Tally's built-in named
  reports (e.g. "All Masters", the format behind the file-export feature).
- **Reason:** The named-report shape returns a fixed report's worth of fields
  per record (a `LEDGER` carries 270 child tags in a full "All Masters" export)
  with no way to ask for less. A collection request specifies exactly the
  fields needed. Verified live against a running TallyPrime instance before
  being written into `src/tally/xml.ts` — the first attempt using the
  named-report shape for an ad-hoc collection returned `Unknown Request, cannot
  be processed`; the corrected TDL shape returned real data.
- **Alternatives considered:** The named-report shape — rejected for the reason
  above; parsing Tally's UTF-16LE file-export format instead of the HTTP
  interface — rejected because it requires Tally to have already written a file,
  which isn't triggerable on demand over HTTP.
- **Finding worth flagging:** the HTTP interface responds in plain UTF-8, unlike
  Tally's file exports, which are UTF-16LE with a BOM. The client assumes UTF-8;
  this should be re-confirmed if a different Tally version behaves otherwise.
- **Date:** 2026-09-02

### 14. Master data is cached as raw JSON, not normalised columns

- **Decision:** `tally_masters` stores each record's fields as one JSON blob per
  master (`data`), keyed by `(master_type, name)`. No per-field columns.
- **Reason:** Ledger records alone carry radically different shapes depending on
  configuration (GST fields, bill-wise settings, bank details). A fixed column
  set would need a migration every time a phase needs one more field; JSON does
  not. The one column actually queried on — `name` — is promoted out for the
  lookup index.
- **Alternatives considered:** A normalised `ledgers` / `stock_items` / ... table
  per master type — more type safety, but five schemas to maintain for data this
  MVP only reads back by name, and expanding a field list would still be a
  migration.
- **Date:** 2026-09-02

### 15. A resync fully replaces one master type; no incremental diffing

- **Decision:** `MasterCache.replaceAll` deletes and reinserts all rows for a
  master type in one transaction on every sync. There is no update-in-place or
  diff-based sync.
- **Reason:** The MVP scope is periodic/on-demand full sync, not live updates.
  Full replace is simple, and the transaction means a reader never sees a
  half-updated set. Tally master data at this scale (dozens to low hundreds of
  records) makes the cost of refetching everything negligible.
- **Alternatives considered:** Incremental sync via Tally's ALTERID tracking —
  real Tally capability, but meaningful complexity for a problem that doesn't
  exist yet at this data volume.
- **Date:** 2026-09-02

### 16. Anthropic Claude, using forced tool-use for structured extraction

- **Decision:** Phase 4's single LLM provider is Anthropic (Claude Sonnet 5 by
  default), called via the Messages API with `tool_choice` forcing a call to
  one tool (`record_transaction_draft`) whose `input_schema` is the draft
  schema. Intent (`voucherType`) and field extraction happen in that one call.
- **Reason:** Directed by the project owner. Forced tool-use makes the schema a
  generation constraint the API enforces, not just a hope — closer to
  structured output than prompting for JSON in prose and hoping it parses.
  A raw `fetch` call was used instead of the `@anthropic-ai/sdk` package, for
  the same reason the Telegram and Tally clients use raw `fetch`: one endpoint,
  one call shape, no need for a full SDK's surface area, and it keeps `fetch`
  trivially injectable for tests with no real network dependency.
- **Alternatives considered:** `@anthropic-ai/sdk` — heavier than needed for one
  call site; prompting for JSON without tool-use — no schema enforcement from
  the API side, leaving more for the runtime validator to catch.
- **Date:** 2026-09-02

### 17. The runtime validator never trusts a tool call just because it matched

- **Decision:** `parseTransactionDraft` re-validates every field of a model's
  tool-use `input` from scratch — type, enum membership, no coercion, no extra
  fields — even though `tool_choice` already constrains what the API should
  return.
- **Reason:** This project's core rule is that the backend never trusts LLM
  output; a forced tool schema narrows what a well-behaved model will produce,
  it does not guarantee it, and a client bug or an API change is still
  possible. The validator is the actual enforcement point, not the API's
  best-effort schema matching.
- **Alternatives considered:** Trusting `tool_choice` output directly and
  casting it to `TransactionDraft` — rejected outright; it is exactly the
  "backend blindly trusts the AI" failure mode `CLAUDE.md` rules out.
- **Date:** 2026-09-02

### 18. Combined edit-distance and partial-substring scoring for master matching

- **Decision:** `matchName` scores a candidate as `max(wholeStringSimilarity,
  bestSubstringWindowSimilarity)`, not plain Levenshtein similarity alone.
- **Reason:** Real Tally master names are frequently long and compound (e.g.
  "ACC Cement OPC 43 Grade"), while an LLM extracts short, plain names from a
  user's message (e.g. "cement"). Measured directly: whole-string similarity
  between those two strings is 0.26 — far below any usable threshold — despite
  "cement" being an exact substring. Sliding a same-length window across the
  longer name and taking the best exact-edit-distance score against that window
  fixes this while remaining fully deterministic (still edit distance, just
  against the best-aligned slice).
- **Alternatives considered:** Plain whole-string similarity — verified
  unusable for this project's actual data shape before being rejected, not
  assumed; a token-overlap/Jaccard scorer — workable, but a second, differently
  parameterised algorithm to reason about for one gain that the window approach
  already provides.
- **Date:** 2026-09-02

### 19. GST rate is checked against a fixed slab list, not per-item master data

- **Decision:** `isValidGstPercent` checks a stated rate against a fixed list of
  documented Indian GST slabs (0, 0.25, 1.5, 3, 5, 6, 7.5, 12, 18, 28), not
  against a per-stock-item or per-HSN rate looked up from Tally.
- **Reason:** The Phase 3 master cache does not carry GST/HSN fields (its
  `StockItem` field list is `NAME, PARENT, BASEUNITS` — see `src/tally/masters.ts`).
  Adding those fields is real scope, not a Phase 5 validation concern, so this
  phase validates plausibility of the stated number rather than correctness
  against a specific item's actual configured rate.
- **Limitation this creates:** a user-stated GST rate that is a real slab but
  wrong *for that specific item* (e.g. 18% stated for an item actually taxed at
  5%) passes this check. Catching that requires Phase 3's `StockItem` fields to
  be extended with GST/HSN data — explicitly out of Phase 5's scope, not
  overlooked.
- **Alternatives considered:** Fetching GST fields as part of this phase —
  rejected as scope creep into Phase 3's territory; skipping GST validation
  entirely — rejected, since a plausibility check is cheap and catches real
  extraction errors (e.g. "80% GST").
- **Date:** 2026-09-02

### 20. Voucher type validation checks the underlying Tally master, not just the enum

- **Decision:** Beyond rejecting `voucherType: 'unknown'`, a `sales` or
  `purchase` draft is checked against the Phase 3 `VoucherType` master cache
  for an exact-match "Sales" or "Purchase" record. Exact match only — no fuzzy
  matching for voucher types.
- **Reason:** A company can rename or delete Tally's default voucher types.
  Checking the enum alone would let a draft through that references a voucher
  type this specific company does not actually have configured. Fuzzy matching
  is deliberately excluded here: voucher type names are Tally configuration,
  not user-typed free text, so a close-but-wrong fuzzy match would be a real
  misconfiguration risk with no corresponding benefit.
- **Date:** 2026-09-02

### 21. Confirm/Cancel safety via a versioned, compare-and-set draft state machine

- **Decision:** Every draft stored in `conversation_drafts` carries a
  `draft_version_id` that changes on every create or update. Confirm/Cancel
  buttons embed that version in their `callback_data`. Acting on a tap goes
  through `setStatusIfCurrent`, a single SQL `UPDATE ... WHERE chat_id = ? AND
  telegram_user_id = ? AND draft_version_id = ? AND status = ?` — it only
  succeeds if every one of those still matches exactly what the callback
  claims.
- **Reason:** This one mechanism covers every safety requirement at once: a
  stale button (superseded draft) fails on version mismatch; a duplicate tap
  fails because the second attempt's expected status (`ready_for_confirmation`)
  no longer matches the first attempt's result (`confirmed`); a forged or
  cross-chat callback fails on chat/user mismatch; a race between two
  concurrent taps fails for whichever one the database serializes second,
  atomically, with no separate locking needed. No callback is ever trusted by
  itself — only what the database still says is current.
- **Alternatives considered:** A separate "used tokens" table to explicitly
  block replays — redundant once the state machine's own status transition
  already makes a second use impossible; optimistic version checking in
  application code (read, compare, then write) — has a real race window between
  the read and the write that a single conditional `UPDATE` does not.
- **Date:** 2026-09-02

### 22. Multi-turn continuation is a deterministic merge, not LLM-provided context

- **Decision:** A follow-up message is extracted by Anthropic standalone,
  exactly like a first message — Phase 4's `extractTransactionDraft` was not
  changed to accept prior-draft context. Combining old and new information is a
  plain function (`mergeDraft`): a field the new extraction actually stated
  overrides the old value, a field it left blank keeps what was already known.
- **Reason:** The task's own caution against modifying Phase 4 unless an actual
  integration issue requires it, weighed against the alternative: giving the
  model prior-draft context would require prompt changes whose effect on real
  model behaviour cannot be verified without a live API key, which this phase
  does not use in its automated tests. A deterministic merge is fully testable
  with mocked extractions and keeps every Phase 4 test passing unmodified.
- **Limitation this creates:** a bare correction like "actually make that 200"
  with no other context relies on the model still returning a sensible
  standalone extraction for that fragment; this has not been verified against
  the real Anthropic API (no key used in this phase). Disambiguation replies
  avoid this risk entirely — they are resolved by deterministic candidate
  matching (`resolveClarificationReply`) and never sent to the LLM at all.
- **Alternatives considered:** Extending Phase 4's client to accept optional
  prior-draft context per the original plan's "send the running draft + latest
  message" design — deferred until real API testing can confirm the model
  reconciles context well; a hand-written field-by-field NLP merge — rejected
  as exactly the kind of brittle heuristic the project delegates to the LLM.
- **Date:** 2026-09-02

### 23. Ambiguity is resolved deterministically from the user's reply, never by another LLM call

- **Decision:** When validation reports an ambiguous ledger or stock item
  match, the very next message is first checked against the offered candidates
  using Phase 5's own `matchName` (exact then fuzzy). Only if that fails to
  resolve does the message go to the LLM as a normal new extraction.
- **Reason:** Interpreting "which of these two options did you mean" is a
  small, closed-set decision — exactly what deterministic matching already does
  reliably elsewhere in this project, and it stays consistent with the core
  rule that the backend decides, not the model. It also means disambiguation
  requires no live-API verification (see decision #22's limitation) — it works
  identically whether or not the model would have handled a bare name reply
  well.
- **Date:** 2026-09-02

### 24. Widening the audit event CHECK constraint via SQLite's recreate-table pattern

- **Decision:** Adding the Phase 6 event types to `audit_events.type`'s CHECK
  constraint required a genuine migration (migration 3): drop the two
  append-only triggers, rename the table aside, create it fresh with the wider
  constraint, copy every row across, drop the old table, then recreate the
  three indexes and two triggers.
- **Reason:** SQLite has no `ALTER TABLE ... DROP/ADD CONSTRAINT`. This is the
  standard, correct way to change one. Doing it explicitly — rather than
  relying on however a given SQLite build treats trigger definitions across a
  bare `ALTER TABLE ... RENAME` — means the migration's correctness does not
  depend on an assumption that was never verified against this project's
  actual SQLite version. Verified directly before use: existing rows and event
  types survive the migration, and the append-only triggers still block UPDATE
  and DELETE afterward.
- **Date:** 2026-09-02
