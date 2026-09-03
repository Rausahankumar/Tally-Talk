/**
 * Whether a validated draft is actually ready to be confirmed/posted, once
 * GST and ledger mapping are taken into account.
 *
 * This runs *after* Phase 5's `validateTransactionDraft` has already passed —
 * it does not repeat those checks, it adds the ones Phase 5 had no data for
 * (place of supply, GST treatment, ledger mapping, per-item godown). Every
 * decision here is a plain function or an exact lookup against
 * backend-controlled configuration and the local master cache; nothing is
 * inferred from the party's state, nothing is fuzzy-matched, and nothing is
 * chosen by the LLM.
 */

import type { DatabaseSync } from 'node:sqlite';

import type { GodownConfig, GstLedgerConfig } from '../config/index.ts';
import type { TransactionDraft } from '../llm/schema.ts';
import type { DraftValidationResult } from '../validation/types.ts';
import { godownExistsExact } from '../tally/godownExistence.ts';
import { ledgerExistsExact } from './ledgerExistence.ts';
import type { ItemLedgerMappingStore } from './itemLedgerMapping.ts';
import { isRecognizedState } from './states.ts';
import { determineGstTreatment } from './treatment.ts';
import type { GstTreatment } from './treatment.ts';

export type PostingBlockCode =
  | 'phase5_validation_failed'
  | 'company_state_not_configured'
  | 'place_of_supply_missing'
  | 'place_of_supply_unrecognized'
  | 'gst_ledger_not_found_in_masters'
  | 'item_ledger_mapping_missing'
  | 'item_ledger_not_found_in_masters'
  | 'godown_missing'
  | 'godown_not_found_in_masters';

export interface PostingBlocker {
  readonly code: PostingBlockCode;
  readonly message: string;
  readonly itemIndex?: number;
}

export interface LineItemLedgers {
  readonly itemIndex: number;
  readonly salesLedger: string | null;
  readonly purchaseLedger: string | null;
}

export interface LineItemGodown {
  readonly itemIndex: number;
  /** The godown actually resolved for this item — stated or the configured default. `null` if unresolved. */
  readonly godown: string | null;
}

export interface PostingReadinessResult {
  readonly ready: boolean;
  /** The place of supply actually used — either stated or the configured default. `null` if unresolved. */
  readonly placeOfSupply: string | null;
  readonly gstTreatment: GstTreatment | null;
  readonly itemLedgers: readonly LineItemLedgers[];
  readonly itemGodowns: readonly LineItemGodown[];
  readonly blockers: readonly PostingBlocker[];
}

export interface PostingReadinessDeps {
  readonly db: DatabaseSync;
  readonly gstConfig: GstLedgerConfig;
  readonly itemLedgerMappingStore: ItemLedgerMappingStore;
  readonly godownConfig: GodownConfig;
}

/**
 * `true` only when every check that CAN be answered without a config fix has
 * been answered, and the single remaining gap is a place of supply the user
 * has not yet stated. Callers use this to decide whether to ask the user a
 * question versus report a configuration error nothing they type can fix.
 */
export function isOnlyMissingPlaceOfSupply(result: PostingReadinessResult): boolean {
  return (
    !result.ready &&
    result.blockers.length === 1 &&
    result.blockers[0]!.code === 'place_of_supply_missing'
  );
}

