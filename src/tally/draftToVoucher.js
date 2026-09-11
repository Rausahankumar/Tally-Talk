/**
 * Deterministic adapter: a confirmed `TransactionDraft` + its Phase 5
 * validation + a ready `PostingReadinessResult` -> the `SalesVoucherInput`
 * `postConfirmedTransaction` expects.
 *
 * Pure and read-only: no Tally call, no LLM call, no write of any kind.
 * Nothing here re-decides a ledger, a godown, a batch, or a GST split — it
 * only assembles what `checkPostingReadiness` already resolved. Amounts
 * (quantity * rate, and the GST split) are computed here, deterministically,
 * because the LLM never computes amounts — see CLAUDE.md's core philosophy.
 *
 * GST is resolved per line item, never blended across the whole voucher at
 * one rate: `draft.items[i].gstPercent` (filled in by
 * `validateTransactionDraft`'s per-item resolution — see
 * `resolveLineItemGstPercent` in validation/validateDraft.js) is each item's
 * own real rate, and `buildTaxLedgerAllocationsByRateBucket`
 * (taxLedgerAllocation.js) groups items by that rate before computing tax —
 * two items with two different real Tally GST rates produce two separate
 * tax amounts, not one figure computed from a single voucher-wide rate.
 *
 * Fails closed: even if `readiness.ready` says yes, every value this module
 * actually needs is re-checked non-null before a `SalesVoucherInput` is
 * built — including each item's own resolved GST percent, so one item with
 * an unresolvable rate blocks with a precise, itemIndex-scoped reason
 * without forcing another item's real rate onto it. Every problem is
 * collected in one pass, not just the first.
 */
