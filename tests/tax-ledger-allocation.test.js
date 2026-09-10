import { describe, expect, it } from 'vitest';
import { buildTaxLedgerAllocationsByRateBucket } from '../src/tally/taxLedgerAllocation.js';
const INTERSTATE = { ledgers: [{ ledgerName: 'IGST', share: 1 }] };
const INTRASTATE = {
  ledgers: [
    { ledgerName: 'CGST', share: 0.5 },
    { ledgerName: 'SGST', share: 0.5 },
  ],
};
describe('buildTaxLedgerAllocationsByRateBucket', () => {
  it('1. a single item produces the same result as the original single-rate blended calculation', () => {
    const lineItems = [{ amount: 5000, gstPercent: 18 }];
    const allocations = buildTaxLedgerAllocationsByRateBucket(lineItems, INTERSTATE);
    expect(allocations).toEqual([{ ledgerName: 'IGST', amount: 900, ratePercent: 18 }]);
  });
  it('2. two items sharing the same GST rate produce one bucket, matching the original blended amount', () => {
    const lineItems = [
      { amount: 5000, gstPercent: 18 },
      { amount: 1000, gstPercent: 18 },
    ];
    const allocations = buildTaxLedgerAllocationsByRateBucket(lineItems, INTERSTATE);
    // (5000 + 1000) * 18% = 1080 — one entry, not two.
    expect(allocations).toEqual([{ ledgerName: 'IGST', amount: 1080, ratePercent: 18 }]);
  });
  it('3. two items with different GST rates, interstate — the real Orange 18% / Shampoo 5% example', () => {
    const lineItems = [
      { amount: 5000, gstPercent: 18 }, // Orange
      { amount: 625, gstPercent: 5 }, // Anti-Dandruff Shampoos
    ];
    const allocations = buildTaxLedgerAllocationsByRateBucket(lineItems, INTERSTATE);
    expect(allocations).toEqual([
      { ledgerName: 'IGST', amount: 31.25, ratePercent: 5 },
      { ledgerName: 'IGST', amount: 900, ratePercent: 18 },
    ]);
  });
  it('4. two items with different GST rates, intrastate — separate CGST/SGST per rate bucket', () => {
    const lineItems = [
      { amount: 5000, gstPercent: 18 },
      { amount: 625, gstPercent: 5 },
    ];
    const allocations = buildTaxLedgerAllocationsByRateBucket(lineItems, INTRASTATE);
    expect(allocations).toEqual([
      { ledgerName: 'CGST', amount: 15.63, ratePercent: 5 },
      { ledgerName: 'SGST', amount: 15.63, ratePercent: 5 },
      { ledgerName: 'CGST', amount: 450, ratePercent: 18 },
      { ledgerName: 'SGST', amount: 450, ratePercent: 18 },
    ]);
  });
  it('9. rounding: a bucket whose split is not an exact number of paise still rounds each allocation independently', () => {
    // 625 * 5% = 31.25 exactly; 31.25 * 0.5 = 15.625, which rounds to 15.63 —
    // an existing, unchanged characteristic of the same roundMoney approach
    // the original single-rate calculation already used (JS Math.round
    // rounds .5 away from zero). Documented here, not "fixed": this module
    // must not invent new rounding precision beyond what already existed.
    const lineItems = [{ amount: 625, gstPercent: 5 }];
    const allocations = buildTaxLedgerAllocationsByRateBucket(lineItems, INTRASTATE);
    expect(allocations).toEqual([
      { ledgerName: 'CGST', amount: 15.63, ratePercent: 5 },
      { ledgerName: 'SGST', amount: 15.63, ratePercent: 5 },
    ]);
  });
  it('sorts buckets by rate ascending regardless of item order in the draft', () => {
    const lineItems = [
      { amount: 625, gstPercent: 5 },
      { amount: 5000, gstPercent: 18 },
    ];
    const allocations = buildTaxLedgerAllocationsByRateBucket(lineItems, INTERSTATE);
    expect(allocations.map((a) => a.ratePercent)).toEqual([5, 18]);
  });
  it('a zero-rated (0%) bucket still produces a real, explicit zero-amount entry rather than being dropped', () => {
    const lineItems = [{ amount: 1000, gstPercent: 0 }];
    const allocations = buildTaxLedgerAllocationsByRateBucket(lineItems, INTERSTATE);
    expect(allocations).toEqual([{ ledgerName: 'IGST', amount: 0, ratePercent: 0 }]);
  });
  it('three distinct rates produce three independent buckets', () => {
    const lineItems = [
      { amount: 1000, gstPercent: 12 },
      { amount: 2000, gstPercent: 28 },
      { amount: 625, gstPercent: 5 },
    ];
    const allocations = buildTaxLedgerAllocationsByRateBucket(lineItems, INTERSTATE);
    expect(allocations).toEqual([
      { ledgerName: 'IGST', amount: 31.25, ratePercent: 5 },
      { ledgerName: 'IGST', amount: 120, ratePercent: 12 },
      { ledgerName: 'IGST', amount: 560, ratePercent: 28 },
    ]);
  });
});
