import { describe, expect, it } from 'vitest';
import { mergeDraft } from '../src/conversation/merge.js';
function draft(overrides = {}) {
  return {
    voucherType: 'unknown',
    partyName: null,
    items: [],
    gstPercent: null,
    placeOfSupply: null,
    date: null,
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
    const items = [{ itemName: 'Cement', quantity: 10, rate: 50, godown: null }];
    const existing = draft({ items });
    const incoming = draft({ items: [] });
    expect(mergeDraft(existing, incoming).items).toEqual(items);
  });
  it('replaces items entirely when the new message restates them', () => {
    const existing = draft({
      items: [{ itemName: 'Cement', quantity: 10, rate: 50, godown: null }],
    });
    const incoming = draft({
      items: [{ itemName: 'Steel Rods', quantity: 5, rate: 100, godown: null }],
    });
    expect(mergeDraft(existing, incoming).items).toEqual([
      { itemName: 'Steel Rods', quantity: 5, rate: 100, godown: null },
    ]);
  });
  it('keeps an existing date when a follow-up message states none — regression: an intervening unrelated message must not erase a previously stated date', () => {
    const existing = draft({ date: '2026-06-01' });
    const incoming = draft();
    expect(mergeDraft(existing, incoming).date).toBe('2026-06-01');
  });
  it('overrides the date when the new extraction states one', () => {
    const existing = draft({ date: '2026-06-01' });
    const incoming = draft({ date: '2026-09-01' });
    expect(mergeDraft(existing, incoming).date).toBe('2026-09-01');
  });
  it('carries a first-stated date through a merge with a draft that never had one', () => {
    const existing = draft(); // e.g. an earlier message the LLM could not parse at all
    const incoming = draft({ date: '2026-09-01' });
    expect(mergeDraft(existing, incoming).date).toBe('2026-09-01');
  });
  it('regression: a follow-up stating only rate/GST for the same item does not wipe out its already-known quantity', () => {
    // Reproduces a real reported loop: "Sell 5 Apple to Balaji" (qty known,
    // rate/GST missing) followed by "Rate is 1000 each apple and gst rate is
    // 18%" (the LLM correctly names the item but has no memory of the
    // quantity, so it reports quantity: null) — the merge must fill in the
    // rate without losing the quantity already on file.
    const existing = draft({
      items: [{ itemName: 'Apple', quantity: 5, rate: null, godown: null }],
    });
    const incoming = draft({
      items: [{ itemName: 'apple', quantity: null, rate: 1000, godown: null }],
    });
    expect(mergeDraft(existing, incoming).items).toEqual([
      { itemName: 'apple', quantity: 5, rate: 1000, godown: null },
    ]);
  });
  it('regression: a bare quantity follow-up for the same item does not wipe out its already-known rate', () => {
    const existing = draft({
      items: [{ itemName: 'apple', quantity: null, rate: 1000, godown: null }],
    });
    const incoming = draft({
      items: [{ itemName: 'apple', quantity: 5, rate: null, godown: null }],
    });
    expect(mergeDraft(existing, incoming).items).toEqual([
      { itemName: 'apple', quantity: 5, rate: 1000, godown: null },
    ]);
  });
  it('a fully restated single item still fully replaces, since every field it states wins anyway', () => {
    const existing = draft({
      items: [{ itemName: 'Apple', quantity: 5, rate: 1000, godown: 'Main Location' }],
    });
    const incoming = draft({
      items: [{ itemName: 'Apple', quantity: 10, rate: 900, godown: 'Warehouse B' }],
    });
    expect(mergeDraft(existing, incoming).items).toEqual([
      { itemName: 'Apple', quantity: 10, rate: 900, godown: 'Warehouse B' },
    ]);
  });
  it('replaces items entirely when the item counts differ, since that is a real change in what is being transacted', () => {
    const existing = draft({
      items: [{ itemName: 'Apple', quantity: 5, rate: 1000, godown: null }],
    });
    const incoming = draft({
      items: [
        { itemName: 'Apple', quantity: 5, rate: 1000, godown: null },
        { itemName: 'Banana', quantity: 2, rate: 40, godown: null },
      ],
    });
    expect(mergeDraft(existing, incoming).items).toHaveLength(2);
  });
  it('always takes the latest missingFields and ambiguityNote from the new extraction', () => {
    const existing = draft({ missingFields: ['gstPercent'], ambiguityNote: 'old note' });
    const incoming = draft({ missingFields: [], ambiguityNote: null });
    const merged = mergeDraft(existing, incoming);
    expect(merged.missingFields).toEqual([]);
    expect(merged.ambiguityNote).toBeNull();
  });
});
