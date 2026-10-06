/**
 * Fixed-point decimal helpers shared by the Math steps.
 *
 * Values are carried as a BigInt mantissa plus a decimal exponent so RAD/WAD
 * magnitude numbers (1e45 / 1e18) survive comparison and formatting without
 * the float precision loss a plain `Number` round-trip introduces.
 *
 * Also holds the tolerance, list-parsing and median helpers that more than one
 * step needs, so the steps stay free of copies.
 *
 * No "use step" directive: imported by several step files.
 */

import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

const DECIMAL_PATTERN = /^[+-]?(\d+)?(\.\d+)?$/;
const SEPARATOR_STRIP = /[,_\s]/g;
const TRAILING_ZEROS = /0+$/;
const SIGN_PREFIX = /^[+-]/;

const TEN = BigInt(10);
const TWO = BigInt(2);

export const DEFAULT_PRECISION = 6;
export const MAX_PRECISION = 30;
export const HUNDRED = BigInt(100);
export const ZERO = BigInt(0);

export type Mode = "percent" | "absolute";

export type Decimal = {
  /** Unscaled value: the real number is `value / 10 ** decimals`. */
  value: bigint;
  decimals: number;
};

export type StepFailure = {
  success: false;
  error: string;
  errorClass: ExecutionErrorType;
};

/** Failure shape every Math step returns for bad author input. */
export function failed(error: string): StepFailure {
  return { success: false, error, errorClass: ExecutionErrorType.USER };
}

export function resolveMode(raw: string | undefined): Mode {
  return raw === "absolute" ? "absolute" : "percent";
}

export function resolvePrecision(raw: string | number | undefined): number {
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_PRECISION;
  }
  return Math.min(Math.trunc(parsed), MAX_PRECISION);
}

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

/** Bring any number of decimals onto a common scale. */
export function alignAll(decimals: Decimal[]): {
  values: bigint[];
  scale: number;
} {
  let scale = 0;
  for (const d of decimals) {
    scale = Math.max(scale, d.decimals);
  }
  return { values: decimals.map((d) => rescale(d, scale)), scale };
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

/**
 * Percent tolerance without dividing first: `|diff| / |base| <= tol / 100` is
 * checked as `|diff| * 100 * 10^td <= tol * |base|`, so both sides stay
 * integral and nothing is lost at RAD/WAD magnitudes.
 */
export function isWithinPercent(
  absoluteDifference: bigint,
  base: bigint,
  tolerance: Decimal
): boolean {
  if (base === ZERO) {
    return absoluteDifference === ZERO;
  }
  const left = absoluteDifference * HUNDRED * pow10(tolerance.decimals);
  const right = absBigInt(tolerance.value) * absBigInt(base);
  return left <= right;
}

/** Absolute tolerance compared on the wider of the two scales, so a tolerance with more decimal places than the values never rescales by a negative exponent. */
export function isWithinAbsolute(
  absoluteDifference: bigint,
  decimals: number,
  tolerance: Decimal
): boolean {
  const scale = Math.max(decimals, tolerance.decimals);
  const scaledDifference = absoluteDifference * pow10(scale - decimals);
  return absBigInt(scaledDifference) <= absBigInt(rescale(tolerance, scale));
}

export function sortBigIntsAscending(values: bigint[]): bigint[] {
  return [...values].sort((a, b) => {
    if (a < b) {
      return -1;
    }
    if (a > b) {
      return 1;
    }
    return 0;
  });
}

export type MedianArithmetic<T> = {
  two: T;
  addition: (a: T, b: T) => T;
  divide: (a: T, b: T) => T;
  sortAscending: (values: T[]) => T[];
};

export function computeMedian<T>(
  values: T[],
  arithmetic: MedianArithmetic<T>
): T {
  const sorted = arithmetic.sortAscending(values);
  const midIndex = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return arithmetic.divide(
      arithmetic.addition(sorted[midIndex - 1], sorted[midIndex]),
      arithmetic.two
    );
  }
  return sorted[midIndex];
}

const BIGINT_MEDIAN_ARITHMETIC: MedianArithmetic<bigint> = {
  two: TWO,
  addition: (a, b) => a + b,
  divide: (a, b) => a / b,
  sortAscending: sortBigIntsAscending,
};

/** Median of values already on a common scale, widened one place so the mean of the two middle entries is exact. */
export function medianScaled(values: bigint[], decimals: number): Decimal {
  const widened = values.map((value) => value * TEN);
  return {
    value: computeMedian(widened, BIGINT_MEDIAN_ARITHMETIC),
    decimals: decimals + 1,
  };
}

/** Parse a JSON array, with a workflow-friendly message when the input is not one. */
export function parseJsonArray(input: string, fieldName: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error(
      `${fieldName} is not valid JSON. Expected a JSON array, e.g. [1, 2, 3].`
    );
  }

  if (Array.isArray(parsed)) {
    return parsed;
  }

  throw new Error(
    `${fieldName} must be a JSON array. If your upstream node returns an object, reference the array field directly in your template variable, e.g. {{@node:Label.rows}} instead of {{@node:Label}}.`
  );
}

/** Split a delimited list into trimmed, non-empty entries. */
export function splitValueList(raw: string, separator: RegExp): string[] {
  return raw
    .split(separator)
    .map((part) => part.trim())
    .filter(Boolean);
}

function valueEntryToString(item: unknown): string {
  if (item !== null && typeof item === "object") {
    const record = item as Record<string, unknown>;
    return String(record.value ?? record.price ?? record.result ?? item).trim();
  }
  return String(item ?? "").trim();
}

/** Read a list of raw value strings from either a JSON array or a delimited list. */
export function parseValueList(raw: unknown, separator: RegExp): string[] {
  if (typeof raw !== "string") {
    return [];
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return [];
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      return parseJsonArray(trimmed, "values")
        .map(valueEntryToString)
        .filter(Boolean);
    } catch {
      // Not a JSON array, fall through to the delimited form.
    }
  }
  return splitValueList(trimmed, separator);
}

/** Divide two BigInts and round the mathematical result toward positive infinity. */
export function divideCeil(
  numerator: bigint,
  denominator: bigint
): bigint {
  if (denominator === BigInt(0)) {
    throw new Error("Cannot divide by zero.");
  }

  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === BigInt(0)) {
    return quotient;
  }

  const sameSign =
    (numerator > BigInt(0) && denominator > BigInt(0)) ||
    (numerator < BigInt(0) && denominator < BigInt(0));

  return sameSign ? quotient + BigInt(1) : quotient;
}
