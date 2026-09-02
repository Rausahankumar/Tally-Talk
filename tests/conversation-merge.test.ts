import { describe, expect, it } from 'vitest';

import { mergeDraft } from '../src/conversation/merge.ts';
import type { TransactionDraft } from '../src/llm/schema.ts';

function draft(overrides: Partial<TransactionDraft> = {}): TransactionDraft {
  return {
    voucherType: 'unknown',
    partyName: null,
    items: [],
    gstPercent: null,
    missingFields: [],
    ambiguityNote: null,
    ...overrides,
  };
}

describe('mergeDraft', () => {
  it('keeps an existing field when the new extraction leaves it blank', () => {
    const existing = draft({ partyName: 'Ramesh', gstPercent: 18 });
    const incoming = draft();

    expect(mergeDraft(existing, incoming).partyName).toBe('Ramesh');
    expect(mergeDraft(existing, incoming).gstPercent).toBe(18);
  });

  it('overrides an existing field when the new extraction states one', () => {
    const existing = draft({ partyName: 'Ramesh' });
    const incoming = draft({ partyName: 'Suresh' });

    expect(mergeDraft(existing, incoming).partyName).toBe('Suresh');
  });

  it('keeps voucherType when the new extraction could not determine it', () => {
    const existing = draft({ voucherType: 'sales' });
    const incoming = draft({ voucherType: 'unknown' });

    expect(mergeDraft(existing, incoming).voucherType).toBe('sales');
  });

  it('overrides voucherType when the new extraction has an opinion', () => {
    const existing = draft({ voucherType: 'sales' });
    const incoming = draft({ voucherType: 'purchase' });

    expect(mergeDraft(existing, incoming).voucherType).toBe('purchase');
  });

  it('keeps existing items when the new message mentions none', () => {
    const items = [{ itemName: 'Cement', quantity: 10, rate: 50 }];
    const existing = draft({ items });
    const incoming = draft({ items: [] });

    expect(mergeDraft(existing, incoming).items).toEqual(items);
  });

  it('replaces items entirely when the new message restates them', () => {
    const existing = draft({ items: [{ itemName: 'Cement', quantity: 10, rate: 50 }] });
    const incoming = draft({ items: [{ itemName: 'Steel Rods', quantity: 5, rate: 100 }] });

    expect(mergeDraft(existing, incoming).items).toEqual([
      { itemName: 'Steel Rods', quantity: 5, rate: 100 },
    ]);
  });

  it('always takes the latest missingFields and ambiguityNote from the new extraction', () => {
    const existing = draft({ missingFields: ['gstPercent'], ambiguityNote: 'old note' });
    const incoming = draft({ missingFields: [], ambiguityNote: null });

    const merged = mergeDraft(existing, incoming);
    expect(merged.missingFields).toEqual([]);
    expect(merged.ambiguityNote).toBeNull();
  });
});
