/**
 * Logic for data/filter. No "use step": filter.ts wraps it and tests call it
 * directly. Config parsing and the save-time check live in ../filter-config.
 *
 * Each item is tested with the Condition node's own expression and evaluator.
 * An item a test cannot apply to (a missing field, null under a number or
 * boolean test, an object under a text test) fails the step, or is skipped
 * and counted when the node is set to skip.
 */

import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { getErrorMessage } from "@/lib/utils";
import { operatorToExpression } from "@/lib/workflow/nodes/condition/expression";
import { compileSafeCondition } from "@/lib/workflow/nodes/condition/safe-eval";
import {
  exactNumberOf,
  type FilterCoreInput,
  type FilterSettings,
  isQuotedValue,
  readSettings,
  readValue,
  toLabels,
  toNumeric,
  toSourceArray,
} from "../filter-config";
import {
  ARRAY_FILTER_OPERATORS,
  BOOLEAN_FILTER_OPERATORS,
  baseConditionOperator,
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
} from "../filter-operators";
import { isPlainObject, resolveSegments } from "./resolve-path-core";

export type { FilterCoreInput } from "../filter-config";

// Tests where a number item meets a Value kept as text (see exactNumberOf).
const NUMBER_TWIN_OPERATORS: readonly FilterOperator[] = [
  "===",
  "!==",
  "==",
  "!=",
  "arrayContains",
];

const ITEM_VAR = "__v0";
const VALUE_VAR = "__v1";

type FilterOutput = {
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
  const comparison = ignoreCase ? foldCase(value) : value;
  // A Value kept as exact text that is also exactly a number. Under equals,
  // number items are compared with the number, as a Condition literal would
  // be. Under Array: contains an unquoted one is that number and a quoted one
  // stays text, as for any other Value.
  const asNumber = NUMBER_TWIN_OPERATORS.includes(operator)
    ? exactNumberOf(value)
    : undefined;
  const containsNumber =
    operator === "arrayContains" &&
    asNumber !== undefined &&
    !isQuotedValue(rawValue);
  const evaluate = compileSafeCondition(
    operatorToExpression(baseConditionOperator(operator), ITEM_VAR, VALUE_VAR)
  );
  const negate = isNegatedTextOperator(operator);
  const test = (item: unknown, against: unknown): boolean =>
    Boolean(evaluate({ [ITEM_VAR]: item, [VALUE_VAR]: against }));

  return (fieldValue: unknown): boolean | Untestable => {
    const tested = toTestedValue(fieldValue, operator);
    if ("reason" in tested) {
      return tested;
    }
    const item = ignoreCase ? foldCase(tested.value) : tested.value;
    let passed: boolean;
    if (containsNumber) {
      passed = test(item, asNumber);
    } else if (asNumber === undefined || operator === "arrayContains") {
      passed = test(item, comparison);
    } else {
      passed = test(item, typeof item === "number" ? asNumber : comparison);
    }
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
    throw new Error(
      `Item at index ${index} could not be tested: ${getErrorMessage(error)}`
    );
  }
}

function runFilter(input: FilterCoreInput): FilterOutput {
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
      if (labelsIn) {
        output.skippedLabels.push(labelsIn[index] ?? null);
      }
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
    if (labelsIn) {
      output.labels.push(labelsIn[index] ?? null);
    }
  }
  output.count = output.items.length;
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
