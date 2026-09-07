/**
 * Shared types for deterministic draft validation.
 *
 * Nothing here talks to Telegram, the LLM, or Tally's write path. Validation
 * takes a {@link TransactionDraft} (a Phase 4 output type) and the Phase 3
 * master cache, and produces a result a later phase can act on — it does not
 * act on anything itself.
 */
export {};
