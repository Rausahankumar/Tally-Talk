/**
 * Shared types for deterministic draft validation.
 *
 * Nothing here talks to Telegram, the LLM, or Tally's write path. Validation
 * takes a {@link TransactionDraft} (a Phase 4 output type) and the Phase 3
 * master cache, and produces a result a later phase can act on — it does not
 * act on anything itself.
 */

/**
 * How a free-text name resolved against a Tally master collection.
 *
 * `ambiguous` and `not_found` are both "cannot proceed" outcomes, but for
 * different reasons a caller needs to handle differently: an ambiguous match
 * has real candidates worth asking the user to choose between; a not-found
 * match does not.
 */
export type MatchStatus = 'exact' | 'fuzzy' | 'ambiguous' | 'not_found';

export interface MasterMatchResult {
  readonly status: MatchStatus;
  /** The resolved Tally master name, for `exact` and `fuzzy` only. */
  readonly matchedName: string | null;
  /**
   * Candidate names for an `ambiguous` result — never the whole master list,
   * only the names that plausibly matched the query.
   */
  readonly candidates: readonly string[];
}

export type ValidationIssueCode =
  | 'missing_voucher_type'
  | 'invalid_voucher_type'
  | 'voucher_type_master_not_found'
  | 'missing_party_name'
  | 'party_not_found'
  | 'party_ambiguous'
  | 'missing_items'
  | 'missing_item_name'
  | 'stock_item_not_found'
  | 'stock_item_ambiguous'
  | 'missing_quantity'
  | 'invalid_quantity'
  | 'missing_rate'
  | 'invalid_rate'
  | 'missing_gst_percent'
  | 'invalid_gst_percent';

export interface ValidationIssue {
  readonly code: ValidationIssueCode;
  readonly message: string;
  /** Index into `draft.items`, for an issue scoped to one line item. */
  readonly itemIndex?: number;
  /** Populated only for an ambiguous-match issue. */
  readonly candidates?: readonly string[];
}

export interface LineItemValidationResult {
  readonly itemName: string;
  readonly stockItemMatch: MasterMatchResult;
  readonly quantityValid: boolean;
  readonly rateValid: boolean;
}

export interface DraftValidationResult {
  /** True only when every check below passed with no issues at all. */
  readonly isValid: boolean;
  readonly voucherTypeValid: boolean;
  /** null when partyName itself was missing — see the `missing_party_name` issue instead. */
  readonly partyMatch: MasterMatchResult | null;
  readonly items: readonly LineItemValidationResult[];
  /** null when gstPercent was missing — see the `missing_gst_percent` issue instead. */
  readonly gstPercentValid: boolean | null;
  readonly issues: readonly ValidationIssue[];
}
