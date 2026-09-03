import { describe, expect, it } from 'vitest';

import { buildSalesVoucherXml, parseImportResponse } from '../src/tally/postingXml.ts';
import type { SalesVoucherInput } from '../src/tally/postingXml.ts';

function voucherInput(overrides: Partial<SalesVoucherInput> = {}): SalesVoucherInput {
  return {
    date: new Date('2026-09-02T00:00:00Z'),
    companyName: 'Nirmal FMCG Traders Ltd',
    partyLedgerName: 'Suresh & Sons',
    items: [
      {
        stockItemName: 'Steel Rods',
        quantity: 100,
        unit: 'Kg',
        rate: 500,
        amount: 50000,
        ledgerAllocation: { ledgerName: 'Sales', amount: 50000 },
        godown: 'Main Location',
      },
    ],
    taxLedgerAllocations: [
      { ledgerName: 'CGST', amount: 4500 },
      { ledgerName: 'SGST', amount: 4500 },
    ],
    ...overrides,
  };
}

/** Sum of every top-level LEDGERENTRIES amount plus every item's own accounting allocation. */
function doubleEntryBalance(xml: string): number {
  const ledgerBlocks = [...xml.matchAll(/<LEDGERENTRIES\.LIST>([\s\S]*?)<\/LEDGERENTRIES\.LIST>/g)];
  const allocationBlocks = [
    ...xml.matchAll(/<ACCOUNTINGALLOCATIONS\.LIST>([\s\S]*?)<\/ACCOUNTINGALLOCATIONS\.LIST>/g),
  ];
  const amountOf = (block: string): number => Number(/<AMOUNT>([-\d.]+)<\/AMOUNT>/.exec(block)![1]);

  return (
    ledgerBlocks.reduce((sum, m) => sum + amountOf(m[1]!), 0) +
    allocationBlocks.reduce((sum, m) => sum + amountOf(m[1]!), 0)
  );
}

describe('buildSalesVoucherXml', () => {
  it('produces a voucher that balances to zero across ledger entries and allocations', () => {
    const xml = buildSalesVoucherXml(voucherInput());

    expect(doubleEntryBalance(xml)).toBeCloseTo(0, 8);
  });

  it('makes the party ledger entry negative with ISDEEMEDPOSITIVE Yes', () => {
    const xml = buildSalesVoucherXml(voucherInput());
    const match = /<LEDGERNAME>Suresh &amp; Sons<\/LEDGERNAME>\s*<ISDEEMEDPOSITIVE>(\w+)<\/ISDEEMEDPOSITIVE>\s*<AMOUNT>([-\d.]+)<\/AMOUNT>/.exec(
      xml,
    );

    expect(match?.[1]).toBe('Yes');
    expect(Number(match?.[2])).toBeLessThan(0);
  });

  it('makes every tax and sales ledger entry positive with ISDEEMEDPOSITIVE No', () => {
    const xml = buildSalesVoucherXml(voucherInput());

    for (const name of ['CGST', 'SGST', 'Sales']) {
      const match = new RegExp(
        `<LEDGERNAME>${name}</LEDGERNAME>\\s*<ISDEEMEDPOSITIVE>(\\w+)</ISDEEMEDPOSITIVE>\\s*<AMOUNT>([-\\d.]+)</AMOUNT>`,
      ).exec(xml);
      expect(match?.[1]).toBe('No');
      expect(Number(match?.[2])).toBeGreaterThan(0);
    }
  });

  it('formats the date as YYYYMMDD', () => {
    const xml = buildSalesVoucherXml(voucherInput({ date: new Date('2026-01-05T00:00:00Z') }));

    expect(xml).toContain('<DATE>20260105</DATE>');
  });

  it('formats rate as "value/unit" and quantity as "value unit"', () => {
    const xml = buildSalesVoucherXml(voucherInput());

    expect(xml).toContain('<RATE>500.00/Kg</RATE>');
    expect(xml).toContain('<ACTUALQTY>100 Kg</ACTUALQTY>');
    expect(xml).toContain('<BILLEDQTY>100 Kg</BILLEDQTY>');
  });

  it('escapes XML special characters in every name field', () => {
    const xml = buildSalesVoucherXml(
      voucherInput({
        partyLedgerName: 'A & B "Traders" <Ltd>',
        companyName: 'Co & Co',
      }),
    );

    expect(xml).toContain('A &amp; B &quot;Traders&quot; &lt;Ltd&gt;');
    expect(xml).toContain('Co &amp; Co');
    expect(xml).not.toContain('<Ltd>');
  });

  it('includes one inventory block per line item, in order', () => {
    const xml = buildSalesVoucherXml(
      voucherInput({
        items: [
          { stockItemName: 'Cement', quantity: 1, unit: 'Bags', rate: 100, amount: 100, ledgerAllocation: { ledgerName: 'Sales', amount: 100 }, godown: 'Main Location' },
          { stockItemName: 'Bricks', quantity: 2, unit: 'Nos', rate: 50, amount: 100, ledgerAllocation: { ledgerName: 'Sales', amount: 100 }, godown: 'Warehouse B' },
        ],
        taxLedgerAllocations: [],
      }),
    );

    const cementIndex = xml.indexOf('Cement');
    const bricksIndex = xml.indexOf('Bricks');
    expect(cementIndex).toBeGreaterThan(-1);
    expect(bricksIndex).toBeGreaterThan(cementIndex);
    expect(xml.match(/<ALLINVENTORYENTRIES\.LIST>/g)).toHaveLength(2);
  });

  it('omits NARRATION when none is given, and includes it when given', () => {
    expect(buildSalesVoucherXml(voucherInput())).not.toContain('<NARRATION>');
    expect(buildSalesVoucherXml(voucherInput({ narration: 'Test note' }))).toContain(
      '<NARRATION>Test note</NARRATION>',
    );
  });

  it('is deterministic: identical input produces identical output', () => {
    const input = voucherInput();
    expect(buildSalesVoucherXml(input)).toBe(buildSalesVoucherXml(input));
  });

  describe('godown placement (confirmed against a real captured voucher)', () => {
    it('places GODOWNNAME inside BATCHALLOCATIONS.LIST, nested inside ALLINVENTORYENTRIES.LIST', () => {
      const xml = buildSalesVoucherXml(voucherInput());

      const inventoryBlock = /<ALLINVENTORYENTRIES\.LIST>([\s\S]*?)<\/ALLINVENTORYENTRIES\.LIST>/.exec(xml)?.[1];
      expect(inventoryBlock).toBeDefined();

      const batchBlock = /<BATCHALLOCATIONS\.LIST>([\s\S]*?)<\/BATCHALLOCATIONS\.LIST>/.exec(inventoryBlock!)?.[1];
      expect(batchBlock).toBeDefined();
      expect(batchBlock).toContain('<GODOWNNAME>Main Location</GODOWNNAME>');
    });

    it('does not place GODOWNNAME directly under ALLINVENTORYENTRIES.LIST', () => {
      const xml = buildSalesVoucherXml(voucherInput());
      const inventoryBlock = /<ALLINVENTORYENTRIES\.LIST>([\s\S]*?)<BATCHALLOCATIONS\.LIST>/.exec(xml)?.[1];

      expect(inventoryBlock).toBeDefined();
      expect(inventoryBlock).not.toContain('GODOWNNAME');
    });

    it('escapes the godown name', () => {
      const xml = buildSalesVoucherXml(
        voucherInput({
          items: [
            {
              stockItemName: 'Steel Rods',
              quantity: 100,
              unit: 'Kg',
              rate: 500,
              amount: 50000,
              ledgerAllocation: { ledgerName: 'Sales', amount: 50000 },
              godown: 'A & B Godown',
            },
          ],
        }),
      );

      expect(xml).toContain('<GODOWNNAME>A &amp; B Godown</GODOWNNAME>');
    });

    it('gives each item its own independent godown, including when items share one', () => {
      const xml = buildSalesVoucherXml(
        voucherInput({
          items: [
            { stockItemName: 'Cement', quantity: 1, unit: 'Bags', rate: 100, amount: 100, ledgerAllocation: { ledgerName: 'Sales', amount: 100 }, godown: 'Main Location' },
            { stockItemName: 'Bricks', quantity: 2, unit: 'Nos', rate: 50, amount: 100, ledgerAllocation: { ledgerName: 'Sales', amount: 100 }, godown: 'Warehouse B' },
            { stockItemName: 'Sand', quantity: 3, unit: 'Nos', rate: 30, amount: 90, ledgerAllocation: { ledgerName: 'Sales', amount: 90 }, godown: 'Warehouse B' },
          ],
        }),
      );

      const godowns = [...xml.matchAll(/<GODOWNNAME>([^<]+)<\/GODOWNNAME>/g)].map((m) => m[1]);
      expect(godowns).toEqual(['Main Location', 'Warehouse B', 'Warehouse B']);
    });
  });
});

