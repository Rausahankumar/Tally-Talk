import { describe, expect, it } from 'vitest';

/**
 * Phase 0 toolchain check.
 *
 * Proves the pieces the rest of the project depends on actually work: vitest
 * discovers and runs the JavaScript test files, and the runtime is a Node
 * version this project supports.
 *
 * This originally also asserted that TypeScript-only syntax (interfaces,
 * generics, `satisfies`) survived the transform. That check retired with the
 * migration to plain JavaScript — there is no transform left to verify.
 */

function totalPaise(lines) {
  return lines.reduce((sum, line) => sum + line.amountPaise, 0);
}

describe('toolchain', () => {
  it('runs JavaScript test files through vitest', () => {
    const lines = [{ amountPaise: 5_000_000 }, { amountPaise: 900_000 }];

    expect(totalPaise(lines)).toBe(5_900_000);
  });

  it('runs on a supported Node major version', () => {
    const major = Number(process.versions.node.split('.')[0]);

    expect(major).toBeGreaterThanOrEqual(20);
  });
});
