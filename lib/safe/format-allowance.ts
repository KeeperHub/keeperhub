/**
 * Display helpers for Zodiac Roles allowance buckets.
 *
 * These render wei amounts and refill periods in the same human-friendly
 * form across both simulate routes (POST .../role/simulate and POST
 * .../safe/simulate-deploy) so the install confirmation screen never shows
 * raw 10^18 values to admins. Pure string formatting -- no DB, no RPC, no
 * server-only directive.
 */

const SECONDS_PER_DAY = 86_400;
const SECONDS_PER_WEEK = 604_800;
const SECONDS_PER_MONTH = 2_592_000;
const TRAILING_ZEROS_REGEX = /0+$/;
const TRAILING_DOT_REGEX = /\.$/;

/**
 * Render a refill period in plain English so the wizard preview reads like
 * "every week" instead of "every 604800s". Falls back to the raw seconds
 * count for non-canonical periods so we never lie to the admin about what
 * `setAllowance` is actually being called with.
 */
export function formatPeriod(seconds: number): string {
  if (seconds === SECONDS_PER_DAY) {
    return "every day";
  }
  if (seconds === SECONDS_PER_WEEK) {
    return "every week";
  }
  if (seconds === SECONDS_PER_MONTH) {
    return "every month";
  }
  return `every ${seconds}s`;
}

/**
 * Convert a wei-denominated amount back to its human form using the token's
 * declared decimals, then drop trailing zeros so "1.000000" renders as "1".
 * On unparseable input we fall back to the raw "<wei> wei" form rather than
 * silently dropping the value.
 */
export function formatTokenAmount(amountWei: string, decimals: number): string {
  try {
    const big = BigInt(amountWei);
    if (decimals === 0) {
      return big.toString();
    }
    const divisor = BigInt(10) ** BigInt(decimals);
    const whole = big / divisor;
    const fraction = big % divisor;
    if (fraction === BigInt(0)) {
      return whole.toString();
    }
    const fractionStr = fraction
      .toString()
      .padStart(decimals, "0")
      .replace(TRAILING_ZEROS_REGEX, "");
    if (fractionStr.length === 0) {
      return whole.toString();
    }
    return `${whole.toString()}.${fractionStr}`.replace(TRAILING_DOT_REGEX, "");
  } catch {
    return `${amountWei} wei`;
  }
}
