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
  baseConditionOperator,
  type FilterOperator,
  type FilterTestKind,
  filterOperatorLabel,
  filterOperatorRule,
  isNegatedTextOperator,
  KEEP_ALL_OPERATOR,
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

type ItemReader = (value: unknown) => { value: unknown } | Untestable;

function readNumber(value: unknown): { value: unknown } | Untestable {
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

function readText(value: unknown): { value: unknown } | Untestable {
  const textual =
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint";
  return textual ? { value } : { reason: describeShape(value) };
}

// What the test sees for an item that is there, or why it cannot apply.
const ITEM_READERS: Record<FilterTestKind, ItemReader> = {
  none: (value) => ({ value }),
  presence: (value) => ({ value }),
  any: (value) => ({ value }),
  loose: (value) =>
    isPrimitive(value) ? { value } : { reason: describeShape(value) },
  text: readText,
  number: readNumber,
  boolean: (value) =>
    typeof value === "boolean"
      ? { value }
      : { reason: `${describeShape(value)}, not true or false` },
  array: (value) =>
    Array.isArray(value) ? { value } : { reason: "its value is not a list" },
  object: (value) =>
    isPlainObject(value) ? { value } : { reason: "its value is not an object" },
};

const MISSING_FIELD: Untestable = { reason: "the field is missing" };

// Picked once per run; presence tests are the only ones that see a missing field.
function itemReaderFor(test: FilterTestKind): ItemReader {
  const read = ITEM_READERS[test];
  if (test === "presence") {
    return read;
  }
  return (value) => (value === undefined ? MISSING_FIELD : read(value));
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
  const rule = filterOperatorRule(operator);
  const value = rule.readsValue ? readValue(rawValue, operator) : undefined;
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
  const readItem = itemReaderFor(rule.test);
  const test = (item: unknown, against: unknown): boolean =>
    Boolean(evaluate({ [ITEM_VAR]: item, [VALUE_VAR]: against }));

  return (fieldValue: unknown): boolean | Untestable => {
    const tested = readItem(fieldValue);
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