export function checkPostingReadiness(
  deps: PostingReadinessDeps,
  draft: TransactionDraft,
  phase5Validation: DraftValidationResult,
): PostingReadinessResult {
  const blockers: PostingBlocker[] = [];

  if (!phase5Validation.isValid) {
    return {
      ready: false,
      placeOfSupply: null,
      gstTreatment: null,
      itemLedgers: [],
      itemGodowns: [],
      blockers: [
        { code: 'phase5_validation_failed', message: 'The transaction has not yet passed basic validation.' },
      ],
    };
  }

  if (deps.gstConfig.companyState.trim() === '') {
    blockers.push({
      code: 'company_state_not_configured',
      message: 'COMPANY_STATE is not configured on this deployment.',
    });
  }

  // The party's stated location is never used here — see module doc. Only an
  // explicit placeOfSupply, or an explicitly configured default, counts.
  const effectivePlaceOfSupply = draft.placeOfSupply ?? deps.gstConfig.defaultPlaceOfSupply;

  if (effectivePlaceOfSupply === null) {
    blockers.push({
      code: 'place_of_supply_missing',
      message: 'No Place of Supply was stated, and no default is configured.',
    });
  } else if (!isRecognizedState(effectivePlaceOfSupply)) {
    blockers.push({
      code: 'place_of_supply_unrecognized',
      message: `"${effectivePlaceOfSupply}" is not a recognised state or union territory.`,
    });
  }

  let gstTreatment: GstTreatment | null = null;
  if (
    effectivePlaceOfSupply !== null &&
    isRecognizedState(effectivePlaceOfSupply) &&
    deps.gstConfig.companyState.trim() !== ''
  ) {
    gstTreatment = determineGstTreatment(deps.gstConfig.companyState, effectivePlaceOfSupply, deps.gstConfig);

    for (const allocation of gstTreatment.ledgers) {
      if (!ledgerExistsExact(deps.db, allocation.ledgerName)) {
        blockers.push({
          code: 'gst_ledger_not_found_in_masters',
          message: `Configured GST ledger "${allocation.ledgerName}" was not found in TallyPrime.`,
        });
      }
    }
  }

  const itemLedgers: LineItemLedgers[] = phase5Validation.items.map((item, itemIndex) => {
    const resolvedName = item.stockItemMatch.matchedName;
    if (resolvedName === null) {
      // Phase 5 already blocks this case (not_found/ambiguous) via
      // phase5_validation_failed above; nothing further to check here.
      return { itemIndex, salesLedger: null, purchaseLedger: null };
    }

    const mapping = deps.itemLedgerMappingStore.getMapping(resolvedName);
    if (mapping === null) {
      blockers.push({
        code: 'item_ledger_mapping_missing',
        message: `No Sales/Purchase ledger mapping is configured for "${resolvedName}".`,
        itemIndex,
      });
      return { itemIndex, salesLedger: null, purchaseLedger: null };
    }

    const ledgerName = draft.voucherType === 'purchase' ? mapping.purchaseLedger : mapping.salesLedger;
    if (!ledgerExistsExact(deps.db, ledgerName)) {
      blockers.push({
        code: 'item_ledger_not_found_in_masters',
        message: `Configured ledger "${ledgerName}" for "${resolvedName}" was not found in TallyPrime.`,
        itemIndex,
      });
    }

    return {
      itemIndex,
      salesLedger: mapping.salesLedger,
      purchaseLedger: mapping.purchaseLedger,
    };
  });

  // Godown resolution is independent of ledger/GST resolution above: it comes
  // from the draft's own per-item field plus the configured default, never
  // from Phase 5's stock item matching. Each item is resolved on its own —
  // items may share a godown or each name a different one; neither is an
  // error (per the real captured Tally evidence this mirrors).
  const itemGodowns: LineItemGodown[] = draft.items.map((item, itemIndex) => {
    const effectiveGodown = item.godown ?? deps.godownConfig.defaultGodown;

    if (effectiveGodown === null) {
      blockers.push({
        code: 'godown_missing',
        message: `No godown was stated for "${item.itemName}", and no default godown is configured.`,
        itemIndex,
      });
      return { itemIndex, godown: null };
    }

    if (!godownExistsExact(deps.db, effectiveGodown)) {
      blockers.push({
        code: 'godown_not_found_in_masters',
        message: `Godown "${effectiveGodown}" for "${item.itemName}" was not found in TallyPrime.`,
        itemIndex,
      });
      return { itemIndex, godown: null };
    }

    return { itemIndex, godown: effectiveGodown };
  });

  return {
    ready: blockers.length === 0,
    placeOfSupply: effectivePlaceOfSupply,
    gstTreatment,
    itemLedgers,
    itemGodowns,
    blockers,
  };
}
