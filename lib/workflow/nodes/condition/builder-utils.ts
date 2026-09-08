import { nanoid } from "nanoid";
import type {
  ConditionGroup,
  ConditionOperator,
  ConditionRule,
} from "./builder-types";
import { isConditionGroup } from "./builder-types";

// Grouping categories drive the type-aware operator dropdown: each operator
// belongs to one value-type group so the picker can show section headers
// (General / Text / Number / Boolean / Array / Object) and the author can see
// at a glance which comparisons make sense for which kind of value.
type OperatorCategory =
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
    description: "Strict equality, no type coercion (a === b)",
  },
  "!==": {
    label: "not equals",
    unary: false,
    category: "general",
    description: "Strict inequality, no type coercion (a !== b)",
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
    description: "Matches the regular expression (new RegExp(b).test(a))",
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

export function isUnaryOperator(operator: ConditionOperator): boolean {
  return OPERATOR_METADATA[operator].unary;
}

export function createEmptyRule(): ConditionRule {
  return {
    id: nanoid(),
    leftOperand: "",
    operator: "==",
    rightOperand: "",
  };
}

export function createEmptyGroup(): ConditionGroup {
  return {
    id: nanoid(),
    logic: "AND",
    rules: [createEmptyRule()],
  };
}

export { visualConditionToExpression } from "./expression";

// ---------------------------------------------------------------------------
// Expression -> ConditionGroup parser (reverse of visualConditionToExpression)
// Parses expressions generated by the visual builder AND simple user-typed
// expressions. Returns null when the expression can't be parsed.
// ---------------------------------------------------------------------------

// Top-level regex patterns for parseAtomicExpression (biome: useTopLevelRegex)
const REGEX_MATCH_PATTERN = /^new RegExp\((.+?)\)\.test\(String\((.+?)\)\)$/;
const STRING_METHOD_PATTERN =
  /^String\((.+?)\)\.(includes|startsWith|endsWith)\((.+)\)$/;
const IS_EMPTY_PATTERN =
  /^(.+?) === null \|\| \1 === undefined \|\| \1 === ""$/;
const IS_NOT_EMPTY_PATTERN =
  /^(.+?) !== null && \1 !== undefined && \1 !== ""$/;
const EXISTS_PATTERN = /^(.+?) !== null && \1 !== undefined$/;
const DOES_NOT_EXIST_PATTERN = /^(.+?) === null \|\| \1 === undefined$/;
const IS_NULL_PATTERN = /^(.+?) === null$/;
const IS_NOT_NULL_PATTERN = /^(.+?) !== null$/;
const IS_UNDEFINED_PATTERN = /^(.+?) === undefined$/;
const IS_NOT_UNDEFINED_PATTERN = /^(.+?) !== undefined$/;
const COMPARISON_PATTERN = /^(.+?)\s+(===|!==|==|!=|>=|<=|>|<)\s+(.+)$/;

function unwrapOperand(raw: string): string {
  const s = raw.trim();

  // Template references stay as-is
  if (s.startsWith("{{") && s.endsWith("}}")) {
    return s;
  }

  // Remove surrounding double quotes
  if (s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }

  // Remove surrounding single quotes
  if (s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1);
  }

  return s;
}

/**
 * Split an expression at top-level `&&` or `||` (depth-0 only).
 * Returns the parts and the detected logic operator, or null if
 * neither `&&` nor `||` appears at depth 0.
 */
function splitTopLevel(
  expr: string
): { parts: string[]; logic: "AND" | "OR" } | null {
  let depth = 0;
  const parts: string[] = [];
  let current = "";
  let detectedLogic: "AND" | "OR" | null = null;

  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === "(") {
      depth++;
      current += ch;
    } else if (ch === ")") {
      depth--;
      current += ch;
    } else if (depth === 0) {
      if (expr.slice(i, i + 4) === " && ") {
        if (detectedLogic === "OR") {
          return null; // mixed operators at same level — can't parse
        }
        detectedLogic = "AND";
        parts.push(current.trim());
        current = "";
        i += 3; // skip " && "
      } else if (expr.slice(i, i + 4) === " || ") {
        if (detectedLogic === "AND") {
          return null;
        }
        detectedLogic = "OR";
        parts.push(current.trim());
        current = "";
        i += 3;
      } else {
        current += ch;
      }
    } else {
      current += ch;
    }
  }

  if (current.trim()) {
    parts.push(current.trim());
  }

  if (detectedLogic === null || parts.length === 0) {
    return null;
  }

  return { parts, logic: detectedLogic };
}

/** Strip one layer of balanced outer parentheses if present. */
function stripOuterParens(s: string): string {
  const trimmed = s.trim();
  if (!(trimmed.startsWith("(") && trimmed.endsWith(")"))) {
    return trimmed;
  }
  let depth = 0;
  for (let i = 0; i < trimmed.length - 1; i++) {
    if (trimmed[i] === "(") {
      depth++;
    } else if (trimmed[i] === ")") {
      depth--;
    }
    if (depth === 0) {
      return trimmed; // closing paren matched before end — not wrapping
    }
  }
  return trimmed.slice(1, -1).trim();
}

function makeRule(
  left: string,
  op: ConditionOperator,
  right = ""
): ConditionRule {
  return {
    id: nanoid(),
    leftOperand: left,
    operator: op,
    rightOperand: right,
  };
}

