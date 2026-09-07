/**
 * Audit event model.
 *
 * Every meaningful step of a user turn is appended here as one immutable event.
 * All events share a common envelope and differ only in `type` and `data`, so a
 * later phase can record a richer payload without a schema change.
 *
 * A whole turn is replayable by querying one `correlationId`.
 */
/**
 * Bumped only when the envelope itself changes shape — not when a new event
 * type starts being emitted. Stored on every row so old records stay readable.
 */
export const AUDIT_SCHEMA_VERSION = 1;
/**
 * The full event vocabulary, including types owned by later phases.
 *
 * Declared once so the shape of the log is designed up front, and so the
 * database CHECK constraint accepts every type from the start — a later phase
 * emits its own events without needing a migration. Only the Phase 2 types are
 * emitted today.
 */
export const AUDIT_EVENT_TYPES = [
  // Phase 2 — inbound and authorization
  'webhook.rejected',
  'message.received',
  'authorization.granted',
  'authorization.denied',
  // Phase 4 — LLM extraction
  'llm.extraction.completed',
  // Phase 5 — deterministic validation
  'validation.completed',
  // Phase 6 — conversation state and confirmation
  'draft.created',
  'draft.updated',
  'preview.shown',
  'user.confirmed',
  'user.cancelled',
  'confirmation.rejected',
  // Phase 7 — Tally posting
  'tally.request.sent',
  'tally.response.received',
  'tally.posting.rejected',
  // Phase 8 — GST and ledger determination
  'gst.determination.completed',
];
export const AUDIT_CHANNELS = ['telegram', 'system'];
export const AUDIT_ACTOR_KINDS = ['user', 'system'];
