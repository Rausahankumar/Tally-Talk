/**
 * Plain-text message builders for every conversational outcome.
 *
 * Kept pure and separate from the handlers so the exact wording can be
 * reviewed and tested without a database, an LLM, or Telegram.
 */

import type { GstTreatment } from '../gst/treatment.ts';
import type { PostingBlocker } from '../gst/postingReadiness.ts';
import type { TransactionDraft } from '../llm/schema.ts';
import type { DraftValidationResult, ValidationIssue } from '../validation/types.ts';
import type { PendingClarification } from './types.ts';

const ISSUE_PROMPTS: Partial<Record<ValidationIssue['code'], string>> = {
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
export function buildFollowUpRequestText(issues: readonly ValidationIssue[]): string {
  const prompts = issues
    .map((issue) => ISSUE_PROMPTS[issue.code])
    .filter((prompt): prompt is string => prompt !== undefined);

  const unique = [...new Set(prompts)];
  if (unique.length === 0) {
    return "I couldn't complete that — could you rephrase the transaction?";
  }
  return `I still need to know: ${unique.join('; ')}.`;
}

export function buildClarificationText(pending: PendingClarification): string {
  if (pending.kind === 'place_of_supply') {
    return 'What is the Place of Supply for this transaction (the state where the goods or services are supplied to)?';
  }

  const subject = pending.kind === 'party' ? 'customer or supplier' : 'item';
  const options = pending.candidates.map((name, index) => `${index + 1}. ${name}`).join('\n');
  return `I found more than one matching ${subject}. Which one did you mean?\n${options}`;
}

/**
 * A configuration problem nothing the user can type will fix — a missing or
 * non-existent GST/ledger mapping. Deliberately does not ask a question.
 */
export function buildConfigurationErrorText(blockers: readonly PostingBlocker[]): string {
  const messages = [...new Set(blockers.map((b) => b.message))];
  return [
    "This transaction can't be completed because of a configuration issue:",
    ...messages.map((m) => `  • ${m}`),
    'Please contact whoever manages this bot to fix the configuration.',
  ].join('\n');
}

function formatAmount(value: number): string {
  return value.toLocaleString('en-IN');
}

/** Every field shown here is a *resolved* name from validation, not the raw draft text. */
export function buildPreviewText(
  draft: TransactionDraft,
  validation: DraftValidationResult,
  gstTreatment: GstTreatment | null = null,
): string {
  const lines: string[] = [];
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
    lines.push(`  • ${resolvedName} — qty ${quantity}, rate ₹${rate}`);
  });

  lines.push('');
  lines.push(`GST rate: ${draft.gstPercent}%`);
  if (gstTreatment !== null) {
    const basis =
      gstTreatment.type === 'intrastate'
        ? `Intrastate (CGST + SGST) — Place of Supply: ${gstTreatment.placeOfSupply}`
        : `Interstate (IGST) — Place of Supply: ${gstTreatment.placeOfSupply}`;
    lines.push(`GST treatment: ${basis}`);
  }
  lines.push('');
  lines.push('Nothing has been sent to TallyPrime yet.');
  lines.push('Tap Confirm to proceed, or Cancel to discard.');

  return lines.join('\n');
}

export function buildConfirmedText(): string {
  return 'Confirmed. This transaction is recorded as ready — it has not been sent to TallyPrime yet.';
}

export function buildCancelledText(): string {
  return 'Cancelled. This draft has been discarded.';
}

export function buildRejectedConfirmationText(): string {
  return "That button is no longer valid — the draft it referred to has changed, expired, or was already acted on. Please send your request again if you'd still like to proceed.";
}

export function buildUnderstandingFailedText(): string {
  return "Sorry, I couldn't process that message right now. Please try again.";
}
