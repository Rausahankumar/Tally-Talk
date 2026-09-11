/**
 * Rate-bucketed GST tax ledger allocation ("Option 1" of the per-line-GST
 * architecture — see the architecture proposal and PROJECT_STATUS.md).
 *
 * Groups a voucher's line items by their own resolved GST%, computes one tax
 * amount per (rate bucket × duty-head ledger), and emits that as a flat list
 * of `{ ledgerName, amount }` — the exact shape `postingXml.js` has always
 * consumed via `SalesVoucherInput.taxLedgerAllocations`, unchanged. Two
 * items on one voucher with two different real Tally GST rates (e.g. an 18%
 * item and a 5% item) therefore produce TWO amounts under the same ledger
 * name (e.g. two "IGST" entries) instead of one figure blended across both
 * items at one rate — the bug this module exists to fix.
 *
 * UNVERIFIED LIVE TALLY IMPORT STRUCTURE: whether TallyPrime's Import
 * interface accepts more than one `LEDGERENTRIES.LIST` entry with the SAME
 * ledger name in one voucher, and sums them correctly, has NOT been
 * confirmed against a real Import. Every real Sales voucher captured from
 * this project's connected Tally instance so far has exactly one line item
 * (see the architecture proposal's live investigation), so no real example
 * of this shape exists yet. Per an explicit decision, no synthetic test
 * voucher has been posted to find out. This function is deliberately
 * isolated — the ONLY place this assumption lives — so a different XML
 * structure (e.g. nesting tax inside each item's own
 * `ACCOUNTINGALLOCATIONS.LIST`, "Option 2") can replace just this function,
 * with no change anywhere else in the posting pipeline, once a real
 * mixed-rate transaction confirms which structure Tally actually accepts.
 * Do not claim this structure is proven compatible with Tally until then.
 */
function roundMoney(value) {
  return Math.round(value * 100) / 100;
}
/**
 * @param lineItems Each must carry `.amount` (taxable amount) and
 *   `.gstPercent` — that item's own resolved GST rate, or `null` for an
 *   item that genuinely has no GST (a valid state, not an error — GST is
 *   optional; see validateDraft.js/postingReadiness.js). A `null`-GST item
 *   contributes no bucket and no tax allocation at all.
 * @param gstTreatment `{ ledgers: [{ ledgerName, share }] }` — CGST+SGST
 *   (0.5/0.5) or IGST (1) — resolved once per voucher exactly as before;
 *   only the per-bucket amount is new here, never which ledgers apply. May
 *   be `null` when no item in `lineItems` carries a GST percent at all —
 *   never dereferenced in that case, since there is nothing to bucket.
 * @returns `{ ledgerName, amount, ratePercent }[]`, one entry per (rate
 *   bucket × duty-head ledger), sorted by rate ascending for deterministic
 *   output regardless of item order in the draft. `ratePercent` is carried
 *   through for tests/debugging only — postingXml.js reads only
 *   `ledgerName`/`amount`, unchanged. `[]` when no item needs GST.
 */
export function buildTaxLedgerAllocationsByRateBucket(lineItems, gstTreatment) {
  const bucketsByRate = new Map();
  for (const item of lineItems) {
    if (item.gstPercent === null) continue; // no GST for this item — nothing to bucket
    const bucket = bucketsByRate.get(item.gstPercent) ?? { ratePercent: item.gstPercent, taxableAmount: 0 };
    bucket.taxableAmount += item.amount;
    bucketsByRate.set(item.gstPercent, bucket);
  }
  if (bucketsByRate.size === 0) return [];
  const sortedBuckets = [...bucketsByRate.values()].sort((a, b) => a.ratePercent - b.ratePercent);
  const allocations = [];
  for (const bucket of sortedBuckets) {
    const bucketTaxAmount = roundMoney(bucket.taxableAmount * (bucket.ratePercent / 100));
    for (const ledger of gstTreatment.ledgers) {
      allocations.push({
        ledgerName: ledger.ledgerName,
        amount: roundMoney(bucketTaxAmount * ledger.share),
        ratePercent: bucket.ratePercent,
      });
    }
  }
  return allocations;
}
