/**
 * Deterministic validation of a Phase 4 {@link TransactionDraft}.
 *
 * The LLM decided nothing here: every check below is a plain function or a
 * lookup against the Phase 3 master cache, run regardless of what the model
 * claimed in `draft.missingFields`. A field the model marked present but that
 * is actually null, and a field it marked missing but that is actually valid,
 * are both caught the same way — by re-deriving the truth from the draft's
 * actual values, never from the model's self-report.
 *
 * This module is independent of Telegram, user confirmation, and Tally
 * voucher creation: it takes a draft and a database handle, and returns a
 * result. Nothing here sends a message, waits for a reply, or writes to Tally.
 */
import { findLedgerMatch, findStockItemMatch, findVoucherTypeMatch } from './masterLookup.js';
import { isValidGstPercent, isValidQuantity, isValidRate, parseIsoDate } from './rules.js';
import { readCachedMasters } from '../tally/cache.js';
/** The Tally voucher type name each supported draft voucherType must resolve to. */
const VOUCHER_TYPE_MASTER_NAME = {
  sales: 'Sales',
  purchase: 'Purchase',
};
/** `Date` -> `"YYYY-MM-DD"`, matching the format `gstRateHistory`/`standardPriceHistory` dates are cached in (see xml.js `tallyDateToIso`). */
function toIsoDateString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
/** The cached StockItem record for an exact resolved name, or `null` if not cached at all. */
function findCachedStockItem(db, stockItemName) {
  const row = readCachedMasters(db, 'StockItem').find((r) => r.name === stockItemName);
  return row?.data ?? null;
}
/**
 * The latest entry in a Tally effective-dated history
 * (`gstRateHistory`/`standardPriceHistory`) whose date is on or before the
 * transaction date — never a future-dated entry, and never just "first" or
 * "last" by array order. `null` when the history is empty/absent or every
 * entry is future-dated: unavailable, never guessed.
 */
function latestApplicable(history, dateField, transactionDateIso) {
  const applicable = (history ?? []).filter((entry) => entry[dateField] <= transactionDateIso);
  if (applicable.length === 0) return null;
  return applicable.reduce((latest, entry) => (entry[dateField] > latest[dateField] ? entry : latest));
}
const GST_RATE_EPSILON = 1e-9;
/**
 * The Tally-derived GST% for one stock item, as of the transaction date, or
 * `null` if unavailable or unverifiable. Only the "Any" state-wise entry is
 * used — real captured data never showed a state-specific override, and
 * picking a different one without evidence would be a guess. CGST + SGST
 * must equal IGST before the record is trusted at all; a mismatch means the
 * record is not used, not that a wrong number is used anyway.
 */
function resolveTallyGstPercent(db, stockItemName, transactionDateIso) {
  const cached = findCachedStockItem(db, stockItemName);
  if (cached === null) return null;
  const entry = latestApplicable(cached.gstRateHistory, 'applicableFrom', transactionDateIso);
  if (entry === null) return null;
  const anyState = entry.states?.find((s) => s.state === 'Any');
  if (anyState === undefined) return null;
  const { cgst, sgst, igst } = anyState;
  if (cgst === null || sgst === null || igst === null) return null;
  if (Math.abs(cgst + sgst - igst) > GST_RATE_EPSILON) return null;
  return isValidGstPercent(igst) ? igst : null;
}
/**
 * The Tally-derived standard selling rate for one stock item, as of the
 * transaction date, or `null` if unavailable. A real figure the company keeps
 * on file, but deliberately the lowest-priority automatic rate source — below
 * an operator-configured `sales_rate` — since it may not reflect what is
 * actually charged (confirmed live: Orange's Standard Price is ₹1000/KG while
 * real sales have used ₹100/KG).
 */