describe('parseImportResponse', () => {
  it('parses a successful creation', () => {
    const result = parseImportResponse(
      '<RESPONSE><CREATED>1</CREATED><ALTERED>0</ALTERED><ERRORS>0</ERRORS><LASTVCHID>4821</LASTVCHID></RESPONSE>',
    );

    expect(result).toEqual({
      outcome: 'posted',
      message: 'Voucher created in TallyPrime',
      tallyVoucherId: '4821',
    });
  });

  it('parses a business/validation error, extracting the line error', () => {
    const result = parseImportResponse(
      '<RESPONSE><CREATED>0</CREATED><ALTERED>0</ALTERED><ERRORS>1</ERRORS><LINEERROR>Ledger does not exist: "Sales Local"</LINEERROR></RESPONSE>',
    );

    expect(result.outcome).toBe('failed');
    expect(result.message).toContain('Ledger does not exist');
    expect(result.tallyVoucherId).toBeNull();
  });

  it('falls back to a generic message when errors are reported without a line error', () => {
    const result = parseImportResponse('<RESPONSE><ERRORS>2</ERRORS></RESPONSE>');

    expect(result.outcome).toBe('failed');
    expect(result.message).toContain('2');
  });

  it('treats an unrecognised response shape as uncertain, not failed or posted', () => {
    const result = parseImportResponse('<html>Unexpected response</html>');

    expect(result.outcome).toBe('uncertain');
  });

  it('treats a response reporting neither success nor error as uncertain', () => {
    const result = parseImportResponse('<RESPONSE><CREATED>0</CREATED><ALTERED>0</ALTERED><ERRORS>0</ERRORS></RESPONSE>');

    expect(result.outcome).toBe('uncertain');
  });

  it('treats completely empty input as uncertain', () => {
    expect(parseImportResponse('').outcome).toBe('uncertain');
  });

  it('recognises ALTERED as a form of success too', () => {
    const result = parseImportResponse('<RESPONSE><CREATED>0</CREATED><ALTERED>1</ALTERED><ERRORS>0</ERRORS></RESPONSE>');

    expect(result.outcome).toBe('posted');
  });
});
