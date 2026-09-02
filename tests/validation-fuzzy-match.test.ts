import { describe, expect, it } from 'vitest';

import { matchName } from '../src/validation/fuzzyMatch.ts';

describe('matchName - exact matches', () => {
  it('matches exactly, ignoring case and surrounding whitespace', () => {
    const result = matchName('  suresh & sons  ', ['Ramesh Kumar Enterprises', 'Suresh & Sons']);

    expect(result).toEqual({ status: 'exact', matchedName: 'Suresh & Sons', candidates: [] });
  });

  it('treats two candidates that normalise to the same name as ambiguous, not a pick', () => {
    const result = matchName('abc', ['ABC', 'abc ']);

    expect(result.status).toBe('ambiguous');
  });
});

describe('matchName - fuzzy matches', () => {
  it('matches a short extracted name against the substring of a longer real Tally name', () => {
    const result = matchName('cement', ['ACC Cement OPC 43 Grade', 'Steel Rods']);

    expect(result).toEqual({
      status: 'fuzzy',
      matchedName: 'ACC Cement OPC 43 Grade',
      candidates: [],
    });
  });

  it('matches a single-character typo against a full name', () => {
    const result = matchName('Balaji Retial Store', ['Balaji Retail Store', 'Suresh & Sons']);

    expect(result).toEqual({ status: 'fuzzy', matchedName: 'Balaji Retail Store', candidates: [] });
  });

  it('only runs fuzzy matching when no exact match exists', () => {
    const result = matchName('Ramesh', ['Ramesh', 'Ramesh Kumar Enterprises']);

    expect(result).toEqual({ status: 'exact', matchedName: 'Ramesh', candidates: [] });
  });
});

describe('matchName - ambiguous matches', () => {
  it('returns ambiguous when two candidates are both plausible and close in score', () => {
    const result = matchName('Ramesh', ['Ramesh Kumar Enterprises', 'Ramesh Traders', 'Suresh & Sons']);

    expect(result.status).toBe('ambiguous');
    expect(result.matchedName).toBeNull();
    expect(result.candidates).toEqual(
      expect.arrayContaining(['Ramesh Kumar Enterprises', 'Ramesh Traders']),
    );
    expect(result.candidates).not.toContain('Suresh & Sons');
  });

  it('does not guess between two equally good substring matches', () => {
    const result = matchName('cement', ['ACC Cement OPC 43 Grade', 'Cement Bags']);

    expect(result.status).toBe('ambiguous');
  });

  it('caps ambiguous candidates rather than returning every plausible name', () => {
    const manySimilar = Array.from({ length: 10 }, (_, i) => `Cement Supplier ${i}`);
    const result = matchName('Cement', manySimilar);

    expect(result.status).toBe('ambiguous');
    expect(result.candidates.length).toBeLessThanOrEqual(5);
  });

  it('picks the clear winner instead of forcing ambiguity when one fuzzy match is much better', () => {
    // Both candidates clear the fuzzy threshold, but "Steel Rods" is close enough
    // to win outright rather than being lumped into an ambiguous result with
    // the much less similar "Steel Sheets".
    const result = matchName('Steel Rod', ['Steel Rods', 'Steel Sheets']);

    expect(result).toEqual({ status: 'fuzzy', matchedName: 'Steel Rods', candidates: [] });
  });
});

describe('matchName - not found', () => {
  it('returns not_found when nothing is plausibly close', () => {
    const result = matchName('Xylophone Traders', ['Ramesh Kumar Enterprises', 'Suresh & Sons']);

    expect(result).toEqual({ status: 'not_found', matchedName: null, candidates: [] });
  });

  it('returns not_found against an empty candidate list', () => {
    expect(matchName('anything', [])).toEqual({
      status: 'not_found',
      matchedName: null,
      candidates: [],
    });
  });
});
