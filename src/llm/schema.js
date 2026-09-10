/**
 * Structured transaction draft — the only thing an LLM call in this project is
 * allowed to produce.
 *
 * The draft carries only what the user literally stated. There is no total,
 * no GST amount, no line-item subtotal: computing those is backend work
 * (Phase 5), never the LLM's. The schema exists twice, deliberately: once as a
 * JSON Schema handed to Anthropic to constrain generation, and once as a
 * runtime validator run against whatever comes back. The model is not trusted
 * just because its output matched the tool signature.
 */
/** Fixed vocabulary so the model can only say what the backend can act on. */
export const MISSING_FIELD_NAMES = [
  'voucherType',
  'partyName',
  'items',
  'gstPercent',
  'placeOfSupply',
];
export const VOUCHER_TYPES = ['sales', 'purchase', 'unknown'];
/** The only date shape accepted from the LLM — deterministic to parse, no locale guessing downstream. */
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/**
 * The tool `input_schema` given to Anthropic. `additionalProperties: false` and
 * explicit enums are what make this a *constraint* on generation, not just a
 * suggestion — the API rejects a tool call that doesn't match this shape.
 */
export const TRANSACTION_DRAFT_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    voucherType: { type: 'string', enum: [...VOUCHER_TYPES] },
    partyName: { type: ['string', 'null'] },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          itemName: { type: 'string' },
          quantity: { type: ['number', 'null'] },
          rate: { type: ['number', 'null'] },
          godown: { type: ['string', 'null'] },
          gstPercent: { type: ['number', 'null'] },
        },
        required: ['itemName', 'quantity', 'rate', 'godown', 'gstPercent'],
        additionalProperties: false,
      },
    },
    gstPercent: { type: ['number', 'null'] },
    placeOfSupply: { type: ['string', 'null'] },
    date: { type: ['string', 'null'] },
    missingFields: {
      type: 'array',
      items: { type: 'string', enum: [...MISSING_FIELD_NAMES] },
    },
    ambiguityNote: { type: ['string', 'null'] },
  },
  required: [
    'voucherType',
    'partyName',
    'items',
    'gstPercent',
    'placeOfSupply',
    'date',
    'missingFields',
    'ambiguityNote',
  ],
  additionalProperties: false,
};
/** Raised when a model's tool call does not actually match the schema above. */
export class DraftValidationError extends Error {
  problems;
  constructor(problems) {
    super(
      `LLM produced an invalid transaction draft:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
    this.name = 'DraftValidationError';
    this.problems = problems;
  }
}
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function validateLineItem(value, index, problems) {
  if (!isPlainObject(value)) {
    problems.push(`items[${index}] must be an object`);
    return null;
  }
  const { itemName, quantity, rate, godown, gstPercent, ...rest } = value;
  const extra = Object.keys(rest);
  if (extra.length > 0) {
    problems.push(`items[${index}] has unexpected fields: ${extra.join(', ')}`);
  }
  if (typeof itemName !== 'string' || itemName.trim() === '') {
    problems.push(`items[${index}].itemName must be a non-empty string`);
    return null;
  }
  if (quantity !== null && typeof quantity !== 'number') {
    problems.push(`items[${index}].quantity must be a number or null`);
    return null;
  }
  if (rate !== null && typeof rate !== 'number') {
    problems.push(`items[${index}].rate must be a number or null`);
    return null;
  }
  if (godown !== null && (typeof godown !== 'string' || godown.trim() === '')) {
    problems.push(`items[${index}].godown must be a non-empty string or null`);
    return null;
  }
  if (gstPercent !== null && gstPercent !== undefined && typeof gstPercent !== 'number') {
    problems.push(`items[${index}].gstPercent must be a number or null`);
    return null;
  }
  return { itemName, quantity, rate, godown, gstPercent: gstPercent ?? null };
}
/**
 * Validate a candidate draft with no coercion: a value either matches the
 * schema exactly or the whole draft is rejected. This is the backend's only
 * defence against a model that ignores its tool schema or a client bug that
 * mangles the response — the draft is never trusted just because it parsed.
 */
export function parseTransactionDraft(candidate) {
  const problems = [];
  if (!isPlainObject(candidate)) {
    throw new DraftValidationError(['draft must be an object']);
  }
  const {
    voucherType,
    partyName,
    items,
    gstPercent,
    placeOfSupply,
    date,
    missingFields,
    ambiguityNote,
    ...rest
  } = candidate;
  const extra = Object.keys(rest);
  if (extra.length > 0) problems.push(`unexpected top-level fields: ${extra.join(', ')}`);
  if (typeof voucherType !== 'string' || !VOUCHER_TYPES.includes(voucherType)) {
    problems.push(`voucherType must be one of ${VOUCHER_TYPES.join(', ')}`);
  }
  if (partyName !== null && typeof partyName !== 'string') {
    problems.push('partyName must be a string or null');
  }
  let parsedItems = [];
  if (!Array.isArray(items)) {
    problems.push('items must be an array');
  } else {
    parsedItems = items
      .map((item, index) => validateLineItem(item, index, problems))
      .filter((item) => item !== null);
  }
  if (gstPercent !== null && typeof gstPercent !== 'number') {
    problems.push('gstPercent must be a number or null');
  }
  if (
    placeOfSupply !== null &&
    (typeof placeOfSupply !== 'string' || placeOfSupply.trim() === '')
  ) {
    problems.push('placeOfSupply must be a non-empty string or null');
  }
  if (date !== null && (typeof date !== 'string' || !ISO_DATE_PATTERN.test(date))) {
    problems.push('date must be an ISO 8601 date (YYYY-MM-DD) or null');
  }
  let parsedMissingFields = [];
  if (!Array.isArray(missingFields)) {
    problems.push('missingFields must be an array');
  } else {
    const known = new Set(MISSING_FIELD_NAMES);
    for (const field of missingFields) {
      if (typeof field !== 'string' || !known.has(field)) {
        problems.push(`missingFields contains an unrecognised value: ${JSON.stringify(field)}`);
      }
    }
    parsedMissingFields = missingFields.filter((f) => known.has(f));
  }
  if (ambiguityNote !== null && typeof ambiguityNote !== 'string') {
    problems.push('ambiguityNote must be a string or null');
  }
  if (problems.length > 0) throw new DraftValidationError(problems);
  return {
    voucherType: voucherType,
    partyName: partyName,
    items: parsedItems,
    gstPercent: gstPercent,
    placeOfSupply: placeOfSupply,
    date: date,
    missingFields: parsedMissingFields,
    ambiguityNote: ambiguityNote,
  };
}