/** Try to parse a single atomic expression into a ConditionRule. */
function parseAtomicExpression(expr: string): ConditionRule | null {
  const s = expr.trim();

  // matchesRegex: new RegExp(right).test(String(left))
  const regexMatch = s.match(REGEX_MATCH_PATTERN);
  if (regexMatch) {
    return makeRule(
      unwrapOperand(regexMatch[2]),
      "matchesRegex",
      unwrapOperand(regexMatch[1])
    );
  }

  // String methods: String(left).includes(right), .startsWith(right), .endsWith(right)
  const stringMethodMatch = s.match(STRING_METHOD_PATTERN);
  if (stringMethodMatch) {
    const methodMap: Record<string, ConditionOperator> = {
      includes: "contains",
      startsWith: "startsWith",
      endsWith: "endsWith",
    };
    const op = methodMap[stringMethodMatch[2]];
    if (op) {
      return makeRule(
        unwrapOperand(stringMethodMatch[1]),
        op,
        unwrapOperand(stringMethodMatch[3])
      );
    }
  }

  // Unary existence patterns (wrapped in parens, already stripped by caller or not)
  const stripped = stripOuterParens(s);

  // isEmpty: left === null || left === undefined || left === ""
  const isEmptyMatch = stripped.match(IS_EMPTY_PATTERN);
  if (isEmptyMatch) {
    return makeRule(unwrapOperand(isEmptyMatch[1]), "isEmpty");
  }

  // isNotEmpty: left !== null && left !== undefined && left !== ""
  const isNotEmptyMatch = stripped.match(IS_NOT_EMPTY_PATTERN);
  if (isNotEmptyMatch) {
    return makeRule(unwrapOperand(isNotEmptyMatch[1]), "isNotEmpty");
  }

  // exists: left !== null && left !== undefined
  const existsMatch = stripped.match(EXISTS_PATTERN);
  if (existsMatch) {
    return makeRule(unwrapOperand(existsMatch[1]), "exists");
  }

  // doesNotExist: left === null || left === undefined
  const doesNotExistMatch = stripped.match(DOES_NOT_EXIST_PATTERN);
  if (doesNotExistMatch) {
    return makeRule(unwrapOperand(doesNotExistMatch[1]), "doesNotExist");
  }

  // Single-clause null/undefined checks (must run after the two-clause
  // exists/doesNotExist patterns above so those win first).
  const isNotNullMatch = stripped.match(IS_NOT_NULL_PATTERN);
  if (isNotNullMatch) {
    return makeRule(unwrapOperand(isNotNullMatch[1]), "isNotNull");
  }

  const isNullMatch = stripped.match(IS_NULL_PATTERN);
  if (isNullMatch) {
    return makeRule(unwrapOperand(isNullMatch[1]), "isNull");
  }

  const isNotUndefinedMatch = stripped.match(IS_NOT_UNDEFINED_PATTERN);
  if (isNotUndefinedMatch) {
    return makeRule(unwrapOperand(isNotUndefinedMatch[1]), "isNotUndefined");
  }

  const isUndefinedMatch = stripped.match(IS_UNDEFINED_PATTERN);
  if (isUndefinedMatch) {
    return makeRule(unwrapOperand(isUndefinedMatch[1]), "isUndefined");
  }

  // Comparison operators: left op right
  const comparisonMatch = s.match(COMPARISON_PATTERN);
  if (comparisonMatch) {
    return makeRule(
      unwrapOperand(comparisonMatch[1]),
      comparisonMatch[2] as ConditionOperator,
      unwrapOperand(comparisonMatch[3])
    );
  }

  // Bare value (e.g. template ref, variable) — treat as truthy check via "exists"
  const bareValue = unwrapOperand(s);
  if (bareValue) {
    return makeRule(bareValue, "exists");
  }

  return null;
}

function parseExpression(expr: string): ConditionGroup | ConditionRule | null {
  const s = expr.trim();
  if (!s || s === "true") {
    return null;
  }

  // Try splitting at top-level && / ||
  const split = splitTopLevel(s);
  if (split) {
    const rules: (ConditionRule | ConditionGroup)[] = [];
    for (const part of split.parts) {
      const stripped = stripOuterParens(part);
      const parsed = parseExpression(stripped);
      if (parsed === null) {
        return null; // bail if any part is unparseable
      }
      rules.push(parsed);
    }
    return { id: nanoid(), logic: split.logic, rules };
  }

  // Single expression — try to parse as atomic rule
  const rule = parseAtomicExpression(s);
  if (rule) {
    return rule;
  }

  // Try stripping outer parens and re-parsing (for parenthesized single expressions)
  const stripped = stripOuterParens(s);
  if (stripped !== s) {
    return parseExpression(stripped);
  }

  return null;
}

/**
 * Parse a condition expression string into a ConditionGroup.
 * Returns null if the expression cannot be parsed into visual form.
 */
export function expressionToConditionGroup(
  expression: string
): ConditionGroup | null {
  const trimmed = expression.trim();
  if (!trimmed) {
    return null;
  }

  const result = parseExpression(trimmed);
  if (result === null) {
    return null;
  }

  // If result is already a group, return it
  if (isConditionGroup(result)) {
    return result;
  }

  // Wrap single rule in a group
  return { id: nanoid(), logic: "AND", rules: [result] };
}
