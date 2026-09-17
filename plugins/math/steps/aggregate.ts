import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { runPluginStep, type StepInput } from "@/lib/workflow/executor/step-handler";
import { getErrorMessage } from "@/lib/utils";
import {
  type Decimal,
  divideScaled,
  formatScaled,
  parseDecimal,
  pow10,
  rescale,
} from "./decimal-core";

// ─── Constants ──────────────────────────────────────────────────────────────

const PLUGIN_NAME = "math";
const ACTION_NAME = "aggregate";

const AGGREGATE_OPERATIONS = [
  "sum",
  "count",
  "average",
  "median",
  "min",
  "max",
  "product",
] as const;

/** Post-ops that require an operand (binary) */
const BINARY_POST_OPERATIONS = [
  "multiply",
  "divide",
  "modulo",
  "subtract",
  "add",
  "power",
  "round-decimals",
] as const;

/** Post-ops that take no operand (unary) */
const UNARY_POST_OPERATIONS = ["abs", "round", "floor", "ceil"] as const;

const ALL_POST_OPERATIONS = [
  "none",
  ...BINARY_POST_OPERATIONS,
  ...UNARY_POST_OPERATIONS,
] as const;

const INPUT_MODES = ["array", "explicit"] as const;
const RESULT_TYPES = ["number", "bigint"] as const;

const BIGINT_ZERO = BigInt(0);
const BIGINT_ONE = BigInt(1);
const BIGINT_TWO = BigInt(2);
const EXPLICIT_SEPARATOR = /[,\n]+/;
const COMMA_STRIP = /,/g;
const INTEGER_PATTERN = /^-?\d+$/;
// A fixed-point division that cannot be exact (average, the divide post-op)
// keeps at least this many fractional digits and at least this many
// significant digits, whichever needs more, then truncates. 18 covers a wei
// amount divided by 1e18 exactly and a dust amount over a raw supply to 18
// significant digits.
const DIVISION_PRECISION = 18;
// The text grammars that convert to fixed point exactly. Anything else that
// Number() accepts ("0x10", "5.") is carried as the float's own digits.
const DECIMAL_TEXT = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;
const EXPONENT_FORM = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))[eE]([+-]?\d+)$/;
// Bounds on the fixed-point work, so ordinary input cannot make the step
// spend seconds or memory on digits no on-chain unit has. Fractional digits
// beyond MAX_SCALE are dropped wherever a scale is produced: on every parsed
// value, and after each product, power and division. An integer power whose
// result would pass MAX_DIGITS goes through float instead.
const MAX_SCALE = 256;
const MAX_DIGITS = 4096;
const MAX_EXACT_POWER = 256;

// ─── Types ──────────────────────────────────────────────────────────────────

type AggregateOperation = (typeof AGGREGATE_OPERATIONS)[number];
type BinaryPostOperation = (typeof BINARY_POST_OPERATIONS)[number];
type UnaryPostOperation = (typeof UNARY_POST_OPERATIONS)[number];
type PostOperation = (typeof ALL_POST_OPERATIONS)[number];
type InputMode = (typeof INPUT_MODES)[number];
type ResultType = (typeof RESULT_TYPES)[number];

type NumericValue =
  | { kind: "number"; value: number; text: string }
  | { kind: "bigint"; value: bigint; text: string };

type AggregateResult =
  | {
      success: true;
      result: string;
      resultType: ResultType;
      operation: string;
      inputCount: number;
      divisionByZero?: true;
    }
  | { success: false; error: string; errorClass?: ExecutionErrorType };

// Division by zero is reported, not thrown, so a workflow can branch on it:
// a zero denominator is a legitimate state for a ratio. The reported value
// follows IEEE arithmetic (Infinity, -Infinity, NaN).
type PostResult<T> =
  | { kind: "value"; value: T }
  | { kind: "float"; value: number }
  | { kind: "divisionByZero"; value: number };

