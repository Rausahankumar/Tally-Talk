/**
 * Company-level default Sales/Purchase revenue ledger.
 *
 * Distinct from `item_ledger_mappings` (per-stock-item, an exception
 * mechanism): this is one configured pair of ledgers per Tally company,
 * answering "which ledger does an ordinary sale/purchase use here" so a
 * brand-new stock item never needs its own mapping row first (see
 * postingReadiness.js's resolution order and DECISIONS.md).
 *
 * Keyed by company name because this project already treats "the one Tally
 * company currently open" as the unit of configuration (tally/company.js) —
 * a deployment that talks to a different company gets its own independent
 * row here, never a shared/global default.
 *
 * Lookup is by exact company name only, same as item_ledger_mappings' exact
 * stock-item lookup: never fuzzy, because a near-miss here is a configuration
 * problem to fix, not a company to guess at.
 */
import { COMPANY_REVENUE_LEDGER_DEFAULTS_TABLE } from '../db/schema.js';
export function createCompanyRevenueLedgerDefaultsStore(db) {
  const select = db.prepare(
    `SELECT company_name, sales_ledger, sales_ledger_guid, purchase_ledger, purchase_ledger_guid
     FROM ${COMPANY_REVENUE_LEDGER_DEFAULTS_TABLE} WHERE company_name = ?`,
  );
  const upsert = db.prepare(`
    INSERT INTO ${COMPANY_REVENUE_LEDGER_DEFAULTS_TABLE}
      (company_name, sales_ledger, sales_ledger_guid, purchase_ledger, purchase_ledger_guid, updated_at)
    VALUES (@companyName, @salesLedger, @salesLedgerGuid, @purchaseLedger, @purchaseLedgerGuid, @updatedAt)
    ON CONFLICT(company_name) DO UPDATE SET
      sales_ledger = excluded.sales_ledger,
      sales_ledger_guid = excluded.sales_ledger_guid,
      purchase_ledger = excluded.purchase_ledger,
      purchase_ledger_guid = excluded.purchase_ledger_guid,
      updated_at = excluded.updated_at
  `);
  return {
    getDefaults(companyName) {
      const row = select.get(companyName);
      if (row === undefined) return null;
      return {
        companyName: row.company_name,
        salesLedger: row.sales_ledger ?? null,
        salesLedgerGuid: row.sales_ledger_guid ?? null,
        purchaseLedger: row.purchase_ledger ?? null,
        purchaseLedgerGuid: row.purchase_ledger_guid ?? null,
      };
    },
    setDefaults(defaults) {
      upsert.run({
        companyName: defaults.companyName,
        salesLedger: defaults.salesLedger ?? null,
        salesLedgerGuid: defaults.salesLedgerGuid ?? null,
        purchaseLedger: defaults.purchaseLedger ?? null,
        purchaseLedgerGuid: defaults.purchaseLedgerGuid ?? null,
        updatedAt: new Date().toISOString(),
      });
    },
  };
}
