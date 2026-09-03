/**
 * Resolving an ambiguous match deterministically from the user's reply.
 *
 * When validation finds more than one plausible ledger or stock item, the
 * user is shown only those candidates and asked to pick one (requirement: show
 * only the relevant candidates, never guess). Interpreting their reply is
 * deliberately *not* another LLM call: matching a short reply against a known,
 * short candidate list is exactly the deterministic job Phase 5's own
 * `matchName` already does, and using it here means the choice is resolved the
 * same way — and with the same guarantees against guessing — as every other
 * master lookup in this project.
 */

import { canonicalStateName } from '../gst/states.ts';
import type { TransactionDraft } from '../llm/schema.ts';
import { matchName } from '../validation/fuzzyMatch.ts';
import type { DraftValidationResult } from '../validation/types.ts';
import type { PendingClarification } from './types.ts';

/**
 * Which single ambiguity to ask about next, or `null` if none remain.
 *
 * Only one clarification is ever pending at a time — asking about the party
 * before any item keeps the conversation to one question at a time rather
 * than listing every open ambiguity at once.
 */
export function deriveClarification(validation: DraftValidationResult): PendingClarification | null {
  if (validation.partyMatch?.status === 'ambiguous') {
    return { kind: 'party', candidates: validation.partyMatch.candidates };
  }

  const ambiguousItemIndex = validation.items.findIndex(
    (item) => item.stockItemMatch.status === 'ambiguous',
  );
  if (ambiguousItemIndex !== -1) {
    return {
      kind: 'item',
      itemIndex: ambiguousItemIndex,
      candidates: validation.items[ambiguousItemIndex]!.stockItemMatch.candidates,
    };
  }

  return null;
}

/**
 * Try to read the user's reply as a choice among `pending`'s candidates (for
 * `party`/`item`) or as a recognised state name (for `place_of_supply`).
 * Returns `null` if the reply does not clearly resolve it — the caller then
 * falls back to normal extraction, since the user may simply be saying
 * something else entirely.
 *
 * The place-of-supply case is deliberately exact-only (via
 * `canonicalStateName`, not `matchName`'s fuzzy tier): guessing a state name
 * wrong flips the GST treatment entirely, unlike a near-miss on a ledger
 * candidate list where the field itself is still open to a normal follow-up.
 */
export function resolveClarificationReply(
  pending: PendingClarification,
  replyText: string,
): string | null {
  if (pending.kind === 'place_of_supply') {
    return canonicalStateName(replyText);
  }

  const match = matchName(replyText, pending.candidates);
  return match.status === 'exact' || match.status === 'fuzzy' ? match.matchedName : null;
}

/** Apply a resolved value to the field `pending` was asking about. */
export function applyClarification(
  draft: TransactionDraft,
  pending: PendingClarification,
  resolvedValue: string,
): TransactionDraft {
  if (pending.kind === 'party') {
    return { ...draft, partyName: resolvedValue };
  }

  if (pending.kind === 'place_of_supply') {
    return { ...draft, placeOfSupply: resolvedValue };
  }

  return {
    ...draft,
    items: draft.items.map((item, index) =>
      index === pending.itemIndex ? { ...item, itemName: resolvedValue } : item,
    ),
  };
}
