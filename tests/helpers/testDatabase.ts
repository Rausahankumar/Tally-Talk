import { openDatabase } from '../../src/db/sqlite.ts';
import type { Database } from '../../src/db/sqlite.ts';
import { silentLogger } from '../../src/logger.ts';

/**
 * A fresh, migrated, in-memory database per test.
 *
 * In-memory rather than a temp file because the append-only triggers make
 * clearing rows between tests impossible by design — each test gets its own.
 */
export function createTestDatabase(): Database {
  return openDatabase(':memory:', silentLogger);
}
