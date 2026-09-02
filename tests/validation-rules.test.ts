import { describe, expect, it } from 'vitest';

import { VALID_GST_RATES, isValidGstPercent, isValidQuantity, isValidRate } from '../src/validation/rules.ts';

describe('isValidQuantity', () => {
  it('accepts a positive number', () => {
    expect(isValidQuantity(100)).toBe(true);
    expect(isValidQuantity(0.5)).toBe(true);
  });

  it('rejects zero and negative numbers', () => {
    expect(isValidQuantity(0)).toBe(false);
    expect(isValidQuantity(-10)).toBe(false);
  });

  it('rejects non-finite numbers', () => {
    expect(isValidQuantity(Number.NaN)).toBe(false);
    expect(isValidQuantity(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('isValidRate', () => {
  it('accepts a positive number', () => {
    expect(isValidRate(500)).toBe(true);
  });

  it('rejects zero and negative numbers', () => {
    expect(isValidRate(0)).toBe(false);
    expect(isValidRate(-500)).toBe(false);
  });

  it('rejects non-finite numbers', () => {
    expect(isValidRate(Number.NaN)).toBe(false);
  });
});

describe('isValidGstPercent', () => {
  it('accepts every documented Indian GST slab', () => {
    for (const rate of VALID_GST_RATES) {
      expect(isValidGstPercent(rate)).toBe(true);
    }
  });

  it('rejects a rate that is not a recognised slab', () => {
    expect(isValidGstPercent(15)).toBe(false);
    expect(isValidGstPercent(20)).toBe(false);
  });

  it('rejects a negative rate', () => {
    expect(isValidGstPercent(-18)).toBe(false);
  });

  it('rejects a non-finite rate', () => {
    expect(isValidGstPercent(Number.NaN)).toBe(false);
  });
});
