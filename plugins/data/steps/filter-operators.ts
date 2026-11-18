/**
 * Operator options for data/filter. No "use step": the plugin definition and
 * the step core both read this list.
 *
 * Every set below is derived from Condition's operator metadata, so an
 * operator added there is classified here without a second list to update.
 */

import { qualifiedOptionLabel } from "@/lib/workflow/editor/select-option-groups";
import type { ConditionOperator } from "@/lib/workflow/nodes/condition/builder-types";
import {
  OPERATOR_GROUPS,
  OPERATOR_METADATA,
  type OperatorCategory,
  operatorsForCategory,
} from "@/lib/workflow/nodes/condition/operator-metadata";

export const KEEP_ALL_OPERATOR = "keepAll";
export const DEFAULT_FILTER_OPERATOR = "===";

// Filter-only negations of the Text tests.
export const NEGATED_TEXT_OPERATORS = {
  notContains: "contains",
  notStartsWith: "startsWith",
  notEndsWith: "endsWith",
  notMatchesRegex: "matchesRegex",
} as const satisfies Record<string, ConditionOperator>;

export type NegatedTextOperator = keyof typeof NEGATED_TEXT_OPERATORS;

export type FilterConditionOperator = ConditionOperator;

export type FilterOperator =
  | FilterConditionOperator
  | NegatedTextOperator
  | typeof KEEP_ALL_OPERATOR;

export type FilterOperatorOption = {
  value: FilterOperator;
  label: string;
  group: string;
  description: string;
};

// Where Filter's test differs from Condition's, its hint says so.
const NUMBER_TEST_SCOPE = "numbers, numeric text and hex are tested";
const BOOLEAN_TEST_SCOPE = "other values are skipped";

const FILTER_HINTS: Partial<Record<FilterOperator, string>> = {
  contains: "Text includes the value",
  startsWith: "Text begins with the value",
  endsWith: "Text ends with the value",
  notContains: "Text does not include the value",
  notStartsWith: "Text does not begin with the value",
  notEndsWith: "Text does not end with the value",
  matchesRegex:
    "Text matches the RE2 pattern anywhere; use ^ and $ to match it whole",
  notMatchesRegex: "Text does not match the RE2 pattern",
  ">": `Numerically greater than; ${NUMBER_TEST_SCOPE}`,
  ">=": `Numerically greater than or equal; ${NUMBER_TEST_SCOPE}`,
  "<": `Numerically less than; ${NUMBER_TEST_SCOPE}`,
  "<=": `Numerically less than or equal; ${NUMBER_TEST_SCOPE}`,
  isTrue: `Strictly the boolean true; ${BOOLEAN_TEST_SCOPE}`,
  isFalse: `Strictly the boolean false; ${BOOLEAN_TEST_SCOPE}`,
  arrayLength: "Array length equals the value, a whole number",
};

const NEGATED_LABELS: Record<NegatedTextOperator, string> = {
  notContains: "does not contain",
  notStartsWith: "does not start with",
  notEndsWith: "does not end with",
  notMatchesRegex: "does not match regex",
};

function conditionOption(
  op: FilterConditionOperator,
  group: string
): FilterOperatorOption {
  return {
    value: op,
    label: OPERATOR_METADATA[op].label,
    group,
    description: FILTER_HINTS[op] ?? OPERATOR_METADATA[op].description,
  };
}

function negatedOption(op: NegatedTextOperator): FilterOperatorOption {
  return {
    value: op,
    label: NEGATED_LABELS[op],
    group: "Text",
    description: FILTER_HINTS[op] ?? "",
  };
}

function groupOptions(
  category: OperatorCategory,
  label: string
): FilterOperatorOption[] {
  const options = operatorsForCategory(category).map((op) =>
    conditionOption(op, label)
  );
  if (category !== "text") {
    return options;
  }
  // Each negation sits right after the test it negates.
  return options.flatMap((option) => {
    const negation = (
      Object.keys(NEGATED_TEXT_OPERATORS) as NegatedTextOperator[]
    ).find((op) => NEGATED_TEXT_OPERATORS[op] === option.value);
    return negation ? [option, negatedOption(negation)] : [option];
  });
}

