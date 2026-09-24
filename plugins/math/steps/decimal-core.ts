/**
 * Fixed-point decimal helpers shared by the Math steps.
 *
 * Values are carried as a BigInt mantissa plus a decimal exponent so RAD/WAD
 * magnitude numbers (1e45 / 1e18) survive comparison and formatting without
 * the float precision loss a plain `Number` round-trip introduces.
 *
 * No "use step" directive: imported by several step files.
 */

const DECIMAL_PATTERN = /^[+-]?(\d+)?(\.\d+)?$/;
const SEPARATOR_STRIP = /[,_\s]/g;
const TRAILING_ZEROS = /0+$/;
const SIGN_PREFIX = /^[+-]/;

export type Decimal = {
  /** Unscaled value: the real number is `value / 10 ** decimals`. */
  value: bigint;
  decimals: number;
};

export function parseDecimal(raw: unknown, fieldName: string): Decimal {
  const text = String(raw ?? "").replace(SEPARATOR_STRIP, "").trim();
  if (text === "" || !DECIMAL_PATTERN.test(text)) {
    return throwInvalid(text, fieldName);
  }
  const negative = text.startsWith("-");
  const unsigned = text.replace(SIGN_PREFIX, "");
  const [whole = "", fraction = ""] = unsigned.split(".");
  const digits = `${whole}${fraction}`;
  if (digits === "") {
    return throwInvalid(text, fieldName);
  }
  const value = BigInt(digits);
  return { value: negative ? -value : value, decimals: fraction.length };
}

function throwInvalid(text: string, fieldName: string): never {
  throw new Error(`${fieldName} must be a number, received "${text}".`);
}

export function pow10(exponent: number): bigint {
  return BigInt(10) ** BigInt(exponent);
}

/** Re-express a decimal at a larger decimals scale. */
export function rescale(decimal: Decimal, decimals: number): bigint {
  return decimal.value * pow10(decimals - decimal.decimals);
}

/** Bring two decimals onto a common scale. */
export function align(a: Decimal, b: Decimal): {
  a: bigint;
  b: bigint;
  decimals: number;
} {
  const decimals = Math.max(a.decimals, b.decimals);
  return { a: rescale(a, decimals), b: rescale(b, decimals), decimals };
}

export function absBigInt(value: bigint): bigint {
  return value < BigInt(0) ? -value : value;
}

/** Render an unscaled BigInt as a decimal string, dropping trailing zeros. */
export function formatScaled(
  value: bigint,
  decimals: number,
  trimTrailingZeros = true
): string {
  if (decimals <= 0) {
    return value.toString();
  }
  const negative = value < BigInt(0);
  const digits = absBigInt(value).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  let fraction = digits.slice(digits.length - decimals);
  if (trimTrailingZeros) {
    fraction = fraction.replace(TRAILING_ZEROS, "");
  }
  const body = fraction === "" ? whole : `${whole}.${fraction}`;
  return negative ? `-${body}` : body;
}

/** Divide two BigInts, returning the quotient scaled to `decimals` places. */
export function divideScaled(
  numerator: bigint,
  denominator: bigint,
  decimals: number
): bigint {
  return (numerator * pow10(decimals)) / denominator;
}
