import { openDatabase } from '../../src/db/sqlite.js';
import { silentLogger } from '../../src/logger.js';
/**
 * A fresh, migrated, in-memory database per test.
 *
 * In-memory rather than a temp file because the append-only triggers make
 * clearing rows between tests impossible by design — each test gets its own.
 */
export function createTestDatabase() {
  return openDatabase(':memory:', silentLogger);
}
