/**
 * Condition Expression Validator
 *
 * Validates and sanitizes condition expressions before evaluation.
 * This prevents arbitrary code execution while allowing useful comparisons.
 *
 * Allowed syntax:
 * - Template variables: {{@nodeId:Label.field}} (replaced with safe __v0, __v1, etc.)
 * - Comparison operators: ===, !==, ==, !=, >, <, >=, <=
 * - Logical operators: &&, ||, !
 * - Arithmetic operators: +, -, *, /, %, **
 * - Grouping: ( )
 * - Literals: strings ('...', "..."), numbers, true, false, null, undefined
 * - Property access on variables: __v0.property, __v0[0], __v0["key"]
 * - Array methods: .includes(), .length
 * - String methods: .startsWith(), .endsWith(), .includes()
 *
 * NOT allowed:
 * - Function calls (except allowed methods)
 * - Assignment operators (=, +=, -=, etc.)
 * - Code execution constructs (eval, Function, import, require)
 * - Property assignment
 * - Array/object literals ([1,2,3], {key: value})
 * - Comments
 */

// Dangerous patterns that should never appear in conditions
const DANGEROUS_PATTERNS = [
  // Assignment operators
  /(?<![=!<>])=(?!=)/g, // = but not ==, ===, !=, !==, <=, >=
  /\+=|-=|\*=|\/=|%=|\^=|\|=|&=/g,
  // Code execution
  /\beval\s*\(/gi,
  /\bFunction\s*\(/gi,
  /\bimport\s*\(/gi,
  /\brequire\s*\(/gi,
  /\bnew\s+\w/gi,
  // Dangerous globals
  /\bprocess\b/gi,
  /\bglobal\b/gi,
  /\bwindow\b/gi,
  /\bdocument\b/gi,
  /\bconstructor\b/gi,
  /\b__proto__\b/gi,
  /\bprototype\b/gi,
  // Control flow that could be exploited
  /\bwhile\s*\(/gi,
  /\bfor\s*\(/gi,
  /\bdo\s*\{/gi,
  /\bswitch\s*\(/gi,
  /\btry\s*\{/gi,
  /\bcatch\s*\(/gi,
  /\bfinally\s*\{/gi,
  /\bthrow\s+/gi,
  /\breturn\s+/gi,
  // Template literals with expressions (could execute code)
  /`[^`]*\$\{/g,
  // Object literals (but NOT bracket property access)
  /\{\s*\w+\s*:/g,
  // Increment/decrement
  /\+\+|--/g,
  // Bitwise operators (rarely needed, often used in exploits)
  /<<|>>|>>>/g,
  // Comma operator (can chain expressions)
  /,(?![^(]*\))/g, // Comma not inside function call parentheses
  // Semicolons (statement separator)
  /;/g,
];

// Allowed method names that can be called
const ALLOWED_METHODS = new Set([
  "includes",
  "startsWith",
  "endsWith",
  "toString",
  "toLowerCase",
  "toUpperCase",
  "trim",
  "length", // Actually a property, but accessed like .length
  // Type guards emitted by the visual builder's Array/Object operators. Both are
  // pure, non-mutating reads on built-in globals, so they are safe to evaluate
  // and let array/object comparisons run without throwing on non-matching types.
  "isArray", // Array.isArray(...)
  "keys", // Object.keys(...)
]);

// Pattern to match method calls
const METHOD_CALL_PATTERN = /\.(\w+)\s*\(/g;

// Pattern to match bracket expressions: captures what's before and inside the brackets
const BRACKET_EXPRESSION_PATTERN = /(\w+)\s*\[([^\]]+)\]/g;

// Pattern for valid variable property access: __v0[0], __v0["key"], __v0['key']
const VALID_BRACKET_ACCESS_PATTERN = /^__v\d+$/;
const VALID_BRACKET_CONTENT_PATTERN = /^(\d+|'[^']*'|"[^"]*")$/;

// Top-level regex patterns for token validation
const WHITESPACE_SPLIT_PATTERN = /\s+/;
const VARIABLE_TOKEN_PATTERN = /^__v\d+/;
const STRING_TOKEN_PATTERN = /^['"]/;
const NUMBER_TOKEN_PATTERN = /^\d/;
const LITERAL_TOKEN_PATTERN = /^(true|false|null|undefined)$/;
const OPERATOR_TOKEN_PATTERN =
  /^(===|!==|==|!=|>=|<=|>|<|&&|\|\||\*\*|!|\(|\))$/;
const IDENTIFIER_TOKEN_PATTERN = /^[a-zA-Z_]\w*$/;

// Regex patterns for UI validation
const EXTRA_SPACES_PATTERN = /\s{2,}/;
const WHITESPACE_CHAR_PATTERN = /\s/;
const TEMPLATE_VAR_PATTERN = /^\{\{@[^}]+\}\}/;
const STRING_LITERAL_PATTERN = /^(['"])(?:(?<!\\)\\.|(?!\1).)*\1/;
const NUMBER_PATTERN = /^\d+(\.\d+)?/;
const IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*/;
const OPERATOR_BEFORE_PATTERN =
  /(===|!==|==|!=|>=|<=|>|<|&&|\|\||\*\*|\+|-|\*|\/|%|!)$/;
const OPERATOR_AFTER_PATTERN =
  /^(===|!==|==|!=|>=|<=|>|<|&&|\|\||\*\*|\+|-|\*|\/|%|!)/;
const OPERATOR_PATTERN = /(===|!==|==|!=|>=|<=|>|<|&&|\|\||\*\*|\+|-|\*|\/|%)/g;
const OPERATOR_CHAR_PATTERN = /[=!<>&|+\-*/%]/;
const WHITESPACE_TEST_PATTERN = /\s/;

export type ValidationResult =
  | { valid: true }
  | { valid: false; error: string };

/**
 * Check for dangerous patterns in the expression
 */
function checkDangerousPatterns(expression: string): ValidationResult {
  for (const pattern of DANGEROUS_PATTERNS) {
    // Reset regex state
    pattern.lastIndex = 0;
    if (pattern.test(expression)) {
      pattern.lastIndex = 0;
      const match = expression.match(pattern);
      return {
        valid: false,
        error: `Condition contains disallowed syntax: "${match?.[0] || "unknown"}"`,
      };
    }
  }
  return { valid: true };
}

/**
 * Check bracket expressions to distinguish between:
 * - Allowed: Variable property access like __v0[0], __v0["key"], __v0['key']
 * - Blocked: Array literals like [1,2,3], or dangerous expressions like __v0[eval('x')]
 */
function checkBracketExpressions(expression: string): ValidationResult {
  BRACKET_EXPRESSION_PATTERN.lastIndex = 0;

  // Use exec loop for compatibility
  let match: RegExpExecArray | null = null;
  while (true) {
    match = BRACKET_EXPRESSION_PATTERN.exec(expression);
    if (match === null) {
      break;
    }

    const beforeBracket = match[1];
    const insideBracket = match[2].trim();

    // Check if the part before the bracket is a valid variable (__v0, __v1, etc.).
    // Bare references like `step2[1]` reach here when an author uses an
    // unsupported reference grammar instead of the stored template format.
    if (!VALID_BRACKET_ACCESS_PATTERN.test(beforeBracket)) {
      return {
        valid: false,
        error: `Cannot index "${beforeBracket}[...]". Reference step outputs with the {{@nodeId:Label.field}} template format - use the component name for tuple/struct outputs (e.g. {{@nodeId:Label.result.liquidityIndex}}) and bracket indexing only inside the field path for arrays (e.g. {{@nodeId:Label.result.items[0]}}).`,
      };
    }

    // Check if the content inside brackets is safe (number or string literal)
    if (!VALID_BRACKET_CONTENT_PATTERN.test(insideBracket)) {
      return {
        valid: false,
        error: `Invalid bracket content: "[${insideBracket}]". Only numeric indices or string literals are allowed.`,
      };
    }
  }

  // Check for standalone array literals (brackets not preceded by a variable)
  // This catches cases like "[1, 2, 3]" at the start of expression or after operators
  const standaloneArrayPattern = /(?:^|[=!<>&|(\s])\s*\[/g;
  standaloneArrayPattern.lastIndex = 0;
  if (standaloneArrayPattern.test(expression)) {
    return {
      valid: false,
      error:
        "Array literals are not allowed in conditions. Use workflow variables instead.",
    };
  }

  return { valid: true };
}

/**
 * Check that all method calls use allowed methods
 */
function checkMethodCalls(expression: string): ValidationResult {
  METHOD_CALL_PATTERN.lastIndex = 0;

  // Use exec loop for compatibility
  let match: RegExpExecArray | null = null;
  while (true) {
    match = METHOD_CALL_PATTERN.exec(expression);
    if (match === null) {
      break;
    }

    const methodName = match[1];
    if (!ALLOWED_METHODS.has(methodName)) {
      return {
        valid: false,
        error: `Method "${methodName}" is not allowed in conditions. Allowed methods: ${Array.from(ALLOWED_METHODS).join(", ")}`,
      };
    }
  }

  return { valid: true };
}

/**
 * Check that parentheses are balanced
 */
function checkParentheses(expression: string): ValidationResult {
  let parenDepth = 0;

  for (const char of expression) {
    if (char === "(") {
      parenDepth += 1;
    }
    if (char === ")") {
      parenDepth -= 1;
    }
    if (parenDepth < 0) {
      return { valid: false, error: "Unbalanced parentheses in condition" };
    }
  }

  if (parenDepth !== 0) {
    return { valid: false, error: "Unbalanced parentheses in condition" };
  }

  return { valid: true };
}

/**
 * Check if a token is valid
 */
function isValidToken(token: string): boolean {
  // Skip known valid patterns
  if (VARIABLE_TOKEN_PATTERN.test(token)) {
    return true;
  }
  if (STRING_TOKEN_PATTERN.test(token)) {
    return true;
  }
  if (NUMBER_TOKEN_PATTERN.test(token)) {
    return true;
  }
  if (LITERAL_TOKEN_PATTERN.test(token)) {
    return true;
  }
  if (OPERATOR_TOKEN_PATTERN.test(token)) {
    return true;
  }
  return false;
}

/**
 * Check for unauthorized identifiers in the expression
 */
function checkUnauthorizedIdentifiers(expression: string): ValidationResult {
  const tokens = expression.split(WHITESPACE_SPLIT_PATTERN).filter(Boolean);

  for (const token of tokens) {
    if (isValidToken(token)) {
      continue;
    }

    // Check if it looks like an unauthorized identifier
    if (IDENTIFIER_TOKEN_PATTERN.test(token) && !token.startsWith("__v")) {
      return {
        valid: false,
        error: `Unknown identifier "${token}" in condition. Use template variables like {{@nodeId:Label.field}} to reference workflow data.`,
      };
    }
  }

  return { valid: true };
}

/**
 * Validate a condition expression after template variables have been replaced
 *
 * @param expression - The expression with template vars replaced (e.g., "__v0 === 'test'")
 * @returns ValidationResult indicating if the expression is safe to evaluate
 */
export function validateConditionExpression(
  expression: string
): ValidationResult {
  // Empty expressions are invalid
  if (!expression || expression.trim() === "") {
    return { valid: false, error: "Condition expression cannot be empty" };
  }

  // Check for dangerous patterns
  const dangerousCheck = checkDangerousPatterns(expression);
  if (!dangerousCheck.valid) {
    return dangerousCheck;
  }

  // Check bracket expressions (array access vs array literals)
  const bracketCheck = checkBracketExpressions(expression);
  if (!bracketCheck.valid) {
    return bracketCheck;
  }

  // Check method calls are allowed
  const methodCheck = checkMethodCalls(expression);
  if (!methodCheck.valid) {
    return methodCheck;
  }

  // Validate balanced parentheses
  const parenCheck = checkParentheses(expression);
  if (!parenCheck.valid) {
    return parenCheck;
  }

  // Check for unauthorized identifiers
  const identifierCheck = checkUnauthorizedIdentifiers(expression);
  if (!identifierCheck.valid) {
    return identifierCheck;
  }

  return { valid: true };
}

/**
 * Check if a raw expression (before template replacement) looks safe
 * This is a quick pre-check before the more thorough validation
 */
export function preValidateConditionExpression(
  expression: string
): ValidationResult {
  if (!expression || typeof expression !== "string") {
    return { valid: false, error: "Condition must be a non-empty string" };
  }

  // Check for obviously dangerous patterns before any processing
  const dangerousKeywords = [
    "eval",
    "Function",
    "import",
    "require",
    "process",
    "global",
    "window",
    "document",
    "__proto__",
    "constructor",
    "prototype",
  ];

  // Strip template variables before keyword check — node IDs like @process
  // are safe and should not trigger false positives
  const expressionWithoutTemplates = expression.replace(/\{\{@[^}]+\}\}/g, "");

  const lowerExpression = expressionWithoutTemplates.toLowerCase();
  for (const keyword of dangerousKeywords) {
    if (lowerExpression.includes(keyword.toLowerCase())) {
      return {
        valid: false,
        error: `Condition contains disallowed keyword: "${keyword}"`,
      };
    }
  }

  return { valid: true };
}

/**
 * Sanitize an expression by escaping potentially dangerous characters
 * This is used as an additional safety measure
 */
export function sanitizeForDisplay(expression: string): string {
  return expression
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type Token = { type: string; value: string; start: number };

const VALID_OPERATORS_UI = new Set([
  "===",
  "!==",
  "==",
  "!=",
  ">=",
  "<=",
  ">",
  "<",
  "&&",
  "||",
  "!",
  "**",
  "+",
  "-",
  "*",
  "/",
  "%",
  ".",
]);

const BINARY_OPERATORS_UI = new Set([
  "===",
  "!==",
  "==",
  "!=",
  ">=",
  "<=",
  ">",
  "<",
  "&&",
  "||",
  "**",
  "+",
  "-",
  "*",
  "/",
  "%",
]);

/**
 * Tokenizes a condition expression
 */
function tokenizeExpression(
  expression: string
): ValidationResult & { tokens?: Token[] } {
  const tokens: Token[] = [];
  let i = 0;

  while (i < expression.length) {
    // Skip whitespace
    if (WHITESPACE_CHAR_PATTERN.test(expression[i])) {
      i++;
      continue;
    }

    // Template variable: {{@nodeId:Label.field}}
    const templateMatch = expression.slice(i).match(TEMPLATE_VAR_PATTERN);
    if (templateMatch) {
      tokens.push({
        type: "template",
        value: templateMatch[0],
        start: i,
      });
      i += templateMatch[0].length;
      continue;
    }

    // String literal: '...' or "..."
    const stringMatch = expression.slice(i).match(STRING_LITERAL_PATTERN);
    if (stringMatch) {
      tokens.push({
        type: "string",
        value: stringMatch[0],
        start: i,
      });
      i += stringMatch[0].length;
      continue;
    }

    // Multi-character operators (check longest first)
    const multiCharOps = [
      "===",
      "!==",
      "==",
      "!=",
      ">=",
      "<=",
      "&&",
      "||",
      "**",
    ];
    let matched = false;
    for (const op of multiCharOps) {
      if (expression.slice(i).startsWith(op)) {
        tokens.push({
          type: "operator",
          value: op,
          start: i,
        });
        i += op.length;
        matched = true;
        break;
      }
    }
    if (matched) {
      continue;
    }

    // Single character operators
    if (
      ["!", ">", "<", "(", ")", "+", "-", "*", "/", "%", "."].includes(
        expression[i]
      )
    ) {
      tokens.push({
        type: "operator",
        value: expression[i],
        start: i,
      });
      i++;
      continue;
    }

    // Number: digits with optional decimal
    const numberMatch = expression.slice(i).match(NUMBER_PATTERN);
    if (numberMatch) {
      tokens.push({
        type: "number",
        value: numberMatch[0],
        start: i,
      });
      i += numberMatch[0].length;
      continue;
    }

    // Identifier (boolean/null literals or property access)
    const identifierMatch = expression.slice(i).match(IDENTIFIER_PATTERN);
    if (identifierMatch) {
      const value = identifierMatch[0];
      if (["true", "false", "null", "undefined"].includes(value)) {
        tokens.push({
          type: "literal",
          value,
          start: i,
        });
      } else {
        tokens.push({
          type: "identifier",
          value,
          start: i,
        });
      }
      i += value.length;
      continue;
    }

    // Unknown character
    return {
      valid: false,
      error: `Invalid character: "${expression[i]}"`,
    };
  }

  return { valid: true, tokens };
}

/**
 * Checks if a token is a valid operand
 */
function isValidOperand(token: Token): boolean {
  return (
    token.type === "template" ||
    token.type === "string" ||
    token.type === "number" ||
    token.type === "literal" ||
    token.type === "identifier" ||
    token.value === ")" ||
    token.value === "(" ||
    token.value === "!"
  );
}

/**
 * Validates spacing around binary operators (must have exactly one space on both sides)
 * Uses regex to find operators directly in the expression string for accurate positioning
 */
function validateOperatorSpacing(
  expression: string,
  _tokens: Token[]
): ValidationResult {
  // Find all operator matches in the expression
  const operatorMatches: Array<{ value: string; index: number }> = [];
  // Reset regex and find all matches
  const pattern = new RegExp(OPERATOR_PATTERN.source, OPERATOR_PATTERN.flags);
  let match: RegExpExecArray | null = null;
  // biome-ignore lint/suspicious/noAssignInExpressions: Standard pattern for regex.exec in loop
  while ((match = pattern.exec(expression)) !== null) {
    // Skip if this is part of a template variable (inside {{...}})
    const beforeMatch = expression.slice(0, match.index);
    const openBraces = (beforeMatch.match(/\{\{/g) || []).length;
    const closeBraces = (beforeMatch.match(/\}\}/g) || []).length;
    const isInsideTemplate = openBraces > closeBraces;

    if (!isInsideTemplate) {
      operatorMatches.push({
        value: match[1],
        index: match.index,
      });
    }
  }

  // Validate spacing for each operator
  for (const opMatch of operatorMatches) {
    const operatorValue = opMatch.value;
    const operatorStart = opMatch.index;
    const operatorEnd = operatorStart + operatorValue.length;

    // Skip unary operators at start or after certain operators
    if (operatorValue === "-" || operatorValue === "!") {
      const charBefore =
        operatorStart > 0 ? expression[operatorStart - 1] : null;
      // Allow unary - or ! at start, after operators, or after (
      if (
        operatorStart === 0 ||
        charBefore === " " ||
        charBefore === "(" ||
        OPERATOR_CHAR_PATTERN.test(charBefore || "")
      ) {
        continue;
      }
    }

    // Only validate binary operators
    if (!BINARY_OPERATORS_UI.has(operatorValue)) {
      continue;
    }

    // Check if this is at the start of expression (no space needed before)
    const isAtStart = operatorStart === 0;
    // Check if this is at the end of expression (no space needed after)
    const isAtEnd = operatorEnd === expression.length;

    // Check space before operator
    if (!isAtStart) {
      const charBefore = expression[operatorStart - 1];
      // Accept regular space (32) or non-breaking space (160) or other common whitespace
      const isWhitespace =
        charBefore === " " ||
        charBefore === "\u00A0" || // Non-breaking space
        WHITESPACE_TEST_PATTERN.test(charBefore);
      if (!isWhitespace) {
        return {
          valid: false,
          error: `Operator "${operatorValue}" must have exactly one space before it`,
        };
      }
      // Check for multiple spaces before (regular or non-breaking)
      if (
        operatorStart > 1 &&
        (expression[operatorStart - 2] === " " ||
          expression[operatorStart - 2] === "\u00A0" ||
          WHITESPACE_TEST_PATTERN.test(expression[operatorStart - 2]))
      ) {
        return {
          valid: false,
          error: `Extra spaces detected before operator "${operatorValue}"`,
        };
      }
    }

    // Check space after operator
    if (!isAtEnd) {
      const charAfter = expression[operatorEnd];
      // Accept regular space (32) or non-breaking space (160) or other common whitespace
      const isWhitespace =
        charAfter === " " ||
        charAfter === "\u00A0" || // Non-breaking space
        WHITESPACE_TEST_PATTERN.test(charAfter);
      if (!isWhitespace) {
        return {
          valid: false,
          error: `Operator "${operatorValue}" must have exactly one space after it`,
        };
      }
      // Check for multiple spaces after (regular or non-breaking)
      if (
        operatorEnd + 1 < expression.length &&
        (expression[operatorEnd + 1] === " " ||
          expression[operatorEnd + 1] === "\u00A0" ||
          WHITESPACE_TEST_PATTERN.test(expression[operatorEnd + 1]))
      ) {
        return {
          valid: false,
          error: `Extra spaces detected after operator "${operatorValue}"`,
        };
      }
    }
  }

  return { valid: true };
}

/**
 * Validates operators at start/end of expression
 */
function validateOperatorBoundaries(tokens: Token[]): ValidationResult {
  const firstToken = tokens[0];
  const lastToken = tokens.at(-1);

  if (
    firstToken &&
    firstToken.type === "operator" &&
    firstToken.value !== "!" &&
    firstToken.value !== "-" &&
    firstToken.value !== "("
  ) {
    return {
      valid: false,
      error: `Expression cannot start with operator "${firstToken.value}"`,
    };
  }

  if (lastToken && lastToken.type === "operator" && lastToken.value !== ")") {
    return {
      valid: false,
      error: `Incomplete expression: operator "${lastToken.value}" is missing a value`,
    };
  }

  return { valid: true };
}

/**
 * Validates consecutive operators
 */
function validateConsecutiveOperators(tokens: Token[]): ValidationResult {
  for (let j = 0; j < tokens.length - 1; j++) {
    const current = tokens[j];
    const next = tokens[j + 1];

    if (current.type === "operator" && next.type === "operator") {
      // Allow ! and - before other operators or operands (unary operators)
      if (current.value === "!" || current.value === "-") {
        continue;
      }
      // Allow ) before operators
      if (current.value === ")") {
        continue;
      }
      // Allow ( after operators
      if (next.value === "(") {
        continue;
      }

      // Check for cases like == = or === =
      if (BINARY_OPERATORS_UI.has(current.value) && next.value === "=") {
        return {
          valid: false,
          error: `Operator "${current.value}" is missing a valid operand on the right side`,
        };
      }

      return {
        valid: false,
        error: `Consecutive operators must be separated by a valid operand: "${current.value}" followed by "${next.value}"`,
      };
    }
  }

  return { valid: true };
}

/**
 * Validates binary operator has operands on both sides
 * Note: `-` can be unary (negative numbers) or binary (subtraction)
 */
function validateBinaryOperator(
  token: Token,
  index: number,
  tokens: Token[]
): ValidationResult {
  // `-` can be unary (negative numbers) - allow it at start or after certain operators
  if (token.value === "-") {
    const canBeUnary =
      index === 0 ||
      (index > 0 &&
        (tokens[index - 1].type === "operator" ||
          tokens[index - 1].value === "("));
    if (canBeUnary) {
      // Validate it has a right operand (it's unary)
      if (index === tokens.length - 1) {
        return {
          valid: false,
          error: "Operator '-' is missing a value",
        };
      }
      const next = tokens[index + 1];
      if (!isValidOperand(next)) {
        return {
          valid: false,
          error: "Operator '-' must be followed by a valid operand",
        };
      }
      return { valid: true };
    }
  }

  // Check left operand
  let hasLeftOperand = false;
  if (index > 0) {
    const prev = tokens[index - 1];
    if (isValidOperand(prev)) {
      hasLeftOperand = true;
    }
  }

  if (!hasLeftOperand) {
    return {
      valid: false,
      error: `Operator "${token.value}" is missing a valid operand on the left side`,
    };
  }

  // Check right operand
  let hasRightOperand = false;
  if (index < tokens.length - 1) {
    const next = tokens[index + 1];
    if (isValidOperand(next)) {
      hasRightOperand = true;
    }
  }

  if (!hasRightOperand) {
    return {
      valid: false,
      error: `Operator "${token.value}" is missing a valid operand on the right side`,
    };
  }

  return { valid: true };
}

/**
 * Validates unary operator !
 */
function validateUnaryOperator(
  _token: Token,
  index: number,
  tokens: Token[]
): ValidationResult {
  if (index === tokens.length - 1) {
    return {
      valid: false,
      error: "Operator '!' is missing a value",
    };
  }

  const next = tokens[index + 1];
  if (!isValidOperand(next)) {
    return {
      valid: false,
      error: "Operator '!' must be followed by a valid operand",
    };
  }

  return { valid: true };
}

/**
 * Validates operator placement and operands
 */
function validateOperators(tokens: Token[]): ValidationResult {
  // Check boundaries
  const boundaryCheck = validateOperatorBoundaries(tokens);
  if (!boundaryCheck.valid) {
    return boundaryCheck;
  }

  // Check consecutive operators
  const consecutiveCheck = validateConsecutiveOperators(tokens);
  if (!consecutiveCheck.valid) {
    return consecutiveCheck;
  }

  // Validate each operator
  for (let j = 0; j < tokens.length; j++) {
    const token = tokens[j];

    if (token.type === "operator") {
      // Validate binary operators
      if (BINARY_OPERATORS_UI.has(token.value)) {
        const binaryCheck = validateBinaryOperator(token, j, tokens);
        if (!binaryCheck.valid) {
          return binaryCheck;
        }
      }

      // Validate unary operator !
      if (token.value === "!") {
        const unaryCheck = validateUnaryOperator(token, j, tokens);
        if (!unaryCheck.valid) {
          return unaryCheck;
        }
      }

      // Validate operator is in allowed list
      if (
        !VALID_OPERATORS_UI.has(token.value) &&
        token.value !== "(" &&
        token.value !== ")"
      ) {
        return {
          valid: false,
          error: `Invalid operator: "${token.value}"`,
        };
      }
    }
  }

  return { valid: true };
}

/**
 * Validates condition expression for UI feedback (before template replacement)
 * Checks for syntax errors like incomplete expressions, extra spaces, invalid operators
 * This is purely informational - does not block saving
 */
export function validateConditionExpressionUI(
  expression: string
): ValidationResult {
  // Empty expressions are valid (user might be typing)
  if (!expression || expression.trim() === "") {
    return { valid: true };
  }

  const trimmed = expression.trim();

  // Check for extra spaces (2+ consecutive spaces) and identify the operator
  const extraSpacesMatch = trimmed.match(EXTRA_SPACES_PATTERN);
  if (extraSpacesMatch) {
    const matchIndex = extraSpacesMatch.index ?? 0;
    const beforeMatch = trimmed.slice(0, matchIndex);
    const afterMatch = trimmed.slice(matchIndex + extraSpacesMatch[0].length);

    // Find the operator before or after the extra spaces
    // Check what's before the extra spaces
    const beforeMatchTrimmed = beforeMatch.trimEnd();
    const operatorBeforeMatch = beforeMatchTrimmed.match(
      OPERATOR_BEFORE_PATTERN
    );
    if (operatorBeforeMatch) {
      return {
        valid: false,
        error: `Extra spaces detected after operator "${operatorBeforeMatch[1]}"`,
      };
    }

    // Check what's after the extra spaces
    const afterMatchTrimmed = afterMatch.trimStart();
    const operatorAfterMatch = afterMatchTrimmed.match(OPERATOR_AFTER_PATTERN);
    if (operatorAfterMatch) {
      return {
        valid: false,
        error: `Extra spaces detected before operator "${operatorAfterMatch[1]}"`,
      };
    }

    // Fallback if we can't identify the operator
    return {
      valid: false,
      error: "Extra spaces detected between operators",
    };
  }

  // Tokenize the expression
  const tokenizeResult = tokenizeExpression(trimmed);
  if (!tokenizeResult.valid) {
    return tokenizeResult;
  }

  const tokens = tokenizeResult.tokens;
  if (!tokens || tokens.length === 0) {
    return { valid: true };
  }

  // Validate spacing around binary operators (must have exactly one space on both sides)
  const spacingCheck = validateOperatorSpacing(trimmed, tokens);
  if (!spacingCheck.valid) {
    return spacingCheck;
  }

  // Validate operators
  return validateOperators(tokens);
}
