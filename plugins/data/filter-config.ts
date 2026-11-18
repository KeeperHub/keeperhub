/**
 * The Filter Array config parsing shared by the step and the save-time check.
 * Kept free of the condition evaluator so the plugin definition, which the
 * editor loads, can run the save-time check without bundling it.
 */

import { getErrorMessage } from "@/lib/utils";
import { valueContainsTemplate } from "@/lib/workflow/template-ref";
import {
  CASE_FOLDING_FILTER_OPERATORS,
  DEFAULT_FILTER_OPERATOR,
  FILTER_OPERATOR_OPTIONS,
  type FilterOperator,
  filterOperatorLabel,
  KEEP_ALL_OPERATOR,
  NUMBER_FILTER_OPERATORS,
  PRESENCE_FILTER_OPERATORS,
  TEXT_FILTER_OPERATORS,
  VALUELESS_FILTER_OPERATORS,
} from "./filter-operators";
import { parseJsonValue, splitPath } from "./steps/resolve-path-core";

export const MAX_FILTER_ITEMS = 10_000;
// A uint256 is 78 digits; this leaves room for decimals without letting a
// huge Value make every comparison slow.
const MAX_NUMBER_VALUE_LENGTH = 100;
const MAX_PATH_LENGTH = 500;
const MAX_VALUE_LENGTH = 10_000;
const MAX_ECHOED_LENGTH = 60;

const DECIMAL_TEXT = /^[+-]?\d+(\.\d+)?$/;
const WHOLE_NUMBER_TEXT = /^\d+$/;
const HEX_TEXT = /^0x[0-9a-fA-F]+$/;
const DOUBLE_QUOTED = /^"[\s\S]*"$/;
const SINGLE_QUOTED = /^'([\s\S]*)'$/;
const EN_US = "en-US";

const KNOWN_OPERATORS: ReadonlySet<string> = new Set(
  FILTER_OPERATOR_OPTIONS.map((option) => option.value)
);

type UntestableItemMode = "skip" | "fail";
type MissingReturnMode = "keep" | "fail";

export type FilterCoreInput = {
  source: unknown;
  field?: unknown;
  operator?: unknown;
  value?: unknown;
  returnField?: unknown;
  labels?: unknown;
  ignoreCase?: unknown;
  untestable?: unknown;
  missingReturn?: unknown;
};

export type FilterSettings = {
  operator: FilterOperator;
  testPath: string[];
  returnPath: string[];
  returnField: string;
  untestable: UntestableItemMode;
  missingReturn: MissingReturnMode;
  ignoreCase: boolean;
};

function readPath(raw: unknown, name: string): string {
  if (raw === undefined || raw === null) {
    return "";
  }
  if (typeof raw === "number") {
    return String(raw);
  }
  if (typeof raw !== "string") {
    throw new Error(`${name} must be text, e.g. success or meta.name.`);
  }
  const path = raw.trim();
  if (path.length > MAX_PATH_LENGTH) {
    throw new Error(`${name} is longer than ${MAX_PATH_LENGTH} characters.`);
  }
  if (path !== "" && splitPath(path).some((segment) => segment === "")) {
    throw new Error(`${name} has an empty part, e.g. a..b. Write it as a.b.`);
  }
  return path;
}

function resolveOperator(raw: unknown): FilterOperator {
  if (raw !== undefined && raw !== null && typeof raw !== "string") {
    throw new Error("Operator must be text, e.g. startsWith.");
  }
  const operator = (raw ?? "").trim() || DEFAULT_FILTER_OPERATOR;
  if (operator === "matchesRegex") {
    throw new Error(
      "Matches regex is not supported in Filter Array yet. Use contains, starts with or ends with."
    );
  }
  if (!KNOWN_OPERATORS.has(operator)) {
    const shown =
      operator.length > MAX_ECHOED_LENGTH
        ? `${operator.slice(0, MAX_ECHOED_LENGTH)}...`
        : operator;
    throw new Error(`Unknown operator "${shown}".`);
  }
  return operator as FilterOperator;
}

function readSwitch(raw: unknown, name: string): boolean {
  if (raw === undefined || raw === null || raw === "") {
    return false;
  }
  if (raw === true || raw === "true") {
    return true;
  }
  if (raw === false || raw === "false") {
    return false;
  }
  throw new Error(`${name} must be true or false.`);
}

function readMissingReturnMode(raw: unknown): MissingReturnMode {
  if (raw === undefined || raw === null || raw === "") {
    return "keep";
  }
  if (raw === "keep" || raw === "fail") {
    return raw;
  }
  throw new Error('If a match has no Return field must be "keep" or "fail".');
}

