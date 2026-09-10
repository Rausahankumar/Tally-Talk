/**
 * Master data sync.
 *
 * Each type below is a thin declaration of what to fetch from Tally and which
 * field identifies a record; matching/normalisation logic (fuzzy name
 * matching, GST parsing) is deliberately not here — that belongs to Phase 5,
 * once there is an LLM draft to validate against these masters.
 */
import { parseStockItemCollectionResponse } from './xml.js';
/**
 * Confirmed live against the target company (Nirmal FMCG Traders Ltd) before
 * being encoded here — see DECISIONS.md. Field lists are intentionally narrow:
 * only what backend validation and matching will need, not a full record.
 */
export const MASTER_DEFINITIONS = [
  // TAXTYPE + GSTDUTYHEAD confirmed live against a real CGST/SGST ledger
  // (TAXTYPE="GST", GSTDUTYHEAD="CGST"/"SGST/UTGST") — the only reliable,
  // non-name-based way to identify which ledger is which GST tax. A ledger
  // in the same "Duties & Taxes" group with a different TAXTYPE (e.g. "VAT")
  // has no GSTDUTYHEAD at all, confirming PARENT alone cannot distinguish
  // them. Never used for fuzzy matching — see src/gst/gstLedgerResolution.js.
  // LEDSTATENAME confirmed live as a real, plain field (a party's own
  // registered state) — used only to derive Place of Supply when nothing
  // else states one (src/gst/postingReadiness.js `resolvePartyState`), per
  // an explicit, informed decision to reopen the exception DECISIONS.md #28
  // otherwise avoids.
  // GUID confirmed live as a real, plain field on both Ledger and StockItem —
  // Tally's own stable identifier, cached so a duplicate display name can be
  // told apart from a genuinely different master rather than only ever
  // compared by name.
  {
    type: 'Ledger',
    fields: ['NAME', 'PARENT', 'OPENINGBALANCE', 'ISBILLWISEON', 'TAXTYPE', 'GSTDUTYHEAD', 'LEDSTATENAME', 'GUID'],
  },
  // ISBATCHWISEON confirmed live and fetchable — cached for future use;
  // stock availability resolution itself (src/tally/stockAvailability.js)
  // works from the availability cache directly and does not branch on it.
  // GSTHSNCODE is a real, plain field (confirmed live). GSTDETAILS.LIST /
  // STANDARDPRICELIST / STANDARDCOSTLIST are real `.LIST` history structures
  // (also confirmed live) — `parse: parseStockItemCollectionResponse` is what
  // surfaces them as `gstRateHistory`/`standardPriceHistory`/
  // `standardCostHistory` instead of being silently dropped like every other
  // `.LIST` field on every other master type.
  {
    type: 'StockItem',
    fields: [
      'NAME',
      'PARENT',
      'BASEUNITS',
      'ISBATCHWISEON',
      'GSTHSNCODE',
      'GUID',
      'GSTDETAILS.LIST',
      'STANDARDPRICELIST',
      'STANDARDCOSTLIST',
    ],
    parse: parseStockItemCollectionResponse,
  },
  { type: 'Godown', fields: ['NAME', 'PARENT'] },
  { type: 'Unit', fields: ['NAME'] },
  { type: 'VoucherType', fields: ['NAME', 'PARENT'] },
  // Company is deliberately not here: discovering it is what determines the
  // SVCURRENTCOMPANY every other query in this list (and this sync itself)
  // needs to be scoped to — see src/tally/company.js and syncCli.js, which
  // resolve and cache Company before this list is synced.
];
/**
 * Fetch every defined master type and replace the cache's copy of each.
 *
 * One type failing (a company without inventory features, say) does not stop
 * the others — each is fetched and reported independently.
 */
export async function syncMasterData(client, cache) {
  const results = [];
  for (const definition of MASTER_DEFINITIONS) {
    const records = await client.exportCollection(
      definition.type,
      definition.fields,
      definition.parse !== undefined ? { parse: definition.parse } : undefined,
    );
    cache.replaceAll(definition.type, records);
    results.push({ type: definition.type, count: records.length });
  }
  return results;
}
