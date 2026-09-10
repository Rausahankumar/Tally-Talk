import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startupSync } from '../src/tally/startupSync.js';
import { CompanyResolutionError } from '../src/tally/company.js';
import { silentLogger } from '../src/logger.js';
import { createTestDatabase } from './helpers/testDatabase.js';
const CONFIG = { tally: { host: '127.0.0.1', port: 9000 } };
let database;
beforeEach(() => {
  database = createTestDatabase();
});
afterEach(() => {
  database.close();
});
describe('8. startupSync — application startup triggers the master sync', () => {
  it('live sync succeeds -> proceeds with the freshly resolved company', async () => {
    let runSyncCalls = 0;
    const runSync = async (options) => {
      runSyncCalls += 1;
      expect(options.host).toBe('127.0.0.1');
      expect(options.port).toBe(9000);
      return { companyName: 'Acme Ltd', masterResults: [], availabilityResults: [] };
    };
    const resolveCompany = () => ({ name: 'Acme Ltd', state: 'Delhi', guid: null });
    const company = await startupSync(database.db, CONFIG, {
      runSync,
      resolveCompany,
      logger: silentLogger,
    });
    expect(runSyncCalls).toBe(1);
    expect(company).toEqual({ name: 'Acme Ltd', state: 'Delhi', guid: null });
  });
  it('live sync fails, but a company was already cached from an earlier sync -> starts in degraded mode, does not crash', async () => {
    const runSync = async () => {
      throw new Error('Tally unreachable');
    };
    const resolveCompany = () => ({ name: 'Acme Ltd (cached)', state: 'Delhi', guid: null });
    let exitCalled = false;
    const exit = () => {
      exitCalled = true;
    };
    const company = await startupSync(database.db, CONFIG, {
      runSync,
      resolveCompany,
      logger: silentLogger,
      exit,
    });
    expect(exitCalled).toBe(false);
    expect(company).toEqual({ name: 'Acme Ltd (cached)', state: 'Delhi', guid: null });
  });
  it('live sync fails AND nothing has ever been cached -> fails closed, does not silently guess a company', async () => {
    const runSync = async () => {
      throw new Error('Tally unreachable');
    };
    const resolveCompany = () => {
      throw new CompanyResolutionError('no company data was found');
    };
    let exitCode = null;
    const exit = (code) => {
      exitCode = code;
    };
    await startupSync(database.db, CONFIG, { runSync, resolveCompany, logger: silentLogger, exit });
    expect(exitCode).toBe(1);
  });
  it('a non-CompanyResolutionError from the cache fallback is never swallowed', async () => {
    const runSync = async () => {
      throw new Error('Tally unreachable');
    };
    const resolveCompany = () => {
      throw new TypeError('something genuinely unexpected');
    };
    await expect(
      startupSync(database.db, CONFIG, { runSync, resolveCompany, logger: silentLogger, exit: () => {} }),
    ).rejects.toThrow(TypeError);
  });
});