// Fail by default, so a read an attacker can make revert cannot pass quietly.
function readUntestableMode(raw: unknown): UntestableItemMode {
  if (raw === undefined || raw === null || raw === "") {
    return "fail";
  }
  if (raw === "skip" || raw === "fail") {
    return raw;
  }
  throw new Error('If an item can\'t be tested must be "skip" or "fail".');
}

// The settings the form shows for this operator; hidden ones are not read,
// so a stale hidden value can neither steer nor fail the step.
export function readSettings(input: FilterCoreInput): FilterSettings {
  const operator = resolveOperator(input.operator);
  const keepAll = operator === KEEP_ALL_OPERATOR;
  const fieldPath = keepAll ? "" : readPath(input.field, "Field to test");
  const returnField = readPath(input.returnField, "Return field");
  const canSkip = !(keepAll || PRESENCE_FILTER_OPERATORS.includes(operator));
  return {
    operator,
    testPath: splitPath(fieldPath),
    returnPath: splitPath(returnField || fieldPath),
    returnField: returnField || fieldPath,
    untestable: canSkip ? readUntestableMode(input.untestable) : "skip",
    missingReturn: readMissingReturnMode(input.missingReturn),
    ignoreCase: CASE_FOLDING_FILTER_OPERATORS.includes(operator)
      ? readSwitch(input.ignoreCase, "Ignore case")
      : false,
  };
}

function notAnArray(name: string): Error {
  return new Error(
    `${name} must be a JSON array. Reference the array field directly, e.g. {{@node1:Label.results}}.`
  );
}

function parseArrayInput(raw: unknown, name: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = parseJsonValue(raw, name);
  } catch (error) {
    // Text that is not JSON gets the array hint rather than the generic one;
    // text that starts like an array is a typo in it.
    if (typeof raw === "string" && raw.trim() !== "") {
      throw raw.trim().startsWith("[")
        ? new Error(
            `${name} is not valid JSON: check its brackets and quotes, e.g. a missing ] or ".`
          )
        : notAnArray(name);
    }
    throw error;
  }
  if (!Array.isArray(parsed)) {
    throw notAnArray(name);
  }
  return parsed;
}

export function toSourceArray(raw: unknown): unknown[] {
  const source = parseArrayInput(raw, "Source");
  if (source.length > MAX_FILTER_ITEMS) {
    throw new Error(
      `Source has ${source.length.toLocaleString(EN_US)} items; the limit is ${MAX_FILTER_ITEMS.toLocaleString(EN_US)}.`
    );
  }
  return source;
}

function isBlank(raw: unknown): boolean {
  return (
    raw === undefined ||
    raw === null ||
    (typeof raw === "string" && raw.trim() === "")
  );
}

export function toLabels(
  raw: unknown,
  sourceLength: number
): unknown[] | undefined {
  if (isBlank(raw)) {
    return;
  }
  const labels = parseArrayInput(raw, "Labels");
  if (labels.length !== sourceLength) {
    throw new Error(
      `Labels has ${labels.length.toLocaleString(EN_US)} ${labels.length === 1 ? "entry" : "entries"} but Source has ${sourceLength.toLocaleString(EN_US)}; they must line up one to one.`
    );
  }
  return labels;
}

// Quotes force text; double quotes decode escapes as a Condition literal does.
function unquote(text: string): string | undefined {
  if (DOUBLE_QUOTED.test(text)) {
    try {
      return JSON.parse(text) as string;
    } catch {
      return text.slice(1, -1);
    }
  }
  return SINGLE_QUOTED.exec(text)?.[1];
}

// A decimal in the form `String(number)` prints: no plus sign, no leading or
// trailing zeros, and 0 for minus zero. Loops rather than regexes, since a
// Value can be long.
function canonicalDecimal(text: string): string {
  const negative = text.startsWith("-");
  const unsigned = negative || text.startsWith("+") ? text.slice(1) : text;
  const point = unsigned.indexOf(".");
  const whole = point === -1 ? unsigned : unsigned.slice(0, point);
  let fraction = point === -1 ? "" : unsigned.slice(point + 1);
  let start = 0;
  while (start < whole.length - 1 && whole[start] === "0") {
    start += 1;
  }
  let end = fraction.length;
  while (end > 0 && fraction[end - 1] === "0") {
    end -= 1;
  }
  fraction = fraction.slice(0, end);
  const digits = fraction
    ? `${whole.slice(start)}.${fraction}`
    : whole.slice(start);
  return negative && digits !== "0" ? `-${digits}` : digits;
}

