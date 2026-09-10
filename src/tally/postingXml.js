/**
 * Voucher XML construction and Import response parsing.
 *
 * Deterministic and pure — no I/O here. Every field name and the
 * debit/credit sign convention below were confirmed against a real Sales
 * voucher exported from the target TallyPrime company during Phase 3
 * discovery, not assumed from general documentation (see DECISIONS.md #25).
 *
 * Only Sales vouchers are supported. There is no verified real sample of a
 * Purchase voucher to confirm its sign convention against (it is commonly the
 * mirror image of Sales, but "commonly" is not "confirmed", and this project
 * does not guess at anything that posts to a real accounting system) — see
 * the Phase 7 completion report.
 *
 * Godown placement was confirmed the same way: a real Sales voucher manually
 * created in TallyPrime with an explicit godown per item, then exported, shows
 * `GODOWNNAME` nested inside each inventory entry's own `BATCHALLOCATIONS.LIST`
 * — never at voucher level, never directly under `ALLINVENTORYENTRIES.LIST`.
 *
 * `BATCHNAME` is never hardcoded here. An earlier version of this module
 * assumed every item's batch was named "Primary Batch" — real Tally data
 * proved that wrong: a batch-tracked item's real recorded batch was named
 * `"1"`, not "Primary Batch" (only non-batch-tracked items actually use
 * Tally's implicit "Primary Batch"). `batchName` is a required field on
 * `TallyVoucherLineItem` precisely so the backend-resolved real batch (from
 * `checkPostingReadiness`'s cached availability lookup) is what reaches the
 * XML — never guessed here.
 */
function escapeXml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function formatTallyDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}
function formatAmount(value) {
  return value.toFixed(2);
}
function formatQuantity(quantity, unit) {
  return `${quantity} ${unit}`;
}
function formatRate(rate, unit) {
  return `${rate.toFixed(2)}/${unit}`;
}
/** Every line item's allocation plus every tax allocation, summed. */
function creditSideTotal(input) {
  const itemsTotal = input.items.reduce((sum, item) => sum + item.amount, 0);
  const taxTotal = input.taxLedgerAllocations.reduce((sum, tax) => sum + tax.amount, 0);
  return itemsTotal + taxTotal;
}
function buildBatchAllocationEntry(item) {
  return `
      <BATCHALLOCATIONS.LIST>
       <GODOWNNAME>${escapeXml(item.godown)}</GODOWNNAME>
       <BATCHNAME>${escapeXml(item.batchName)}</BATCHNAME>
       <AMOUNT>${formatAmount(item.amount)}</AMOUNT>
       <ACTUALQTY>${formatQuantity(item.quantity, item.unit)}</ACTUALQTY>
       <BILLEDQTY>${formatQuantity(item.quantity, item.unit)}</BILLEDQTY>
      </BATCHALLOCATIONS.LIST>`;
}
function buildInventoryEntry(item) {
  return `
      <ALLINVENTORYENTRIES.LIST>
       <STOCKITEMNAME>${escapeXml(item.stockItemName)}</STOCKITEMNAME>
       <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
       <RATE>${formatRate(item.rate, item.unit)}</RATE>
       <AMOUNT>${formatAmount(item.amount)}</AMOUNT>
       <ACTUALQTY>${formatQuantity(item.quantity, item.unit)}</ACTUALQTY>
       <BILLEDQTY>${formatQuantity(item.quantity, item.unit)}</BILLEDQTY>${buildBatchAllocationEntry(item)}
       <ACCOUNTINGALLOCATIONS.LIST>
        <LEDGERNAME>${escapeXml(item.ledgerAllocation.ledgerName)}</LEDGERNAME>
        <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
        <AMOUNT>${formatAmount(item.ledgerAllocation.amount)}</AMOUNT>
       </ACCOUNTINGALLOCATIONS.LIST>
      </ALLINVENTORYENTRIES.LIST>`;
}
function buildLedgerEntry(ledgerName, amount, isDeemedPositive) {
  return `
      <LEDGERENTRIES.LIST>
       <LEDGERNAME>${escapeXml(ledgerName)}</LEDGERNAME>
       <ISDEEMEDPOSITIVE>${isDeemedPositive ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>
       <AMOUNT>${formatAmount(amount)}</AMOUNT>
      </LEDGERENTRIES.LIST>`;
}
/**
 * Build a Sales voucher Import request.
 *
 * Sign convention, confirmed against real captured data: the party ledger
 * entry is negative with `ISDEEMEDPOSITIVE = Yes`; every sales/income and tax
 * ledger entry (including each inventory line's own accounting allocation) is
 * positive with `ISDEEMEDPOSITIVE = No`. The voucher must balance to zero —
 * the party amount is computed here as exactly the negative of everything
 * else, never taken as a separate input that could drift out of balance.
 */