export type AggregateCoreInput = {
  operation: AggregateOperation;
  inputMode: InputMode;
  arrayInput?: string;
  fieldPath?: string;
  explicitValues?: string;
  postOperation?: PostOperation;
  postOperand?: string;
  postDecimalPlaces?: string;
};

export type AggregateInput = StepInput & AggregateCoreInput;

/**
 * Arithmetic primitives for a numeric type.
 * Allows a single generic aggregation function to work with both number and bigint.
 */
type ArithmeticOperations<T> = {
  zero: T;
  one: T;
  two: T;
  addition: (a: T, b: T) => T;
  multiply: (a: T, b: T) => T;
  divide: (a: T, b: T) => T;
  lessThan: (a: T, b: T) => boolean;
  sortAscending: (values: T[]) => T[];
  fromLength: (n: number) => T;
  toString: (a: T) => string;
};

// ─── Validation ─────────────────────────────────────────────────────────────

const VALID_OPERATIONS: ReadonlySet<string> = new Set(AGGREGATE_OPERATIONS);
const VALID_POST_OPERATIONS: ReadonlySet<string> = new Set(ALL_POST_OPERATIONS);
const BINARY_POST_OPS_SET: ReadonlySet<string> = new Set(
  BINARY_POST_OPERATIONS
);

function isValidOperation(value: string): value is AggregateOperation {
  return VALID_OPERATIONS.has(value);
}

function isActivePostOperation(
  value: string | undefined
): value is BinaryPostOperation | UnaryPostOperation {
  return (
    value !== undefined && value !== "none" && VALID_POST_OPERATIONS.has(value)
  );
}

function isBinaryPostOperation(value: string): value is BinaryPostOperation {
  return BINARY_POST_OPS_SET.has(value);
}

// ─── Error helpers ──────────────────────────────────────────────────────────

function failedAggregation(error: string): AggregateResult {
  return { success: false, error, errorClass: ExecutionErrorType.USER };
}

// ─── Arithmetic implementations ─────────────────────────────────────────────

const NUMBER_ARITHMETIC: ArithmeticOperations<number> = {
  zero: 0,
  one: 1,
  two: 2,
  addition: (a, b) => a + b,
  multiply: (a, b) => a * b,
  divide: (a, b) => a / b,
  lessThan: (a, b) => a < b,
  sortAscending: (values) => [...values].sort((a, b) => a - b),
  fromLength: (n) => n,
  toString: (a) => String(a),
};

// ─── Numeric parsing ────────────────────────────────────────────────────────

function sanitizeRawValueToString(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : null;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "string") {
    const cleaned = value.replace(COMMA_STRIP, "").trim();
    return cleaned === "" ? null : cleaned;
  }
  return null;
}

function parseStringToNumericValue(cleaned: string): NumericValue | null {
  if (INTEGER_PATTERN.test(cleaned)) {
    const bi = BigInt(cleaned);
    if (
      bi > BigInt(Number.MAX_SAFE_INTEGER) ||
      bi < BigInt(-Number.MAX_SAFE_INTEGER)
    ) {
      return { kind: "bigint", value: bi, text: cleaned };
    }
    return { kind: "number", value: Number(bi), text: cleaned };
  }
  const num = Number(cleaned);
  if (!Number.isFinite(num)) {
    return null;
  }
  const exact = DECIMAL_TEXT.test(cleaned) || EXPONENT_FORM.test(cleaned);
  return { kind: "number", value: num, text: exact ? cleaned : String(num) };
}

function parseUnknownToNumericValue(value: unknown): NumericValue | null {
  const cleaned = sanitizeRawValueToString(value);
  if (cleaned === null) {
    return null;
  }
  return parseStringToNumericValue(cleaned);
}

