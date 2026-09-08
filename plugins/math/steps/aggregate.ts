import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { runPluginStep, type StepInput } from "@/lib/workflow/executor/step-handler";
import { getErrorMessage } from "@/lib/utils";

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

// ─── Types ──────────────────────────────────────────────────────────────────

type AggregateOperation = (typeof AGGREGATE_OPERATIONS)[number];
type BinaryPostOperation = (typeof BINARY_POST_OPERATIONS)[number];
type UnaryPostOperation = (typeof UNARY_POST_OPERATIONS)[number];
type PostOperation = (typeof ALL_POST_OPERATIONS)[number];
type InputMode = (typeof INPUT_MODES)[number];
type ResultType = (typeof RESULT_TYPES)[number];

type NumericValue =
  | { kind: "number"; value: number }
  | { kind: "bigint"; value: bigint };

type AggregateResult =
  | {
      success: true;
      result: string;
      resultType: ResultType;
      operation: string;
      inputCount: number;
    }
  | { success: false; error: string; errorClass?: ExecutionErrorType };

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

const BIGINT_ARITHMETIC: ArithmeticOperations<bigint> = {
  zero: BIGINT_ZERO,
  one: BIGINT_ONE,
  two: BIGINT_TWO,
  addition: (a, b) => a + b,
  multiply: (a, b) => a * b,
  divide: (a, b) => a / b,
  lessThan: (a, b) => a < b,
  sortAscending: (values) =>
    [...values].sort((a, b) => {
      if (a < b) {
        return -1;
      }
      if (a > b) {
        return 1;
      }
      return 0;
    }),
  fromLength: (n) => BigInt(n),
  toString: (a) => a.toString(),
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
      return { kind: "bigint", value: bi };
    }
    return { kind: "number", value: Number(bi) };
  }
  const num = Number(cleaned);
  return Number.isFinite(num) ? { kind: "number", value: num } : null;
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

function convertNumericValuesToBigInts(values: NumericValue[]): bigint[] {
  return values.map((v) =>
    v.kind === "bigint" ? v.value : BigInt(Math.trunc(v.value))
  );
}

function convertNumericValuesToNumbers(values: NumericValue[]): number[] {
  return values.map((v) => (v.kind === "number" ? v.value : Number(v.value)));
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
): number {
  switch (postOp) {
    case "add":
      return value + operand;
    case "subtract":
      return value - operand;
    case "multiply":
      return value * operand;
    case "divide":
      if (operand === 0) {
        throw new Error("Division by zero.");
      }
      return value / operand;
    case "modulo":
      if (operand === 0) {
        throw new Error("Modulo by zero.");
      }
      return value % operand;
    case "power":
      return value ** operand;
    case "round-decimals": {
      const factor = 10 ** Math.trunc(operand);
      return Math.round(value * factor) / factor;
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
): number {
  if (isBinaryPostOperation(postOp)) {
    if (operand === null) {
      throw new Error(
        `postOperand is required for "${postOp}" post-operation.`
      );
    }
    return applyBinaryPostOperation(value, postOp, operand);
  }
  return applyUnaryPostOperation(value, postOp);
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

    const needsBigInt = parsed.some((v) => v.kind === "bigint");
    const { postOperation } = input;

    if (needsBigInt) {
      const aggregated = computeAggregation(
        convertNumericValuesToBigInts(parsed),
        input.operation,
        BIGINT_ARITHMETIC
      );

      if (!isActivePostOperation(postOperation)) {
        return {
          success: true,
          result: aggregated,
          resultType: "bigint",
          operation: buildOperationLabel(input),
          inputCount: parsed.length,
        };
      }

      // Post-operations use Number arithmetic — convert only the aggregated
      // result, preserving BigInt precision for the aggregation step itself
      let result = Number(aggregated);
      const operandSource =
        postOperation === "round-decimals"
          ? input.postDecimalPlaces
          : input.postOperand;
      const operand = parseUnknownToNumber(operandSource);
      result = applyPostOperation(result, postOperation, operand);

      return {
        success: true,
        result: String(result),
        resultType: "number",
        operation: buildOperationLabel(input),
        inputCount: parsed.length,
      };
    }

    const aggregated = computeAggregation(
      convertNumericValuesToNumbers(parsed),
      input.operation,
      NUMBER_ARITHMETIC
    );
    let result = Number(aggregated);

    if (isActivePostOperation(postOperation)) {
      const operandSource =
        postOperation === "round-decimals"
          ? input.postDecimalPlaces
          : input.postOperand;
      const operand = parseUnknownToNumber(operandSource);
      result = applyPostOperation(result, postOperation, operand);
    }

    return {
      success: true,
      result: String(result),
      resultType: "number",
      operation: buildOperationLabel(input),
      inputCount: parsed.length,
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
