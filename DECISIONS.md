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
