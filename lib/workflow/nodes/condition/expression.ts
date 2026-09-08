/**
 * Pure expression generation from ConditionGroup -> string.
 *
 * Extracted from condition-builder-utils.ts so that modules in the workflow
 * bundle (condition-resolver.ts) can convert visual configs to expression
 * strings WITHOUT pulling in nanoid (a Node.js module that the workflow
 * runtime rejects).
 */

import type {
  ConditionGroup,
  ConditionOperator,
  ConditionRule,
} from "./builder-types";
import { isConditionGroup } from "./builder-types";

// Decimal grammar the safe-eval tokenizer accepts (integer or fixed-point, optional sign).
// Excludes hex like 0x... and exponents like 1e5, which Number() treats as numeric but the
// tokenizer cannot parse, so those stay quoted as string literals.
const NUMERIC_LITERAL_RE = /^[+-]?\d+(\.\d+)?$/;

// Keep in sync with OPERATOR_METADATA in condition-builder-utils.ts (unary: true entries)
const UNARY_OPERATORS: ReadonlySet<ConditionOperator> = new Set([
  "isEmpty",
  "isNotEmpty",
  "exists",
  "doesNotExist",
  "isNull",
  "isNotNull",
  "isUndefined",
  "isNotUndefined",
  "isTrue",
  "isFalse",
  "arrayIsEmpty",
  "arrayIsNotEmpty",
  "objectIsEmpty",
]);

function wrapOperand(operand: string): string {
  const trimmed = operand.trim();
  if (!trimmed) {
    return '""';
  }

  if (trimmed.startsWith("{{") && trimmed.endsWith("}}")) {
    return trimmed;
  }

  if (NUMERIC_LITERAL_RE.test(trimmed)) {
    return trimmed;
  }

  if (trimmed === "true" || trimmed === "false") {
    return trimmed;
  }

  if (trimmed === "null" || trimmed === "undefined") {
    return trimmed;
  }

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed;
  }

  const escaped = trimmed.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function ruleToExpression(rule: ConditionRule): string {
  const left = wrapOperand(rule.leftOperand);

  switch (rule.operator) {
    case "==":
    case "===":
    case "!=":
    case "!==":
    case ">":
    case ">=":
    case "<":
    case "<=":
      return `${left} ${rule.operator} ${wrapOperand(rule.rightOperand)}`;

    case "contains":
      return `String(${left}).includes(${wrapOperand(rule.rightOperand)})`;

    case "startsWith":
      return `String(${left}).startsWith(${wrapOperand(rule.rightOperand)})`;

    case "endsWith":
      return `String(${left}).endsWith(${wrapOperand(rule.rightOperand)})`;

    case "isEmpty":
      return `(${left} === null || ${left} === undefined || ${left} === "")`;

    case "isNotEmpty":
      return `(${left} !== null && ${left} !== undefined && ${left} !== "")`;

    case "exists":
      return `(${left} !== null && ${left} !== undefined)`;

    case "doesNotExist":
      return `(${left} === null || ${left} === undefined)`;

    case "isNull":
      return `(${left} === null)`;

    case "isNotNull":
      return `(${left} !== null)`;

    case "isUndefined":
      return `(${left} === undefined)`;

    case "isNotUndefined":
      return `(${left} !== undefined)`;

    case "matchesRegex":
      return `new RegExp(${wrapOperand(rule.rightOperand)}).test(String(${left}))`;

    case "isTrue":
      return `${left} === true`;

    case "isFalse":
      return `${left} === false`;

    // Array operators are guarded with Array.isArray so they evaluate safely
    // (to false) when the referenced value is not an array, instead of throwing.
    case "arrayIsEmpty":
      return `(Array.isArray(${left}) && ${left}.length === 0)`;

    case "arrayIsNotEmpty":
      return `(Array.isArray(${left}) && ${left}.length > 0)`;

    case "arrayContains":
      return `(Array.isArray(${left}) && ${left}.includes(${wrapOperand(rule.rightOperand)}))`;

    case "arrayLength":
      return `(Array.isArray(${left}) && ${left}.length === ${wrapOperand(rule.rightOperand)})`;

    // Object operators guard against null/undefined before reading keys, so a
    // missing reference is false rather than a thrown error.
    case "objectIsEmpty":
      return `(${left} !== null && ${left} !== undefined && Object.keys(${left}).length === 0)`;

    case "objectHasKey":
      return `(${left} !== null && ${left} !== undefined && Object.keys(${left}).includes(${wrapOperand(rule.rightOperand)}))`;

    default: {
      const _exhaustive: never = rule.operator;
      return `${left} == ${wrapOperand(rule.rightOperand)}`;
    }
  }
}

function isEmptyRule(rule: ConditionRule): boolean {
  if (rule.leftOperand.trim() === "") {
    return true;
  }
  if (!UNARY_OPERATORS.has(rule.operator) && rule.rightOperand.trim() === "") {
    return true;
  }
  return false;
}

function groupToExpression(group: ConditionGroup): string {
  if (group.rules.length === 0) {
    return "true";
  }

  const joiner = group.logic === "AND" ? " && " : " || ";

  const parts: string[] = [];
  for (const item of group.rules) {
    if (isConditionGroup(item)) {
      const nested = groupToExpression(item);
      if (nested !== "true") {
        parts.push(`(${nested})`);
      }
    } else if (!isEmptyRule(item)) {
      parts.push(ruleToExpression(item));
    }
  }

  if (parts.length === 0) {
    return "true";
  }

  if (parts.length === 1) {
    return parts[0];
  }

  return parts.join(joiner);
}

export function visualConditionToExpression(group: ConditionGroup): string {
  return groupToExpression(group);
}
