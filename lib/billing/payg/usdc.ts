// Client-safe USDC amount helpers. All PAYG money is USDC 6-decimal raw units
// (integers) stored/summed as strings; these convert to/from a human decimal.

export const USDC_DECIMALS = 6;

// Non-negative decimal with an optional integer and/or fractional part, so the
// common ways to type a USDC amount all parse: "5", "0.5", ".5", "5.", "5.50".
// Rejects negatives, letters, and multiple dots.
const DECIMAL_RE = /^(\d+\.?\d*|\.\d+)$/;

/**
 * True if `value` is a well-formed non-negative USDC decimal (e.g. "0", "1.5",
 * ".5"). Callers that must distinguish "0" (a valid zero) from garbage validate
 * with this before calling usdcDecimalToRaw, which returns 0n for both.
 */
export function isValidUsdcDecimal(value: string): boolean {
  return DECIMAL_RE.test(value.trim());
}

/** "0.0075" -> 7500n. Returns 0n for a malformed input. */
export function usdcDecimalToRaw(decimal: string): bigint {
  const trimmed = decimal.trim();
  if (!DECIMAL_RE.test(trimmed)) {
    return BigInt(0);
  }
  const [whole, frac = ""] = trimmed.split(".");
  const fracPadded = `${frac}${"0".repeat(USDC_DECIMALS)}`.slice(
    0,
    USDC_DECIMALS
  );
  const scale = BigInt(10) ** BigInt(USDC_DECIMALS);
  return BigInt(whole) * scale + BigInt(fracPadded || "0");
}

/** 7500n -> "0.007500". */
export function usdcRawToDecimal(raw: bigint): string {
  const scale = BigInt(10) ** BigInt(USDC_DECIMALS);
  const whole = raw / scale;
  const frac = (raw % scale).toString().padStart(USDC_DECIMALS, "0");
  return `${whole}.${frac}`;
}
