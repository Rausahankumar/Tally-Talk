/**
 * Deterministic merge of a follow-up extraction into an existing draft.
 *
 * Each follow-up message is extracted by the LLM standalone, exactly like a
 * first message — Phase 4's client is not given prior-draft context, and this
 * phase does not add that (see DECISIONS.md for why: it keeps every extraction
 * call independently testable with no assumption about how the model would
 * behave with injected context, and it means a wrong or malicious follow-up
 * cannot corrupt a field indirectly through prompt content). Combining old and
 * new information is a plain, deterministic merge instead: a field the new
 * message actually stated overrides the old value; a field the new message
 * left blank keeps whatever was already known.
 */

import type { TransactionDraft } from '../llm/schema.ts';

export function mergeDraft(existing: TransactionDraft, incoming: TransactionDraft): TransactionDraft {
  return {
    voucherType: incoming.voucherType !== 'unknown' ? incoming.voucherType : existing.voucherType,
    partyName: incoming.partyName ?? existing.partyName,
    // A follow-up that mentions items at all is taken as the current, complete
    // statement of what is being bought/sold — restating quantities/rates is
    // the natural way a user corrects them ("actually 200 bags, not 100").
    items: incoming.items.length > 0 ? incoming.items : existing.items,
    gstPercent: incoming.gstPercent ?? existing.gstPercent,
    placeOfSupply: incoming.placeOfSupply ?? existing.placeOfSupply,
    missingFields: incoming.missingFields,
    ambiguityNote: incoming.ambiguityNote,
  };
}
