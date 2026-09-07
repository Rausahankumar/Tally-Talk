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
import { isValidGstPercent, isValidQuantity, isValidRate } from './rules.js';
/** The Tally voucher type name each supported draft voucherType must resolve to. */
const VOUCHER_TYPE_MASTER_NAME = {
  sales: 'Sales',
  purchase: 'Purchase',
};
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
  const match = findLedgerMatch(db, draft.partyName);
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
function validateGstPercent(draft, issues) {
  if (draft.gstPercent === null) {
    issues.push({ code: 'missing_gst_percent', message: 'No GST rate was stated.' });
    return null;
  }
  const valid = isValidGstPercent(draft.gstPercent);
  if (!valid) {
    issues.push({
      code: 'invalid_gst_percent',
      message: `${draft.gstPercent}% is not a recognised GST rate.`,
    });
  }
  return valid;
}
function validateLineItem(db, item, index, issues) {
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
  let rateValid = false;
  if (item.rate === null) {
    issues.push({ code: 'missing_rate', message: 'No rate was stated.', itemIndex: index });
  } else {
    rateValid = isValidRate(item.rate);
    if (!rateValid) {
      issues.push({
        code: 'invalid_rate',
        message: `${item.rate} is not a valid rate.`,
        itemIndex: index,
      });
    }
  }
  return { itemName: item.itemName, stockItemMatch, quantityValid, rateValid };
}
export function validateTransactionDraft(db, draft) {
  const issues = [];
  const voucherTypeValid = validateVoucherType(db, draft, issues);
  const partyMatch = validateParty(db, draft, issues);
  const gstPercentValid = validateGstPercent(draft, issues);
  if (draft.items.length === 0) {
    issues.push({ code: 'missing_items', message: 'No line items were stated.' });
  }
  const items = draft.items.map((item, index) => validateLineItem(db, item, index, issues));
  return {
    isValid: issues.length === 0,
    voucherTypeValid,
    partyMatch,
    items,
    gstPercentValid,
    issues,
  };
}
