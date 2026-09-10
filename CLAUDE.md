# CLAUDE.md — TallyTalk Project Instructions

Persistent instructions for any Claude session working in this repository.

## Project

TallyTalk is a conversational AI assistant for TallyPrime. A user describes a
transaction in natural language on Telegram; the system creates the voucher in
Tally only after backend validation and explicit user confirmation.

**Core philosophy — never violate this:**

> AI understands → Backend verifies → User confirms → Tally executes

The LLM is not the decision maker. It never talks to Tally, never performs
accounting calculations, and never causes a write on its own.

Source documents (treat as authoritative, do not edit):
- `TallyChat - TallyTalk.md` — product vision and requirements
- `snoopy-swimming-walrus.md` — approved foundation plan

## Reading order (token efficiency)

1. `PROJECT_STATUS.md`
2. Files directly relevant to the current task
3. `PROJECT_PLAN.md` — only when deeper planning context is needed
4. Anything else — only when necessary

Do not read the whole repository, re-read unchanged files, restate the full
architecture in responses, generate unneeded documentation, or invent
abstractions that no current phase requires.

## Documentation to maintain

Keep each file short and current. Do not add other docs without being asked.

**`PROJECT_STATUS.md`** — update after every significant completed task or phase:
current phase, current task, completed work, work in progress, next task, known
issues/blockers, last important technical decision.

**`PROJECT_PLAN.md`** — the living plan, seeded from the approved plan. Update
only on architecture changes, major requirement changes, or completion of a
major feature/phase. Do not rewrite it for minor changes.

**`DECISIONS.md`** — important decisions only, each with decision, reason,
alternatives considered, and date. No trivial implementation details.

## Implementation workflow

Work in phases. For every significant phase:

1. Read `PROJECT_STATUS.md` first.
2. Read only the files relevant to that phase.
3. Briefly review whether the approved approach is still the simplest option.
4. If a better approach exists, explain it *before* changing approved architecture.
5. Implement only the current phase.
6. Write or update relevant tests.
7. Run all relevant tests.
8. Fix failures.
9. Do not move on until required tests pass.
10. Update `PROJECT_STATUS.md`.
11. Update `PROJECT_PLAN.md` / `DECISIONS.md` only if required.



Technology Stack:
- Node.js
- Express.js
- JavaScript (not TypeScript)
- SQLite
- Telegram Bot API
- Anthropic API
- TallyPrime XML/HTTP integration



## Token and Execution Efficiency

Prioritize efficient execution.

Do not narrate implementation step by step.

Work silently unless:
- blocked by missing information
- user approval is required
- a significant unexpected problem changes the approved scope

Do not send progress messages such as:
- "Now inspecting..."
- "Now verifying..."
- "Now implementing..."
- "Quick sanity check..."
- "Confirming..."

Do not perform broad discovery.

Use the existing codebase, tests, documentation, and known project architecture as the primary source of truth.

Only inspect additional files, environment state, or external systems when a specific unknown blocks the current implementation.

Avoid redundant verification.

Do not:
- typecheck after every file
- repeatedly inspect unchanged files
- perform manual sanity checks already covered by automated tests
- run live end-to-end tests for every phase
- repeatedly run the full test suite unless failures require it

Preferred workflow:

1. Inspect only the files directly relevant to the current task.
2. Implement the complete approved logical unit.
3. Run relevant tests.
4. Fix failures.
5. Run the full test suite once.
6. Run typecheck once.
7. Update only necessary documentation.
8. Review the final diff once.
9. Commit if required.

Prefer existing patterns and libraries already present in the project.

Do not over-engineer edge cases outside the approved scope.

Keep final reports concise and limited to:
- implementation completed
- tests run
- blockers or limitations
- commit hash

**Never start the next significant phase without explicit user confirmation.**
Stop after each phase and report: completed work, tests run and results, git
status, documentation updates, recommended next phase.

Create files and directories only when an approved phase actually needs them.
Do not scaffold the future architecture in advance.

## Testing

Every meaningful feature must have relevant tests. Before marking any task or
phase complete: run the relevant tests, run the full suite when practical, and
fix failures caused by the change.

If an unrelated test is already failing, do not silently ignore it — report it
and state whether the current change caused it.

**Never claim tests pass unless they were actually run successfully.**

## Git

Before implementing: check repository status and never overwrite or discard
existing user changes. Create a meaningful branch per significant feature/phase.

On phase completion: review changed files, run tests, confirm they pass, then
make one clear commit with a meaningful message.

If a remote and GitHub workflow are configured, push the branch and prepare a PR
with summary, changes, and tests performed. Do not create or merge a PR without
confirming repository state and available permissions.

## Non-negotiable product rules

- The LLM never writes to Tally directly, and never computes amounts, GST, or totals.
- No voucher reaches Tally without backend validation *and* explicit user confirmation.
- Tally's XML/HTTP interface stays on localhost/LAN — never exposed to the internet.
- Reject any Telegram user not on the allowlist, before any LLM call or Tally write.
- Verify the Telegram webhook secret on every inbound request.
- Backend re-validates everything regardless of LLM output (prompt-injection defence).
- Confirm/Cancel are deterministic backend actions — no LLM call.
- Never send full master data or full chat history to the LLM.
- Secrets live in `.env` only, never committed. Document new keys in `.env.example`.
- The audit log is append-only; the app never edits or deletes entries.
