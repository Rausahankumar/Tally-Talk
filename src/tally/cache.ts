/**
 * SQLite-backed store for {@link MasterCache}.
 *
 * A resync replaces every row for one master type in a single transaction, so
 * a reader never sees a half-updated set (some old rows, some new).
 */

import type { DatabaseSync, StatementSync } from 'node:sqlite';

import { TALLY_MASTERS_TABLE } from '../db/schema.ts';
import type { MasterCache } from './masters.ts';
import type { RawMasterRecord } from './xml.ts';

export interface TallyMasterCacheDeps {
  readonly db: DatabaseSync;
}

const DELETE_TYPE_SQL = `DELETE FROM ${TALLY_MASTERS_TABLE} WHERE master_type = ?`;
const INSERT_SQL = `
INSERT INTO ${TALLY_MASTERS_TABLE} (master_type, name, data, synced_at)
VALUES (?, ?, ?, ?)
`;
/** Every cached record of one type, most recently named first. */
export const SELECT_BY_TYPE_SQL = `
SELECT name, data, synced_at FROM ${TALLY_MASTERS_TABLE} WHERE master_type = ? ORDER BY name ASC
`;

export function createTallyMasterCache(deps: TallyMasterCacheDeps): MasterCache {
  const deleteType: StatementSync = deps.db.prepare(DELETE_TYPE_SQL);
  const insert: StatementSync = deps.db.prepare(INSERT_SQL);

  return {
    replaceAll(masterType: string, records: readonly RawMasterRecord[]): void {
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

export interface CachedMasterRow {
  readonly name: string;
  readonly data: Readonly<Record<string, string>>;
  readonly syncedAt: Date;
}

/** Read every cached record of one type. Used by the sync CLI to report results. */
export function readCachedMasters(db: DatabaseSync, masterType: string): CachedMasterRow[] {
  const rows = db.prepare(SELECT_BY_TYPE_SQL).all(masterType) as unknown as {
    name: string;
    data: string;
    synced_at: string;
  }[];

  return rows.map((row) => ({
    name: row.name,
    data: JSON.parse(row.data) as Record<string, string>,
    syncedAt: new Date(row.synced_at),
  }));
}
