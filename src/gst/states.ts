/**
 * India's GST-registered states and union territories.
 *
 * A fixed reference list, not sourced from Tally or the LLM — the same
 * pattern as `VALID_GST_RATES` in `src/validation/rules.ts`: a small, stable,
 * publicly documented set used to sanity-check a stated value, not to guess
 * one. Used to validate both `COMPANY_STATE` (config) and a draft's
 * `placeOfSupply` before either is used in a GST decision.
 */
export const SUPPORTED_STATES = [
  'Andhra Pradesh',
  'Arunachal Pradesh',
  'Assam',
  'Bihar',
  'Chhattisgarh',
  'Goa',
  'Gujarat',
  'Haryana',
  'Himachal Pradesh',
  'Jharkhand',
  'Karnataka',
  'Kerala',
  'Madhya Pradesh',
  'Maharashtra',
  'Manipur',
  'Meghalaya',
  'Mizoram',
  'Nagaland',
  'Odisha',
  'Punjab',
  'Rajasthan',
  'Sikkim',
  'Tamil Nadu',
  'Telangana',
  'Tripura',
  'Uttar Pradesh',
  'Uttarakhand',
  'West Bengal',
  'Andaman and Nicobar Islands',
  'Chandigarh',
  'Dadra and Nagar Haveli and Daman and Diu',
  'Delhi',
  'Jammu and Kashmir',
  'Ladakh',
  'Lakshadweep',
  'Puducherry',
] as const;

export type SupportedState = (typeof SUPPORTED_STATES)[number];

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

const NORMALIZED_TO_CANONICAL = new Map<string, SupportedState>(
  SUPPORTED_STATES.map((state) => [normalize(state), state]),
);

/** Case/whitespace-insensitive exact match only — no fuzzy matching on states. */
export function isRecognizedState(value: string): boolean {
  return NORMALIZED_TO_CANONICAL.has(normalize(value));
}

/** The canonical spelling for a recognized state, or `null` if it isn't one. */
export function canonicalStateName(value: string): string | null {
  return NORMALIZED_TO_CANONICAL.get(normalize(value)) ?? null;
}
