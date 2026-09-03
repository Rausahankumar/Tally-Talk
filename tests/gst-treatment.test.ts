import { describe, expect, it } from 'vitest';

import type { GstLedgerConfig } from '../src/config/index.ts';
import { isRecognizedState } from '../src/gst/states.ts';
import { determineGstTreatment } from '../src/gst/treatment.ts';

const CONFIG: GstLedgerConfig = {
  companyState: 'Delhi',
  cgstLedger: 'CGST',
  sgstLedger: 'SGST',
  igstLedger: 'IGST',
  defaultPlaceOfSupply: null,
};

describe('isRecognizedState', () => {
  it('recognises a real state or union territory, case/whitespace-insensitively', () => {
    expect(isRecognizedState('Delhi')).toBe(true);
    expect(isRecognizedState('  delhi  ')).toBe(true);
    expect(isRecognizedState('UTTAR   PRADESH')).toBe(true);
  });

  it('rejects a made-up or misspelled name', () => {
    expect(isRecognizedState('Narnia')).toBe(false);
    expect(isRecognizedState('Utar Pradesh')).toBe(false); // no fuzzy matching on states
  });
});

describe('determineGstTreatment', () => {
  it('Company: Delhi, POS: Delhi -> intrastate, CGST + SGST', () => {
    const result = determineGstTreatment('Delhi', 'Delhi', CONFIG);

    expect(result.type).toBe('intrastate');
    expect(result.ledgers.map((l) => l.ledgerName)).toEqual(['CGST', 'SGST']);
  });

  it('Company: Delhi, POS: Uttar Pradesh -> interstate, IGST', () => {
    const result = determineGstTreatment('Delhi', 'Uttar Pradesh', CONFIG);

    expect(result.type).toBe('interstate');
    expect(result.ledgers.map((l) => l.ledgerName)).toEqual(['IGST']);
  });

  it('an intrastate CGST/SGST split shares the tax equally', () => {
    const result = determineGstTreatment('Delhi', 'Delhi', CONFIG);

    expect(result.ledgers.every((l) => l.share === 0.5)).toBe(true);
  });

  it('an interstate IGST allocation carries the full share', () => {
    const result = determineGstTreatment('Delhi', 'Uttar Pradesh', CONFIG);

    expect(result.ledgers[0]?.share).toBe(1);
  });

  it('is case/whitespace-insensitive when comparing company state and place of supply', () => {
    const result = determineGstTreatment('  DELHI ', 'delhi', CONFIG);

    expect(result.type).toBe('intrastate');
  });

  it('always uses the configured ledger names, never anything derived from input text', () => {
    const customConfig: GstLedgerConfig = {
      companyState: 'Delhi',
      cgstLedger: 'Central GST Payable',
      sgstLedger: 'State GST Payable',
      igstLedger: 'Integrated GST Payable',
      defaultPlaceOfSupply: null,
    };

    const intrastate = determineGstTreatment('Delhi', 'Delhi', customConfig);
    expect(intrastate.ledgers.map((l) => l.ledgerName)).toEqual([
      'Central GST Payable',
      'State GST Payable',
    ]);

    const interstate = determineGstTreatment('Delhi', 'Uttar Pradesh', customConfig);
    expect(interstate.ledgers.map((l) => l.ledgerName)).toEqual(['Integrated GST Payable']);
  });
});
