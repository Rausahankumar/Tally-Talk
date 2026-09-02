/**
 * Shared types for per-chat conversation state.
 *
 * A conversation holds at most one active draft per Telegram chat. Nothing
 * here talks to Tally — `confirmed` means "the user approved this draft",
 * never "this was posted".
 */

import type { TransactionDraft } from '../llm/schema.ts';
import type { DraftValidationResult } from '../validation/types.ts';

export const CONVERSATION_STATUSES = [
  'collecting',
  'ready_for_confirmation',
  'confirmed',
  'cancelled',
  'expired',
] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

/** Which single ambiguous field the next message is expected to resolve. */
export type PendingClarification =
  | { readonly kind: 'party'; readonly candidates: readonly string[] }
  | { readonly kind: 'item'; readonly itemIndex: number; readonly candidates: readonly string[] };

export interface ConversationDraftRow {
  readonly chatId: number;
  readonly telegramUserId: number;
  /** Changes on every create/update. Confirm and Cancel must quote the current one. */
  readonly draftVersionId: string;
  readonly status: ConversationStatus;
  readonly draft: TransactionDraft;
  readonly validation: DraftValidationResult;
  readonly pending: PendingClarification | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly expiresAt: Date;
}
