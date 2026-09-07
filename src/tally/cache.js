/**
 * SQLite-backed store for {@link MasterCache}.
 *
 * A resync replaces every row for one master type in a single transaction, so
 * a reader never sees a half-updated set (some old rows, some new).
 */
import { TALLY_MASTERS_TABLE } from '../db/schema.js';
const DELETE_TYPE_SQL = `DELETE FROM ${TALLY_MASTERS_TABLE} WHERE master_type = ?`;
const INSERT_SQL = `
INSERT INTO ${TALLY_MASTERS_TABLE} (master_type, name, data, synced_at)
VALUES (?, ?, ?, ?)
`;
/** Every cached record of one type, most recently named first. */
export const SELECT_BY_TYPE_SQL = `
SELECT name, data, synced_at FROM ${TALLY_MASTERS_TABLE} WHERE master_type = ? ORDER BY name ASC
`;
export function createTallyMasterCache(deps) {
  const deleteType = deps.db.prepare(DELETE_TYPE_SQL);
  const insert = deps.db.prepare(INSERT_SQL);
  return {
    replaceAll(masterType, records) {
      const now = new Date().toISOString();
      deps.db.exec('BEGIN');
      try {
        deleteType.run(masterType);
        for (const record of records) {
          const name = record.NAME;
          if (!name) continue; // A master with no NAME cannot be looked up later.
          insert.run(masterType, name, JSON.stringify(record), now);
        }
        deps.db.exec('COMMIT');
      } catch (error) {
        deps.db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
/** Read every cached record of one type. Used by the sync CLI to report results. */
export function readCachedMasters(db, masterType) {
  const rows = db.prepare(SELECT_BY_TYPE_SQL).all(masterType);
  return rows.map((row) => ({
    name: row.name,
    data: JSON.parse(row.data),
    syncedAt: new Date(row.synced_at),
  }));
}
