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
 *
 * `companyName` is optional — confirmed live that omitting `SVCURRENTCOMPANY`
 * entirely (not an empty value, the tag left out) still returns data scoped
 * to whichever single company is open in Tally. This is what makes company
 * discovery itself possible without already knowing the company's name (see
 * `tally/company.js`); every other query still passes a real discovered name.
 */
export function buildCollectionRequest(options) {
  const { collectionName, masterType, companyName, fields, childOf } = options;
  const childOfXml =
    childOf !== undefined ? `\n      <CHILDOF>${escapeXml(childOf)}</CHILDOF>` : '';
  const companyXml =
    companyName !== undefined
      ? `\n    <SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>`
      : '';
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
    <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>${companyXml}
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
function escapeXml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
/** Raised when a response cannot be parsed as the collection shape expected. */
export class TallyResponseError extends Error {
  constructor(message) {
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
 * Parse a COLLECTION export response into raw records.
 *
 * Tally responses vary in a way that is easy to get wrong: a collection with
 * one matching master is a single object, not a one-element array. Both shapes
 * are normalised to an array here.
 */
/**
 * Shared envelope-unwrapping: validates the response shape and returns the
 * raw (un-flattened) rows for one master tag, or throws/returns `[]` exactly
 * as documented on `parseCollectionResponse`. Both that function and
 * `parseStockItemCollectionResponse` build on this so the envelope-handling
 * rules (rejected request, non-success status, empty/whitespace collection)
 * are defined once, not duplicated.
 */
function parseEnvelopeRows(xml, masterTag) {
  let doc;
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
  const rows = collection[masterTag];
  if (rows === undefined) return [];
  return Array.isArray(rows) ? rows : [rows];
}
export function parseCollectionResponse(xml, masterTag) {
  return parseEnvelopeRows(xml, masterTag).map((row) => flattenRecord(row));
}
function getPath(value, path) {
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = current[key];
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
function flattenRecord(row) {
  if (typeof row !== 'object' || row === null) return {};
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (key.includes('.')) continue; // *.LIST fields — not used in Phase 3
    // Whitespace text nodes between the sibling elements above, not a field.
    if (key === '#text') continue;
    if (key.startsWith('@_')) {
      out[key.slice(2)] = String(value);
      continue;
    }
    if (typeof value === 'object' && value !== null) {
      const text = value['#text'];
      if (text !== undefined) out[key] = String(text);
      // A field with no text content (e.g. self-closed) contributes nothing.
      continue;
    }
    out[key] = String(value);
  }
  return out;
}
/**
 * Text content of one Tally leaf node — handles both the
 * `{"@_TYPE":"...", "#text":"..."}` shape and a plain string leaf
 * (`<RATE>500.00/KG</RATE>` has no TYPE attribute). A self-closed or
 * genuinely absent node returns `null`, never a guessed default.
 */
function textOf(node) {
  if (node === undefined || node === null) return null;
  if (typeof node === 'string') return node.trim() === '' ? null : node.trim();
  if (typeof node === 'object') {
    const text = node['#text'];
    return text !== undefined ? String(text).trim() : null;
  }
  return String(node);
}
/** Tally's fixed `YYYYMMDD` date shape only — `"20250401"` -> `"2025-04-01"`. Anything else returns `null`, never guessed. */
function tallyDateToIso(value) {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value ?? '');
  if (match === null) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}
/** `"500.00/KG"` -> `{ rate: 500, unit: "KG" }`. Anything not matching this exact shape returns `null`. */
function parseSlashRate(value) {
  const match = /^\s*([\d.]+)\s*\/\s*(\S+)\s*$/.exec(value ?? '');
  if (match === null) return null;
  const rate = Number(match[1]);
  return Number.isFinite(rate) ? { rate, unit: match[2] } : null;
}
/** Normalises "one row or many" the same way `parseEnvelopeRows` does for the outer collection — Tally omits the array wrapper for a single child too. */
function asList(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
/** Only the three duty heads this project actually resolves elsewhere (`gstLedgerResolution.js`) — Cess/State Cess are real fields but not tracked here. */
const GST_DUTY_HEAD_KEY = { cgst: 'cgst', 'sgst/utgst': 'sgst', igst: 'igst' };
/** One `STATEWISEDETAILS.LIST` entry -> `{ state, cgst, sgst, igst }`. A duty head with no `GSTRATE` (confirmed live: Tally omits the tag rather than sending 0) stays `null`. */
function parseStateWiseDetails(raw) {
  const state = textOf(raw?.STATENAME) ?? 'Any';
  const rates = { cgst: null, sgst: null, igst: null };
  for (const entry of asList(raw?.['RATEDETAILS.LIST'])) {
    const dutyHead = textOf(entry?.GSTRATEDUTYHEAD)?.toLowerCase();
    const key = dutyHead !== undefined ? GST_DUTY_HEAD_KEY[dutyHead] : undefined;
    if (key === undefined) continue;
    const rateText = textOf(entry?.GSTRATE);
    const rate = rateText === null ? null : Number(rateText);
    rates[key] = rate !== null && Number.isFinite(rate) ? rate : null;
  }
  return { state, ...rates };
}
/** One `GSTDETAILS.LIST` entry -> `{ applicableFrom, states }`, or `null` when its date can't be parsed — dropped, never defaulted. */
function parseGstDetailsEntry(raw) {
  const applicableFrom = tallyDateToIso(textOf(raw?.APPLICABLEFROM));
  if (applicableFrom === null) return null;
  return { applicableFrom, states: asList(raw?.['STATEWISEDETAILS.LIST']).map(parseStateWiseDetails) };
}
/** One `STANDARDPRICELIST.LIST`/`STANDARDCOSTLIST.LIST` entry -> `{ date, rate, unit }`, or `null` if unparseable/absent. */
function parseRateHistoryEntry(raw) {
  const date = tallyDateToIso(textOf(raw?.DATE));
  const parsedRate = parseSlashRate(textOf(raw?.RATE));
  return date !== null && parsedRate !== null ? { date, rate: parsedRate.rate, unit: parsedRate.unit } : null;
}
/**
 * Parses ONLY the three specific StockItem `.LIST` structures confirmed live
 * against this project's own TallyPrime instance (`GSTDETAILS.LIST`,
 * `STANDARDPRICELIST.LIST`, `STANDARDCOSTLIST.LIST`) into a small, explicit,
 * normalised shape. This is deliberately not a generic `.LIST` parser —
 * `flattenRecord` (used for every field on every other master type, and for
 * every other field on StockItem too) is completely untouched; adding
 * support for a different `.LIST` field later means extending this function
 * by name, never enabling `.LIST` parsing in general.
 */
function parseStockItemGstAndPricing(row) {
  if (typeof row !== 'object' || row === null) {
    return { gstRateHistory: [], standardPriceHistory: [], standardCostHistory: [] };
  }
  return {
    gstRateHistory: asList(row['GSTDETAILS.LIST']).map(parseGstDetailsEntry).filter((e) => e !== null),
    standardPriceHistory: asList(row['STANDARDPRICELIST.LIST'])
      .map(parseRateHistoryEntry)
      .filter((e) => e !== null),
    standardCostHistory: asList(row['STANDARDCOSTLIST.LIST'])
      .map(parseRateHistoryEntry)
      .filter((e) => e !== null),
  };
}
/**
 * Same envelope handling as `parseCollectionResponse`, for `TYPE=StockItem`
 * only: every plain field is flattened exactly as before (same
 * `flattenRecord`), with `gstRateHistory`/`standardPriceHistory`/
 * `standardCostHistory` added from the three `.LIST` structures above. No
 * other master type gets this treatment.
 */
export function parseStockItemCollectionResponse(xml) {
  return parseEnvelopeRows(xml, 'STOCKITEM').map((row) => ({
    ...flattenRecord(row),
    ...parseStockItemGstAndPricing(row),
  }));
}
