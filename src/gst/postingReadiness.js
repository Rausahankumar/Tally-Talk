/**
 * Whether a validated draft is actually ready to be confirmed/posted, once
 * GST and ledger mapping are taken into account.
 *
 * This runs *after* Phase 5's `validateTransactionDraft` has already passed —
 * it does not repeat those checks, it adds the ones Phase 5 had no data for
 * (place of supply, GST treatment, ledger mapping, per-item godown). Every
 * decision here is a plain function or an exact lookup against
 * backend-controlled configuration and the local master cache; nothing is
 * fuzzy-matched, and nothing is chosen by the LLM. Place of Supply may be
 * derived from the resolved party ledger's own registered state as one of
 * several precedence tiers (see `resolvePartyState`) — a deliberate,
 * explicitly-approved exception to this module's earlier "never the party's
 * state" rule, always surfaced to the user via `placeOfSupplySource` rather
 * than trusted silently.
 */
import { readCachedMasters } from '../tally/cache.js';
import { godownExistsExact } from '../tally/godownExistence.js';
import { GST_DUTY_HEADS, resolveGstLedgers } from './gstLedgerResolution.js';
import { ledgerExistsExact } from './ledgerExistence.js';
import { isRecognizedState } from './states.js';
import { determineGstTreatment } from './treatment.js';
/** The stock item's base unit, e.g. "Kg" — from the Tally master, only for display in a stock warning. */
function findStockItemUnit(db, stockItemName) {
  const row = readCachedMasters(db, 'StockItem').find((r) => r.name === stockItemName);
  const unit = row?.data.BASEUNITS;
  return unit !== undefined && unit !== '' ? unit : null;
}
/**
 * The party ledger's own registered state (`LEDSTATENAME`, confirmed live as
 * a real, plain Ledger field), when cached and a recognised state. Used only
 * to derive Place of Supply when the user stated none and no default is
 * configured — never overrides an explicit value, and the caller always
 * surfaces which source won (see `placeOfSupplySource`) so a case where the
 * party's registered state genuinely differs from where goods are actually
 * supplied (a branch office, a job site — see DECISIONS.md #28) is visible
 * to the user before they confirm, not silently trusted.
 */
function resolvePartyState(db, partyLedgerName) {
  if (partyLedgerName === null) return null;
  const row = readCachedMasters(db, 'Ledger').find((r) => r.name === partyLedgerName);
  const state = row?.data.LEDSTATENAME;
  return state !== undefined && state !== '' ? state : null;
}
/**
 * Tally's own reserved, non-client-specific primary group names for revenue
 * ledgers — the same category as "Sundry Creditors"/"Duties & Taxes" already
 * used elsewhere in this project (see masterLookup.js, gstLedgerResolution.js)
 * — never a client-invented ledger name.
 */
const REVENUE_LEDGER_GROUP = {
  sales: 'Sales Accounts',
  purchase: 'Purchase Accounts',
  credit_note: 'Sales Accounts',
  debit_note: 'Purchase Accounts',
};
/**
 * Resolve which Sales/Purchase-type ledger to use for a given voucher type
 * when no explicit `item_ledger_mappings` override exists for this stock
 * item. Three tiers, in order — never a fourth, and never a guess:
 *
 *  1. This company's configured default
 *     (`company_revenue_ledger_defaults`, keyed by `deps.companyName`) — set
 *     once per company from real evidence of how that company actually
 *     posts (see DECISIONS.md), not hardcoded here. Re-validated against the
 *     live master cache on every call: a configured name that no longer
 *     exists in Tally is a configuration problem, reported as
 *     `configuredMissing`, and never silently falls through to tier 2 — that
 *     would risk posting against a ledger nobody actually chose.
 *  2. Automatic single-candidate resolution: the one Sales/Purchase-type
 *     ledger this company has, when there is exactly one, under Tally's own
 *     reserved "Sales Accounts"/"Purchase Accounts" group (never a
 *     client-invented name) — lets a company with naturally unambiguous data
 *     work with zero configuration at all, company-level or per-item.
 *  3. Neither: `ledgerName: null` with the real candidate names (when any
 *     exist), so the caller can block with something the user can actually
 *     act on.
 */
