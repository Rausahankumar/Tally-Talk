import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  TallyResponseError,
  buildCollectionRequest,
  parseCollectionResponse,
  parseStockItemCollectionResponse,
} from '../src/tally/xml.js';
const REAL_LEDGER_RESPONSE = readFileSync(
  new URL('./fixtures/tally/ledger-collection-response.xml', import.meta.url),
  'utf8',
);
const REAL_STOCKITEM_GST_PRICING_RESPONSE = readFileSync(
  new URL('./fixtures/tally/stockitem-gst-pricing-response.xml', import.meta.url),
  'utf8',
);
describe('buildCollectionRequest', () => {
  it('builds the TDL collection envelope Tally expects', () => {
    const xml = buildCollectionRequest({
      collectionName: 'MyCollection',
      masterType: 'Ledger',
      companyName: 'Acme Ltd',
      fields: ['NAME', 'PARENT'],
    });
    expect(xml).toContain('<TALLYREQUEST>EXPORT</TALLYREQUEST>');
    expect(xml).toContain('<TYPE>COLLECTION</TYPE>');
    expect(xml).toContain('<ID>MyCollection</ID>');
    expect(xml).toContain('<SVCURRENTCOMPANY>Acme Ltd</SVCURRENTCOMPANY>');
    expect(xml).toContain('<TYPE>Ledger</TYPE>');
    expect(xml).toContain('<FETCH>NAME, PARENT</FETCH>');
  });
  it('omits SVCURRENTCOMPANY entirely when no company name is given — needed for company discovery itself', () => {
    // Confirmed live: Tally still returns the single open company's data
    // when SVCURRENTCOMPANY is left out of the request entirely (not an
    // empty value — the tag absent). This is what makes discovering the
    // company possible without already knowing its name (tally/company.js).
    const xml = buildCollectionRequest({
      collectionName: 'TallyTalk_CompanyProbe',
      masterType: 'Company',
      fields: ['NAME', 'STATENAME'],
    });
    expect(xml).not.toContain('SVCURRENTCOMPANY');
    expect(xml).toContain('<TYPE>Company</TYPE>');
  });
  it('escapes XML special characters in the company name', () => {
    const xml = buildCollectionRequest({
      collectionName: 'C',
      masterType: 'Ledger',
      companyName: 'A & B "Traders" <Ltd>',
      fields: ['NAME'],
    });
    expect(xml).toContain('A &amp; B &quot;Traders&quot; &lt;Ltd&gt;');
    expect(xml).not.toContain('<Ltd>');
  });
  it('omits CHILDOF when not given', () => {
    const xml = buildCollectionRequest({
      collectionName: 'C',
      masterType: 'Batch',
      companyName: 'Acme Ltd',
      fields: ['NAME'],
    });
    expect(xml).not.toContain('CHILDOF');
  });
  it('includes CHILDOF, scoping the collection to one parent, when given', () => {
    const xml = buildCollectionRequest({
      collectionName: 'C',
      masterType: 'Batch',
      companyName: 'Acme Ltd',
      fields: ['NAME', 'PARENT', 'GODOWNNAME', 'CLOSINGBALANCE'],
      childOf: 'Apple',
    });
    expect(xml).toContain('<CHILDOF>Apple</CHILDOF>');
    // Must appear inside the COLLECTION, before FETCH, per the confirmed live shape.
    expect(xml.indexOf('<CHILDOF>Apple</CHILDOF>')).toBeLessThan(xml.indexOf('<FETCH>'));
  });
  it('escapes the CHILDOF value', () => {
    const xml = buildCollectionRequest({
      collectionName: 'C',
      masterType: 'Batch',
      companyName: 'Acme Ltd',
      fields: ['NAME'],
      childOf: 'A & B Item',
    });
    expect(xml).toContain('<CHILDOF>A &amp; B Item</CHILDOF>');
  });
});
describe('parseCollectionResponse — against a real captured TallyPrime response', () => {
  it('parses every ledger in the fixture', () => {
    const rows = parseCollectionResponse(REAL_LEDGER_RESPONSE, 'LEDGER');
    expect(rows).toHaveLength(29);
  });
  it('flattens attribute and element fields onto one record', () => {
    const rows = parseCollectionResponse(REAL_LEDGER_RESPONSE, 'LEDGER');
    const first = rows.find((r) => r.NAME === 'AAAPS5432A');
    expect(first).toEqual({
      NAME: 'AAAPS5432A',
      RESERVEDNAME: '',
      PARENT: 'Sundry Debtors',
      ISBILLWISEON: 'No',
      OPENINGBALANCE: '7000000.00',
    });
  });
  it('drops *.LIST fields rather than guessing at their shape', () => {
    const rows = parseCollectionResponse(REAL_LEDGER_RESPONSE, 'LEDGER');
    for (const row of rows) {
      expect(Object.keys(row).some((k) => k.includes('.'))).toBe(false);
    }
  });
  it('leaves values as strings, never coercing amounts or booleans', () => {
    const rows = parseCollectionResponse(REAL_LEDGER_RESPONSE, 'LEDGER');
    const first = rows.find((r) => r.NAME === 'AAAPS5432A');
    expect(typeof first?.OPENINGBALANCE).toBe('string');
    expect(typeof first?.ISBILLWISEON).toBe('string');
  });
});
describe('parseCollectionResponse — edge cases', () => {
  const envelope = (body) =>
    `<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY>${body}</BODY></ENVELOPE>`;
  it('returns an empty array when Tally omits DATA/COLLECTION entirely', () => {
    expect(parseCollectionResponse(envelope('<DATA></DATA>'), 'LEDGER')).toEqual([]);
  });
  it('returns an empty array for an explicitly empty collection', () => {
    expect(
      parseCollectionResponse(envelope('<DATA><COLLECTION></COLLECTION></DATA>'), 'LEDGER'),
    ).toEqual([]);
  });
  it('returns an empty array for a whitespace-only collection, as real Tally sends', () => {
    // Confirmed live: a Batch collection scoped to a stock item with no
    // batches comes back as `<COLLECTION>   </COLLECTION>`, and the parser
    // keeps that whitespace (trimValues: false). This must read as "no rows",
    // not as an unrecognisable shape.
    expect(
      parseCollectionResponse(envelope('<DATA><COLLECTION>   </COLLECTION></DATA>'), 'BATCH'),
    ).toEqual([]);
    expect(
      parseCollectionResponse(envelope('<DATA><COLLECTION>\n      </COLLECTION></DATA>'), 'BATCH'),
    ).toEqual([]);
  });
  it('normalises a single-record collection to a one-element array', () => {
    const xml = envelope(
      '<DATA><COLLECTION><LEDGER NAME="Solo"><PARENT TYPE="String">Sundry Debtors</PARENT></LEDGER></COLLECTION></DATA>',
    );
    const rows = parseCollectionResponse(xml, 'LEDGER');
    expect(rows).toEqual([{ NAME: 'Solo', PARENT: 'Sundry Debtors' }]);
  });
  it('throws a distinct error for a request Tally rejected outright', () => {
    expect(() =>
      parseCollectionResponse(
        '<RESPONSE>Unknown Request, cannot be processed</RESPONSE>',
        'LEDGER',
      ),
    ).toThrow(TallyResponseError);
  });
  it('throws on a non-success status', () => {
    expect(() =>
      parseCollectionResponse(
        '<ENVELOPE><HEADER><STATUS>0</STATUS></HEADER><BODY></BODY></ENVELOPE>',
        'LEDGER',
      ),
    ).toThrow(/non-success status/);
  });
  it('throws on input that is not a recognisable Tally response', () => {
    expect(() => parseCollectionResponse('<html>not tally</html>', 'LEDGER')).toThrow(
      TallyResponseError,
    );
  });
  it('throws on malformed XML rather than returning a partial result', () => {
    expect(() => parseCollectionResponse('<ENVELOPE><BODY', 'LEDGER')).toThrow(TallyResponseError);
  });
});
describe('parseStockItemCollectionResponse — against a real captured TallyPrime response', () => {
  it('still flattens every plain field exactly like parseCollectionResponse', () => {
    const rows = parseStockItemCollectionResponse(REAL_STOCKITEM_GST_PRICING_RESPONSE);
    const apple = rows.find((r) => r.NAME === 'Apple');
    expect(apple).toMatchObject({ NAME: 'Apple', RESERVEDNAME: '' });
  });
  it('returns an empty gstRateHistory/standardPriceHistory/standardCostHistory for an item with no data, never guessing one', () => {
    const rows = parseStockItemCollectionResponse(REAL_STOCKITEM_GST_PRICING_RESPONSE);
    const apple = rows.find((r) => r.NAME === 'Apple');
    expect(apple.standardPriceHistory).toEqual([]);
    expect(apple.standardCostHistory).toEqual([]);
    // Apple does have one real GST entry, though (checked separately below).
    expect(apple.gstRateHistory).toHaveLength(1);
  });
  it('parses a single GSTDETAILS.LIST entry into normalised CGST/SGST/IGST rates', () => {
    const rows = parseStockItemCollectionResponse(REAL_STOCKITEM_GST_PRICING_RESPONSE);
    const orange = rows.find((r) => r.NAME === 'Orange');
    expect(orange.gstRateHistory).toEqual([
      {
        applicableFrom: '2025-04-01',
        states: [{ state: 'Any', cgst: 9, sgst: 9, igst: 18 }],
      },
    ]);
  });
  it('parses real STANDARDPRICELIST/STANDARDCOSTLIST entries, including the "value/unit" rate format', () => {
    const rows = parseStockItemCollectionResponse(REAL_STOCKITEM_GST_PRICING_RESPONSE);
    const orange = rows.find((r) => r.NAME === 'Orange');
    expect(orange.standardCostHistory).toEqual([{ date: '2026-04-01', rate: 500, unit: 'KG' }]);
    expect(orange.standardPriceHistory).toEqual([{ date: '2026-04-01', rate: 1000, unit: 'KG' }]);
  });
  it('parses multiple GSTDETAILS.LIST entries as a real effective-dated history, never picking just one', () => {
    const rows = parseStockItemCollectionResponse(REAL_STOCKITEM_GST_PRICING_RESPONSE);
    const shampoo = rows.find((r) => r.NAME === 'Anti-Dandruff Shampoos');
    expect(shampoo.gstRateHistory).toEqual([
      { applicableFrom: '2025-04-01', states: [{ state: 'Any', cgst: null, sgst: null, igst: null }] },
      { applicableFrom: '2025-08-01', states: [{ state: 'Any', cgst: 2.5, sgst: 2.5, igst: 5 }] },
    ]);
  });
  it('flattens GSTHSNCODE like any other plain field — it needs no special .LIST handling', () => {
    const xml = `<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY><DATA><COLLECTION>
      <STOCKITEM NAME="Solo"><GSTHSNCODE TYPE="String">123456</GSTHSNCODE></STOCKITEM>
    </COLLECTION></DATA></BODY></ENVELOPE>`;
    const rows = parseStockItemCollectionResponse(xml);
    expect(rows).toEqual([
      { NAME: 'Solo', GSTHSNCODE: '123456', gstRateHistory: [], standardPriceHistory: [], standardCostHistory: [] },
    ]);
  });
  it('never touches the general *.LIST-dropping behaviour of flattenRecord — other .LIST fields stay absent', () => {
    const rows = parseStockItemCollectionResponse(REAL_STOCKITEM_GST_PRICING_RESPONSE);
    for (const row of rows) {
      const listKeys = Object.keys(row).filter(
        (k) => k.includes('.') && !['gstRateHistory', 'standardPriceHistory', 'standardCostHistory'].includes(k),
      );
      expect(listKeys).toEqual([]);
    }
  });
});