function parseUnknownToNumber(value: unknown): number | null {
  const cleaned = sanitizeRawValueToString(value);
  if (cleaned === null) {
    return null;
  }
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

// ─── Field path resolution ──────────────────────────────────────────────────

function resolveFieldPath(obj: unknown, path: string): unknown {
  let current: unknown = obj;
  for (const segment of path.split(".")) {
    if (
      current === null ||
      current === undefined ||
      typeof current !== "object"
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

// ─── Value extraction ───────────────────────────────────────────────────────

function parseJsonToArray(input: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error(
      "arrayInput is not valid JSON. Expected a JSON array, e.g. [1, 2, 3]."
    );
  }

  if (Array.isArray(parsed)) {
    return parsed;
  }

  throw new Error(
    "arrayInput must be a JSON array. If your upstream node returns an object, reference the array field directly in your template variable, e.g. {{@node:Label.rows}} instead of {{@node:Label}}."
  );
}

function collectNumericValues(
  items: unknown[],
  fieldPath: string | undefined
): NumericValue[] {
  const values: NumericValue[] = [];
  for (const item of items) {
    const raw = fieldPath ? resolveFieldPath(item, fieldPath) : item;
    const numericValue = parseUnknownToNumericValue(raw);
    if (numericValue !== null) {
      values.push(numericValue);
    }
  }
  return values;
}

function extractArrayValues(
  arrayInput: string,
  fieldPath: string | undefined
): NumericValue[] {
  const items = parseJsonToArray(arrayInput);
  return collectNumericValues(items, fieldPath);
}

function extractExplicitValues(explicitValues: string): NumericValue[] {
  const parts = explicitValues.split(EXPLICIT_SEPARATOR);
  const values: NumericValue[] = [];
  for (const part of parts) {
    const numericValue = parseUnknownToNumericValue(part);
    if (numericValue !== null) {
      values.push(numericValue);
    }
  }
  return values;
}

// ─── Type conversion ────────────────────────────────────────────────────────

function convertNumericValuesToNumbers(values: NumericValue[]): number[] {
  return values.map((v) => (v.kind === "number" ? v.value : Number(v.value)));
}

// ─── Fixed-point conversion ─────────────────────────────────────────────────

// Drops fractional digits past MAX_SCALE. Applied wherever a scale is made,
// so no input or intermediate can push the whole set to an absurd scale.
function boundScale(d: Decimal): Decimal {
  if (d.decimals <= MAX_SCALE) {
    return d;
  }
  return {
    value: d.value / pow10(d.decimals - MAX_SCALE),
    decimals: MAX_SCALE,
  };
}

function digitCount(value: bigint): number {
  return (value < BIGINT_ZERO ? -value : value).toString().length;
}

// "1.5e-3" is the decimal 1.5 shifted three places: exact, no float involved.
// A shift far below MAX_SCALE lands on zero, as the float would.
function parseExponentForm(text: string): Decimal | null {
  const match = EXPONENT_FORM.exec(text);
  if (match === null) {
    return null;
  }
  const mantissa = parseDecimal(match[1], "value");
  const exponent = Number(match[2]);
  const decimals = mantissa.decimals - exponent;
  if (decimals > MAX_SCALE) {
    return { value: BIGINT_ZERO, decimals: 0 };
  }
  if (decimals >= 0) {
    return { value: mantissa.value, decimals };
  }
  return { value: mantissa.value * pow10(-decimals), decimals: 0 };
}

// The value's own text is what gets parsed, so "0.1" stays 0.1 rather than
// the nearest float. The text is always one of the two grammars above.
function toDecimal(v: NumericValue): Decimal {
  if (v.kind === "bigint") {
    return { value: v.value, decimals: 0 };
  }
  return boundScale(
    parseExponentForm(v.text) ?? parseDecimal(v.text, "value")
  );
}

function alignAll(decimals: Decimal[]): { values: bigint[]; scale: number } {
  let scale = 0;
  for (const d of decimals) {
    scale = Math.max(scale, d.decimals);
  }
  return { values: decimals.map((d) => rescale(d, scale)), scale };
}

// Round half up (toward +infinity, like Math.round) after dropping `drop`
// decimal places.
function roundDropping(value: bigint, drop: number): bigint {
  if (drop <= 0) {
    return value;
  }
  const p = pow10(drop);
  const q = value / p;
  const r = value - q * p;
  if (r * BIGINT_TWO >= p) {
    return q + BIGINT_ONE;
  }
  if (r * BIGINT_TWO < -p) {
    return q - BIGINT_ONE;
  }
  return q;
}

function floorDropping(value: bigint, drop: number): bigint {
  if (drop <= 0) {
    return value;
  }
  const p = pow10(drop);
  const q = value / p;
  return value < BIGINT_ZERO && q * p !== value ? q - BIGINT_ONE : q;
}

function ceilDropping(value: bigint, drop: number): bigint {
  if (drop <= 0) {
    return value;
  }
  const p = pow10(drop);
  const q = value / p;
  return value > BIGINT_ZERO && q * p !== value ? q + BIGINT_ONE : q;
}

// The quotient keeps DIVISION_PRECISION fractional digits, and more when the
// magnitudes call for it: a numerator far smaller than its denominator would
// otherwise truncate to zero and be labelled whole.
function decimalDivide(numerator: Decimal, denominator: Decimal): Decimal {
  const { values, scale } = alignAll([numerator, denominator]);
  const [n, d] = values;
  const magnitudeGap = digitCount(d) - digitCount(n);
  const wanted = Math.max(
    scale,
    DIVISION_PRECISION,
    DIVISION_PRECISION + magnitudeGap
  );
  const quotientScale = Math.min(wanted, MAX_SCALE);
  return { value: divideScaled(n, d, quotientScale), decimals: quotientScale };
}

function sortBigInts(values: bigint[]): bigint[] {
  return [...values].sort((a, b) => {
    if (a < b) {
      return -1;
    }
    return a > b ? 1 : 0;
  });
}

// Called with at least one value: the fixed-point path only runs when some
// value is a bigint.
function aggregateDecimals(
  decimals: Decimal[],
  operation: AggregateOperation
): Decimal {
  const { values, scale } = alignAll(decimals);
  const sum = reduceValues(values, BIGINT_ZERO, (a, b) => a + b);

  switch (operation) {
    case "sum":
      return { value: sum, decimals: scale };
    case "count":
      return { value: BigInt(values.length), decimals: 0 };
    case "average":
      return decimalDivide(
        { value: sum, decimals: scale },
        { value: BigInt(values.length), decimals: 0 }
      );
    case "median": {
      const sorted = sortBigInts(values);
      const mid = Math.floor(sorted.length / 2);
      if (sorted.length % 2 === 0) {
        // One extra place makes halving exact.
        const doubled = (sorted[mid - 1] + sorted[mid]) * BigInt(10);
        return boundScale({ value: doubled / BIGINT_TWO, decimals: scale + 1 });
      }
      return { value: sorted[mid], decimals: scale };
    }
    case "min":
      return { value: findExtremeValue(values, (a, b) => a < b), decimals: scale };
    case "max":
      return { value: findExtremeValue(values, (a, b) => b < a), decimals: scale };
    case "product":
      return decimals.reduce<Decimal>(
        (acc, d) =>
          boundScale({
            value: acc.value * d.value,
            decimals: acc.decimals + d.decimals,
          }),
        { value: BIGINT_ONE, decimals: 0 }
      );
    default:
      throw new Error(`Unknown operation: ${operation}`);
  }
}

function valueOf<T>(value: T): PostResult<T> {
  return { kind: "value", value };
}

function applyBinaryDecimalPostOperation(
  value: Decimal,
  postOp: BinaryPostOperation,
  operand: NumericValue
): PostResult<Decimal> {
  const operandDecimal = toDecimal(operand);
  const exponent = Number(operand.value);
  const { values, scale } = alignAll([value, operandDecimal]);
  const [a, b] = values;
  switch (postOp) {
    case "add":
      return valueOf({ value: a + b, decimals: scale });
    case "subtract":
      return valueOf({ value: a - b, decimals: scale });
    case "multiply":
      return valueOf({
        value: value.value * operandDecimal.value,
        decimals: value.decimals + operandDecimal.decimals,
      });
    case "divide":
      if (b === BIGINT_ZERO) {
        return divisionByZero(value, postOp);
      }
      return valueOf(decimalDivide(value, operandDecimal));
    case "modulo":
      if (b === BIGINT_ZERO) {
        return divisionByZero(value, postOp);
      }
      return valueOf({ value: a % b, decimals: scale });
    case "power": {
      if (
        Number.isInteger(exponent) &&
        exponent >= 0 &&
        exponent <= MAX_EXACT_POWER &&
        digitCount(value.value) * exponent <= MAX_DIGITS
      ) {
        return valueOf(
          boundScale({
            value: value.value ** BigInt(exponent),
            decimals: value.decimals * exponent,
          })
        );
      }
      return {
        kind: "float",
        value: Number(formatScaled(value.value, value.decimals)) ** exponent,
      };
    }
    case "round-decimals": {
      const places = Math.trunc(exponent);
      if (places >= value.decimals) {
        return valueOf(value);
      }
      if (places >= 0) {
        return valueOf({
          value: roundDropping(value.value, value.decimals - places),
          decimals: places,
        });
      }
      // Negative places round to tens, hundreds, ... as the number path does.
      const rounded = roundDropping(value.value, value.decimals - places);
      return valueOf({ value: rounded * pow10(-places), decimals: 0 });
    }
    default:
      throw new Error(`Unknown post-operation: ${postOp}`);
  }
}

function applyUnaryDecimalPostOperation(
  value: Decimal,
  postOp: UnaryPostOperation
): Decimal {
  switch (postOp) {
    case "abs":
      return {
        value: value.value < BIGINT_ZERO ? -value.value : value.value,
        decimals: value.decimals,
      };
    case "round":
      return { value: roundDropping(value.value, value.decimals), decimals: 0 };
    case "floor":
      return { value: floorDropping(value.value, value.decimals), decimals: 0 };
    case "ceil":
      return { value: ceilDropping(value.value, value.decimals), decimals: 0 };
    default:
      throw new Error(`Unknown post-operation: ${postOp}`);
  }
}

function applyDecimalPostOperation(
  value: Decimal,
  postOp: BinaryPostOperation | UnaryPostOperation,
  operand: NumericValue | null
): PostResult<Decimal> {
  if (isBinaryPostOperation(postOp)) {
    if (operand === null) {
      throw new Error(
        `postOperand is required for "${postOp}" post-operation.`
      );
    }
    return applyBinaryDecimalPostOperation(value, postOp, operand);
  }
  return valueOf(applyUnaryDecimalPostOperation(value, postOp));
}

function isWholeDecimal(d: Decimal): boolean {
  return d.decimals <= 0 || d.value % pow10(d.decimals) === BIGINT_ZERO;
}

function divisionByZero(
  numerator: Decimal | number,
  postOp: BinaryPostOperation
): PostResult<never> {
  const sign =
    typeof numerator === "number"
      ? Math.sign(numerator)
      : Number(numerator.value > BIGINT_ZERO) - Number(numerator.value < BIGINT_ZERO);
  if (postOp === "modulo" || sign === 0) {
    return { kind: "divisionByZero", value: Number.NaN };
  }
  return {
    kind: "divisionByZero",
    value: sign < 0 ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
  };
}

// ─── Generic aggregation ────────────────────────────────────────────────────

function reduceValues<T>(
  values: T[],
  initial: T,
  accumulator: (acc: T, current: T) => T
): T {
  let result = initial;
  for (const value of values) {
    result = accumulator(result, value);
  }
  return result;
}

function findExtremeValue<T>(
  values: T[],
  isLessThan: (a: T, b: T) => boolean
): T {
  let extreme = values[0];
  for (const value of values) {
    if (isLessThan(value, extreme)) {
      extreme = value;
    }
  }
  return extreme;
}

function computeMedian<T>(values: T[], arithmetic: ArithmeticOperations<T>): T {
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

function computeAggregation<T>(
  values: T[],
  operation: AggregateOperation,
  arithmetic: ArithmeticOperations<T>
): string {
  if (values.length === 0) {
    if (operation === "count" || operation === "sum") {
      return arithmetic.toString(arithmetic.zero);
    }
    if (operation === "product") {
      return arithmetic.toString(arithmetic.one);
    }
    throw new Error(`Cannot compute ${operation} on an empty set of values.`);
  }

  switch (operation) {
    case "sum":
      return arithmetic.toString(
        reduceValues(values, arithmetic.zero, arithmetic.addition)
      );
    case "count":
      return String(values.length);
    case "average":
      return arithmetic.toString(
        arithmetic.divide(
          reduceValues(values, arithmetic.zero, arithmetic.addition),
          arithmetic.fromLength(values.length)
        )
      );
    case "median":
      return arithmetic.toString(computeMedian(values, arithmetic));
    case "min":
      return arithmetic.toString(findExtremeValue(values, arithmetic.lessThan));
    case "max":
      return arithmetic.toString(
        findExtremeValue(values, (a, b) => arithmetic.lessThan(b, a))
      );
    case "product":
      return arithmetic.toString(
        reduceValues(values, arithmetic.one, arithmetic.multiply)
      );
    default:
      throw new Error(`Unknown operation: ${operation}`);
  }
}

// ─── Post-operations ────────────────────────────────────────────────────────

function applyBinaryPostOperation(
  value: number,
  postOp: BinaryPostOperation,
  operand: number
): PostResult<number> {
  switch (postOp) {
    case "add":
      return valueOf(value + operand);
    case "subtract":
      return valueOf(value - operand);
    case "multiply":
      return valueOf(value * operand);
    case "divide":
      if (operand === 0) {
        return divisionByZero(value, postOp);
      }
      return valueOf(value / operand);
    case "modulo":
      if (operand === 0) {
        return divisionByZero(value, postOp);
      }
      return valueOf(value % operand);
    case "power":
      return valueOf(value ** operand);
    case "round-decimals": {
      const factor = 10 ** Math.trunc(operand);
      return valueOf(Math.round(value * factor) / factor);
    }
    default:
      throw new Error(`Unknown post-operation: ${postOp}`);
  }
}

function applyUnaryPostOperation(
  value: number,
  postOp: UnaryPostOperation
): number {
  switch (postOp) {
    case "abs":
      return Math.abs(value);
    case "round":
      return Math.round(value);
    case "floor":
      return Math.floor(value);
    case "ceil":
      return Math.ceil(value);
    default:
      throw new Error(`Unknown post-operation: ${postOp}`);
  }
}

function applyPostOperation(
  value: number,
  postOp: BinaryPostOperation | UnaryPostOperation,
  operand: number | null
): PostResult<number> {
  if (isBinaryPostOperation(postOp)) {
    if (operand === null) {
      throw new Error(
        `postOperand is required for "${postOp}" post-operation.`
      );
    }
    return applyBinaryPostOperation(value, postOp, operand);
  }
  return valueOf(applyUnaryPostOperation(value, postOp));
}

function postOperandOf(input: AggregateCoreInput): NumericValue | null {
  return parseUnknownToNumericValue(
    input.postOperation === "round-decimals"
      ? input.postDecimalPlaces
      : input.postOperand
  );
}

// ─── Input parsing ──────────────────────────────────────────────────────────

function parseInputValues(
  input: AggregateCoreInput
): NumericValue[] | AggregateResult {
  if (input.inputMode === "array") {
    if (!input.arrayInput) {
      return failedAggregation(
        "arrayInput is required in array mode. Reference an upstream node output containing a JSON array."
      );
    }
    return extractArrayValues(input.arrayInput, input.fieldPath);
  }

  if (input.inputMode === "explicit") {
    if (!input.explicitValues) {
      return failedAggregation(
        "explicitValues is required in explicit mode. Provide comma-separated or newline-separated values."
      );
    }
    return extractExplicitValues(input.explicitValues);
  }

  return failedAggregation(
    `Invalid inputMode "${input.inputMode}". Must be "array" or "explicit".`
  );
}

function validatePostOperation(
  input: AggregateCoreInput
): AggregateResult | null {
  const { postOperation } = input;
  if (!postOperation || postOperation === "none") {
    return null;
  }
  if (!VALID_POST_OPERATIONS.has(postOperation)) {
    return failedAggregation(
      `Invalid postOperation "${postOperation}". Must be one of: ${ALL_POST_OPERATIONS.join(", ")}.`
    );
  }
  if (isBinaryPostOperation(postOperation)) {
    const operandSource =
      postOperation === "round-decimals"
        ? input.postDecimalPlaces
        : input.postOperand;
    const operand = parseUnknownToNumber(operandSource);
    if (operand === null) {
      const fieldName =
        postOperation === "round-decimals"
          ? "postDecimalPlaces"
          : "postOperand";
      return failedAggregation(
        `${fieldName} is required and must be a valid number for "${postOperation}" post-operation.`
      );
    }
  }
  return null;
}

function buildOperationLabel(input: AggregateCoreInput): string {
  const { postOperation } = input;
  return isActivePostOperation(postOperation)
    ? `${input.operation} then ${postOperation}`
    : input.operation;
}

// ─── Core step handler ──────────────────────────────────────────────────────

function stepHandler(input: AggregateCoreInput): AggregateResult {
  try {
    if (!isValidOperation(input.operation)) {
      return failedAggregation(
        `Invalid operation "${input.operation}". Must be one of: ${AGGREGATE_OPERATIONS.join(", ")}.`
      );
    }

    const parsed = parseInputValues(input);
    if (!Array.isArray(parsed)) {
      return parsed;
    }

    const postError = validatePostOperation(input);
    if (postError !== null) {
      return postError;
    }

    const { postOperation } = input;
    const operationLabel = buildOperationLabel(input);
    const operand = postOperandOf(input);

    // Any value outside the safe-integer range puts the whole set on the
    // fixed-point path, where a fractional sibling keeps its digits instead
    // of being truncated to an integer.
    if (parsed.some((v) => v.kind === "bigint")) {
      const aggregated = aggregateDecimals(
        parsed.map(toDecimal),
        input.operation
      );
      const post = isActivePostOperation(postOperation)
        ? applyDecimalPostOperation(aggregated, postOperation, operand)
        : valueOf(aggregated);
      if (post.kind !== "value") {
        return {
          success: true,
          result: String(post.value),
          resultType: "number",
          operation: operationLabel,
          inputCount: parsed.length,
          ...(post.kind === "divisionByZero" ? { divisionByZero: true } : {}),
        };
      }
      return {
        success: true,
        result: formatScaled(post.value.value, post.value.decimals),
        resultType: isWholeDecimal(post.value) ? "bigint" : "number",
        operation: operationLabel,
        inputCount: parsed.length,
      };
    }

    const aggregated = Number(
      computeAggregation(
        convertNumericValuesToNumbers(parsed),
        input.operation,
        NUMBER_ARITHMETIC
      )
    );
    const post = isActivePostOperation(postOperation)
      ? applyPostOperation(
          aggregated,
          postOperation,
          operand === null ? null : Number(operand.value)
        )
      : valueOf(aggregated);

    return {
      success: true,
      result: String(post.value),
      resultType: "number",
      operation: operationLabel,
      inputCount: parsed.length,
      ...(post.kind === "divisionByZero" ? { divisionByZero: true } : {}),
    };
  } catch (error) {
    return failedAggregation(`Aggregation failed: ${getErrorMessage(error)}`);
  }
}

// ─── Entry point ────────────────────────────────────────────────────────────

export async function aggregateStep(
  input: AggregateInput
): Promise<AggregateResult> {
  "use step";

  return runPluginStep(
    { pluginName: PLUGIN_NAME, actionName: ACTION_NAME },
    input,
    () => Promise.resolve(stepHandler(input))
  );
}

aggregateStep.maxRetries = 0;

export const _integrationType = PLUGIN_NAME;