// Reads Value as a typed operand. A decimal that reads back unchanged as a
// plain decimal (1.50, 007, +5) is a number. Any other (one a double would
// round, or prints with an exponent) stays text, which the evaluator compares
// by value without rounding against text items; the step compares number
// items with exactNumberOf instead.
function toTypedValue(text: string, label: string): unknown {
  const quoted = unquote(text);
  const typed = quoted ?? text;
  // The evaluator reads decimal text by value for every item, so a long one
  // costs items x length; numbers past 100 characters are not needed.
  if (DECIMAL_TEXT.test(typed) && typed.length > MAX_NUMBER_VALUE_LENGTH) {
    throw new Error(
      `Value for "${label}" is a number longer than ${MAX_NUMBER_VALUE_LENGTH} characters.`
    );
  }
  if (quoted !== undefined) {
    return quoted;
  }
  if (DECIMAL_TEXT.test(text)) {
    const number = Number(text);
    return String(number) === canonicalDecimal(text) ? number : text;
  }
  const keywords: Record<string, unknown> = {
    true: true,
    false: false,
    null: null,
  };
  return Object.hasOwn(keywords, text) ? keywords[text] : text;
}

// A number's own decimal written without an exponent (1e-7 -> 0.0000001). A
// double's exponent stays within about 330 digits, so this is bounded.
function plainDecimal(number: number): string {
  const literal = String(number);
  const e = literal.indexOf("e");
  if (e === -1) {
    return literal;
  }
  const mantissa = literal.slice(0, e);
  const negative = mantissa.startsWith("-");
  const unsigned = negative ? mantissa.slice(1) : mantissa;
  const point = unsigned.indexOf(".");
  const digits =
    point === -1
      ? unsigned
      : unsigned.slice(0, point) + unsigned.slice(point + 1);
  const shift =
    (point === -1 ? unsigned.length : point) + Number(literal.slice(e + 1));
  let plain: string;
  if (shift <= 0) {
    plain = `0.${"0".repeat(-shift)}${digits}`;
  } else if (shift >= digits.length) {
    plain = digits + "0".repeat(shift - digits.length);
  } else {
    plain = `${digits.slice(0, shift)}.${digits.slice(shift)}`;
  }
  return negative ? `-${plain}` : plain;
}

/**
 * The number a decimal text Value is, when it is exactly one (its shortest
 * double reads back as the same decimal), so a number item can be compared
 * with a number, as Condition does with a typed literal. Text that prints with
 * an exponent (1000000000000000000000, 0.0000001) qualifies; a decimal a
 * double would round does not.
 */
export function exactNumberOf(value: unknown): number | undefined {
  if (typeof value !== "string" || !DECIMAL_TEXT.test(value)) {
    return;
  }
  const number = Number(value);
  return Number.isFinite(number) &&
    plainDecimal(number) === canonicalDecimal(value)
    ? number
    : undefined;
}

// A number, bigint, decimal text or hex text in a form the evaluator orders
// exactly; undefined for anything else.
export function toNumeric(value: unknown): unknown {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value !== "string") {
    return;
  }
  const text = value.trim();
  if (DECIMAL_TEXT.test(text)) {
    return text;
  }
  return HEX_TEXT.test(text) ? BigInt(text) : undefined;
}

function requireNumeric(value: unknown, label: string): unknown {
  if (typeof value === "string" && value.length > MAX_NUMBER_VALUE_LENGTH) {
    throw new Error(
      `Value for "${label}" is longer than ${MAX_NUMBER_VALUE_LENGTH} characters.`
    );
  }
  const numeric = toNumeric(value);
  if (numeric === undefined) {
    throw new Error(`Value for "${label}" must be a number, e.g. 100 or 0x64.`);
  }
  return numeric;
}

function requireWholeNumber(value: unknown, label: string): number {
  const text = typeof value === "number" ? String(value) : value;
  const number = typeof text === "string" ? Number(text) : Number.NaN;
  if (
    typeof text !== "string" ||
    !WHOLE_NUMBER_TEXT.test(text) ||
    !Number.isSafeInteger(number)
  ) {
    throw new Error(
      `Value for "${label}" must be a whole number up to ${Number.MAX_SAFE_INTEGER.toLocaleString(EN_US)}, e.g. 3.`
    );
  }
  return number;
}

// A JSON number past 2^53 has already lost digits; ask for it as text.
function rejectUnusableNumber(value: unknown, label: string): void {
  if (typeof value !== "number") {
    return;
  }
  if (!Number.isFinite(value)) {
    throw new Error(`Value for "${label}" must be a finite number.`);
  }
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    throw new Error(
      `Value for "${label}" is too large to send as a number. Send it as text, e.g. "1000000000000000000000".`
    );
  }
}

