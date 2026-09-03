import { describe, expect, it } from 'vitest';

import { DraftValidationError, parseTransactionDraft } from '../src/llm/schema.ts';

const VALID_DRAFT = {
  voucherType: 'sales',
  partyName: 'Ramesh',
  items: [{ itemName: 'cement', quantity: 100, rate: 500 }],
  gstPercent: 18,
  placeOfSupply: null,
  missingFields: [],
  ambiguityNote: null,
};

function problemsFrom(candidate: unknown): readonly string[] {
  try {
    parseTransactionDraft(candidate);
  } catch (error) {
    if (error instanceof DraftValidationError) return error.problems;
    throw error;
  }
  throw new Error('expected parseTransactionDraft to throw');
}

describe('parseTransactionDraft — accepts a well-formed draft', () => {
  it('round-trips a complete draft', () => {
    expect(parseTransactionDraft(VALID_DRAFT)).toEqual(VALID_DRAFT);
  });

  it('accepts null for every nullable field', () => {
    const draft = {
      voucherType: 'unknown',
      partyName: null,
      items: [],
      gstPercent: null,
      placeOfSupply: null,
      missingFields: ['voucherType', 'partyName', 'items', 'gstPercent', 'placeOfSupply'],
      ambiguityNote: null,
    };

    expect(parseTransactionDraft(draft)).toEqual(draft);
  });

  it('accepts a line item with null quantity and rate', () => {
    const draft = {
      ...VALID_DRAFT,
      items: [{ itemName: 'cement', quantity: null, rate: null }],
    };

    expect(parseTransactionDraft(draft).items).toEqual([
      { itemName: 'cement', quantity: null, rate: null },
    ]);
  });

  it('accepts multiple line items', () => {
    const draft = {
      ...VALID_DRAFT,
      items: [
        { itemName: 'cement', quantity: 100, rate: 500 },
        { itemName: 'bricks', quantity: 50, rate: 20 },
      ],
    };

    expect(parseTransactionDraft(draft).items).toHaveLength(2);
  });

  it('accepts an explicitly stated place of supply', () => {
    const draft = { ...VALID_DRAFT, placeOfSupply: 'Uttar Pradesh' };

    expect(parseTransactionDraft(draft).placeOfSupply).toBe('Uttar Pradesh');
  });
});

describe('parseTransactionDraft — rejects malformed drafts', () => {
  it('rejects a non-object', () => {
    expect(problemsFrom('not an object').join('\n')).toContain('must be an object');
    expect(problemsFrom(null).join('\n')).toContain('must be an object');
    expect(problemsFrom([1, 2, 3]).join('\n')).toContain('must be an object');
  });

  it('rejects an invalid voucherType', () => {
    expect(
      problemsFrom({ ...VALID_DRAFT, voucherType: 'refund' }).join('\n'),
    ).toContain('voucherType must be one of');
  });

  it('rejects a non-string, non-null partyName', () => {
    expect(problemsFrom({ ...VALID_DRAFT, partyName: 42 }).join('\n')).toContain('partyName');
  });

  it('rejects items that is not an array', () => {
    expect(problemsFrom({ ...VALID_DRAFT, items: 'cement' }).join('\n')).toContain(
      'items must be an array',
    );
  });

  it('rejects a line item missing itemName', () => {
    expect(
      problemsFrom({ ...VALID_DRAFT, items: [{ quantity: 100, rate: 500 }] }).join('\n'),
    ).toContain('itemName');
  });

  it('rejects a line item with an empty itemName', () => {
    expect(
      problemsFrom({ ...VALID_DRAFT, items: [{ itemName: '  ', quantity: 1, rate: 1 }] }).join(
        '\n',
      ),
    ).toContain('itemName');
  });

  it('rejects a line item with a string quantity', () => {
    expect(
      problemsFrom({
        ...VALID_DRAFT,
        items: [{ itemName: 'cement', quantity: '100', rate: 500 }],
      }).join('\n'),
    ).toContain('quantity');
  });

  it('rejects an unexpected field on a line item', () => {
    expect(
      problemsFrom({
        ...VALID_DRAFT,
        items: [{ itemName: 'cement', quantity: 1, rate: 1, totalAmount: 500 }],
      }).join('\n'),
    ).toContain('unexpected fields');
  });

  it('rejects a non-number, non-null gstPercent', () => {
    expect(problemsFrom({ ...VALID_DRAFT, gstPercent: '18%' }).join('\n')).toContain('gstPercent');
  });

  it('rejects a non-string, non-null placeOfSupply', () => {
    expect(problemsFrom({ ...VALID_DRAFT, placeOfSupply: 42 }).join('\n')).toContain('placeOfSupply');
  });

  it('rejects an empty-string placeOfSupply rather than treating it as unstated', () => {
    expect(problemsFrom({ ...VALID_DRAFT, placeOfSupply: '' }).join('\n')).toContain('placeOfSupply');
  });

  it('rejects a missingFields value outside the fixed vocabulary', () => {
    expect(
      problemsFrom({ ...VALID_DRAFT, missingFields: ['totalAmount'] }).join('\n'),
    ).toContain('unrecognised value');
  });

  it('rejects an unexpected top-level field', () => {
    expect(problemsFrom({ ...VALID_DRAFT, totalAmount: 59000 }).join('\n')).toContain(
      'unexpected top-level fields',
    );
  });

  it('reports every problem in one pass', () => {
    const problems = problemsFrom({
      voucherType: 'invoice',
      partyName: 42,
      items: 'none',
      gstPercent: 'high',
      missingFields: 'all of them',
      ambiguityNote: 7,
    });

    expect(problems.length).toBeGreaterThanOrEqual(5);
  });
});
