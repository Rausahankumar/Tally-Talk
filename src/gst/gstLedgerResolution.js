/**
 * Dynamic CGST/SGST/IGST ledger resolution from cached Tally Ledger masters.
 *
 * Confirmed live against a real CGST and a real SGST ledger (see
 * DECISIONS.md): both carry `TAXTYPE="GST"` and a `GSTDUTYHEAD` value
 * ("CGST", "SGST/UTGST") as plain, direct fields on the Ledger master — not
 * nested in a `.LIST`. A `VAT` ledger in the very same "Duties & Taxes"
 * `PARENT` group has `TAXTYPE="VAT"` and no `GSTDUTYHEAD` at all, proving
 * `PARENT` alone cannot tell GST ledgers apart from other duties/taxes.
 *
 * No IGST ledger exists yet in the verified instance (it has never posted an
 * interstate sale) — this resolves it the exact same generic way, from
 * `GSTDUTYHEAD`, never from a hardcoded or guessed ledger name.
 *
 * Classification only, never fuzzy: a tax ledger is money-moving and exact
 * classification data already exists — there is no legitimate "close enough"
 * match here, unlike a free-text party or item name.
 */
import { readCachedMasters } from '../tally/cache.js';
const REQUIRED_TAX_TYPE = 'GST';
export const GST_DUTY_HEADS = {
  cgst: 'CGST',
  sgst: 'SGST/UTGST',
  igst: 'IGST',
};
/**
 * `{status:'resolved', ledgerName}` on exactly one match, `{status:'not_found'}`
 * on zero, `{status:'ambiguous', candidates}` on more than one — never a pick.
 */
export function resolveGstLedger(db, dutyHead) {
  const matches = readCachedMasters(db, 'Ledger').filter(
    (row) => row.data.TAXTYPE === REQUIRED_TAX_TYPE && row.data.GSTDUTYHEAD === dutyHead,
  );
  if (matches.length === 1) {
    return { status: 'resolved', ledgerName: matches[0].name, candidates: [] };
  }
  if (matches.length === 0) {
    return { status: 'not_found', ledgerName: null, candidates: [] };
  }
  return { status: 'ambiguous', ledgerName: null, candidates: matches.map((row) => row.name) };
}
/** Resolves all three duty heads in one pass — the shape `postingReadiness.js` consumes. */
export function resolveGstLedgers(db) {
  return {
    cgst: resolveGstLedger(db, GST_DUTY_HEADS.cgst),
    sgst: resolveGstLedger(db, GST_DUTY_HEADS.sgst),
    igst: resolveGstLedger(db, GST_DUTY_HEADS.igst),
  };
}
