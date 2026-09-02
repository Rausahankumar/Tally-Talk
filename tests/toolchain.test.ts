import { describe, expect, it } from 'vitest';

/**
 * Phase 0 toolchain check.
 *
 * Proves the pieces the rest of the project depends on actually work:
 * vitest discovers and runs tests, and TypeScript-only syntax (types,
 * generics, satisfies) survives the transform rather than being a
 * compile-time-only illusion.
 */

interface Money {
  readonly amountPaise: number;
}

function totalPaise<T extends Money>(lines: readonly T[]): number {
  return lines.reduce((sum, line) => sum + line.amountPaise, 0);
}

describe('toolchain', () => {
  it('runs TypeScript test files through vitest', () => {
    const lines = [{ amountPaise: 5_000_000 }, { amountPaise: 900_000 }] satisfies Money[];

    expect(totalPaise(lines)).toBe(5_900_000);
  });

  it('runs on a supported Node major version', () => {
    const major = Number(process.versions.node.split('.')[0]);

    expect(major).toBeGreaterThanOrEqual(20);
  });
});
