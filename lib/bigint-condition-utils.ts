/**
 * BigInt-safe condition evaluation utilities
 *
 * Problem:
 *   JavaScript's Number type uses IEEE 754 double-precision floats, which can
 *   only represent integers exactly up to 2^53 - 1 (Number.MAX_SAFE_INTEGER =
 *   9007199254740991). Web3 values like token balances in wei routinely exceed
 *   this (1 ETH = 1e18 wei). When the condition evaluator uses `new Function()`
 *   to run expressions like `__v0 > 1000000000000000000`, both the string-to-
 *   number coercion and the number literal itself lose precision silently.
 *
 * Solution:
 *   Before `new Function()` evaluation, detect if any operand exceeds
 *   MAX_SAFE_INTEGER. If so, convert ALL integer operands to BigInt - both the
 *   context variable values and the number literals embedded in the expression.
 *   This ensures both sides of every comparison are the same type (BigInt) and
 *   produce exact results.
 *
 * Integration:
 *   Called in `evaluateConditionExpression()` (workflow-executor.workflow.ts)
 *   AFTER the condition-validator has approved the expression. The validator
 *   never sees BigInt-related tokens. The injected `__b<N>` variables for
 *   replaced literals are only present in the `new Function()` call, not in the
 *   validated expression string.
 *
 * Constraints:
 *   - The condition-validator rejects `BigInt(...)` calls and unknown identifiers
 *   - We cannot modify the expression to contain BigInt syntax
 *   - All BigInt handling happens via variable injection after validation
 */

/** Matches strings that consist entirely of digits (integer representation). */
const INTEGER_RE = /^\d+$/;

/**
 * Matches either a quoted string (single or double) to skip, a decimal number
 * (digits.digits) to skip, or a bare integer literal at a word boundary.
 *
 * Order matters - decimal patterns are checked before bare integers so that
 * "3.14" is consumed as one match (and skipped) rather than splitting into
 * two digit matches ("3" and "14") which would produce invalid `__b0.__b1`.
 *
 * Group 1: quote character (string literal - skip)
 * Group 2: decimal number (float literal - skip, BigInt cannot represent floats)
 * Group 3: bare digit sequence (integer literal - replace with __b variable)
 */
const EXPRESSION_TOKEN_RE = /(["'])(?:(?!\1).)*\1|(\b\d+\.\d+\b)|\b(\d+)\b/g;

/**
 * Check if a digit string represents an integer beyond Number.MAX_SAFE_INTEGER.
 * Only pure digit strings are considered - strings containing non-digit characters
 * (letters, dots, hyphens) are not integers and return false.
 */
function isLargeInteger(value: string): boolean {
  return INTEGER_RE.test(value) && !Number.isSafeInteger(Number(value));
}

/**
 * Detect whether BigInt mode is needed for the given expression and context.
 *
 * Returns true if ANY of these conditions hold:
 * - An evalContext value is a digit-only string exceeding MAX_SAFE_INTEGER
 * - An evalContext value is a Number that is an integer but not safe
 * - The expression contains a number literal exceeding MAX_SAFE_INTEGER
 *
 * Non-integer types (booleans, null, undefined, objects, non-digit strings,
 * floats) are ignored - they cannot cause BigInt precision issues.
 *
 * @param expression - The transformed condition expression (templates already
 *   replaced with `__v<N>` variables)
 * @param evalContext - Map of variable names to their resolved values
 * @returns true if any value needs BigInt for precise comparison
 */
export function needsBigIntMode(
  expression: string,
  evalContext: Record<string, unknown>
): boolean {
  for (const val of Object.values(evalContext)) {
    if (typeof val === "string" && isLargeInteger(val)) {
      return true;
    }
    if (
      typeof val === "number" &&
      Number.isInteger(val) &&
      !Number.isSafeInteger(val)
    ) {
      return true;
    }
  }

  for (const match of expression.matchAll(EXPRESSION_TOKEN_RE)) {
    const digits = match[3];
    // Skip quoted strings and decimals (digits is undefined when group 1 or 2 matched)
    if (digits !== undefined && isLargeInteger(digits)) {
      return true;
    }
  }

  return false;
}

/**
 * Convert all integer operands to BigInt for exact comparison.
 *
 * Two-phase conversion:
 *
 * 1. **Context values** (resolved template variables like `__v0`, `__v1`):
 *    - Digit-only strings (e.g. `"2000000000000000000"`) -> `BigInt(value)`
 *    - Integer numbers (e.g. `100`) -> `BigInt(value)`
 *    - Everything else is left as-is: non-digit strings, booleans, null,
 *      undefined, objects, floats. These types don't participate in BigInt
 *      comparison and would throw if converted.
 *
 * 2. **Expression literals** (number tokens in the expression string):
 *    - Each `\b\d+\b` match is extracted, replaced with an injected variable
 *      `__b0`, `__b1`, etc., and the BigInt equivalent is stored in the
 *      returned context.
 *    - This avoids modifying the expression to contain BigInt syntax (which
 *      the validator would reject).
 *
 * After conversion, both sides of any comparison are BigInt, so operators
 * like `>`, `<`, `===`, `>=`, `<=` work correctly without precision loss.
 *
 * @param expression - The validated condition expression with `__v<N>` vars
 * @param evalContext - Current variable name -> value mapping
 * @returns New expression string and new evalContext with BigInt values
 *
 * @example
 *   applyBigIntConversion("__v0 > 1000000000000000000", { __v0: "2000000000000000000" })
 *   // => { expression: "__v0 > __b0", evalContext: { __v0: 2000000000000000000n, __b0: 1000000000000000000n } }
 */
export function applyBigIntConversion(
  expression: string,
  evalContext: Record<string, unknown>
): { expression: string; evalContext: Record<string, unknown> } {
  const converted: Record<string, unknown> = {};

  for (const [key, val] of Object.entries(evalContext)) {
    if (typeof val === "string" && INTEGER_RE.test(val)) {
      converted[key] = BigInt(val);
    } else if (
      typeof val === "number" &&
      Number.isInteger(val) &&
      Number.isFinite(val)
    ) {
      converted[key] = BigInt(val);
    } else {
      converted[key] = val;
    }
  }

  let counter = 0;
  const resultExpression = expression.replace(
    EXPRESSION_TOKEN_RE,
    (
      fullMatch,
      _quoteChar: string | undefined,
      _decimal: string | undefined,
      digits: string | undefined
    ) => {
      // If no digits captured, this is a quoted string or decimal - leave unchanged
      if (digits === undefined) {
        return fullMatch;
      }
      const varName = `__b${counter}`;
      counter++;
      converted[varName] = BigInt(digits);
      return varName;
    }
  );

  return { expression: resultExpression, evalContext: converted };
}
