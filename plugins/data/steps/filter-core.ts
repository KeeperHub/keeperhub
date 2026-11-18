/**
 * Logic for data/filter. No "use step": filter.ts wraps it, the plugin
 * definition reuses its config check at save time, and tests call it directly.
 *
 * Each item is tested with the Condition node's own expression and evaluator.
 * An item a test cannot apply to (a missing field, null under a number or
 * boolean test, an object under a text test) is skipped and counted, or fails
 * the step when the node is set to.
 */

import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { getErrorMessage } from "@/lib/utils";
import { operatorToExpression } from "@/lib/workflow/nodes/condition/expression";
import {
  compileRegex,
  MAX_REGEX_TEXT_LENGTH,
  REGEX_SOURCE_ERROR,
  RegexBudget,
  RegexBudgetError,
  readRegexPattern,
  regexMatches,
  regexPatternError,
  regexTextTooLong,
} from "@/lib/workflow/nodes/condition/regex-match";
import { compileSafeCondition } from "@/lib/workflow/nodes/condition/safe-eval";
import { valueContainsTemplate } from "@/lib/workflow/template-ref";
import {
  ARRAY_FILTER_OPERATORS,
  BOOLEAN_FILTER_OPERATORS,
  baseConditionOperator,
  CASE_FOLDING_FILTER_OPERATORS,
  DEFAULT_FILTER_OPERATOR,
  FILTER_OPERATOR_OPTIONS,
  type FilterOperator,
  filterOperatorLabel,
  isNegatedTextOperator,
  KEEP_ALL_OPERATOR,
  LOOSE_EQUALITY_FILTER_OPERATORS,
  NUMBER_FILTER_OPERATORS,
  OBJECT_FILTER_OPERATORS,
  PRESENCE_FILTER_OPERATORS,
  TEXT_FILTER_OPERATORS,
  VALUELESS_FILTER_OPERATORS,
} from "./filter-operators";
import {
  isPlainObject,
  parseJsonValue,
  resolveSegments,
  splitPath,
} from "./resolve-path-core";

export const MAX_FILTER_ITEMS = 10_000;
// A uint256 is 78 digits; this leaves room for decimals without letting a
// huge Value make every comparison slow.
export const MAX_NUMBER_VALUE_LENGTH = 100;
export const MAX_PATH_LENGTH = 500;
const MAX_ECHOED_LENGTH = 60;

const ITEM_VAR = "__v0";
const VALUE_VAR = "__v1";
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

export type FilterOutput = {
  success: true;
  items: unknown[];
  values: unknown[];
  indexes: number[];
  labels: unknown[];
  count: number;
  skipped: number;
  skippedIndexes: number[];
  skippedLabels: unknown[];
  missingReturn: number;
  total: number;
};

export type FilterResult =
  | FilterOutput
  | { success: false; error: string; errorClass?: ExecutionErrorType };

// Why an item cannot be tested; describes the shape, never the item's content.
type Untestable = { reason: string };

type FilterSettings = {
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
function readSettings(input: FilterCoreInput): FilterSettings {
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
    // Text that is not JSON gets the array hint rather than the generic one.
    if (typeof raw === "string" && raw.trim() !== "") {
      throw notAnArray(name);
    }
    throw error;
  }
  if (!Array.isArray(parsed)) {
    throw notAnArray(name);
  }
  return parsed;
}

