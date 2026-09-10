/**
 * Plain-text message builders for every conversational outcome.
 *
 * Kept pure and separate from the handlers so the exact wording can be
 * reviewed and tested without a database, an LLM, or Telegram.
 */
const ISSUE_PROMPTS = {
  missing_party_name: 'who the customer or supplier is',
  missing_items: 'what is being bought or sold',
  missing_item_name: 'the name of an item',
  missing_quantity: 'the quantity',
  invalid_quantity: 'a valid quantity (a positive number)',
  missing_rate: 'the rate per unit',
  invalid_rate: 'a valid rate (a positive number)',
  missing_gst_percent: 'the GST rate',
  invalid_gst_percent: 'a valid GST rate (e.g. 5%, 12%, 18%, 28%)',
  invalid_voucher_type: 'whether this is a sale or a purchase',
};
/** A short, human list of exactly what is still needed — never the whole draft state. */
export function buildFollowUpRequestText(issues) {
  const prompts = issues
    .map((issue) => ISSUE_PROMPTS[issue.code])
    .filter((prompt) => prompt !== undefined);
  const unique = [...new Set(prompts)];
  if (unique.length === 0) {
    return "I couldn't complete that — could you rephrase the transaction?";
  }
  return `I still need to know: ${unique.join('; ')}.`;
}
export function buildClarificationText(pending) {
  if (pending.kind === 'place_of_supply') {
    return 'What is the Place of Supply for this transaction (the state where the goods or services are supplied to)?';
  }
  const options = pending.candidates.map((name, index) => `${index + 1}. ${name}`).join('\n');
  if (pending.kind === 'godown') {
    return `More than one godown has stock recorded for this item. Which one should I use?\n${options}`;
  }
  const subject = pending.kind === 'party' ? 'customer or supplier' : 'item';
  // A single candidate here is a low-confidence match asking for confirmation
  // (see findLedgerMatch), not a genuine multi-way ambiguity — worded to match.
  if (pending.candidates.length === 1) {
    return `Did you mean this ${subject}?\n${options}`;
  }
  return `I found more than one matching ${subject}. Which one did you mean?\n${options}`;
}
/**
 * A configuration problem nothing the user can type will fix — a missing or
 * non-existent GST/ledger mapping. Deliberately does not ask a question.
 */
export function buildConfigurationErrorText(blockers) {
  const messages = [...new Set(blockers.map((b) => b.message))];
  return [
    "This transaction can't be completed because of a configuration issue:",
    ...messages.map((m) => `  • ${m}`),
    'Please contact whoever manages this bot to fix the configuration.',
  ].join('\n');
}
function formatAmount(value) {
  return value.toLocaleString('en-IN');
}
function formatQuantityWithUnit(quantity, unit) {
  return unit !== null ? `${formatAmount(quantity)} ${unit}` : formatAmount(quantity);
}
/**
 * A stock issue that never blocks the transaction — the user sees it and
 * still decides whether to proceed. Distinguishes "no cached data" from a
 * genuine "0 in stock" (see postingReadiness.js's `stockWarnings`).
 */
function buildStockWarningLine(warning) {
  const requested = formatQuantityWithUnit(warning.requestedQuantity, warning.requestedUnit);
  if (warning.reason === 'no_data') {
    return `⚠️ Stock Warning: ${warning.itemName} — requested ${requested}; available stock: unavailable/not cached. Voucher can still be created.`;
  }
  const available = formatQuantityWithUnit(warning.availableQuantity, warning.availableUnit);
  const shortfall = formatQuantityWithUnit(
    warning.requestedQuantity - warning.availableQuantity,
    warning.availableUnit,
  );
  return `⚠️ Stock Warning: ${warning.itemName} — requested ${requested}; available stock: ${available}. Requested quantity exceeds cached stock by ${shortfall}. Voucher can still be created.`;
}
/**
 * Every field shown here is a *resolved* value: `draft` is expected to be
 * the resolved draft `validateTransactionDraft` returns (rate/GST already
 * filled in from trusted configuration where the user left them unstated),
 * and godown/batch come from `readiness`, the one place they are ever
 * decided. Nothing here re-decides or invents anything — it only displays
 * what earlier stages already resolved, so what Confirm posts is exactly
 * what this shows.
 */
