/**
 * Application-side Sales/Purchase ledger mapping, per stock item.
 *
 * This is deliberately not Tally data: it never reads from or writes to
 * Tally's masters, and it never alters an existing Tally ledger or stock
 * item. It is local configuration answering one question — "which ledger
 * does this stock item's sale or purchase amount get credited/debited to?" —
 * that this project's existing master cache (`tally_masters`) has no field
 * for (see DECISIONS.md #19 and #26).
 *
 * Lookup is by exact stock item name only. There is no fuzzy matching here:
 * fuzzy-matching a *ledger selection* would mean guessing which of two
 * similarly-configured items' tax treatment to apply, which is exactly the
 * kind of guess this project does not make when money is involved.
 */
import { ITEM_LEDGER_MAPPINGS_TABLE } from '../db/schema.js';
export function createItemLedgerMappingStore(db) {
  const select = db.prepare(
    `SELECT stock_item_name, sales_ledger, purchase_ledger FROM ${ITEM_LEDGER_MAPPINGS_TABLE} WHERE stock_item_name = ?`,
  );
  const upsert = db.prepare(`
    INSERT INTO ${ITEM_LEDGER_MAPPINGS_TABLE} (stock_item_name, sales_ledger, purchase_ledger, updated_at)
    VALUES (@stockItemName, @salesLedger, @purchaseLedger, @updatedAt)
    ON CONFLICT(stock_item_name) DO UPDATE SET
      sales_ledger = excluded.sales_ledger,
      purchase_ledger = excluded.purchase_ledger,
      updated_at = excluded.updated_at
  `);
  return {
    getMapping(stockItemName) {
      const row = select.get(stockItemName);
      if (row === undefined) return null;
      return {
        stockItemName: row.stock_item_name,
        salesLedger: row.sales_ledger,
        purchaseLedger: row.purchase_ledger,
      };
    },
    setMapping(mapping) {
      upsert.run({
        stockItemName: mapping.stockItemName,
        salesLedger: mapping.salesLedger,
        purchaseLedger: mapping.purchaseLedger,
        updatedAt: new Date().toISOString(),
      });
    },
  };
}