// Condition's groups, labels and order, plus the negations and keep every item.
export const FILTER_OPERATOR_OPTIONS: readonly FilterOperatorOption[] = [
  ...OPERATOR_GROUPS.flatMap((group) =>
    groupOptions(group.category, group.label)
  ),
  {
    value: KEEP_ALL_OPERATOR,
    label: "keep every item",
    group: "No test",
    description: "Skip the test and only pull the Return field",
  },
];

const ALL_VALUES = FILTER_OPERATOR_OPTIONS.map((option) => option.value);

export function isNegatedTextOperator(
  op: FilterOperator
): op is NegatedTextOperator {
  return Object.hasOwn(NEGATED_TEXT_OPERATORS, op);
}

// The Condition operator a Filter operator evaluates (a negation runs its base).
export function baseConditionOperator(
  op: Exclude<FilterOperator, typeof KEEP_ALL_OPERATOR>
): FilterConditionOperator {
  return isNegatedTextOperator(op) ? NEGATED_TEXT_OPERATORS[op] : op;
}

function categoryOf(op: FilterOperator): OperatorCategory | undefined {
  if (op === KEEP_ALL_OPERATOR) {
    return;
  }
  return OPERATOR_METADATA[baseConditionOperator(op)].category;
}

function isUnary(op: FilterOperator): boolean {
  return (
    op === KEEP_ALL_OPERATOR ||
    OPERATOR_METADATA[baseConditionOperator(op)].unary
  );
}

// Operators that take no Value: Condition's unary operators plus keep every item.
export const VALUELESS_FILTER_OPERATORS: readonly FilterOperator[] =
  ALL_VALUES.filter(isUnary);

// Operators that compare against Value.
export const VALUE_FILTER_OPERATORS: readonly FilterOperator[] =
  ALL_VALUES.filter((op) => !isUnary(op));

// Text tests that compare against Value (is empty / is not empty take none).
export const TEXT_FILTER_OPERATORS: readonly FilterOperator[] =
  ALL_VALUES.filter((op) => categoryOf(op) === "text" && !isUnary(op));

export const NUMBER_FILTER_OPERATORS: readonly FilterOperator[] =
  ALL_VALUES.filter((op) => categoryOf(op) === "number");

export const BOOLEAN_FILTER_OPERATORS: readonly FilterOperator[] =
  ALL_VALUES.filter((op) => categoryOf(op) === "boolean");

export const ARRAY_FILTER_OPERATORS: readonly FilterOperator[] =
  ALL_VALUES.filter((op) => categoryOf(op) === "array");

export const OBJECT_FILTER_OPERATORS: readonly FilterOperator[] =
  ALL_VALUES.filter((op) => categoryOf(op) === "object");

// Unary General and Text tests: they ask whether a value is there at all.
export const PRESENCE_FILTER_OPERATORS: readonly FilterOperator[] =
  ALL_VALUES.filter(
    (op) =>
      op !== KEEP_ALL_OPERATOR &&
      isUnary(op) &&
      (categoryOf(op) === "general" || categoryOf(op) === "text")
  );

// Soft equals and soft not equals compare loosely, so they only see primitives.
export const LOOSE_EQUALITY_FILTER_OPERATORS: readonly FilterOperator[] = [
  "==",
  "!=",
] satisfies readonly FilterConditionOperator[];

// Where Ignore case applies: comparisons of text against Value.
export const CASE_FOLDING_FILTER_OPERATORS: readonly FilterOperator[] = [
  ...ALL_VALUES.filter((op) => categoryOf(op) === "general" && !isUnary(op)),
  ...TEXT_FILTER_OPERATORS,
  ...(["arrayContains"] satisfies FilterConditionOperator[]),
];

export function filterOperatorLabel(operator: FilterOperator): string {
  return qualifiedOptionLabel(FILTER_OPERATOR_OPTIONS, operator) ?? operator;
}
