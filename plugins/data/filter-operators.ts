/**
 * Operator options for data/filter. No "use step": the plugin definition and
 * the step core both read this list.
 *
 * Each operator's rule is derived from Condition's operator metadata, so an
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
import type { SelectOption } from "@/plugins/registry";

export const KEEP_ALL_OPERATOR = "keepAll";
export const DEFAULT_FILTER_OPERATOR = "===";

// Filter-only negations of the Text tests.
const NEGATED_TEXT_OPERATORS = {
  notContains: "contains",
  notStartsWith: "startsWith",
  notEndsWith: "endsWith",
} as const satisfies Record<string, ConditionOperator>;

type NegatedTextOperator = keyof typeof NEGATED_TEXT_OPERATORS;

export type FilterOperator =
  | ConditionOperator
  | NegatedTextOperator
  | typeof KEEP_ALL_OPERATOR;

// A select option, so the operator list goes to the field as it is.
type FilterOperatorOption = SelectOption & {
  value: FilterOperator;
  group: string;
  description: string;
};

// Where Filter's test differs from Condition's, its hint says so.
const NUMBER_TEST_SCOPE = "numbers, numeric text and hex are tested";
const BOOLEAN_TEST_SCOPE = "other values can't be tested";

const FILTER_HINTS: Partial<Record<FilterOperator, string>> = {
  contains: "Text includes the value",
  startsWith: "Text begins with the value",
  endsWith: "Text ends with the value",
  notContains: "Text does not include the value",
  notStartsWith: "Text does not begin with the value",
  notEndsWith: "Text does not end with the value",
  matchesRegex:
    "Text matches the regular expression anywhere; ^ start, $ end, (?i) ignore case",
  notMatchesRegex:
    "Text does not match the regular expression anywhere; ^ start, $ end, (?i) ignore case",
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
};

function conditionOption(
  op: ConditionOperator,
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
): ConditionOperator {
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

/**
 * How the step reads an item for a test, which decides the items it applies
 * to: "presence" tests take any item, a missing field included; "any" (equals,
 * not equals) takes any item that is there; "loose" only primitives.
 */
export type FilterTestKind =
  | "none"
  | "presence"
  | "any"
  | "loose"
  | "text"
  | "number"
  | "boolean"
  | "array"
  | "object";

/**
 * What one operator reads. The step, the save-time check and the form's
 * showWhen all come from this, so a hidden setting is never read.
 */
export type FilterOperatorRule = {
  test: FilterTestKind;
  readsField: boolean;
  readsValue: boolean;
  readsIgnoreCase: boolean;
  // A number item can meet a Value kept as exact text (see exactNumberOf).
  meetsNumberText: boolean;
  // Reads "If an item can't be tested": the test can meet an item it can't apply to.
  canSkip: boolean;
};

function testKindOf(op: FilterOperator): FilterTestKind {
  const category = categoryOf(op);
  if (category === undefined) {
    return "none";
  }
  if (isUnary(op) && (category === "general" || category === "text")) {
    return "presence";
  }
  if (category === "general") {
    return op === "==" || op === "!=" ? "loose" : "any";
  }
  return category;
}

function ruleOf(op: FilterOperator): FilterOperatorRule {
  const test = testKindOf(op);
  const readsValue = !isUnary(op);
  const equality = test === "any" || test === "loose";
  return {
    test,
    readsField: test !== "none",
    readsValue,
    // Comparisons of text against Value.
    readsIgnoreCase:
      readsValue && (equality || test === "text" || op === "arrayContains"),
    meetsNumberText: readsValue && (equality || op === "arrayContains"),
    canSkip: test !== "none" && test !== "presence",
  };
}

const RULES = new Map<FilterOperator, FilterOperatorRule>(
  ALL_VALUES.map((op) => [op, ruleOf(op)])
);

export function filterOperatorRule(op: FilterOperator): FilterOperatorRule {
  const rule = RULES.get(op);
  if (!rule) {
    throw new Error(`Unknown operator "${op}".`);
  }
  return rule;
}

/** The operators whose rule passes `predicate`, in option order. */
export function filterOperatorsWhere(
  predicate: (rule: FilterOperatorRule) => boolean
): FilterOperator[] {
  return ALL_VALUES.filter((op) => predicate(filterOperatorRule(op)));
}

export function filterOperatorLabel(operator: FilterOperator): string {
  return qualifiedOptionLabel(FILTER_OPERATOR_OPTIONS, operator) ?? operator;
}
