/**
 * Ranking, filtering, and HF-threshold helpers for the scan suggestion engine.
 *
 * Exported constants and functions are consumed by:
 *   - lib/scan/suggestions/engine.ts (dust filter, rankAndFilter, clampHfThreshold)
 *   - lib/scan/factory/ shapes (hfThresholdRaw for 1e18-scale condition values)
 *   - tests/unit/scan-suggestions.test.ts (direct unit tests for SUGGEST-07/09)
 *
 * No server-only imports. No side-effects.
 */
import type {
  SuggestionCategory,
  SuggestionDescriptor,
} from "@/lib/scan/suggestions/types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum USD value for any position or balance to qualify for a suggestion (SUGGEST-07). */
export const DUST_THRESHOLD_USD = 10;

/**
 * Maximum number of suggestions returned per scan (SUGGEST-07).
 * Raised from the original 7: the results grid now groups sibling
 * suggestions into one card per family/venue, so the visible card count
 * stays digestible even with many per-(token, network) descriptors.
 */
export const MAX_SUGGESTIONS = 20;

/**
 * Priority order for categories (health > yield > alert > claim).
 * The index within this array determines ranking (lower = higher priority).
 */
export const CATEGORY_ORDER: SuggestionCategory[] = [
  "health",
  "yield",
  "alert",
  "claim",
];

// ---------------------------------------------------------------------------
// HF threshold helpers (SUGGEST-09)
// ---------------------------------------------------------------------------

/** Hard floor: generated thresholds are never below this value. */
const HF_FLOOR = 1.3;

/** Default suggested threshold when the user's HF has sufficient headroom. */
const HF_DEFAULT = 1.5;

/**
 * Clamp a health-factor alert threshold (SUGGEST-09).
 *
 * Rules:
 *   - When currentHf > HF_DEFAULT (1.5): return 1.5 (default, user has headroom).
 *   - Otherwise: return Math.max(currentHf - 0.1, HF_FLOOR).
 *   - Result is NEVER below HF_FLOOR (1.3) — the hard floor.
 */
export function clampHfThreshold(currentHf: number): number {
  if (currentHf > HF_DEFAULT) {
    return HF_DEFAULT;
  }
  // Round to 2 decimals so the value survives display formatting unchanged
  // (1.45 - 0.1 is 1.3499999999999999 in FP, which would render as 1.35 but
  // convert to a raw condition operand of 1.3499...e18).
  return Math.round(Math.max(currentHf - 0.1, HF_FLOOR) * 100) / 100;
}

/**
 * Convert a float HF threshold to Aave's 1e18 base-unit string representation.
 *
 * Aave's healthFactor is returned as a uint256 in 1e18 units.
 * A threshold of 1.5 becomes "1500000000000000000".
 *
 * Floating point note: only values that are exact multiples of 128 at the
 * 1e18 scale (e.g. 1.5) are represented without rounding error.
 * 1.4 * 1e18 = 1399999999999999872 (off by 128 units — negligible for HF
 * comparison). Use BigInt string literals for exact values if needed in future.
 */
export function hfThresholdRaw(threshold: number): string {
  return BigInt(Math.floor(threshold * 1e18)).toString();
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/**
 * Sort descriptors by category priority then USD value (descending), and cap
 * the result at MAX_SUGGESTIONS (SUGGEST-07).
 *
 * Produces a new array; does not mutate the input.
 */
export function rankAndFilter(
  descriptors: SuggestionDescriptor[]
): SuggestionDescriptor[] {
  const sorted = [...descriptors].sort((a, b) => {
    const catDiff =
      CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category);
    if (catDiff !== 0) {
      return catDiff;
    }
    return (b.usdValue ?? 0) - (a.usdValue ?? 0);
  });
  return sorted.slice(0, MAX_SUGGESTIONS);
}
