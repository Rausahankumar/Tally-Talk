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
import { canonicalStateName } from './states.js';
/**
 * Compare Company State against Place of Supply and return which configured
 * ledgers apply. Both inputs are validated (`isRecognizedState`) by the
 * caller before this runs — this function assumes it is already dealing with
 * two canonical state names.
 */
export function determineGstTreatment(companyState, placeOfSupply, config) {
  const canonicalCompanyState = canonicalStateName(companyState) ?? companyState;
  const canonicalPlaceOfSupply = canonicalStateName(placeOfSupply) ?? placeOfSupply;
  const isIntrastate = canonicalCompanyState.toLowerCase() === canonicalPlaceOfSupply.toLowerCase();
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
