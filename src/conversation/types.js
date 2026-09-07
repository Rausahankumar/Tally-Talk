/**
 * Shared types for per-chat conversation state.
 *
 * A conversation holds at most one active draft per Telegram chat. Nothing
 * here talks to Tally — `confirmed` means "the user approved this draft",
 * never "this was posted".
 */
export const CONVERSATION_STATUSES = [
  'collecting',
  'ready_for_confirmation',
  'confirmed',
  'cancelled',
  'expired',
];
