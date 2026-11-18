/**
 * Pure expression generation from ConditionGroup -> string.
 *
 * Extracted from condition-builder-utils.ts so that modules in the workflow
 * bundle (condition-resolver.ts) can convert visual configs to expression
 * strings WITHOUT pulling in nanoid (a Node.js module that the workflow
 * runtime rejects).
 */

import { hasTemplateToken } from "@/lib/workflow/template-ref";
import type {
  ConditionGroup,
  ConditionOperator,
  ConditionRule,
} from "./builder-types";
import { isConditionGroup } from "./builder-types";
import { OPERATOR_METADATA } from "./operator-metadata";

// Decimal grammar the safe-eval tokenizer accepts (integer or fixed-point, optional sign).
// Excludes hex like 0x... and exponents like 1e5, which Number() treats as numeric but the
// tokenizer cannot parse, so those stay quoted as string literals.
const NUMERIC_LITERAL_RE = /^[+-]?\d+(\.\d+)?$/;

const UNARY_OPERATORS: ReadonlySet<ConditionOperator> = new Set(
  (Object.keys(OPERATOR_METADATA) as ConditionOperator[]).filter(
    (op) => OPERATOR_METADATA[op].unary
  )
);

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

  return quoteText(trimmed);
}

function quoteText(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** A regex rule's pattern as typed: one layer of surrounding quotes removed. */
export function regexRulePattern(operand: string): string {
  const trimmed = operand.trim();
  const quote = trimmed[0];
  const quoted =
    trimmed.length >= 2 &&
    (quote === '"' || quote === "'") &&
    trimmed.at(-1) === quote;
  return quoted ? trimmed.slice(1, -1) : trimmed;
}

// Always a quoted literal, whatever it looks like (42, true, "a"|"b"). A
// reference stays bare so the run refuses it rather than matching its text.
function regexOperand(operand: string): string {
  const trimmed = operand.trim();
  return hasTemplateToken(trimmed)
    ? trimmed
    : quoteText(regexRulePattern(trimmed));
}

// Both sides arrive as expressions: wrapped operands, or variables such as __v0.
export function operatorToExpression(
  operator: ConditionOperator,
  left: string,
  right: string
): string {
  switch (operator) {
    case "==":
    case "===":
    case "!=":
    case "!==":
    case ">":
    case ">=":
    case "<":
    case "<=":
      return `${left} ${operator} ${right}`;

    case "contains":
      return `String(${left}).includes(${right})`;

    case "startsWith":
      return `String(${left}).startsWith(${right})`;

    case "endsWith":
      return `String(${left}).endsWith(${right})`;

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
      return `matchesRegex(String(${left}), ${right})`;

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
      return `(Array.isArray(${left}) && ${left}.includes(${right}))`;

    case "arrayLength":
      return `(Array.isArray(${left}) && ${left}.length === ${right})`;

    // Object operators guard against null/undefined before reading keys, so a
    // missing reference is false rather than a thrown error.
    case "objectIsEmpty":
      return `(${left} !== null && ${left} !== undefined && Object.keys(${left}).length === 0)`;

    case "objectHasKey":
      return `(${left} !== null && ${left} !== undefined && Object.keys(${left}).includes(${right}))`;

    default: {
      const _exhaustive: never = operator;
      return `${left} == ${right}`;
    }
  }
}

function ruleToExpression(rule: ConditionRule): string {
  return operatorToExpression(
    rule.operator,
    wrapOperand(rule.leftOperand),
    rule.operator === "matchesRegex"
      ? regexOperand(rule.rightOperand)
      : wrapOperand(rule.rightOperand)
  );
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
