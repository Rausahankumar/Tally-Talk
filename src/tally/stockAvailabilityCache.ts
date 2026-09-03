/**
 * SQLite-backed implementation of {@link StockAvailabilityStore}.
 *
 * A resync replaces every cached row for one stock item in a single
 * transaction — the same replace-per-key pattern as the Tally master cache
 * (`cache.ts`), so a reader never sees a half-updated set for that item.
 */

import type { DatabaseSync, StatementSync } from 'node:sqlite';

import { STOCK_AVAILABILITY_TABLE } from '../db/schema.ts';
import type { GodownAvailability, StockAvailabilityRow, StockAvailabilityStore } from './stockAvailability.ts';

export interface StockAvailabilityCacheDeps {
  readonly db: DatabaseSync;
}

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

interface AvailabilityRowDb {
  readonly batch_name: string;
  readonly godown_name: string;
  readonly quantity: number;
  readonly unit: string;
}

interface AlternativeGodownRowDb {
  readonly godown_name: string;
  readonly total_quantity: number;
}

export function createStockAvailabilityCache(deps: StockAvailabilityCacheDeps): StockAvailabilityStore {
  const deleteItem: StatementSync = deps.db.prepare(DELETE_ITEM_SQL);
  const insert: StatementSync = deps.db.prepare(INSERT_SQL);
  const selectAvailability: StatementSync = deps.db.prepare(SELECT_AVAILABILITY_SQL);
  const selectAlternativeGodowns: StatementSync = deps.db.prepare(SELECT_ALTERNATIVE_GODOWNS_SQL);

  return {
    getAvailability(stockItemName: string, godownName: string): readonly StockAvailabilityRow[] {
      const rows = selectAvailability.all(stockItemName, godownName) as unknown as AvailabilityRowDb[];
      return rows.map((row) => ({
        batchName: row.batch_name,
        godownName: row.godown_name,
        quantity: row.quantity,
        unit: row.unit,
      }));
    },

    getGodownsWithSufficientStock(
      stockItemName: string,
      requiredQuantity: number,
      excludeGodown: string,
    ): readonly GodownAvailability[] {
      const rows = selectAlternativeGodowns.all(
        stockItemName,
        excludeGodown,
        requiredQuantity,
      ) as unknown as AlternativeGodownRowDb[];
      return rows.map((row) => ({ godown: row.godown_name, availableQuantity: row.total_quantity }));
    },

    replaceAllForItem(stockItemName: string, rows: readonly StockAvailabilityRow[]): void {
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
