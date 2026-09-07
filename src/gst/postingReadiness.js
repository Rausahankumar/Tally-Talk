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
import { godownExistsExact } from '../tally/godownExistence.js';
import { ledgerExistsExact } from './ledgerExistence.js';
import { isRecognizedState } from './states.js';
import { determineGstTreatment } from './treatment.js';
/**
 * `true` only when every check that CAN be answered without a config fix has
 * been answered, and the single remaining gap is a place of supply the user
 * has not yet stated. Callers use this to decide whether to ask the user a
 * question versus report a configuration error nothing they type can fix.
 */
export function isOnlyMissingPlaceOfSupply(result) {
  return (
    !result.ready &&
    result.blockers.length === 1 &&
    result.blockers[0].code === 'place_of_supply_missing'
  );
}
export function checkPostingReadiness(deps, draft, phase5Validation) {
  const blockers = [];
  if (!phase5Validation.isValid) {
    return {
      ready: false,
      placeOfSupply: null,
      gstTreatment: null,
      itemLedgers: [],
      itemGodowns: [],
      itemStock: [],
      blockers: [
        {
          code: 'phase5_validation_failed',
          message: 'The transaction has not yet passed basic validation.',
        },
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
  let gstTreatment = null;
  if (
    effectivePlaceOfSupply !== null &&
    isRecognizedState(effectivePlaceOfSupply) &&
    deps.gstConfig.companyState.trim() !== ''
  ) {
    gstTreatment = determineGstTreatment(
      deps.gstConfig.companyState,
      effectivePlaceOfSupply,
      deps.gstConfig,
    );
    for (const allocation of gstTreatment.ledgers) {
      if (!ledgerExistsExact(deps.db, allocation.ledgerName)) {
        blockers.push({
          code: 'gst_ledger_not_found_in_masters',
          message: `Configured GST ledger "${allocation.ledgerName}" was not found in TallyPrime.`,
        });
      }
    }
  }
  const itemLedgers = phase5Validation.items.map((item, itemIndex) => {
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
    const ledgerName =
      draft.voucherType === 'purchase' ? mapping.purchaseLedger : mapping.salesLedger;
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
  //
  // Stock resolution runs immediately after, for the same item, only once a
  // godown is actually resolved: batch and closing quantity are looked up
  // from the cached (item, godown) -> batch rows confirmed live via
  // TYPE=Batch/CHILDOF. Never guessed: zero rows blocks as missing data, more
  // than one row blocks as ambiguous (no rule chooses between real batches).
  const itemGodowns = [];
  const itemStock = [];
  draft.items.forEach((item, itemIndex) => {
    const effectiveGodown = item.godown ?? deps.godownConfig.defaultGodown;
    if (effectiveGodown === null) {
      blockers.push({
        code: 'godown_missing',
        message: `No godown was stated for "${item.itemName}", and no default godown is configured.`,
        itemIndex,
      });
      itemGodowns.push({ itemIndex, godown: null });
      itemStock.push({
        itemIndex,
        resolvedBatch: null,
        availableQuantity: null,
        alternativeGodowns: [],
      });
      return;
    }
    if (!godownExistsExact(deps.db, effectiveGodown)) {
      blockers.push({
        code: 'godown_not_found_in_masters',
        message: `Godown "${effectiveGodown}" for "${item.itemName}" was not found in TallyPrime.`,
        itemIndex,
      });
      itemGodowns.push({ itemIndex, godown: null });
      itemStock.push({
        itemIndex,
        resolvedBatch: null,
        availableQuantity: null,
        alternativeGodowns: [],
      });
      return;
    }
    itemGodowns.push({ itemIndex, godown: effectiveGodown });
    // The exact resolved master name, from Phase 5 matching — same source
    // the ledger-mapping lookup above uses, never the raw draft text.
    const resolvedItemName = phase5Validation.items[itemIndex]?.stockItemMatch.matchedName ?? null;
    const requestedQuantity = item.quantity;
    if (resolvedItemName === null || requestedQuantity === null) {
      // Defensive only — Phase 5 already guarantees both once isValid is true.
      itemStock.push({
        itemIndex,
        resolvedBatch: null,
        availableQuantity: null,
        alternativeGodowns: [],
      });
      return;
    }
    const rows = deps.stockAvailabilityStore.getAvailability(resolvedItemName, effectiveGodown);
    if (rows.length === 0) {
      blockers.push({
        code: 'stock_data_missing',
        message: `No stock availability data is cached for "${resolvedItemName}" in godown "${effectiveGodown}".`,
        itemIndex,
      });
      itemStock.push({
        itemIndex,
        resolvedBatch: null,
        availableQuantity: null,
        alternativeGodowns: [],
      });
      return;
    }
    if (rows.length > 1) {
      blockers.push({
        code: 'stock_batch_ambiguous',
        message: `Multiple batches of "${resolvedItemName}" exist in godown "${effectiveGodown}"; the batch cannot be resolved automatically.`,
        itemIndex,
      });
      itemStock.push({
        itemIndex,
        resolvedBatch: null,
        availableQuantity: null,
        alternativeGodowns: [],
      });
      return;
    }
    const row = rows[0];
    if (requestedQuantity > row.quantity) {
      const alternativeGodowns = deps.stockAvailabilityStore.getGodownsWithSufficientStock(
        resolvedItemName,
        requestedQuantity,
        effectiveGodown,
      );
      const alternativesText =
        alternativeGodowns.length > 0
          ? ` Sufficient stock is available in: ${alternativeGodowns.map((g) => `${g.godown} (${g.availableQuantity} ${row.unit})`).join(', ')}.`
          : '';
      blockers.push({
        code: 'stock_insufficient',
        message: `Only ${row.quantity} ${row.unit} of "${resolvedItemName}" is available in godown "${effectiveGodown}", but ${requestedQuantity} was requested.${alternativesText}`,
        itemIndex,
      });
      itemStock.push({
        itemIndex,
        resolvedBatch: row.batchName,
        availableQuantity: row.quantity,
        alternativeGodowns,
      });
      return;
    }
    itemStock.push({
      itemIndex,
      resolvedBatch: row.batchName,
      availableQuantity: row.quantity,
      alternativeGodowns: [],
    });
  });
  return {
    ready: blockers.length === 0,
    placeOfSupply: effectivePlaceOfSupply,
    gstTreatment,
    itemLedgers,
    itemGodowns,
    itemStock,
    blockers,
  };
}
