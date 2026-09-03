/**
 * Deterministic intrastate/interstate determination.
 *
 * Company State compared with Place of Supply — never the party's state. A
 * party can be registered in one state and still receive goods at a
 * different place of supply (e.g. a branch office, a job site); assuming
 * party state == place of supply would silently get GST treatment wrong in
 * exactly that case. This module never sees or asks for the party's state at
 * all, so that assumption cannot creep in by accident.
 */

import type { GstLedgerConfig } from '../config/index.ts';
import { canonicalStateName } from './states.ts';

export type GstTreatmentType = 'intrastate' | 'interstate';

export interface GstLedgerAllocationName {
  readonly ledgerName: string;
  /** Share of the total tax this ledger carries — 0.5 for a CGST/SGST split, 1 for IGST. */
  readonly share: number;
}

export interface GstTreatment {
  readonly type: GstTreatmentType;
  readonly placeOfSupply: string;
  /** The ledgers to use, in a fixed, config-driven order — never chosen by the LLM. */
  readonly ledgers: readonly GstLedgerAllocationName[];
}

/**
 * Compare Company State against Place of Supply and return which configured
 * ledgers apply. Both inputs are validated (`isRecognizedState`) by the
 * caller before this runs — this function assumes it is already dealing with
 * two canonical state names.
 */
export function determineGstTreatment(
  companyState: string,
  placeOfSupply: string,
  config: GstLedgerConfig,
): GstTreatment {
  const canonicalCompanyState = canonicalStateName(companyState) ?? companyState;
  const canonicalPlaceOfSupply = canonicalStateName(placeOfSupply) ?? placeOfSupply;

  const isIntrastate =
    canonicalCompanyState.toLowerCase() === canonicalPlaceOfSupply.toLowerCase();

  if (isIntrastate) {
    return {
      type: 'intrastate',
      placeOfSupply: canonicalPlaceOfSupply,
      ledgers: [
        { ledgerName: config.cgstLedger, share: 0.5 },
        { ledgerName: config.sgstLedger, share: 0.5 },
      ],
    };
  }

  return {
    type: 'interstate',
    placeOfSupply: canonicalPlaceOfSupply,
    ledgers: [{ ledgerName: config.igstLedger, share: 1 }],
  };
}