function valueTip(operator: FilterOperator): string {
  if (NUMBER_FILTER_OPERATORS.includes(operator)) {
    return " Enter a number, e.g. 100 or 0x64.";
  }
  if (operator === "arrayLength") {
    return " Enter a whole number, e.g. 3.";
  }
  if (operator === "objectHasKey") {
    return " Enter the key to look for.";
  }
  return ' To match empty text, enter "".';
}

export function readValue(raw: unknown, operator: FilterOperator): unknown {
  const label = filterOperatorLabel(operator);
  if (typeof raw === "object" && raw !== null) {
    throw new Error(
      `Value for "${label}" must be a single value, not a list or object.`
    );
  }
  // Each item is compared with the whole Value, so its length bounds a run.
  // Number tests have their own, shorter limit, checked first.
  if (
    typeof raw === "string" &&
    raw.length > MAX_VALUE_LENGTH &&
    !NUMBER_FILTER_OPERATORS.includes(operator)
  ) {
    throw new Error(
      `Value for "${label}" is longer than ${MAX_VALUE_LENGTH.toLocaleString(EN_US)} characters.`
    );
  }
  // Array: length has its own whole-number rule, so skip the "send as text" tip.
  if (operator !== "arrayLength") {
    rejectUnusableNumber(raw, label);
  }
  const value = typeof raw === "string" ? raw.trim() : raw;
  if (value === undefined || value === null || value === "") {
    throw new Error(`Value is required for "${label}".${valueTip(operator)}`);
  }
  const text = typeof value === "string" ? (unquote(value) ?? value) : value;
  if (TEXT_FILTER_OPERATORS.includes(operator) || operator === "objectHasKey") {
    return String(text);
  }
  if (NUMBER_FILTER_OPERATORS.includes(operator)) {
    return requireNumeric(text, label);
  }
  if (operator === "arrayLength") {
    return requireWholeNumber(text, label);
  }
  return typeof value === "string" ? toTypedValue(value, label) : value;
}

/**
 * The save-time check: the step's own parsing, run on the settings a builder
 * typed, so a config that saves cannot fail every run. Values holding a
 * template are left to the run, where they are resolved.
 */
export function checkFilterConfig(
  config: Record<string, unknown>
): { field: string; message: string } | undefined {
  const typed = (key: string): unknown =>
    valueContainsTemplate(config[key]) ? undefined : config[key];
  let operator: FilterOperator;
  try {
    operator = resolveOperator(config.operator);
  } catch (error) {
    return { field: "operator", message: getErrorMessage(error) };
  }
  // Typed Source is parsed once and its length reused for the Labels check.
  let sourceLength: number | undefined;
  // Same visibility rules as readSettings, field by field, so the issue
  // names the field to fix.
  const checks: [string, () => void][] = [
    [
      "field",
      () =>
        operator === KEEP_ALL_OPERATOR ||
        readPath(typed("field"), "Field to test"),
    ],
    ["returnField", () => readPath(typed("returnField"), "Return field")],
    [
      "value",
      () =>
        VALUELESS_FILTER_OPERATORS.includes(operator) ||
        // Read raw, not through typed(): readValue needs the original type.
        valueContainsTemplate(config.value) ||
        readValue(config.value, operator),
    ],
    [
      "ignoreCase",
      () =>
        CASE_FOLDING_FILTER_OPERATORS.includes(operator) &&
        readSwitch(typed("ignoreCase"), "Ignore case"),
    ],
    [
      "untestable",
      () =>
        operator === KEEP_ALL_OPERATOR ||
        PRESENCE_FILTER_OPERATORS.includes(operator) ||
        readUntestableMode(typed("untestable")),
    ],
    ["missingReturn", () => readMissingReturnMode(typed("missingReturn"))],
    [
      "source",
      () => {
        const source = typed("source");
        sourceLength = isBlank(source)
          ? undefined
          : toSourceArray(source).length;
      },
    ],
    [
      "labels",
      () => {
        const labels = typed("labels");
        if (isBlank(labels)) {
          return;
        }
        if (sourceLength === undefined) {
          parseArrayInput(labels, "Labels");
          return;
        }
        toLabels(labels, sourceLength);
      },
    ],
  ];
  for (const [field, check] of checks) {
    try {
      check();
    } catch (error) {
      return { field, message: getErrorMessage(error) };
    }
  }
  return;
}