function resolveRevenueLedger(deps, voucherType) {
  const group = REVENUE_LEDGER_GROUP[voucherType];
  if (group === undefined) {
    return { ledgerName: null, source: null, candidates: [], configuredMissing: null };
  }
  const companyDefaults =
    deps.companyRevenueLedgerDefaultsStore !== undefined && deps.companyName !== undefined
      ? deps.companyRevenueLedgerDefaultsStore.getDefaults(deps.companyName)
      : null;
  const configuredName =
    voucherType === 'purchase'
      ? companyDefaults?.purchaseLedger ?? null
      : companyDefaults?.salesLedger ?? null;
  if (configuredName !== null) {
    if (ledgerExistsExact(deps.db, configuredName)) {
      return { ledgerName: configuredName, source: 'company_default', candidates: [], configuredMissing: null };
    }
    // Configured but gone from Tally — never replaced by a different
    // resolution tier; that would mean the effective ledger silently changed
    // out from under a configuration nobody updated.
    return { ledgerName: null, source: null, candidates: [], configuredMissing: configuredName };
  }
  const candidates = readCachedMasters(deps.db, 'Ledger')
    .filter((row) => row.data.PARENT === group)
    .map((row) => row.name);
  return candidates.length === 1
    ? { ledgerName: candidates[0], source: 'auto_single_candidate', candidates: [], configuredMissing: null }
    : { ledgerName: null, source: null, candidates, configuredMissing: null };
}
/**
 * `true` only when the cached StockItem master explicitly says
 * `ISBATCHWISEON="No"` — never inferred from an absent/unknown field. This is
 * the one case where a missing `stock_availability` row does not leave the
 * batch unresolved: real captured Tally data (see postingXml.js's module doc)
 * confirms a non-batch-tracked item is still posted through a batch
 * allocation, always under Tally's own fixed implicit name "Primary Batch" —
 * using that name here is reusing a confirmed Tally mechanism, not guessing
 * one. A batch-tracked item (`ISBATCHWISEON="Yes"`) never gets this
 * treatment — its real batch name is arbitrary and only ever comes from a
 * cached `Batch` row.
 */
function isConfirmedNonBatchTracked(db, stockItemName) {
  const row = readCachedMasters(db, 'StockItem').find((r) => r.name === stockItemName);
  return row?.data.ISBATCHWISEON === 'No';
}
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
/**
 * `{ itemIndex, candidates }` only when the single remaining gap is a choice
 * between more than one godown that each independently have recorded stock —
 * something the user can actually answer — or `null` otherwise. Mirrors
 * {@link isOnlyMissingPlaceOfSupply}: asking a clarifying question is only
 * safe when it is the *one* thing blocking readiness, not when some other,
 * unrelated configuration problem exists alongside it.
 */
