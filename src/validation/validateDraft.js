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
 * The Tally-derived GST% for one stock item, as of the transaction date.
 * Distinguishes two very different reasons nothing resolves, per GST being
 * optional (not mandatory) — Tally is the source of truth for both:
 *
 *  - `{status:'absent'}` — Tally genuinely has no GST classification for
 *    this item (no `GSTDETAILS.LIST` history at all, or no entry effective
 *    as of the transaction date). A valid, real state: the caller may treat
 *    this item as having no GST, never a blocking error.
 *  - `{status:'malformed'}` — an entry exists as of the transaction date but
 *    cannot be trusted: no "Any" state-wise breakdown, a null CGST/SGST/IGST
 *    component, CGST+SGST not equal to IGST, or a resulting rate outside the
 *    documented slabs. Present-but-suspicious data is never silently treated
 *    as "no GST" — the caller must fail closed.
 *  - `{status:'resolved', percent}` — a verified, trustworthy rate.
 *
 * Only the "Any" state-wise entry is used — real captured data never showed
 * a state-specific override, and picking a different one without evidence
 * would be a guess.
 */
function resolveTallyGstPercent(db, stockItemName, transactionDateIso) {
  const cached = findCachedStockItem(db, stockItemName);
  if (cached === null) return { status: 'absent' };
  const entry = latestApplicable(cached.gstRateHistory, 'applicableFrom', transactionDateIso);
  if (entry === null) return { status: 'absent' };
  const anyState = entry.states?.find((s) => s.state === 'Any');
  if (anyState === undefined) return { status: 'malformed' };
  const { cgst, sgst, igst } = anyState;
  if (cgst === null || sgst === null || igst === null) return { status: 'malformed' };
  if (Math.abs(cgst + sgst - igst) > GST_RATE_EPSILON) return { status: 'malformed' };
  return isValidGstPercent(igst) ? { status: 'resolved', percent: igst } : { status: 'malformed' };
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
 * The voucher-wide `draft.gstPercent`, validated once, up front — never
 * per item. An explicitly stated value that fails validation is a real
 * problem the user typed, reported exactly once at draft level (never
 * re-reported per item); it is deliberately NOT treated as "unstated" and
 * does not fall through to a per-item Tally/config lookup, matching this
 * field's original behaviour before per-item GST existed. Returns `null`
 * both when nothing was stated and when what was stated was invalid — the
 * `wasInvalid` flag is what lets callers tell those two apart without a
 * second validity check.
 */
function resolveVoucherLevelGstPercent(draft, issues) {
  if (draft.gstPercent === null) return { value: null, wasInvalid: false };
  const valid = isValidGstPercent(draft.gstPercent);
  if (!valid) {
    issues.push({
      code: 'invalid_gst_percent',
      message: `${draft.gstPercent}% is not a recognised GST rate.`,
    });
    return { value: null, wasInvalid: true };
  }
  return { value: draft.gstPercent, wasInvalid: false };
}
/**
 * GST percent resolution for ONE line item, in order:
 *  1. `item.gstPercent`, explicitly stated for this item — never overridden
 *     by anything else, including the voucher-wide value.
 *  2. `draft.gstPercent`, the voucher-wide fallback, when valid.
 *  3. Tally's own `gstRateHistory` for this item (verified CGST+SGST=IGST,
 *     as of the transaction date) — checked before the operator config
 *     below since a verified live GST classification is more authoritative
 *     than a possibly-stale manual override (the reverse of rate's
 *     precedence — see `resolveLineItemRate`, where Tally's Standard Price
 *     is the less-trusted source).
 *  4. The trusted per-item configuration (`itemLedgerMappingStore.gstPercent`).
 *  5. GST is optional, not mandatory (Tally is the source of truth): if
 *     nothing above resolved AND Tally's own data was cleanly absent (never
 *     malformed — see `resolveTallyGstPercent`), this item genuinely has no
 *     GST. That is a valid, resolved state (`resolvedGstPercent: null`), not
 *     an issue — never a blocking `missing_gst_percent`.
 *  6. If Tally's data was present but unverifiable at step 3, and no later
 *     tier resolved it either, fail closed: `gst_data_unverifiable`. Unlike
 *     absence, this is real data that could not be trusted, so it is never
 *     silently treated as "no GST".
 *
 * Items are deliberately never forced to agree with each other: two items
 * with two different real Tally GST rates (e.g. 18% and 5%) each resolve
 * independently, rather than requiring a single blended value the way this
 * function's draft-level predecessor once did.
 */
function resolveLineItemGstPercent(
  db,
  item,
  stockItemMatch,
  itemLedgerMappingStore,
  issues,
  index,
  transactionDateIso,
  voucherGstPercent,
) {
  const explicitItemGstPercent = item.gstPercent ?? null;
  if (explicitItemGstPercent !== null) {
    const valid = isValidGstPercent(explicitItemGstPercent);
    if (!valid) {
      issues.push({
        code: 'invalid_gst_percent',
        message: `${explicitItemGstPercent}% is not a recognised GST rate.`,
        itemIndex: index,
      });
      return { gstPercentValid: false, resolvedGstPercent: null };
    }
    return { gstPercentValid: true, resolvedGstPercent: explicitItemGstPercent };
  }
  if (voucherGstPercent.wasInvalid) {
    // The one voucher-level `invalid_gst_percent` issue already explains
    // this — no further tier is attempted, and no redundant per-item issue
    // is added, matching the original draft-level short-circuit exactly.
    return { gstPercentValid: false, resolvedGstPercent: null };
  }
  if (voucherGstPercent.value !== null) {
    return { gstPercentValid: true, resolvedGstPercent: voucherGstPercent.value };
  }
  let tallyDataMalformed = false;
  if (stockItemMatch.matchedName !== null) {
    const tallyResult = resolveTallyGstPercent(db, stockItemMatch.matchedName, transactionDateIso);
    if (tallyResult.status === 'resolved') {
      return { gstPercentValid: true, resolvedGstPercent: tallyResult.percent };
    }
    if (tallyResult.status === 'malformed') {
      tallyDataMalformed = true;
    }
  }
  if (itemLedgerMappingStore !== null && stockItemMatch.matchedName !== null) {
    const mapping = itemLedgerMappingStore.getMapping(stockItemMatch.matchedName);
    const mappedGstPercent = mapping?.gstPercent ?? null;
    if (mappedGstPercent !== null && isValidGstPercent(mappedGstPercent)) {
      return { gstPercentValid: true, resolvedGstPercent: mappedGstPercent };
    }
  }
  if (tallyDataMalformed) {
    issues.push({
      code: 'gst_data_unverifiable',
      message: `GST data in TallyPrime for "${stockItemMatch.matchedName}" could not be verified (missing, inconsistent, or unrecognised CGST/SGST/IGST).`,
      itemIndex: index,
    });
    return { gstPercentValid: false, resolvedGstPercent: null };
  }
  // Nothing was stated and Tally genuinely has no GST classification for
  // this item — a valid no-GST resolution, not an error.
  return { gstPercentValid: true, resolvedGstPercent: null };
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
 * see `resolveLineItemGstPercent`) since Tally's Standard Price is a figure the
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
function validateLineItem(
  db,
  item,
  index,
  issues,
  voucherType,
  itemLedgerMappingStore,
  transactionDateIso,
  voucherGstPercent,
) {
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
  const { gstPercentValid, resolvedGstPercent } = resolveLineItemGstPercent(
    db,
    item,
    stockItemMatch,
    itemLedgerMappingStore,
    issues,
    index,
    transactionDateIso,
    voucherGstPercent,
  );
  return {
    itemName: item.itemName,
    stockItemMatch,
    quantityValid,
    rateValid,
    resolvedRate,
    gstPercentValid,
    resolvedGstPercent,
  };
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
  // Validated once, up front — never per item; see resolveVoucherLevelGstPercent.
  const voucherGstPercent = resolveVoucherLevelGstPercent(draft, issues);
  const items = draft.items.map((item, index) =>
    validateLineItem(
      db,
      item,
      index,
      issues,
      draft.voucherType,
      itemLedgerMappingStore,
      transactionDateIso,
      voucherGstPercent,
    ),
  );
  // Draft-level gstPercent/gstPercentValid are derived from the per-item
  // resolution below, kept only for backward compatibility (existing single-
  // rate callers, and the preview's voucher-wide summary line) — the real
  // source of truth from here on is each item's own resolvedGstPercent.
  // `gstPercentValid` is true only when every item resolved successfully;
  // `resolvedGstPercent` is a single value only when every item happens to
  // agree — genuinely mixed rates (or any unresolved item) yield `null`
  // here, never a value silently borrowed from one item and applied to all.
  const gstPercentValid = items.every((item) => item.gstPercentValid);
  const distinctResolvedGstPercents = [
    ...new Set(items.map((item) => item.resolvedGstPercent).filter((value) => value !== null)),
  ];
  const resolvedGstPercent =
    gstPercentValid && distinctResolvedGstPercents.length === 1 ? distinctResolvedGstPercents[0] : null;
  // The same draft shape, with rate/GST filled in from resolution wherever
  // the user left them unstated — the single canonical draft every later
  // stage (readiness, storage, preview, the posting adapter) uses from here
  // on, the same way `applyClarification` already fills in a resolved party
  // or item name directly on the draft.
  const resolvedDraft = {
    ...draft,
    gstPercent: resolvedGstPercent,
    items: draft.items.map((item, index) => ({
      ...item,
      rate: items[index].resolvedRate,
      gstPercent: items[index].resolvedGstPercent,
    })),
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
