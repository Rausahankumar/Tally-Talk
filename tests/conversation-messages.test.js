import { describe, expect, it } from 'vitest';
import { buildPreviewText } from '../src/conversation/messages.js';
const DRAFT = {
  voucherType: 'sales',
  partyName: 'Balaji Retail Store',
  items: [{ itemName: 'Apple', quantity: 5, rate: 1000, godown: null }],
  gstPercent: 18,
  placeOfSupply: 'Delhi',
  date: null,
  missingFields: [],
  ambiguityNote: null,
};
const VALIDATION = {
  partyMatch: { status: 'exact', matchedName: 'Balaji Retail Store', candidates: [] },
  items: [
    {
      itemName: 'Apple',
      stockItemMatch: { status: 'exact', matchedName: 'Apple', candidates: [] },
      quantityValid: true,
      rateValid: true,
      resolvedRate: 1000,
    },
  ],
};
const READINESS = {
  ready: true,
  placeOfSupply: 'Delhi',
  gstTreatment: { type: 'intrastate', placeOfSupply: 'Delhi', ledgers: [] },
  itemGodowns: [{ itemIndex: 0, godown: 'Main Location' }],
  itemStock: [{ itemIndex: 0, resolvedBatch: '1', availableQuantity: 100, alternativeGodowns: [] }],
  blockers: [],
};
describe('buildPreviewText — shows resolved values, not just what the user stated', () => {
  it('shows the resolved rate even though the draft itself never stated one', () => {
    const draftWithoutRate = {
      ...DRAFT,
      items: [{ itemName: 'Apple', quantity: 5, rate: 1000, godown: null }], // already resolved onto the draft
    };
    const text = buildPreviewText(draftWithoutRate, VALIDATION, READINESS);
    expect(text).toContain('rate ₹1,000');
  });
  it('shows the auto-selected godown and batch', () => {
    const text = buildPreviewText(DRAFT, VALIDATION, READINESS);
    expect(text).toContain('godown Main Location');
    expect(text).toContain('batch 1');
  });
  it('shows the GST treatment and place of supply', () => {
    const text = buildPreviewText(DRAFT, VALIDATION, READINESS);
    expect(text).toContain('GST rate: 18%');
    expect(text).toContain('Intrastate (CGST + SGST) — Place of Supply: Delhi');
  });
  it('shows an explicit date when the draft has one', () => {
    const text = buildPreviewText({ ...DRAFT, date: '2026-09-01' }, VALIDATION, READINESS);
    expect(text).toContain('Date: 2026-09-01');
  });
  it('shows "today" when no date was stated, never a hard-coded date', () => {
    const text = buildPreviewText(DRAFT, VALIDATION, READINESS);
    expect(text).toContain('Date: today');
  });
  it('still renders sensibly with no readiness yet (godown/batch simply omitted)', () => {
    const text = buildPreviewText(DRAFT, VALIDATION, null);
    expect(text).not.toContain('godown');
    expect(text).not.toContain('batch');
    expect(text).toContain('Apple');
  });
  it('shows no stock warning when there are none', () => {
    const text = buildPreviewText(DRAFT, VALIDATION, READINESS);
    expect(text).not.toContain('Stock Warning');
  });
});
describe('buildPreviewText — stock warnings never block, only inform', () => {
  const draftWithOrange = {
    ...DRAFT,
    items: [{ itemName: 'Orange', quantity: 10, rate: 50, godown: null }],
  };
  const validationWithOrange = {
    ...VALIDATION,
    items: [
      {
        itemName: 'Orange',
        stockItemMatch: { status: 'exact', matchedName: 'Orange', candidates: [] },
        quantityValid: true,
        rateValid: true,
      },
    ],
  };
  it('shows an "unavailable/not cached" warning when no stock data exists at all', () => {
    const readinessNoData = {
      ...READINESS,
      itemStock: [{ itemIndex: 0, resolvedBatch: null, availableQuantity: null, alternativeGodowns: [] }],
      stockWarnings: [
        {
          itemIndex: 0,
          itemName: 'Orange',
          requestedQuantity: 10,
          requestedUnit: 'KG',
          availableQuantity: null,
          availableUnit: null,
          reason: 'no_data',
        },
      ],
    };
    const text = buildPreviewText(draftWithOrange, validationWithOrange, readinessNoData);
    expect(text).toContain(
      '⚠️ Stock Warning: Orange — requested 10 KG; available stock: unavailable/not cached. Voucher can still be created.',
    );
  });
  it('shows a shortfall warning when cached stock is insufficient', () => {
    const readinessInsufficient = {
      ...READINESS,
      itemStock: [{ itemIndex: 0, resolvedBatch: '1', availableQuantity: 5, alternativeGodowns: [] }],
      stockWarnings: [
        {
          itemIndex: 0,
          itemName: 'Orange',
          requestedQuantity: 10,
          requestedUnit: 'KG',
          availableQuantity: 5,
          availableUnit: 'KG',
          reason: 'insufficient',
        },
      ],
    };
    const text = buildPreviewText(draftWithOrange, validationWithOrange, readinessInsufficient);
    expect(text).toContain(
      '⚠️ Stock Warning: Orange — requested 10 KG; available stock: 5 KG. Requested quantity exceeds cached stock by 5 KG. Voucher can still be created.',
    );
  });
  it('never omits Confirm/Cancel guidance because of a stock warning', () => {
    const readinessNoData = {
      ...READINESS,
      stockWarnings: [
        {
          itemIndex: 0,
          itemName: 'Orange',
          requestedQuantity: 10,
          requestedUnit: 'KG',
          availableQuantity: null,
          availableUnit: null,
          reason: 'no_data',
        },
      ],
    };
    const text = buildPreviewText(draftWithOrange, validationWithOrange, readinessNoData);
    expect(text).toContain('Tap Confirm to proceed, or Cancel to discard.');
  });
});
describe('buildPreviewText — Place of Supply derived from the party\'s own state', () => {
  it('flags it clearly when Place of Supply came from the party ledger, not the user', () => {
    const readinessPartyDerived = {
      ...READINESS,
      placeOfSupply: 'Goa',
      placeOfSupplySource: 'party',
      gstTreatment: { type: 'interstate', placeOfSupply: 'Goa', ledgers: [] },
    };
    const text = buildPreviewText({ ...DRAFT, placeOfSupply: null }, VALIDATION, readinessPartyDerived);
    expect(text).toContain("Place of Supply was not stated");
    expect(text).toContain("party's own registered state in Tally");
    expect(text).toContain('Goa');
  });
  it('shows no such caveat when Place of Supply was explicitly stated', () => {
    const text = buildPreviewText(DRAFT, VALIDATION, { ...READINESS, placeOfSupplySource: 'explicit' });
    expect(text).not.toContain('registered state in Tally');
  });
  it('shows no such caveat when Place of Supply came from a configured default', () => {
    const text = buildPreviewText(DRAFT, VALIDATION, { ...READINESS, placeOfSupplySource: 'default' });
    expect(text).not.toContain('registered state in Tally');
  });
});
