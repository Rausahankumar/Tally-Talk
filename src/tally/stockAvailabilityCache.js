/**
 * SQLite-backed implementation of {@link StockAvailabilityStore}.
 *
 * A resync replaces every cached row for one stock item in a single
 * transaction — the same replace-per-key pattern as the Tally master cache
 * (`cache.js`), so a reader never sees a half-updated set for that item.
 */
import { STOCK_AVAILABILITY_TABLE } from '../db/schema.js';
const DELETE_ITEM_SQL = `DELETE FROM ${STOCK_AVAILABILITY_TABLE} WHERE stock_item_name = ?`;
const INSERT_SQL = `
INSERT INTO ${STOCK_AVAILABILITY_TABLE} (stock_item_name, batch_name, godown_name, quantity, unit, synced_at)
VALUES (?, ?, ?, ?, ?, ?)
`;
const SELECT_AVAILABILITY_SQL = `
SELECT batch_name, godown_name, quantity, unit
FROM ${STOCK_AVAILABILITY_TABLE}
WHERE stock_item_name = ? AND godown_name = ?
ORDER BY batch_name ASC
`;
const SELECT_ALTERNATIVE_GODOWNS_SQL = `
SELECT godown_name, SUM(quantity) AS total_quantity
FROM ${STOCK_AVAILABILITY_TABLE}
WHERE stock_item_name = ? AND godown_name != ?
GROUP BY godown_name
HAVING SUM(quantity) >= ?
ORDER BY godown_name ASC
`;
const SELECT_ALL_GODOWNS_WITH_RECORDED_STOCK_SQL = `
SELECT godown_name, SUM(quantity) AS total_quantity
FROM ${STOCK_AVAILABILITY_TABLE}
WHERE stock_item_name = ?
GROUP BY godown_name
ORDER BY godown_name ASC
`;
export function createStockAvailabilityCache(deps) {
  const deleteItem = deps.db.prepare(DELETE_ITEM_SQL);
  const insert = deps.db.prepare(INSERT_SQL);
  const selectAvailability = deps.db.prepare(SELECT_AVAILABILITY_SQL);
  const selectAlternativeGodowns = deps.db.prepare(SELECT_ALTERNATIVE_GODOWNS_SQL);
  const selectAllGodownsWithRecordedStock = deps.db.prepare(SELECT_ALL_GODOWNS_WITH_RECORDED_STOCK_SQL);
  return {
    getAvailability(stockItemName, godownName) {
      const rows = selectAvailability.all(stockItemName, godownName);
      return rows.map((row) => ({
        batchName: row.batch_name,
        godownName: row.godown_name,
        quantity: row.quantity,
        unit: row.unit,
      }));
    },
    getGodownsWithSufficientStock(stockItemName, requiredQuantity, excludeGodown) {
      const rows = selectAlternativeGodowns.all(stockItemName, excludeGodown, requiredQuantity);
      return rows.map((row) => ({
        godown: row.godown_name,
        availableQuantity: row.total_quantity,
      }));
    },
    /**
     * Every godown (no exclusion) that has *any* recorded stock for this item
     * — regardless of quantity, including zero or negative — used to
     * auto-select a godown when the user did not state one and none is
     * configured as the default (`postingReadiness.js`). Deliberately not
     * filtered by requested quantity: whether the recorded amount is enough
     * is a separate, non-blocking warning (see `postingReadiness.js`'s
     * `stockWarnings`), never a reason to exclude a godown from being
     * selectable here. Never guesses: the caller auto-selects only when
     * exactly one row comes back; a stock item with no recorded row in any
     * godown returns nothing, same as before.
     */
    getAllGodownsWithRecordedStock(stockItemName) {
      const rows = selectAllGodownsWithRecordedStock.all(stockItemName);
      return rows.map((row) => ({
        godown: row.godown_name,
        availableQuantity: row.total_quantity,
      }));
    },
    replaceAllForItem(stockItemName, rows) {
      const now = new Date().toISOString();
      deps.db.exec('BEGIN');
      try {
        deleteItem.run(stockItemName);
        for (const row of rows) {
          insert.run(stockItemName, row.batchName, row.godownName, row.quantity, row.unit, now);
        }
        deps.db.exec('COMMIT');
      } catch (error) {
        deps.db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
