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