export function findGodownSelectionNeeded(result) {
  if (result.ready || result.blockers.length !== 1) return null;
  const blocker = result.blockers[0];
  if (blocker.code !== 'godown_selection_required') return null;
  return { itemIndex: blocker.itemIndex, candidates: blocker.candidates };
}
export function checkPostingReadiness(deps, draft, phase5Validation) {
  const blockers = [];
  const stockWarnings = [];
  if (!phase5Validation.isValid) {
    return {
      ready: false,
      placeOfSupply: null,
      gstTreatment: null,
      itemLedgers: [],
      itemGodowns: [],
      itemStock: [],
      stockWarnings: [],
      blockers: [
        {
          code: 'phase5_validation_failed',
          message: 'The transaction has not yet passed basic validation.',
        },
      ],
    };
  }
  const companyState = deps.gstConfig.companyState ?? '';
  if (companyState.trim() === '') {
    blockers.push({
      code: 'company_state_not_configured',
      message: 'The Tally company has no state on record (Company.STATENAME is empty).',
    });
  } else if (!isRecognizedState(companyState)) {
    blockers.push({
      code: 'company_state_unrecognized',
      message: `"${companyState}" (from the Tally company record) is not a recognised state or union territory.`,
    });
  }
  // Precedence: explicit statement, then the resolved party ledger's own
  // registered state (only when it's a recognised state — an unrecognised or
  // absent value is treated as unavailable, never blocked on, since the user
  // never stated this one themselves), then the configured default. Recorded
  // in `placeOfSupplySource` so callers (the preview) can tell the user
  // exactly where this came from — critical for the party-derived case,
  // which can genuinely be wrong (DECISIONS.md #28).
  let effectivePlaceOfSupply = draft.placeOfSupply;
  let placeOfSupplySource = 'explicit';
  if (effectivePlaceOfSupply === null) {
    const partyState = resolvePartyState(deps.db, phase5Validation.partyMatch?.matchedName ?? null);
    if (partyState !== null && isRecognizedState(partyState)) {
      effectivePlaceOfSupply = partyState;
      placeOfSupplySource = 'party';
    } else {
      effectivePlaceOfSupply = deps.gstConfig.defaultPlaceOfSupply;
      placeOfSupplySource = 'default';
    }
  }
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
    companyState.trim() !== '' &&
    isRecognizedState(companyState)
  ) {
    // Resolved fresh from the cache every time, never from static config —
    // see gstLedgerResolution.js. A ledger name that fails to resolve (not
    // found, or ambiguous) comes back as `null` and is caught below, exactly
    // like the old ledgerExistsExact check, just for a different reason.
    const resolved = resolveGstLedgers(deps.db);
    gstTreatment = determineGstTreatment(companyState, effectivePlaceOfSupply, {
      cgstLedger: resolved.cgst.ledgerName,
      sgstLedger: resolved.sgst.ledgerName,
      igstLedger: resolved.igst.ledgerName,
    });
    const relevantResolutions =
      gstTreatment.type === 'intrastate'
        ? [
            [GST_DUTY_HEADS.cgst, resolved.cgst],
            [GST_DUTY_HEADS.sgst, resolved.sgst],
          ]
        : [[GST_DUTY_HEADS.igst, resolved.igst]];
    for (const [dutyHead, resolution] of relevantResolutions) {
      if (resolution.status === 'not_found') {
        blockers.push({
          code: 'gst_ledger_not_found_in_masters',
          message: `No ledger classified as ${dutyHead} (TAXTYPE=GST) was found in TallyPrime.`,
        });
      } else if (resolution.status === 'ambiguous') {
        blockers.push({
          code: 'gst_ledger_ambiguous',
          message: `Multiple ledgers are classified as ${dutyHead}; the correct one cannot be determined automatically.`,
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
      // No manual override configured for this item — resolve the revenue
      // ledger via the company-level default, then automatic single-candidate
      // resolution, before asking for one. This is what lets a brand-new
      // stock item (never seen by this app before) be sold immediately, with
      // no per-item administrator setup, as long as either this company has
      // a configured default or its own Tally data is itself unambiguous.
      const salesResolution = resolveRevenueLedger(deps, 'sales');
      const purchaseResolution = resolveRevenueLedger(deps, 'purchase');
      const relevant = draft.voucherType === 'purchase' ? purchaseResolution : salesResolution;
      if (relevant.configuredMissing !== null) {
        blockers.push({
          code: 'company_default_ledger_not_found',
          message: `The configured default ${draft.voucherType === 'purchase' ? 'Purchase' : 'Sales'} ledger "${relevant.configuredMissing}" for company "${deps.companyName ?? 'this company'}" was not found in TallyPrime. Update the company's default ledger configuration, or check whether it was renamed or deleted in Tally.`,
          itemIndex,
        });
        return { itemIndex, salesLedger: null, purchaseLedger: null };
      }
      if (relevant.ledgerName !== null) {
        return { itemIndex, salesLedger: salesResolution.ledgerName, purchaseLedger: purchaseResolution.ledgerName };
      }
      const candidateNote =
        relevant.candidates.length > 1
          ? ` Tally has more than one candidate ledger for this: ${relevant.candidates.join(', ')}. Configure which one this item should use, or set a company-level default.`
          : '';
      blockers.push({
        code: 'item_ledger_mapping_missing',
        message: `No Sales/Purchase ledger mapping is configured for "${resolvedName}", and Tally does not have exactly one candidate ledger to use automatically.${candidateNote}`,
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
  // TYPE=Batch/CHILDOF. Never guessed: zero rows is reported as an
  // informational stock warning (missing cache data is never treated as "0 in
  // stock"), more than one row still blocks as ambiguous (no rule chooses
  // between real batches) — stock quantity is a warning, batch identity is
  // not something this app may pick on its own.
  const itemGodowns = [];
  const itemStock = [];
  draft.items.forEach((item, itemIndex) => {
    // Needed up front now: auto-selecting a godown from stock data requires
    // the resolved stock item name and quantity before a godown is even
    // known, not just after (as the rest of this block still does below).
    const resolvedItemNameForGodown =
      phase5Validation.items[itemIndex]?.stockItemMatch.matchedName ?? null;
    const requestedQuantityForGodown = item.quantity;
    let effectiveGodown = item.godown ?? deps.godownConfig.defaultGodown;
    if (effectiveGodown === null) {
      // No godown stated and none configured as default: try to resolve one
      // from real stock data instead of asking immediately. Auto-select only
      // when exactly one godown has any recorded stock for this item at all
      // — regardless of whether that amount is enough (insufficient/zero/
      // negative stock is a warning elsewhere, never a reason to exclude a
      // godown here). More than one recorded godown is a genuine choice
      // nothing here may make silently; zero is the same hard block as
      // before, just with a clearer reason: there is truly no data to decide
      // from, not that what's recorded happens to be too little.
      const candidates =
        resolvedItemNameForGodown !== null && requestedQuantityForGodown !== null
          ? deps.stockAvailabilityStore.getAllGodownsWithRecordedStock(resolvedItemNameForGodown)
          : [];
      if (candidates.length === 1) {
        effectiveGodown = candidates[0].godown;
      } else if (candidates.length > 1) {
        blockers.push({
          code: 'godown_selection_required',
          message: `Multiple godowns have recorded stock of "${item.itemName}"; please choose one: ${candidates.map((c) => c.godown).join(', ')}.`,
          itemIndex,
          candidates: candidates.map((c) => c.godown),
        });
        itemGodowns.push({ itemIndex, godown: null });
        itemStock.push({
          itemIndex,
          resolvedBatch: null,
          availableQuantity: null,
          alternativeGodowns: [],
        });
        return;
      } else {
        blockers.push({
          code: 'godown_missing',
          message: `No godown was stated for "${item.itemName}", no default godown is configured, and no godown has any recorded stock for it.`,
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
    // Same resolved master name and quantity computed above for auto-select —
    // reused rather than looked up again, from Phase 5 matching, never the
    // raw draft text.
    const resolvedItemName = resolvedItemNameForGodown;
    const requestedQuantity = requestedQuantityForGodown;
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
      // Not a hard blocker: missing cache data must never be treated as "0 in
      // stock" — it just means nothing can be confirmed either way. Surfaced
      // to the user as an informational warning instead (see messages.js),
      // shown before Confirm; the user still decides whether to proceed.
      stockWarnings.push({
        itemIndex,
        itemName: resolvedItemName,
        requestedQuantity,
        requestedUnit: findStockItemUnit(deps.db, resolvedItemName),
        availableQuantity: null,
        availableUnit: null,
        reason: 'no_data',
      });
      // A confirmed non-batch-tracked item still resolves its batch even with
      // no cached row for it — see isConfirmedNonBatchTracked's doc. A
      // batch-tracked item (or one whose tracking status isn't confirmed at
      // all) is left unresolved, exactly as before: nothing here may guess a
      // real, arbitrary batch name.
      const resolvedBatch = isConfirmedNonBatchTracked(deps.db, resolvedItemName)
        ? 'Primary Batch'
        : null;
      itemStock.push({
        itemIndex,
        resolvedBatch,
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
      // Not a hard blocker: insufficient cached stock is still an
      // informational warning, never a validation failure — see the
      // `rows.length === 0` branch above for the reasoning.
      const alternativeGodowns = deps.stockAvailabilityStore.getGodownsWithSufficientStock(
        resolvedItemName,
        requestedQuantity,
        effectiveGodown,
      );
      stockWarnings.push({
        itemIndex,
        itemName: resolvedItemName,
        requestedQuantity,
        requestedUnit: row.unit,
        availableQuantity: row.quantity,
        availableUnit: row.unit,
        reason: 'insufficient',
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
    placeOfSupplySource,
    gstTreatment,
    itemLedgers,
    itemGodowns,
    itemStock,
    stockWarnings,
    blockers,
  };
}
