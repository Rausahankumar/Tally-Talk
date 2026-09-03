/**
 * XML building and parsing for Tally's HTTP interface.
 *
 * Two request shapes exist. Tally's own named reports (e.g. "All Masters", used
 * by the file-export feature) use one envelope shape; an ad-hoc collection
 * defined inline via TDL uses another. Only the second is used here, because it
 * lets the caller request exactly the fields it needs instead of a whole
 * report's worth of data. Confirmed against a live TallyPrime instance before
 * this module was written — see DECISIONS.md for the record of that check.
 */

import { XMLParser } from 'fast-xml-parser';

/**
 * Build an ad-hoc COLLECTION export request. `fields` are Tally field names.
 *
 * `childOf`, when given, scopes the collection to one parent master's
 * children — confirmed live as the only way to enumerate `Batch` records
 * (`TYPE=Batch` with no `CHILDOF` returns zero rows even when batches exist;
 * scoped to a specific stock item name, it returns them).
 */
export function buildCollectionRequest(options: {
  readonly collectionName: string;
  readonly masterType: string;
  readonly companyName: string;
  readonly fields: readonly string[];
  readonly childOf?: string;
}): string {
  const { collectionName, masterType, companyName, fields, childOf } = options;
  const childOfXml = childOf !== undefined ? `\n      <CHILDOF>${escapeXml(childOf)}</CHILDOF>` : '';

  return `<ENVELOPE>
 <HEADER>
  <VERSION>1</VERSION>
  <TALLYREQUEST>EXPORT</TALLYREQUEST>
  <TYPE>COLLECTION</TYPE>
  <ID>${escapeXml(collectionName)}</ID>
 </HEADER>
 <BODY>
  <DESC>
   <STATICVARIABLES>
    <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
    <SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>
   </STATICVARIABLES>
   <TDL>
    <TDLMESSAGE>
     <COLLECTION NAME="${escapeXml(collectionName)}" ISINITIALIZE="Yes">
      <TYPE>${escapeXml(masterType)}</TYPE>${childOfXml}
      <FETCH>${fields.map(escapeXml).join(', ')}</FETCH>
     </COLLECTION>
    </TDLMESSAGE>
   </TDL>
  </DESC>
 </BODY>
</ENVELOPE>`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Raised when a response cannot be parsed as the collection shape expected. */
export class TallyResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TallyResponseError';
  }
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Tally always wraps a single field value in a text/attribute pair, never
  // needs array coercion at the parser level — arrays are handled explicitly
  // below because Tally omits the wrapping array entirely for a single row.
  parseTagValue: false,
  trimValues: false,
});

/**
 * One record from a Tally collection, exactly as returned: raw string values,
 * keyed by the field name the caller asked for. No type coercion happens here
 * — Tally's own TYPE attributes (String/Number/Amount/Logical/Date) describe
 * the value, but callers decide what parsing is safe for their use, since a
 * value like "2500.00/Nos" or " 200 Nos" is not a plain number.
 */
export type RawMasterRecord = Readonly<Record<string, string>>;

/**
 * Parse a COLLECTION export response into raw records.
 *
 * Tally responses vary in a way that is easy to get wrong: a collection with
 * one matching master is a single object, not a one-element array. Both shapes
 * are normalised to an array here.
 */
export function parseCollectionResponse(xml: string, masterTag: string): RawMasterRecord[] {
  let doc: unknown;
  try {
    doc = parser.parse(xml);
  } catch (error) {
    throw new TallyResponseError(
      `Response was not valid XML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // A malformed or rejected request gets a bare <RESPONSE>...</RESPONSE>
  // instead of an <ENVELOPE> at all (e.g. "Unknown Request, cannot be
  // processed"). This must not be mistaken for a legitimately empty result.
  const bareResponse = getPath(doc, ['RESPONSE']);
  if (bareResponse !== undefined) {
    throw new TallyResponseError(`Tally rejected the request: ${String(bareResponse)}`);
  }

  const status = getPath(doc, ['ENVELOPE', 'HEADER', 'STATUS']);
  if (status === undefined) {
    throw new TallyResponseError('Response was not a recognisable Tally ENVELOPE');
  }
  if (String(status) !== '1') {
    throw new TallyResponseError(`Tally reported a non-success status: ${String(status)}`);
  }

  const collection = getPath(doc, ['ENVELOPE', 'BODY', 'DATA', 'COLLECTION']);
  if (collection === undefined || (typeof collection === 'string' && collection.trim() === '')) {
    // No masters of this type: DATA/COLLECTION omitted entirely, or present
    // but empty. Confirmed live: Tally returns `<COLLECTION>   </COLLECTION>`
    // — whitespace, not an empty tag — for e.g. a stock item with no batches,
    // and `trimValues: false` keeps that whitespace, so an equality check
    // against '' alone misses it.
    return [];
  }
  if (typeof collection !== 'object' || collection === null) {
    throw new TallyResponseError('Unexpected COLLECTION shape in Tally response');
  }

  const rows = (collection as Record<string, unknown>)[masterTag];
  if (rows === undefined) return [];

  const list = Array.isArray(rows) ? rows : [rows];
  return list.map((row) => flattenRecord(row));
}

function getPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * Reduce one parsed `<LEDGER ...>`-style element to flat string values.
 *
 * Tally encodes each field as either an XML attribute (`NAME`, `RESERVEDNAME`)
 * or a child element carrying a `TYPE` attribute and a text value
 * (`<PARENT TYPE="String">Sundry Debtors</PARENT>`). List-type fields
 * (`LANGUAGENAME.LIST` and similar) are not master-identifying data and are
 * dropped rather than guessed at.
 */
function flattenRecord(row: unknown): RawMasterRecord {
  if (typeof row !== 'object' || row === null) return {};

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    if (key.includes('.')) continue; // *.LIST fields — not used in Phase 3
    // Whitespace text nodes between the sibling elements above, not a field.
    if (key === '#text') continue;

    if (key.startsWith('@_')) {
      out[key.slice(2)] = String(value);
      continue;
    }

    if (typeof value === 'object' && value !== null) {
      const text = (value as Record<string, unknown>)['#text'];
      if (text !== undefined) out[key] = String(text);
      // A field with no text content (e.g. self-closed) contributes nothing.
      continue;
    }

    out[key] = String(value);
  }
  return out;
}
