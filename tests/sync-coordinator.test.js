import { describe, expect, it } from 'vitest';
import { createSyncCoordinator } from '../src/tally/syncCoordinator.js';
describe('createSyncCoordinator', () => {
  it('runs the sync function and reports success', async () => {
    const coordinator = createSyncCoordinator(async () => 'sync-result');
    const outcome = await coordinator.ensureFreshSync();
    expect(outcome).toEqual({ ok: true, result: 'sync-result' });
  });
  it('never throws — a failing sync is reported as { ok: false }', async () => {
    const coordinator = createSyncCoordinator(async () => {
      throw new Error('Tally unreachable');
    });
    const outcome = await coordinator.ensureFreshSync();
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBeInstanceOf(Error);
    expect(outcome.error.message).toBe('Tally unreachable');
  });
  it('7. concurrent callers share one sync, not one each', async () => {
    let callCount = 0;
    let resolveSync;
    const syncFn = () =>
      new Promise((resolve) => {
        callCount += 1;
        resolveSync = resolve;
      });
    const coordinator = createSyncCoordinator(syncFn);
    // Three "requests" all hit a cache miss at roughly the same time.
    const a = coordinator.ensureFreshSync();
    const b = coordinator.ensureFreshSync();
    const c = coordinator.ensureFreshSync();
    // The sync function itself was only invoked once, even though three
    // callers are all waiting on it.
    expect(callCount).toBe(1);
    resolveSync('shared-result');
    const [outcomeA, outcomeB, outcomeC] = await Promise.all([a, b, c]);
    expect(outcomeA).toEqual({ ok: true, result: 'shared-result' });
    // All three callers got the exact same outcome from the one sync.
    expect(outcomeB).toEqual(outcomeA);
    expect(outcomeC).toEqual(outcomeA);
  });
  it('a new sync starts fresh once the previous one has completed — never coalesces with a finished sync', async () => {
    let callCount = 0;
    const coordinator = createSyncCoordinator(async () => {
      callCount += 1;
      return `sync-${callCount}`;
    });
    const first = await coordinator.ensureFreshSync();
    const second = await coordinator.ensureFreshSync();
    expect(first.result).toBe('sync-1');
    expect(second.result).toBe('sync-2');
    expect(callCount).toBe(2);
  });
  it('a sync that fails does not leave the coordinator permanently stuck — the next call tries again', async () => {
    let attempt = 0;
    const coordinator = createSyncCoordinator(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('first attempt fails');
      return 'second attempt succeeds';
    });
    const first = await coordinator.ensureFreshSync();
    expect(first.ok).toBe(false);
    const second = await coordinator.ensureFreshSync();
    expect(second).toEqual({ ok: true, result: 'second attempt succeeds' });
  });
});
