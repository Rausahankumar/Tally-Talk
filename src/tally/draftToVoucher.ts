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
 * Fails closed: even if `readiness.ready` says yes, every value this module
 * actually needs is re-checked non-null before a `SalesVoucherInput` is
 * built. Every problem is collected in one pass, not just the first.
 */

import type { DatabaseSync } from 'node:sqlite';

import type { PostingReadinessResult } from '../gst/postingReadiness.ts';
import type { TransactionDraft } from '../llm/schema.ts';
import type { DraftValidationResult } from '../validation/types.ts';
import { readCachedMasters } from './cache.ts';
import type { SalesVoucherInput, TallyLedgerAllocation, TallyVoucherLineItem } from './postingXml.ts';

export interface BuildSalesVoucherInputDeps {
  readonly db: DatabaseSync;
  readonly companyName: string;
  /** Injectable for deterministic tests — defaults to the system clock. */
  readonly now?: () => Date;
}

export type BuildSalesVoucherInputResult =
  | { readonly ok: true; readonly voucher: SalesVoucherInput }
  | { readonly ok: false; readonly reasons: readonly string[] };

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

/** The stock item's base unit, e.g. "Kg", "Nos" — from the Tally master, never the user's words. */
function findBaseUnit(db: DatabaseSync, stockItemName: string): string | null {
  const row = readCachedMasters(db, 'StockItem').find((r) => r.name === stockItemName);
  const unit = row?.data.BASEUNITS;
  return unit !== undefined && unit !== '' ? unit : null;
}

export function buildSalesVoucherInput(
  deps: BuildSalesVoucherInputDeps,
  draft: TransactionDraft,
  validation: DraftValidationResult,
  readiness: PostingReadinessResult,
): BuildSalesVoucherInputResult {
  if (!readiness.ready) {
    return { ok: false, reasons: ['The transaction is not ready to post.'] };
  }

  if (draft.voucherType !== 'sales') {
    // Purchase vouchers are not implemented anywhere in the posting XML
    // builder (DECISIONS.md #27) — building a "SalesVoucherInput" for
    // anything else would mislabel the transaction, not just be incomplete.
    return { ok: false, reasons: [`Only Sales vouchers can be built; got "${draft.voucherType}".`] };
  }

  const reasons: string[] = [];

  const partyLedgerName = validation.partyMatch?.matchedName ?? null;
  if (partyLedgerName === null) {
    reasons.push('No resolved party ledger name is available.');
  }

  if (readiness.gstTreatment === null) {
    reasons.push('No resolved GST treatment is available.');
  }

  if (draft.gstPercent === null) {
    reasons.push('No GST percent is available.');
  }

  const lineItems: TallyVoucherLineItem[] = [];

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

    const amount = roundMoney(quantity * rate);

    lineItems.push({
      stockItemName,
      quantity,
      unit,
      rate,
      amount,
      ledgerAllocation: { ledgerName: salesLedger, amount },
      godown,
      batchName,
    });
  });

  if (reasons.length > 0) {
    return { ok: false, reasons };
  }

  // Safe: every value asserted below was confirmed non-null above, since
  // `reasons` is empty only when none of the pushes ran.
  const gstTreatment = readiness.gstTreatment!;
  const gstPercent = draft.gstPercent!;

  const totalTaxableAmount = lineItems.reduce((sum, item) => sum + item.amount, 0);
  const totalGstAmount = roundMoney(totalTaxableAmount * (gstPercent / 100));
  const taxLedgerAllocations: TallyLedgerAllocation[] = gstTreatment.ledgers.map((ledger) => ({
    ledgerName: ledger.ledgerName,
    amount: roundMoney(totalGstAmount * ledger.share),
  }));

  const now = deps.now ?? (() => new Date());

  return {
    ok: true,
    voucher: {
      date: now(),
      companyName: deps.companyName,
      partyLedgerName: partyLedgerName!,
      items: lineItems,
      taxLedgerAllocations,
    },
  };
}
