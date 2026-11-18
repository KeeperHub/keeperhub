// Operator labels, groups and hints. Kept free of nanoid so plugin
// definitions (bundled into the workflow runtime) can import it.

import type { ConditionOperator } from "./builder-types";

// Grouping categories drive the type-aware operator dropdown: each operator
// belongs to one value-type group so the picker can show section headers
// (General / Text / Number / Boolean / Array / Object) and the author can see
// at a glance which comparisons make sense for which kind of value.
export type OperatorCategory =
  | "general"
  | "text"
  | "number"
  | "boolean"
  | "array"
  | "object";

type OperatorMeta = {
  label: string;
  unary: boolean;
  category: OperatorCategory;
  // Human-readable explanation of the exact comparison the operator performs,
  // surfaced as a hint in the dropdown so authors can tell apart subtly
  // different checks (e.g. "does not exist" vs "is null").
  description: string;
};

export const OPERATOR_METADATA: Record<ConditionOperator, OperatorMeta> = {
  "===": {
    label: "equals",
    unary: false,
    category: "general",
    description: 'Same value; numbers by magnitude ("1.0" equals 1)',
  },
  "!==": {
    label: "not equals",
    unary: false,
    category: "general",
    description:
      'Different value; numbers by magnitude ("1.0" and 1 count as the same)',
  },
  "==": {
    label: "soft equals",
    unary: false,
    category: "general",
    description: 'Loose equality with type coercion ("0" == 0 is true)',
  },
  "!=": {
    label: "soft not equals",
    unary: false,
    category: "general",
    description: "Loose inequality with type coercion (a != b)",
  },
  exists: {
    label: "exists",
    unary: true,
    category: "general",
    description: "Not null and not undefined",
  },
  doesNotExist: {
    label: "does not exist",
    unary: true,
    category: "general",
    description: "Null or undefined",
  },
  isNull: {
    label: "is null",
    unary: true,
    category: "general",
    description: "Strictly null (a === null); undefined does not match",
  },
  isNotNull: {
    label: "is not null",
    unary: true,
    category: "general",
    description: "Anything except null (a !== null); undefined still matches",
  },
  isUndefined: {
    label: "is undefined",
    unary: true,
    category: "general",
    description: "Strictly undefined (a === undefined); null does not match",
  },
  isNotUndefined: {
    label: "is not undefined",
    unary: true,
    category: "general",
    description:
      "Anything except undefined (a !== undefined); null still matches",
  },
  contains: {
    label: "contains",
    unary: false,
    category: "text",
    description: "Substring match (String(a).includes(b))",
  },
  startsWith: {
    label: "starts with",
    unary: false,
    category: "text",
    description: "Text begins with the value (String(a).startsWith(b))",
  },
  endsWith: {
    label: "ends with",
    unary: false,
    category: "text",
    description: "Text ends with the value (String(a).endsWith(b))",
  },
  matchesRegex: {
    label: "matches regex",
    unary: false,
    category: "text",
    description:
      "Text matches the pattern (regular expression) anywhere; ^ marks the start and $ the end, (?i) ignores case",
  },
  isEmpty: {
    label: "is empty",
    unary: true,
    category: "text",
    description: 'Null, undefined, or empty string ("")',
  },
  isNotEmpty: {
    label: "is not empty",
    unary: true,
    category: "text",
    description: 'Has a value other than null, undefined, or ""',
  },
  ">": {
    label: "greater than",
    unary: false,
    category: "number",
    description: "Numerically greater than (a > b)",
  },
  ">=": {
    label: "greater than or equal",
    unary: false,
    category: "number",
    description: "Numerically greater than or equal (a >= b)",
  },
  "<": {
    label: "less than",
    unary: false,
    category: "number",
    description: "Numerically less than (a < b)",
  },
  "<=": {
    label: "less than or equal",
    unary: false,
    category: "number",
    description: "Numerically less than or equal (a <= b)",
  },
  isTrue: {
    label: "is true",
    unary: true,
    category: "boolean",
    description: "Strictly the boolean true (a === true)",
  },
  isFalse: {
    label: "is false",
    unary: true,
    category: "boolean",
    description: "Strictly the boolean false (a === false)",
  },
  arrayIsEmpty: {
    label: "is empty",
    unary: true,
    category: "array",
    description: "An array with no elements (length === 0)",
  },
  arrayIsNotEmpty: {
    label: "is not empty",
    unary: true,
    category: "array",
    description: "An array with at least one element (length > 0)",
  },
  arrayContains: {
    label: "contains",
    unary: false,
    category: "array",
    description: "Array includes the value (a.includes(b))",
  },
  arrayLength: {
    label: "length",
    unary: false,
    category: "array",
    description: "Array length equals the value (a.length === b)",
  },
  objectIsEmpty: {
    label: "is empty",
    unary: true,
    category: "object",
    description: "An object with no own keys (Object.keys(a).length === 0)",
  },
  objectHasKey: {
    label: "has key",
    unary: false,
    category: "object",
    description: "Object has the given key (Object.keys(a).includes(b))",
  },
} as const;

// Ordered groups for the operator dropdown. Section labels match the screenshot
// pattern (header + items beneath) so each operator reads in the context of the
// value type it applies to.
export const OPERATOR_GROUPS: ReadonlyArray<{
  label: string;
  category: OperatorCategory;
}> = [
  { label: "General", category: "general" },
  { label: "Text", category: "text" },
  { label: "Number", category: "number" },
  { label: "Boolean", category: "boolean" },
  { label: "Array", category: "array" },
  { label: "Object", category: "object" },
] as const;

export function operatorsForCategory(
  category: OperatorCategory
): ConditionOperator[] {
  return (Object.keys(OPERATOR_METADATA) as ConditionOperator[]).filter(
    (op) => OPERATOR_METADATA[op].category === category
  );
}

const REPEATED_LABELS: ReadonlySet<string> = new Set(
  Object.values(OPERATOR_METADATA)
    .map((meta) => meta.label)
    .filter((label, index, labels) => labels.indexOf(label) !== index)
);

// The closed dropdown names the group only where the label repeats
// ("Text: contains" vs "Array: contains"), so it fits Condition's narrow select.
export function closedOperatorLabel(operator: ConditionOperator): string {
  const meta = OPERATOR_METADATA[operator];
  const group = OPERATOR_GROUPS.find(
    (candidate) => candidate.category === meta.category
  );
  return group && REPEATED_LABELS.has(meta.label)
    ? `${group.label}: ${meta.label}`
    : meta.label;
}
