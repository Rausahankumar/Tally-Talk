import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  TallyResponseError,
  buildCollectionRequest,
  parseCollectionResponse,
} from '../src/tally/xml.js';
const REAL_LEDGER_RESPONSE = readFileSync(
  new URL('./fixtures/tally/ledger-collection-response.xml', import.meta.url),
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
