/**
 * Pure, deterministic value checks — no I/O, no Tally, no LLM.
 *
 * These are intentionally simple sanity checks, not a full accounting or GST
 * compliance engine. See DECISIONS.md for what that limitation means in
 * practice.
 */

/** A quantity must be a real, positive, finite number. Zero and negative are rejected. */
export function isValidQuantity(quantity: number): boolean {
  return Number.isFinite(quantity) && quantity > 0;
}

/** A rate must be a real, positive, finite number. */
export function isValidRate(rate: number): boolean {
  return Number.isFinite(rate) && rate > 0;
}

/**
 * The standard Indian GST slabs, plus the handful of documented special rates
 * (0.25% rough diamonds, 1.5%/6%/7.5% specific notified goods). This is a
 * sanity check on the number the user stated, not a per-item HSN rate lookup —
 * the master cache does not carry HSN/GST-rate data (Phase 3 scope). A rate
 * outside this set is rejected as implausible rather than silently accepted.
 */
export const VALID_GST_RATES: readonly number[] = [0, 0.25, 1.5, 3, 5, 6, 7.5, 12, 18, 28];

const GST_RATE_EPSILON = 1e-9;

export function isValidGstPercent(gstPercent: number): boolean {
  if (!Number.isFinite(gstPercent)) return false;
  return VALID_GST_RATES.some((rate) => Math.abs(rate - gstPercent) < GST_RATE_EPSILON);
}