function resolveTallyStandardRate(db, stockItemName, transactionDateIso) {
  const cached = findCachedStockItem(db, stockItemName);
  if (cached === null) return null;
  const entry = latestApplicable(cached.standardPriceHistory, 'date', transactionDateIso);
  if (entry === null) return null;
  return isValidRate(entry.rate) ? entry.rate : null;
}
function validateVoucherType(db, draft, issues) {
  if (draft.voucherType === 'unknown') {
    issues.push({
      code: 'invalid_voucher_type',
      message: 'Could not determine whether this is a sales or purchase transaction.',
    });
    return false;
  }
  const expectedMasterName = VOUCHER_TYPE_MASTER_NAME[draft.voucherType];
  const match = findVoucherTypeMatch(db, expectedMasterName);
  if (match.status !== 'exact') {
    issues.push({
      code: 'voucher_type_master_not_found',
      message: `No "${expectedMasterName}" voucher type exists in TallyPrime for this company.`,
    });
    return false;
  }
  return true;
}
function validateParty(db, draft, issues) {
  if (draft.partyName === null || draft.partyName.trim() === '') {
    issues.push({
      code: 'missing_party_name',
      message: 'No customer or supplier name was stated.',
    });
    return null;
  }
  const match = findLedgerMatch(db, draft.partyName, draft.voucherType);
  if (match.status === 'not_found') {
    issues.push({
      code: 'party_not_found',
      message: `No ledger matching "${draft.partyName}" was found in TallyPrime.`,
    });
  } else if (match.status === 'ambiguous') {
    issues.push({
      code: 'party_ambiguous',
      message: `"${draft.partyName}" matches more than one ledger; the correct one cannot be determined automatically.`,
      candidates: match.candidates,
    });
  }
  return match;
}
/**
 * GST percent resolution, in order: the user's stated value; else a
 * Tally-derived rate (`gstRateHistory`, verified CGST+SGST=IGST, as of the
 * transaction date) when every item that resolved to a real stock item
 * agrees on one value; else the trusted per-item configuration
 * (`itemLedgerMappingStore`), same "must agree" rule; else unresolvable, and
 * the user is asked. Tally is deliberately checked *before* the operator
 * config here (the reverse of rate's precedence — see `resolveLineItemRate`)
 * since a verified live GST classification is more authoritative than a
 * possibly-stale manual override, whereas Tally's Standard Price is the
 * opposite case.
 */
function resolveGstPercent(db, draft, items, itemLedgerMappingStore, issues, transactionDateIso) {
  if (draft.gstPercent !== null) {
    const valid = isValidGstPercent(draft.gstPercent);
    if (!valid) {
      issues.push({
        code: 'invalid_gst_percent',
        message: `${draft.gstPercent}% is not a recognised GST rate.`,
      });
    }
    return { gstPercentValid: valid, resolvedGstPercent: valid ? draft.gstPercent : null };
  }
  const matchedItemNames = items
    .map((item) => item.stockItemMatch.matchedName)
    .filter((name) => name !== null);
  if (matchedItemNames.length > 0) {
    const tallyRates = matchedItemNames
      .map((name) => resolveTallyGstPercent(db, name, transactionDateIso))
      .filter((rate) => rate !== null);
    const distinctTally = [...new Set(tallyRates)];
    if (distinctTally.length === 1) {
      return { gstPercentValid: true, resolvedGstPercent: distinctTally[0] };
    }
  }
  if (itemLedgerMappingStore !== null) {
    const mappedRates = items
      .map((item) => item.stockItemMatch.matchedName)
      .filter((name) => name !== null)
      .map((name) => itemLedgerMappingStore.getMapping(name)?.gstPercent ?? null)
      .filter((rate) => rate !== null);
    const distinct = [...new Set(mappedRates)];
    if (distinct.length === 1 && isValidGstPercent(distinct[0])) {
      return { gstPercentValid: true, resolvedGstPercent: distinct[0] };
    }
  }
  issues.push({ code: 'missing_gst_percent', message: 'No GST rate was stated.' });
  return { gstPercentValid: false, resolvedGstPercent: null };
}
/**
 * A date is only ever checked when the user (via the LLM) actually stated
 * one — an absent date is not an issue here, since the adapter that builds
 * the posting input falls back to today's date on its own. `undefined` is
 * treated the same as `null`: this draft may have come from a caller that
 * predates the `date` field entirely.
 */
function validateDate(draft, issues) {
  if (draft.date === null || draft.date === undefined) return null;
  const parsed = parseIsoDate(draft.date);
  if (parsed === null) {
    issues.push({
      code: 'invalid_date',
      message: `"${draft.date}" is not a valid date.`,
    });
  }
  return parsed;
}
/**
 * Rate resolution for one line item, in order: the user's stated rate
 * (validated exactly as before); else the matched stock item's trusted
 * per-item configuration (`itemLedgerMappingStore`); else — sales only —
 * Tally's own `standardPriceHistory`, as of the transaction date. Operator
 * config is checked *before* Tally here (the reverse of GST's precedence —
 * see `resolveGstPercent`) since Tally's Standard Price is a figure the
 * company keeps on file that may not reflect what is actually charged
 * (confirmed live for a real item), so a deliberate manual override always
 * wins over it. No configuration, no Tally record, and no stated rate means
 * this cannot be resolved, and the user is asked — never invented.
 */
