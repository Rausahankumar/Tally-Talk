import { describe, expect, it } from 'vitest';
import {
  applyClarification,
  deriveClarification,
  resolveClarificationReply,
} from '../src/conversation/clarification.js';
function validation(overrides = {}) {
  return {
    isValid: false,
    voucherTypeValid: true,
    partyMatch: null,
    items: [],
    gstPercentValid: true,
    issues: [],
    ...overrides,
  };
}
describe('deriveClarification', () => {
  it('returns null when nothing is ambiguous', () => {
    expect(deriveClarification(validation())).toBeNull();
  });
  it('flags an ambiguous party', () => {
    const result = deriveClarification(
      validation({
        partyMatch: { status: 'ambiguous', matchedName: null, candidates: ['A', 'B'] },
      }),
    );
    expect(result).toEqual({ kind: 'party', candidates: ['A', 'B'] });
  });
  it('flags an ambiguous item when the party is fine', () => {
    const result = deriveClarification(
      validation({
        partyMatch: { status: 'exact', matchedName: 'Ramesh', candidates: [] },
        items: [
          {
            itemName: 'x',
            stockItemMatch: { status: 'exact', matchedName: 'x', candidates: [] },
            quantityValid: true,
            rateValid: true,
          },
          {
            itemName: 'cement',
            stockItemMatch: {
              status: 'ambiguous',
              matchedName: null,
              candidates: ['Cement A', 'Cement B'],
            },
            quantityValid: true,
            rateValid: true,
          },
        ],
      }),
    );
    expect(result).toEqual({ kind: 'item', itemIndex: 1, candidates: ['Cement A', 'Cement B'] });
  });
  it('asks about the party before any item, when both are ambiguous', () => {
    const result = deriveClarification(
      validation({
        partyMatch: { status: 'ambiguous', matchedName: null, candidates: ['A', 'B'] },
        items: [
          {
            itemName: 'cement',
            stockItemMatch: { status: 'ambiguous', matchedName: null, candidates: ['C', 'D'] },
            quantityValid: true,
            rateValid: true,
          },
        ],
      }),
    );
    expect(result?.kind).toBe('party');
  });
});
describe('resolveClarificationReply', () => {
  const pending = { kind: 'party', candidates: ['Ramesh Kumar Enterprises', 'Ramesh Traders'] };
  it('resolves an exact reply', () => {
    expect(resolveClarificationReply(pending, 'Ramesh Traders')).toBe('Ramesh Traders');
  });
  it('resolves a close typo against the candidates', () => {
    expect(resolveClarificationReply(pending, 'Ramesh Traderz')).toBe('Ramesh Traders');
  });
  it('returns null when the reply matches neither candidate', () => {
    expect(resolveClarificationReply(pending, 'Someone else entirely')).toBeNull();
  });
  it('returns null when the reply is still ambiguous between the candidates', () => {
    expect(resolveClarificationReply(pending, 'Ramesh')).toBeNull();
  });
});
describe('applyClarification', () => {
  function draft(overrides = {}) {
    return {
      voucherType: 'sales',
      partyName: 'Ramesh',
      items: [{ itemName: 'cement', quantity: 1, rate: 1, godown: null }],
      gstPercent: 18,
      placeOfSupply: null,
      missingFields: [],
      ambiguityNote: null,
      ...overrides,
    };
  }
  it('resolves the party field', () => {
    const result = applyClarification(
      draft(),
      { kind: 'party', candidates: [] },
      'Ramesh Kumar Enterprises',
    );
    expect(result.partyName).toBe('Ramesh Kumar Enterprises');
  });
  it('resolves only the targeted item, leaving others untouched', () => {
    const result = applyClarification(
      draft({
        items: [
          { itemName: 'cement', quantity: 1, rate: 1, godown: null },
          { itemName: 'steel', quantity: 2, rate: 2, godown: null },
        ],
      }),
      { kind: 'item', itemIndex: 1, candidates: [] },
      'Steel Rods',
    );
    expect(result.items[0]?.itemName).toBe('cement');
    expect(result.items[1]?.itemName).toBe('Steel Rods');
  });
  it('resolves the godown on only the targeted item, leaving others untouched', () => {
    const result = applyClarification(
      draft({
        items: [
          { itemName: 'cement', quantity: 1, rate: 1, godown: null },
          { itemName: 'steel', quantity: 2, rate: 2, godown: null },
        ],
      }),
      { kind: 'godown', itemIndex: 1, candidates: ['Main Location', 'Warehouse B'] },
      'Warehouse B',
    );
    expect(result.items[0]?.godown).toBeNull();
    expect(result.items[1]?.godown).toBe('Warehouse B');
    expect(result.items[1]?.itemName).toBe('steel'); // untouched
  });
});