export function buildSalesVoucherXml(input) {
  const partyAmount = -creditSideTotal(input);
  const inventoryEntries = input.items.map(buildInventoryEntry).join('');
  const partyEntry = buildLedgerEntry(input.partyLedgerName, partyAmount, true);
  const taxEntries = input.taxLedgerAllocations
    .map((tax) => buildLedgerEntry(tax.ledgerName, tax.amount, false))
    .join('');
  return `<ENVELOPE>
 <HEADER>
  <TALLYREQUEST>Import Data</TALLYREQUEST>
 </HEADER>
 <BODY>
  <IMPORTDATA>
   <REQUESTDESC>
    <REPORTNAME>Vouchers</REPORTNAME>
    <STATICVARIABLES>
     <SVCURRENTCOMPANY>${escapeXml(input.companyName)}</SVCURRENTCOMPANY>
    </STATICVARIABLES>
   </REQUESTDESC>
   <REQUESTDATA>
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
     <VOUCHER VCHTYPE="Sales" ACTION="Create">
      <DATE>${formatTallyDate(input.date)}</DATE>
      <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
      <PARTYLEDGERNAME>${escapeXml(input.partyLedgerName)}</PARTYLEDGERNAME>
      <ISINVOICE>Yes</ISINVOICE>${input.narration !== undefined ? `\n      <NARRATION>${escapeXml(input.narration)}</NARRATION>` : ''}${inventoryEntries}${partyEntry}${taxEntries}
     </VOUCHER>
    </TALLYMESSAGE>
   </REQUESTDATA>
  </IMPORTDATA>
 </BODY>
</ENVELOPE>`;
}
/**
 * Parse a Tally Import response.
 *
 * This is the one part of Phase 7 that could not be grounded in a real
 * captured sample — Phase 3's discovery only captured Export responses, and
 * this project sends no real Import request without explicit approval. The
 * shape below (`<RESPONSE><CREATED>/<ALTERED>/<ERRORS>/<LASTVCHID>/<LINEERROR>`)
 * is Tally's standard, documented Import response format. It has not been
 * confirmed against this specific TallyPrime instance — that confirmation is
 * exactly what the first real, approved Import test is for.
 */
export function parseImportResponse(xml) {
  const createdMatch = /<CREATED>\s*(\d+)\s*<\/CREATED>/i.exec(xml);
  const alteredMatch = /<ALTERED>\s*(\d+)\s*<\/ALTERED>/i.exec(xml);
  const errorsMatch = /<ERRORS>\s*(\d+)\s*<\/ERRORS>/i.exec(xml);
  const exceptionsMatch = /<EXCEPTIONS>\s*(\d+)\s*<\/EXCEPTIONS>/i.exec(xml);
  const lineErrorMatch = /<LINEERROR>([\s\S]*?)<\/LINEERROR>/i.exec(xml);
  const vchIdMatch = /<LASTVCHID>\s*(\d+)\s*<\/LASTVCHID>/i.exec(xml);
  if (createdMatch === null && alteredMatch === null && errorsMatch === null) {
    // Not the shape we know how to read at all — genuinely unknown, not a
    // known failure. Treated as uncertain, never as success or failure.
    return {
      outcome: 'uncertain',
      message: 'Unrecognised Tally response format',
      tallyVoucherId: null,
    };
  }
  const errors = errorsMatch !== null ? Number(errorsMatch[1]) : 0;
  const exceptions = exceptionsMatch !== null ? Number(exceptionsMatch[1]) : 0;
  const created = createdMatch !== null ? Number(createdMatch[1]) : 0;
  const altered = alteredMatch !== null ? Number(alteredMatch[1]) : 0;
  // A real captured response rejected a voucher (CREATED=0) via EXCEPTIONS
  // and a LINEERROR while leaving ERRORS at 0 — that shape is a failure, not
  // "neither success nor error", even though ERRORS alone says otherwise.
  if (errors > 0 || (exceptions > 0 && lineErrorMatch !== null)) {
    return {
      outcome: 'failed',
      message: lineErrorMatch?.[1]?.trim() ?? `Tally reported ${errors} error(s)`,
      tallyVoucherId: null,
    };
  }
  if (created > 0 || altered > 0) {
    return {
      outcome: 'posted',
      message: 'Voucher created in TallyPrime',
      tallyVoucherId: vchIdMatch?.[1] ?? null,
    };
  }
  // No errors, but nothing created or altered either — Tally did not do what
  // was asked, but did not say why. Not a confirmed success.
  return {
    outcome: 'uncertain',
    message: 'Tally reported neither success nor an error',
    tallyVoucherId: null,
  };
}