function resolveLineItemRate(
  db,
  item,
  stockItemMatch,
  voucherType,
  itemLedgerMappingStore,
  issues,
  index,
  transactionDateIso,
) {
  if (item.rate !== null) {
    const valid = isValidRate(item.rate);
    if (!valid) {
      issues.push({
        code: 'invalid_rate',
        message: `${item.rate} is not a valid rate.`,
        itemIndex: index,
      });
    }
    return { rateValid: valid, resolvedRate: valid ? item.rate : null };
  }
  if (itemLedgerMappingStore !== null && stockItemMatch.matchedName !== null) {
    const mapping = itemLedgerMappingStore.getMapping(stockItemMatch.matchedName);
    const mappedRate =
      mapping === null ? null : (voucherType === 'purchase' ? mapping.purchaseRate : mapping.salesRate);
    if (mappedRate !== null && isValidRate(mappedRate)) {
      return { rateValid: true, resolvedRate: mappedRate };
    }
  }
  if (voucherType !== 'purchase' && stockItemMatch.matchedName !== null) {
    const tallyRate = resolveTallyStandardRate(db, stockItemMatch.matchedName, transactionDateIso);
    if (tallyRate !== null) {
      return { rateValid: true, resolvedRate: tallyRate };
    }
  }
  issues.push({ code: 'missing_rate', message: 'No rate was stated.', itemIndex: index });
  return { rateValid: false, resolvedRate: null };
}
function validateLineItem(db, item, index, issues, voucherType, itemLedgerMappingStore, transactionDateIso) {
  const hasItemName = item.itemName.trim() !== '';
  if (!hasItemName) {
    issues.push({
      code: 'missing_item_name',
      message: 'A line item had no item name.',
      itemIndex: index,
    });
  }
  // Matching an empty name would only produce a redundant not-found issue on
  // top of missing_item_name above, for the same root cause.
  const stockItemMatch = hasItemName
    ? findStockItemMatch(db, item.itemName)
    : { status: 'not_found', matchedName: null, candidates: [] };
  if (hasItemName && stockItemMatch.status === 'not_found') {
    issues.push({
      code: 'stock_item_not_found',
      message: `No stock item matching "${item.itemName}" was found in TallyPrime.`,
      itemIndex: index,
    });
  } else if (hasItemName && stockItemMatch.status === 'ambiguous') {
    issues.push({
      code: 'stock_item_ambiguous',
      message: `"${item.itemName}" matches more than one stock item; the correct one cannot be determined automatically.`,
      itemIndex: index,
      candidates: stockItemMatch.candidates,
    });
  }
  let quantityValid = false;
  if (item.quantity === null) {
    issues.push({ code: 'missing_quantity', message: 'No quantity was stated.', itemIndex: index });
  } else {
    quantityValid = isValidQuantity(item.quantity);
    if (!quantityValid) {
      issues.push({
        code: 'invalid_quantity',
        message: `${item.quantity} is not a valid quantity.`,
        itemIndex: index,
      });
    }
  }
  const { rateValid, resolvedRate } = resolveLineItemRate(
    db,
    item,
    stockItemMatch,
    voucherType,
    itemLedgerMappingStore,
    issues,
    index,
    transactionDateIso,
  );
  return { itemName: item.itemName, stockItemMatch, quantityValid, rateValid, resolvedRate };
}
/**
 * @param itemLedgerMappingStore Optional. When omitted, rate/GST resolution
 * from trusted per-item configuration is unavailable and a missing rate or
 * GST rate is reported exactly as it always was — every existing caller that
 * does not pass this keeps its current behaviour unchanged.
 * @param now Optional, defaults to the real current time. Only used to decide
 * "today" for Tally history resolution when the user stated no date —
 * injectable so tests stay deterministic, mirroring `draftToVoucher.js`'s
 * own `now` dependency.
 */
export function validateTransactionDraft(db, draft, itemLedgerMappingStore = null, now = () => new Date()) {
  const issues = [];
  const voucherTypeValid = validateVoucherType(db, draft, issues);
  const partyMatch = validateParty(db, draft, issues);
  const parsedDate = validateDate(draft, issues);
  // Tally's rate/GST history is effective-dated — resolved as of this
  // transaction's actual date when stated, else "today" (the same fallback
  // `draftToVoucher.js` uses once nothing else stated one either).
  const transactionDateIso = toIsoDateString(parsedDate ?? now());
  if (draft.items.length === 0) {
    issues.push({ code: 'missing_items', message: 'No line items were stated.' });
  }
  const items = draft.items.map((item, index) =>
    validateLineItem(db, item, index, issues, draft.voucherType, itemLedgerMappingStore, transactionDateIso),
  );
  const { gstPercentValid, resolvedGstPercent } = resolveGstPercent(
    db,
    draft,
    items,
    itemLedgerMappingStore,
    issues,
    transactionDateIso,
  );
  // The same draft shape, with rate/GST filled in from resolution wherever
  // the user left them unstated — the single canonical draft every later
  // stage (readiness, storage, preview, the posting adapter) uses from here
  // on, the same way `applyClarification` already fills in a resolved party
  // or item name directly on the draft.
  const resolvedDraft = {
    ...draft,
    gstPercent: resolvedGstPercent,
    items: draft.items.map((item, index) => ({ ...item, rate: items[index].resolvedRate })),
  };
  return {
    isValid: issues.length === 0,
    voucherTypeValid,
    partyMatch,
    items,
    gstPercentValid,
    resolvedGstPercent,
    parsedDate,
    issues,
    resolvedDraft,
  };
}