function toSourceArray(raw: unknown): unknown[] {
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

function toLabels(raw: unknown, sourceLength: number): unknown[] | undefined {
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

// Reads Value as Condition reads a typed operand. Numbers past 2^53 stay text
// so they compare exactly.
function toTypedValue(text: string): unknown {
  const quoted = unquote(text);
  if (quoted !== undefined) {
    return quoted;
  }
  if (DECIMAL_TEXT.test(text)) {
    const number = Number(text);
    return Math.abs(number) <= Number.MAX_SAFE_INTEGER ? number : text;
  }
  const keywords: Record<string, unknown> = {
    true: true,
    false: false,
    null: null,
  };
  return Object.hasOwn(keywords, text) ? keywords[text] : text;
}

// A number, bigint, decimal text or hex text in a form the evaluator orders
// exactly; undefined for anything else.
function toNumeric(value: unknown): unknown {
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
  if (isRegexOperator(operator)) {
    return " Enter a pattern, e.g. ^EMSP_; ^$ matches empty text.";
  }
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

function readValue(raw: unknown, operator: FilterOperator): unknown {
  const label = filterOperatorLabel(operator);
  if (typeof raw === "object" && raw !== null) {
    throw new Error(
      `Value for "${label}" must be a single value, not a list or object.`
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
  // A regex pattern is read exactly as typed, as in a Condition: quotes and
  // backslashes are part of the pattern.
  if (isRegexOperator(operator)) {
    const pattern = readRegexPattern(String(value));
    const patternProblem = regexPatternError(pattern);
    if (patternProblem) {
      throw new Error(`${patternProblem}.`);
    }
    return pattern;
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
  return typeof value === "string" ? toTypedValue(value) : value;
}

function foldCase(value: unknown): unknown {
  if (typeof value === "string") {
    return value.toLowerCase();
  }
  if (Array.isArray(value)) {
    return value.map((entry) =>
      typeof entry === "string" ? entry.toLowerCase() : entry
    );
  }
  return value;
}

function isPrimitive(value: unknown): boolean {
  return value === null || (typeof value !== "object" && value !== undefined);
}

function describeShape(value: unknown): string {
  if (value === null) {
    return "its value is null";
  }
  if (Array.isArray(value)) {
    return "its value is a list";
  }
  if (typeof value === "object") {
    return "its value is an object";
  }
  if (typeof value === "boolean") {
    return "its value is true or false";
  }
  if (typeof value === "string") {
    return "its value is text";
  }
  return "its value is a number";
}

function applicableTo(
  value: unknown,
  operator: FilterOperator
): { value: unknown } | Untestable | undefined {
  if (NUMBER_FILTER_OPERATORS.includes(operator)) {
    const numeric = toNumeric(value);
    if (numeric !== undefined) {
      return { value: numeric };
    }
    return {
      reason:
        typeof value === "string"
          ? "its value is text that is not a number"
          : describeShape(value),
    };
  }
  if (BOOLEAN_FILTER_OPERATORS.includes(operator)) {
    return typeof value === "boolean"
      ? { value }
      : { reason: `${describeShape(value)}, not true or false` };
  }
  if (TEXT_FILTER_OPERATORS.includes(operator)) {
    const textual =
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "bigint";
    return textual ? { value } : { reason: describeShape(value) };
  }
  return;
}

// What the test sees for an item, or why the test cannot apply to it.
function toTestedValue(
  value: unknown,
  operator: FilterOperator
): { value: unknown } | Untestable {
  if (PRESENCE_FILTER_OPERATORS.includes(operator)) {
    return { value };
  }
  if (value === undefined) {
    return { reason: "the field is missing" };
  }
  const typed = applicableTo(value, operator);
  if (typed) {
    return typed;
  }
  if (ARRAY_FILTER_OPERATORS.includes(operator)) {
    return Array.isArray(value)
      ? { value }
      : { reason: "its value is not a list" };
  }
  if (OBJECT_FILTER_OPERATORS.includes(operator)) {
    return isPlainObject(value)
      ? { value }
      : { reason: "its value is not an object" };
  }
  if (LOOSE_EQUALITY_FILTER_OPERATORS.includes(operator)) {
    return isPrimitive(value) ? { value } : { reason: describeShape(value) };
  }
  return { value };
}

type Matcher = (fieldValue: unknown) => boolean | Untestable;

function isRegexOperator(operator: FilterOperator): boolean {
  return operator === "matchesRegex" || operator === "notMatchesRegex";
}

// Ignore case uses RE2's flag: lowercasing the pattern would turn \D into \d.
function makeRegexMatcher(
  operator: FilterOperator,
  pattern: string,
  ignoreCase: boolean
): Matcher {
  const regex = compileRegex(pattern, ignoreCase);
  const negate = operator === "notMatchesRegex";
  const budget = new RegexBudget();
  return (fieldValue: unknown): boolean | Untestable => {
    const tested = toTestedValue(fieldValue, operator);
    if ("reason" in tested) {
      return tested;
    }
    const text = String(tested.value);
    if (regexTextTooLong(text)) {
      return {
        reason: `its text is longer than ${MAX_REGEX_TEXT_LENGTH.toLocaleString("en-US")} characters`,
      };
    }
    const passed = regexMatches(regex, text, budget);
    return negate ? !passed : passed;
  };
}

function makeMatcher(
  operator: FilterOperator,
  rawValue: unknown,
  ignoreCase: boolean
): Matcher {
  if (operator === KEEP_ALL_OPERATOR) {
    return () => true;
  }
  const value = VALUELESS_FILTER_OPERATORS.includes(operator)
    ? undefined
    : readValue(rawValue, operator);
  if (isRegexOperator(operator)) {
    return makeRegexMatcher(operator, String(value), ignoreCase);
  }
  const comparison = ignoreCase ? foldCase(value) : value;
  const evaluate = compileSafeCondition(
    operatorToExpression(baseConditionOperator(operator), ITEM_VAR, VALUE_VAR)
  );
  const negate = isNegatedTextOperator(operator);

  return (fieldValue: unknown): boolean | Untestable => {
    const tested = toTestedValue(fieldValue, operator);
    if ("reason" in tested) {
      return tested;
    }
    const item = ignoreCase ? foldCase(tested.value) : tested.value;
    const passed = Boolean(
      evaluate({ [ITEM_VAR]: item, [VALUE_VAR]: comparison })
    );
    return negate ? !passed : passed;
  };
}

function testItem(
  matches: Matcher,
  item: unknown,
  index: number,
  settings: FilterSettings
): boolean | Untestable {
  try {
    return matches(resolveSegments(item, settings.testPath));
  } catch (error) {
    // The run's budget, not this item: report it with this node's way out.
    if (error instanceof RegexBudgetError) {
      throw new Error(
        `${error.message}, or split the list across two Filter Array nodes`
      );
    }
    throw new Error(
      `Item at index ${index} could not be tested: ${getErrorMessage(error)}`
    );
  }
}

export function runFilter(input: FilterCoreInput): FilterOutput {
  const settings = readSettings(input);
  const source = toSourceArray(input.source);
  const labelsIn = toLabels(input.labels, source.length);
  const matches = makeMatcher(
    settings.operator,
    input.value,
    settings.ignoreCase
  );
  const output: FilterOutput = {
    success: true,
    items: [],
    values: [],
    indexes: [],
    labels: [],
    count: 0,
    skipped: 0,
    skippedIndexes: [],
    skippedLabels: [],
    missingReturn: 0,
    total: source.length,
  };
  const labelAt = (index: number): unknown => labelsIn?.[index] ?? null;

  for (const [index, item] of source.entries()) {
    const result = testItem(matches, item, index, settings);
    if (typeof result === "object") {
      if (settings.untestable === "fail") {
        throw new Error(
          `Item at index ${index} can't be tested with "${filterOperatorLabel(settings.operator)}": ${result.reason}.`
        );
      }
      output.skipped += 1;
      output.skippedIndexes.push(index);
      output.skippedLabels.push(labelAt(index));
      continue;
    }
    if (!result) {
      continue;
    }
    const returned = resolveSegments(item, settings.returnPath);
    if (returned === undefined) {
      if (settings.missingReturn === "fail") {
        throw new Error(
          `Item at index ${index} matched but has no Return field "${settings.returnField}".`
        );
      }
      output.missingReturn += 1;
    }
    output.items.push(item);
    output.values.push(returned ?? null);
    output.indexes.push(index);
    output.labels.push(labelAt(index));
  }
  output.count = output.items.length;
  if (!labelsIn) {
    output.labels = [];
    output.skippedLabels = [];
  }
  return output;
}

export function filterArray(input: FilterCoreInput): FilterResult {
  try {
    return runFilter(input);
  } catch (error) {
    return {
      success: false,
      error: `Filter failed: ${getErrorMessage(error)}`,
      errorClass: ExecutionErrorType.USER,
    };
  }
}

// A template Value is resolved at run time, except a regex pattern, which
// must be typed so outside data cannot choose the test.
function checkTemplateValue(raw: unknown, operator: FilterOperator): boolean {
  if (!valueContainsTemplate(raw)) {
    return false;
  }
  if (isRegexOperator(operator)) {
    throw new Error(`${REGEX_SOURCE_ERROR}.`);
  }
  return true;
}

/**
 * The save-time check: the step's own parsing, run on the settings a builder
 * typed, so a config that saves cannot fail every run. Values holding a
 * template are left to the run, where they are resolved.
 */
export function checkFilterConfig(
  config: Record<string, unknown>
): { field: string; message: string } | undefined {
  if (valueContainsTemplate(config.operator)) {
    return;
  }
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
        checkTemplateValue(config.value, operator) ||
        // Read raw, not through typed(): readValue needs the original type.
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
