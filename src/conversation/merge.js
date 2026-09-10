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
/**
 * Merge one follow-up's line items onto the existing ones.
 *
 * When the counts match, each position is merged field-by-field — the same
 * "incoming states it, else keep what was known" rule every other field
 * already uses — rather than replacing the whole item wholesale. This is
 * what lets "Rate is 1000 each apple" fill in just the rate on the item
 * already on file instead of wiping out its already-known quantity, while a
 * genuine full restatement (every field given again) still behaves exactly
 * as before, since every field the incoming extraction states wins anyway.
 *
 * A different item count is treated as a real change in what's being bought
 * or sold — an item added, removed, or swapped for something else entirely —
 * and the incoming items replace the old ones outright, unchanged from
 * before this function merged fields individually.
 */
function mergeItems(existingItems, incomingItems) {
  if (incomingItems.length === 0) return existingItems;
  if (incomingItems.length !== existingItems.length) return incomingItems;
  return incomingItems.map((incomingItem, index) => {
    const existingItem = existingItems[index];
    return {
      itemName: incomingItem.itemName,
      quantity: incomingItem.quantity ?? existingItem.quantity,
      rate: incomingItem.rate ?? existingItem.rate,
      godown: incomingItem.godown ?? existingItem.godown,
      gstPercent: incomingItem.gstPercent ?? existingItem.gstPercent ?? null,
    };
  });
}
export function mergeDraft(existing, incoming) {
  return {
    voucherType: incoming.voucherType !== 'unknown' ? incoming.voucherType : existing.voucherType,
    partyName: incoming.partyName ?? existing.partyName,
    items: mergeItems(existing.items, incoming.items),
    gstPercent: incoming.gstPercent ?? existing.gstPercent,
    placeOfSupply: incoming.placeOfSupply ?? existing.placeOfSupply,
    date: incoming.date ?? existing.date,
    missingFields: incoming.missingFields,
    ambiguityNote: incoming.ambiguityNote,
  };
}