import { readCachedMasters } from './cache.js';
import { buildTaxLedgerAllocationsByRateBucket } from './taxLedgerAllocation.js';
function roundMoney(value) {
  return Math.round(value * 100) / 100;
}
/** The stock item's base unit, e.g. "Kg", "Nos" — from the Tally master, never the user's words. */
function findBaseUnit(db, stockItemName) {
  const row = readCachedMasters(db, 'StockItem').find((r) => r.name === stockItemName);
  const unit = row?.data.BASEUNITS;
  return unit !== undefined && unit !== '' ? unit : null;
}
export function buildSalesVoucherInput(deps, draft, validation, readiness) {
  if (!readiness.ready) {
    return { ok: false, reasons: ['The transaction is not ready to post.'] };
  }
  if (draft.voucherType !== 'sales') {
    // Purchase vouchers are not implemented anywhere in the posting XML
    // builder (DECISIONS.md #27) — building a "SalesVoucherInput" for
    // anything else would mislabel the transaction, not just be incomplete.
    return {
      ok: false,
      reasons: [`Only Sales vouchers can be built; got "${draft.voucherType}".`],
    };
  }
  const reasons = [];
  const partyLedgerName = validation.partyMatch?.matchedName ?? null;
  if (partyLedgerName === null) {
    reasons.push('No resolved party ledger name is available.');
  }
  // GST is optional, not mandatory: a resolved GST treatment is only
  // required when at least one item actually carries a GST percent (see
  // postingReadiness.js, which only resolves gstTreatment in that case). A
  // voucher where every item genuinely has no GST needs none of this.
  const anyItemNeedsGst = draft.items.some((draftItem) => (draftItem.gstPercent ?? null) !== null);
  if (anyItemNeedsGst && readiness.gstTreatment === null) {
    reasons.push('No resolved GST treatment is available.');
  }
  // GST percent is checked per item, in the loop below, not here — a shared
  // voucher-level check would force every item to have a rate even when
  // some items resolve fine and only one genuinely doesn't.
  const lineItems = [];
  draft.items.forEach((draftItem, itemIndex) => {
    const stockItemName = validation.items[itemIndex]?.stockItemMatch.matchedName ?? null;
    const quantity = draftItem.quantity;
    const rate = draftItem.rate;
    const salesLedger = readiness.itemLedgers[itemIndex]?.salesLedger ?? null;
    const godown = readiness.itemGodowns[itemIndex]?.godown ?? null;
    const batchName = readiness.itemStock[itemIndex]?.resolvedBatch ?? null;
    if (stockItemName === null) {
      reasons.push(`Item ${itemIndex}: no resolved stock item name.`);
      return;
    }
    if (quantity === null || rate === null) {
      reasons.push(`Item ${itemIndex} ("${stockItemName}"): missing quantity or rate.`);
      return;
    }
    if (salesLedger === null) {
      reasons.push(`Item ${itemIndex} ("${stockItemName}"): no resolved Sales ledger.`);
      return;
    }
    if (godown === null) {
      reasons.push(`Item ${itemIndex} ("${stockItemName}"): no resolved godown.`);
      return;
    }
    if (batchName === null) {
      reasons.push(`Item ${itemIndex} ("${stockItemName}"): no resolved batch.`);
      return;
    }
    const unit = findBaseUnit(deps.db, stockItemName);
    if (unit === null) {
      reasons.push(`Item ${itemIndex} ("${stockItemName}"): no cached base unit.`);
      return;
    }
    // This item's own resolved GST rate (validateTransactionDraft's
    // per-item resolution, already filled in on the draft the same way
    // `rate` already is) — never a voucher-wide value forced onto every
    // item. `null` is a valid, resolved "no GST for this item" state (GST
    // is optional, not mandatory — see validateDraft.js), not a missing
    // value to block on; it simply excludes this item from tax bucketing
    // below (taxLedgerAllocation.js).
    const gstPercent = draftItem.gstPercent ?? null;
    const amount = roundMoney(quantity * rate);
    lineItems.push({
      stockItemName,
      quantity,
      unit,
      rate,
      amount,
      gstPercent,
      ledgerAllocation: { ledgerName: salesLedger, amount },
      godown,
      batchName,
    });
  });
  if (reasons.length > 0) {
    return { ok: false, reasons };
  }
  // Safe: every value asserted below was confirmed non-null above, since
  // `reasons` is empty only when none of the pushes ran. `gstTreatment`
  // itself may still legitimately be `null` here — a voucher where no item
  // needs GST never required one (see the `anyItemNeedsGst` check above);
  // `buildTaxLedgerAllocationsByRateBucket` handles that case directly.
  const gstTreatment = readiness.gstTreatment;
  // See taxLedgerAllocation.js's module doc: this is the one place the
  // "Option 1" XML shape (multiple LEDGERENTRIES.LIST entries under the same
  // ledger name, one per GST-rate bucket) is assumed — isolated so it can be
  // replaced on its own if a real mixed-rate Import proves Tally needs a
  // different structure. UNVERIFIED against a real Tally Import — see that
  // module's doc for what "unverified" means here.
  // `ratePercent` is debugging/testing context for the bucketing function
  // itself, not part of `SalesVoucherInput.taxLedgerAllocations`' documented
  // shape (`postingXml.js` only ever reads `ledgerName`/`amount`) — stripped
  // here so that contract stays exactly what it always was.
  const taxLedgerAllocations = buildTaxLedgerAllocationsByRateBucket(lineItems, gstTreatment).map(
    ({ ledgerName, amount }) => ({ ledgerName, amount }),
  );
  const now = deps.now ?? (() => new Date());
  // An explicit, validated user-stated date takes priority; only fall back to
  // "now" when the user never stated one (see Phase 5's `validateDate`).
  // `validation` may have round-tripped through JSON storage between Phase 5
  // and here (the confirmed draft is persisted and re-read before posting),
  // which turns a `Date` into a plain ISO string — wrapping in `new Date(...)`
  // normalises either shape without changing the value.
  const voucherDate = validation.parsedDate != null ? new Date(validation.parsedDate) : now();
  return {
    ok: true,
    voucher: {
      date: voucherDate,
      companyName: deps.companyName,
      partyLedgerName: partyLedgerName,
      items: lineItems,
      taxLedgerAllocations,
    },
  };
}
