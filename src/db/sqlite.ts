/**
 * SQLite connection.
 *
 * Uses Node's built-in `node:sqlite`, so there is no native addon to compile or
 * prebuild on the deployment machine (DECISIONS.md #11).
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { Logger } from '../logger.ts';
import { migrate } from './schema.ts';

export interface Database {
  readonly db: DatabaseSync;
  close(): void;
}

/** In-memory databases have no directory to create. */
function isFileDatabase(path: string): boolean {
  return path !== ':memory:' && !path.startsWith('file:');
}

/**
 * Open the database, apply pragmas and run migrations.
 *
 * The parent directory is created if missing so a fresh deployment works from
 * an unpacked checkout without a manual setup step.
 */
export function openDatabase(path: string, logger: Logger): Database {
  if (isFileDatabase(path)) {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new DatabaseSync(path);

  // Write-ahead logging: readers do not block the writer, and a crash cannot
  // leave a torn transaction.
  db.exec('PRAGMA journal_mode = WAL');
  // Wait rather than failing immediately if another connection holds the lock.
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');

  migrate(db, logger);

  return {
    db,
    close: () => db.close(),
  };
}