export function buildPreviewText(draft, validation, readiness = null) {
  const lines = [];
  const kind = draft.voucherType === 'purchase' ? 'Purchase' : 'Sales';
  lines.push(`${kind} voucher — please review:`);
  lines.push('');
  lines.push(`Party: ${validation.partyMatch?.matchedName ?? draft.partyName ?? '(unknown)'}`);
  lines.push('');
  lines.push('Items:');
  draft.items.forEach((item, index) => {
    const resolvedName = validation.items[index]?.stockItemMatch.matchedName ?? item.itemName;
    const quantity = item.quantity !== null ? formatAmount(item.quantity) : '?';
    const rate = item.rate !== null ? formatAmount(item.rate) : '?';
    const godown = readiness?.itemGodowns?.[index]?.godown ?? item.godown ?? null;
    const batch = readiness?.itemStock?.[index]?.resolvedBatch ?? null;
    let line = `  • ${resolvedName} — qty ${quantity}, rate ₹${rate}`;
    // Per-item resolved GST — see validateDraft.js's per-line resolution.
    // Absent (undefined) for any caller/fixture predating that field.
    const itemGstPercent = item.gstPercent ?? null;
    if (itemGstPercent !== null) line += `, GST ${itemGstPercent}%`;
    if (godown !== null) line += `, godown ${godown}`;
    if (batch !== null) line += `, batch ${batch}`;
    lines.push(line);
  });
  lines.push('');
  // `draft.gstPercent` is only ever a single value when every item resolved
  // to the same rate (see validateTransactionDraft's draft-level derivation)
  // — a genuinely mixed-rate voucher shows nothing here, since the per-item
  // lines above already show each item's own real rate; there is no single
  // voucher-wide figure left to summarise.
  if (draft.gstPercent !== null) {
    lines.push(`GST rate: ${draft.gstPercent}%`);
  }
  const gstTreatment = readiness?.gstTreatment ?? null;
  if (gstTreatment !== null) {
    const basis =
      gstTreatment.type === 'intrastate'
        ? `Intrastate (CGST + SGST) — Place of Supply: ${gstTreatment.placeOfSupply}`
        : `Interstate (IGST) — Place of Supply: ${gstTreatment.placeOfSupply}`;
    lines.push(`GST treatment: ${basis}`);
    // Explicit and configured-default Place of Supply are both deliberate,
    // user/operator-stated facts — no extra caveat needed. A party-derived
    // one is different: the party's own registered state can genuinely
    // differ from where goods are actually supplied, so it's flagged here
    // rather than shown as if the user had stated it themselves.
    if (readiness?.placeOfSupplySource === 'party') {
      lines.push(
        `  ⚠️ Place of Supply was not stated — using ${gstTreatment.placeOfSupply}, the party's own registered state in Tally. Please confirm this is correct.`,
      );
    }
  }
  lines.push('');
  lines.push(`Date: ${draft.date ?? 'today'}`);
  const stockWarnings = readiness?.stockWarnings ?? [];
  if (stockWarnings.length > 0) {
    lines.push('');
    stockWarnings.forEach((warning) => lines.push(buildStockWarningLine(warning)));
  }
  lines.push('');
  lines.push('Nothing has been sent to TallyPrime yet.');
  lines.push('Tap Confirm to proceed, or Cancel to discard.');
  return lines.join('\n');
}
export function buildConfirmedText() {
  return 'Confirmed. Posting to TallyPrime now…';
}
/**
 * A problem that blocked posting before Tally was ever contacted — either
 * the final readiness re-check or the draft-to-voucher adapter refused,
 * both for reasons nothing the user can type will fix. Deliberately not a
 * question, same reasoning as {@link buildConfigurationErrorText}.
 */
export function buildPostingFailedText(reasons) {
  const unique = [...new Set(reasons)];
  return [
    'This transaction could not be posted to TallyPrime because of a configuration issue:',
    ...unique.map((m) => `  • ${m}`),
    'Please contact whoever manages this bot to fix the configuration. Nothing was sent to TallyPrime.',
  ].join('\n');
}
/** The outcome of an actual attempt to reach TallyPrime. */
export function buildPostedResultText(result) {
  if (result.status === 'posted') {
    return result.tallyVoucherId !== null
      ? `Posted to TallyPrime successfully. Voucher ID: ${result.tallyVoucherId}.`
      : 'Posted to TallyPrime successfully.';
  }
  if (result.status === 'failed') {
    return `TallyPrime rejected this transaction: ${result.message}`;
  }
  // 'uncertain' (a network/timeout ambiguity) or the transient 'posting' status.
  return `Could not confirm whether this reached TallyPrime: ${result.message}. Please check TallyPrime directly before trying again.`;
}
export function buildCancelledText() {
  return 'Cancelled. This draft has been discarded.';
}
export function buildRejectedConfirmationText() {
  return "That button is no longer valid — the draft it referred to has changed, expired, or was already acted on. Please send your request again if you'd still like to proceed.";
}
export function buildUnderstandingFailedText() {
  return "Sorry, I couldn't process that message right now. Please try again.";
}
