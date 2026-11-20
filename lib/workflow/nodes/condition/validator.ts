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
 * - matchesRegex(text, "pattern"), checked by the interpreter
 *
 * NOT allowed:
 * - Function calls (except allowed methods)
 * - Assignment operators (=, +=, -=, etc.)
 * - Code execution constructs (eval, Function, import, require)
 * - Property assignment
 * - Array/object literals ([1,2,3], {key: value})
 * - Comments
 */

import { stripControlChars } from "@/lib/utils/control-chars";
import { cutText } from "@/lib/utils/cut-text";
import {
  hasTemplateToken,
  parseStoredRef,
  replaceTemplateTokens,
} from "@/lib/workflow/template-ref";
import {
  hasIndirectRegexUseIn,
  hasNegatedRegexCallIn,
  maskedStructure,
  mentionsRegexIn,
  REGEX_OBJECT_RE,
  regexCallsIn,
} from "./regex-calls";
import {
  MAX_REGEX_CALLS,
  MAX_RUN_REGEX_WORK,
  prepareWorkflowPatterns,
  REGEX_ARITY_ERROR,
  REGEX_BACKSLASH_ERROR,
  REGEX_CALLS_ERROR,
  REGEX_DIRECT_ERROR,
  REGEX_LITERAL_ERROR,
  REGEX_NEGATED_ERROR,
  REGEX_SOURCE_ERROR,
  REGEX_TEMPLATE_ERROR,
  RegexBudget,
  regexPatternError,
  workflowCompileError,
} from "./regex-match";
import { resolveCondition } from "./resolver";
import {
  BLOCKED_PROPS,
  regexCallPatterns,
  runnableConditionError,
} from "./safe-eval";
import { maskStringLiterals, scanString } from "./string-literal";

// A comma not inside call parentheses. Checked by hasStrayComma in one pass:
// as a regex, the lookahead rescanned to the end for every comma.
const COMMA_OUTSIDE_CALL = /,(?![^(]*\))/g;

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
  // Comma operator (can chain expressions); checked by strayComma below
  COMMA_OUTSIDE_CALL,
  // Semicolons (statement separator)
  /;/g,
];

const REGEX_OBJECT_ERROR =
  'Regex objects (new RegExp(...) or /.../) are not supported in conditions. Use matchesRegex(value, "pattern") or the "matches regex" operator';
const REGEX_CALL_TEXT_RE = /\bmatchesRegex\s*\(/;
const BACKSLASH_ADVICE_RE = /backslash/;
const TRAILING_PERIOD_RE = /\.$/;
const REGEX_UNCLOSED_ERROR = "matchesRegex( is missing its closing )";
const UNTERMINATED_STRING_ERROR =
  "Condition has an unterminated string: a quote is never closed";
// Masking hides string keys from the keyword scan, so a key is checked after
// decoding, the way the interpreter reads it ("\x63onstructor" included).
const STRING_KEY_RE = /\[\s*["']/g;

function blockedKeyError(
  expression: string,
  code: string
): ValidationResult | undefined {
  for (const match of code.matchAll(STRING_KEY_RE)) {
    const quoteAt = match.index + match[0].length - 1;
    const key = scanString(expression, quoteAt).value;
    if (BLOCKED_PROPS.has(key)) {
      return {
        valid: false,
        error: `Condition contains disallowed syntax: "[${key}]"`,
      };
    }
  }
  return;
}

// Caps conditions that use matchesRegex, whose checks read the text several
// times; each reference counts as the run's short name (__v0).
const MAX_CONDITION_LENGTH = 10_000;

function conditionLength(expression: string): number {
  let index = 0;
  return replaceTemplateTokens(expression, () => `__v${index++}`).length;
}

// `subject` names the Condition when the message is read away from it.
function lengthMessage(
  length: number,
  rules: boolean,
  subject?: string
): string {
  let what = "This condition is";
  let them = "it";
  if (subject) {
    what = `${subject} is`;
  } else if (rules) {
    what = "These rules are";
    them = "them";
  }
  const test = rules ? "a regex test" : "matchesRegex";
  return `${what} too long to run with ${test}: ${length.toLocaleString("en-US")} characters, each {{...}} reference counted as about 4; the limit is ${MAX_CONDITION_LENGTH.toLocaleString("en-US")}. Split ${them} across two Condition nodes`;
}

// Applied only to conditions that use matchesRegex, so no saved condition
// without one stops running.
function lengthError(
  expression: string,
  usesRegex: boolean
): ValidationResult | undefined {
  if (!usesRegex) {
    return;
  }
  const length = conditionLength(expression);
  return length > MAX_CONDITION_LENGTH
    ? { valid: false, error: lengthMessage(length, false) }
    : undefined;
}

/**
 * The limits a visual condition can reach without a typo: its length and how
 * many regex rules it has. Shown under the rules, before any run.
 */
export function visualConditionLimitError(
  expression: string,
  regexRules: number
): string | undefined {
  if (regexRules > MAX_REGEX_CALLS) {
    return `A Condition can have at most ${MAX_REGEX_CALLS} regex tests. Split them across two Condition nodes`;
  }
  if (regexRules === 0) {
    return;
  }
  const length = conditionLength(expression);
  return length > MAX_CONDITION_LENGTH
    ? lengthMessage(length, true)
    : undefined;
}

// The scanner's own reason: an unclosed quote, or an escape it cannot read.
function stringError(error: unknown, expression: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("Unterminated")) {
    return UNTERMINATED_STRING_ERROR;
  }
  const reason = `${message[0]?.toLowerCase() ?? ""}${message.slice(1)}`;
  const hint = REGEX_CALL_TEXT_RE.test(expression)
    ? ". In a regex pattern, double each backslash"
    : "";
  return `Condition has an ${reason}${hint}`;
}

// The text masked once (references and quoted text blanked) for every regex
// check; `masked` is undefined when a quote is never closed.
type RegexScan = { masked: string | undefined; structure: string };

function scanForRegex(expression: string): RegexScan {
  const masked = maskedStructure(expression);
  return { masked, structure: masked ?? expression };
}

// Only the raw condition (references not yet filled in) shows this: a
// reference inside a regex pattern would be filled in as the name __v0.
function rawRegexError(
  expression: string,
  scan: RegexScan
): ValidationResult | undefined {
  if (hasNegatedRegexCallIn(scan.structure)) {
    return { valid: false, error: REGEX_NEGATED_ERROR };
  }
  if (hasIndirectRegexUseIn(scan.masked)) {
    return { valid: false, error: REGEX_DIRECT_ERROR };
  }
  const calls = scan.masked === undefined ? [] : regexCallsIn(scan.masked);
  if (calls.length > MAX_REGEX_CALLS) {
    return { valid: false, error: REGEX_CALLS_ERROR };
  }
  for (const call of calls) {
    const pattern = call.args[1];
    const text = pattern ? expression.slice(...pattern).trim() : "";
    const quoted = text.startsWith('"') || text.startsWith("'");
    if (hasTemplateToken(text)) {
      // Typed inside quotes it may be braces meant literally.
      return {
        valid: false,
        error: quoted ? REGEX_TEMPLATE_ERROR : REGEX_SOURCE_ERROR,
      };
    }
    // e.g. ^0x typed without its quotes, before the tokenizer trips on "^".
    if (text && !quoted) {
      return { valid: false, error: REGEX_LITERAL_ERROR };
    }
  }
  return;
}

// References become __vN as a run turns them; others stay and fail as they would.
function runText(expression: string): string {
  let index = 0;
  return replaceTemplateTokens(expression, ({ body }) =>
    parseStoredRef(body) ? `__v${index++}` : `{{${body}}}`
  );
}

function usesRegex(scan: RegexScan): boolean {
  return (
    mentionsRegexIn(scan.structure) || hasNegatedRegexCallIn(scan.structure)
  );
}

/** Whether a raw condition uses matchesRegex (the negated form included). */
export function conditionUsesRegex(expression: string): boolean {
  return usesRegex(scanForRegex(expression));
}

/**
 * The typed patterns of a condition's matchesRegex calls, as a run reads them;
 * only for one known to use matchesRegex and to fit its own limit.
 */
function conditionRegexPatterns(expression: string): string[] {
  try {
    return regexCallPatterns(runText(expression));
  } catch {
    return [];
  }
}

type NodeWithConfig = {
  type?: unknown;
  data?: {
    type?: unknown;
    label?: unknown;
    enabled?: unknown;
    config?: Record<string, unknown>;
  };
};

const NO_NAME = "Condition with no name";
const WHITESPACE_RUN_RE = /\s+/g;

// Cheap caps on a workflow's regex Conditions, checked before any is parsed.
const MAX_WORKFLOW_REGEX_CONDITIONS = 32;
const MAX_WORKFLOW_REGEX_TEXT = 100_000;

/**
 * A regex problem that refuses a save: one Condition's own, or the workflow's
 * regex Conditions together (too many, too much text, patterns over the cap).
 * For "text" and "patterns", `index` is the Condition with the most, unless
 * `unmeasured` (some patterns past the cap were not measured).
 */
export type RegexIssue = {
  index: number;
  message: string;
  kind: "condition" | "count" | "text" | "patterns";
  unmeasured?: boolean;
};

type IndexedCondition = {
  index: number;
  condition: string;
  fromRules: boolean;
};
type RegexCondition = IndexedCondition & { length: number };

// Each regex Condition with its length, scanned and measured once.
function regexConditionsOf(
  conditions: readonly IndexedCondition[]
): RegexCondition[] {
  const withRegex: RegexCondition[] = [];
  for (const indexed of conditions) {
    if (usesRegex(scanForRegex(indexed.condition))) {
      withRegex.push({
        ...indexed,
        length: conditionLength(indexed.condition),
      });
    }
  }
  return withRegex;
}

// The first Condition over its own length limit; save and run start refuse it.
function tooLong(
  withRegex: readonly RegexCondition[]
): RegexCondition | undefined {
  return withRegex.find(({ length }) => length > MAX_CONDITION_LENGTH);
}

// Over its own limit a Condition is never read; its own check reports it.
function withinLength(withRegex: readonly RegexCondition[]): RegexCondition[] {
  return withRegex.filter(({ length }) => length <= MAX_CONDITION_LENGTH);
}

/** Too many regex Conditions, or too much text in them, before any is parsed. */
function workflowSizeIssue(
  withRegex: readonly RegexCondition[]
): RegexIssue | undefined {
  if (withRegex.length > MAX_WORKFLOW_REGEX_CONDITIONS) {
    return {
      index: withRegex[MAX_WORKFLOW_REGEX_CONDITIONS].index,
      message: `This workflow has ${withRegex.length} Conditions with a regex test; the limit is ${MAX_WORKFLOW_REGEX_CONDITIONS}`,
      kind: "count",
    };
  }
  let total = 0;
  let largest = { index: -1, length: -1 };
  for (const { index, length } of withinLength(withRegex)) {
    total += length;
    if (length > largest.length) {
      largest = { index, length };
    }
  }
  if (total <= MAX_WORKFLOW_REGEX_TEXT) {
    return;
  }
  return {
    index: largest.index,
    message: `Together, this workflow's Conditions with a regex test are ${total.toLocaleString("en-US")} characters; the limit is ${MAX_WORKFLOW_REGEX_TEXT.toLocaleString("en-US")}`,
    kind: "text",
  };
}

/** What each enabled Condition node runs (its rules or its text), with its index. */
export function workflowConditions(
  nodes: readonly NodeWithConfig[]
): IndexedCondition[] {
  const conditions: IndexedCondition[] = [];
  for (const [index, node] of nodes.entries()) {
    const config = node.data?.config;
    const isAction = node.type === "action" || node.data?.type === "action";
    if (
      !isAction ||
      node.data?.enabled === false ||
      config?.actionType !== "Condition"
    ) {
      continue;
    }
    const resolved = resolveCondition(config);
    if (resolved) {
      const { expression, fromRules } = resolved;
      conditions.push({ index, condition: expression, fromRules });
    }
  }
  return conditions;
}

/**
 * At a run's start: compiles every enabled Condition's patterns into the run's
 * budget, and refuses the run past the workflow's caps or for an over-long
 * Condition. A pattern RE2 refuses is not: it fails where the run reaches it.
 */
export function prepareRunRegex(
  nodes: readonly NodeWithConfig[],
  budget: RegexBudget
): string | undefined {
  const withRegex = regexConditionsOf(workflowConditions(nodes));
  // Refused before any step runs, rather than when the run reaches it.
  const long = tooLong(withRegex);
  if (long) {
    const name = labelText(nodes[long.index]?.data?.label);
    const subject = name ? `The Condition "${name}"` : `A ${NO_NAME}`;
    return lengthMessage(long.length, long.fromRules, subject);
  }
  const issue = workflowLimitIssue(withRegex, budget);
  if (!issue) {
    return;
  }
  return limitMessage(issue, mostIn(nodes[issue.index]?.data?.label));
}

const LIMIT_HINTS: Record<Exclude<RegexIssue["kind"], "condition">, string> = {
  count:
    "Combine some tests into one Condition, or test a list with Filter Array",
  text: "Shorten them, or move tests without a regex into their own Condition",
  patterns:
    "Shorten them, reuse one pattern, or test lists with Filter Array (about 2,000 pattern characters fit in all, fewer with repeats like {40})",
};

/** A regex issue's message; for the workflow's limits, where most is and what to do. */
export function limitMessage(issue: RegexIssue, where: string): string {
  if (issue.kind === "condition") {
    return issue.message;
  }
  const named = issue.kind !== "count" && !issue.unmeasured;
  const parts = named ? [issue.message, where] : [issue.message];
  return [...parts, LIMIT_HINTS[issue.kind]].join(". ");
}

/** Names the Condition with the most, by its label as one safe line. */
export function mostIn(label: unknown): string {
  const text = labelText(label);
  return text ? `Most are in "${text}"` : `Most are in a ${NO_NAME}`;
}

// A node label as one safe line of at most 60 characters, or "" for none.
function labelText(label: unknown): string {
  const text =
    typeof label === "string"
      ? stripControlChars(label, { replacement: " " })
          .replaceAll('"', "'")
          .replace(WHITESPACE_RUN_RE, " ")
          .trim()
      : "";
  return text.length > 60 ? `${cutText(text, 57)}...` : text;
}

/**
 * The first problem that refuses saving a workflow's regex Conditions: too
 * many or too long together, then what fails any run reaching a Condition
 * (the run's own checks, a pattern no run can compile), then the patterns
 * together past the cap. Conditions without matchesRegex are not checked, so
 * no saved workflow stops saving.
 */
export function workflowRegexIssue(
  conditions: readonly IndexedCondition[]
): RegexIssue | undefined {
  const withRegex = regexConditionsOf(conditions);
  // One Condition's own length is the more useful message than the total's.
  const long = tooLong(withRegex);
  if (long) {
    return {
      index: long.index,
      message: lengthMessage(long.length, long.fromRules),
      kind: "condition",
    };
  }
  const size = workflowSizeIssue(withRegex);
  if (size) {
    return withMost(size);
  }
  for (const { index, condition } of withRegex) {
    const message = conditionRunError(condition);
    if (message) {
      return { index, message, kind: "condition" };
    }
  }
  const budget = new RegexBudget(MAX_RUN_REGEX_WORK, { scope: "run" });
  const issue = compileConditions(withRegex, budget, true);
  return issue && withMost(issue);
}

// A save names the Condition it reports, so say why it was picked.
function withMost(issue: RegexIssue): RegexIssue {
  return {
    ...issue,
    message: limitMessage(issue, "This Condition has the most"),
  };
}

function conditionRunError(condition: string): string | undefined {
  const pre = preValidateConditionExpression(condition);
  if (!pre.valid) {
    return pre.error;
  }
  const text = runText(condition);
  const checked = validateConditionExpression(text);
  if (!checked.valid) {
    return checked.error;
  }
  const runError = runnableConditionError(text);
  return runError && (inExpressionTerms(runError) ?? runError);
}

function compileConditions(
  conditions: readonly IndexedCondition[],
  budget: RegexBudget,
  reportRefused: boolean
): RegexIssue | undefined {
  const result = prepareWorkflowPatterns(
    conditions.map(({ condition }) => conditionRegexPatterns(condition)),
    budget,
    { reportRefused }
  );
  if (!result) {
    return;
  }
  if ("refused" in result) {
    return {
      index: conditions[result.at].index,
      message: inExpressionTerms(result.refused) ?? result.refused,
      kind: "condition",
    };
  }
  return {
    index: conditions[result.largest].index,
    message: workflowCompileError(result.work, result.atLeast),
    kind: "patterns",
    unmeasured: result.atLeast,
  };
}

/** The workflow's caps on its regex Conditions together, cheapest first. */
function workflowLimitIssue(
  withRegex: readonly RegexCondition[],
  budget: RegexBudget
): RegexIssue | undefined {
  return (
    workflowSizeIssue(withRegex) ??
    compileConditions(withinLength(withRegex), budget, false)
  );
}

/** For the editor: the workflow's regex Conditions together past a cap. */
export function workflowRegexLimit(
  conditions: readonly IndexedCondition[]
): RegexIssue | undefined {
  const budget = new RegexBudget(MAX_RUN_REGEX_WORK, { scope: "run" });
  return workflowLimitIssue(regexConditionsOf(conditions), budget);
}

function regexObjectError(code: string): ValidationResult | undefined {
  return REGEX_OBJECT_RE.test(code)
    ? { valid: false, error: REGEX_OBJECT_ERROR }
    : undefined;
}

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

// A word and the "[" after it. The content runs to the next "]", found in a
// table built once, as /(\w+)\s*\[([^\]]+)\]/ read it without rescanning.
const BRACKET_OPEN_PATTERN = /(?<!\w)(\w+)\s*\[/g;

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

// True when a comma's next parenthesis is not ")", as COMMA_OUTSIDE_CALL
// reads it, found in one pass from the end.
function hasStrayComma(expression: string): boolean {
  let nextParen = "";
  for (let i = expression.length - 1; i >= 0; i--) {
    const ch = expression[i];
    if (ch === "(" || ch === ")") {
      nextParen = ch;
    } else if (ch === "," && nextParen !== ")") {
      return true;
    }
  }
  return false;
}

/**
 * Check for dangerous patterns in the expression
 */
function checkDangerousPatterns(expression: string): ValidationResult {
  for (const pattern of DANGEROUS_PATTERNS) {
    let found: string | undefined;
    if (pattern === COMMA_OUTSIDE_CALL) {
      found = hasStrayComma(expression) ? "," : undefined;
    } else {
      pattern.lastIndex = 0;
      found = pattern.exec(expression)?.[0];
    }
    if (found !== undefined) {
      return {
        valid: false,
        error: `Condition contains disallowed syntax: "${found || "unknown"}"`,
      };
    }
  }
  return { valid: true };
}

// For each index, where the next "]" at or after it is, or -1.
function nextCloseTable(expression: string): Int32Array {
  const next = new Int32Array(expression.length + 1).fill(-1);
  for (let i = expression.length - 1; i >= 0; i--) {
    next[i] = expression[i] === "]" ? i : next[i + 1];
  }
  return next;
}

/**
 * Check bracket expressions to distinguish between:
 * - Allowed: Variable property access like __v0[0], __v0["key"], __v0['key']
 * - Blocked: Array literals like [1,2,3], or dangerous expressions like __v0[eval('x')]
 */
function checkBracketExpressions(expression: string): ValidationResult {
  const nextClose = nextCloseTable(expression);
  for (const match of expression.matchAll(BRACKET_OPEN_PATTERN)) {
    const open = match.index + match[0].length;
    const close = nextClose[open];
    // No "]" after it, or none before the content ends: not a bracket access.
    if (close <= open) {
      continue;
    }

    const beforeBracket = match[1];
    const insideBracket = expression.slice(open, close).trim();

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
  // A "[" at the start or right after an operator or a space; the same
  // matches as (?:^|[=!<>&|(\s])\s*\[ without rescanning runs of spaces.
  const standaloneArrayPattern = /(?:^|[=!<>&|(\s])\[/g;
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

  // These checks read code, so quoted values are blanked first: "a b", "x=1"
  // or a regex like "^0x[0-9a-f]+$" is data, not syntax.
  let code: string;
  try {
    code = maskStringLiterals(expression);
  } catch (error) {
    return (
      lengthError(expression, mentionsRegexIn(expression)) ?? {
        valid: false,
        error: stringError(error, expression),
      }
    );
  }
  // References are already __vN here, so this is the masked structure.
  const tooLong = lengthError(expression, mentionsRegexIn(code));
  if (tooLong) {
    return tooLong;
  }

  const blockedKey = blockedKeyError(expression, code);
  if (blockedKey) {
    return blockedKey;
  }

  const regexObject = regexObjectError(code);
  if (regexObject) {
    return regexObject;
  }

  // Check for dangerous patterns
  const dangerousCheck = checkDangerousPatterns(code);
  if (!dangerousCheck.valid) {
    return dangerousCheck;
  }

  // Check bracket expressions (array access vs array literals)
  const bracketCheck = checkBracketExpressions(code);
  if (!bracketCheck.valid) {
    return bracketCheck;
  }

  // Check method calls are allowed
  const methodCheck = checkMethodCalls(code);
  if (!methodCheck.valid) {
    return methodCheck;
  }

  // Validate balanced parentheses
  const parenCheck = checkParentheses(code);
  if (!parenCheck.valid) {
    return parenCheck;
  }

  // Check for unauthorized identifiers
  const identifierCheck = checkUnauthorizedIdentifiers(code);
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
  const scan = scanForRegex(expression);
  const tooLong = lengthError(expression, mentionsRegexIn(scan.structure));
  if (tooLong) {
    return tooLong;
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
  const expressionWithoutTemplates = replaceTemplateTokens(
    expression,
    ({ body }) => (body.startsWith("@") ? "" : `{{${body}}}`)
  );

  // Quoted values are data: "processed" or "^Retrieval" holds no keyword.
  let code = expressionWithoutTemplates;
  try {
    code = maskStringLiterals(expressionWithoutTemplates);
  } catch {
    // Unterminated quote: check the raw text; the validator refuses it later.
  }
  const lowerExpression = code.toLowerCase();
  for (const keyword of dangerousKeywords) {
    if (lowerExpression.includes(keyword.toLowerCase())) {
      return {
        valid: false,
        error: `Condition contains disallowed keyword: "${keyword}"`,
      };
    }
  }

  return rawRegexError(expression, scan) ?? { valid: true };
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
  ",", // separates call arguments: matchesRegex(text, "pattern")
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

    // String literal: '...' or "...", read by the interpreter's scanner.
    if (expression[i] === '"' || expression[i] === "'") {
      let next: number;
      try {
        next = scanString(expression, i).next;
      } catch (error) {
        return { valid: false, error: stringError(error, expression) };
      }
      tokens.push({
        type: "string",
        value: expression.slice(i, next),
        start: i,
      });
      i = next;
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
      ["!", ">", "<", "(", ")", "+", "-", "*", "/", "%", ".", ","].includes(
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
 * Marks each index inside a string or template variable, from the tokenizer's
 * spans, so the operator scan skips values ("-", "/") and labels ("My-Node").
 */
function textSpans(tokens: Token[], length: number): Uint8Array {
  // One pass; looking each operator up in the tokens was quadratic.
  const inside = new Uint8Array(length);
  for (const token of tokens) {
    if (token.type === "string" || token.type === "template") {
      inside.fill(1, token.start, token.start + token.value.length);
    }
  }
  return inside;
}

/**
 * Validates spacing around binary operators (must have exactly one space on both sides)
 * Uses regex to find operators directly in the expression string for accurate positioning
 */
function validateOperatorSpacing(
  expression: string,
  tokens: Token[]
): ValidationResult {
  // Find all operator matches in the expression
  const operatorMatches: Array<{ value: string; index: number }> = [];
  // Reset regex and find all matches
  const pattern = new RegExp(OPERATOR_PATTERN.source, OPERATOR_PATTERN.flags);
  const inside = textSpans(tokens, expression.length);
  let match: RegExpExecArray | null = null;
  // biome-ignore lint/suspicious/noAssignInExpressions: Standard pattern for regex.exec in loop
  while ((match = pattern.exec(expression)) !== null) {
    // An operator inside a template variable or inside a string literal is the
    // author's own text rather than syntax, and both spans come from the
    // tokenizer: a quoted operand is a value, and a hyphen in a node label is
    // part of the label.
    if (inside[match.index] !== 1) {
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
function negatesOperand(token: Token | undefined): boolean {
  return (
    token !== undefined &&
    (token.type !== "operator" || ["(", "!", "-"].includes(token.value))
  );
}

function validateConsecutiveOperators(tokens: Token[]): ValidationResult {
  for (let j = 0; j < tokens.length - 1; j++) {
    const current = tokens[j];
    const next = tokens[j + 1];

    if (current.type === "operator" && next.type === "operator") {
      // Allow ! and - before other operators or operands (unary operators)
      if (current.value === "!" || current.value === "-") {
        continue;
      }
      // Allow a negation after any operator (a && !b, (!b), as the builder
      // writes) when it negates something: not "(!)" or "! &&".
      if (next.value === "!" && negatesOperand(tokens[j + 2])) {
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
  const scan = scanForRegex(trimmed);
  // Measured as saved, untrimmed, as the run measures it.
  const tooLong = lengthError(expression, mentionsRegexIn(scan.structure));
  if (tooLong) {
    return tooLong;
  }

  // With a quote never closed, the tokenizer below reports it.
  const regexObject = scan.masked && regexObjectError(scan.masked);
  if (regexObject) {
    return regexObject;
  }
  const rawRegex = rawRegexError(trimmed, scan);
  if (rawRegex) {
    return rawRegex;
  }

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

  const operatorCheck = validateOperators(tokens);
  if (!operatorCheck.valid) {
    return operatorCheck;
  }

  const commaCheck = validateCommas(tokens);
  if (!commaCheck.valid) {
    return commaCheck;
  }

  return validateRegexCalls(tokens);
}

/** A comma is only valid between a call's arguments. */
function validateCommas(tokens: Token[]): ValidationResult {
  const calls: boolean[] = [];
  for (const [index, token] of tokens.entries()) {
    if (token.type !== "operator") {
      continue;
    }
    if (token.value === "(") {
      calls.push(tokens[index - 1]?.type === "identifier");
    } else if (token.value === ")") {
      calls.pop();
    } else if (token.value === "," && !calls.at(-1)) {
      return {
        valid: false,
        error:
          'A comma only separates the values of a call, e.g. matchesRegex(value, "^0x")',
      };
    }
  }
  return { valid: true };
}

/** The argument tokens of the call whose "(" is at `open`, or undefined if unclosed. */
function callArguments(tokens: Token[], open: number): Token[][] | undefined {
  const args: Token[][] = [[]];
  let depth = 0;
  for (const token of tokens.slice(open + 1)) {
    const isOperator = token.type === "operator";
    if (isOperator && token.value === ")" && depth === 0) {
      return args;
    }
    if (isOperator && token.value === "," && depth === 0) {
      args.push([]);
      continue;
    }
    if (isOperator && token.value === "(") {
      depth += 1;
    } else if (isOperator && token.value === ")") {
      depth -= 1;
    }
    args.at(-1)?.push(token);
  }
  return;
}

function regexCallError(args: Token[][]): string | undefined {
  if (args.length !== 2 || args.some((arg) => arg.length === 0)) {
    return REGEX_ARITY_ERROR;
  }
  const [pattern, ...rest] = args[1];
  if (rest.length > 0 || pattern.type !== "string") {
    // A reference means taken from another node; a bare word is a pattern
    // typed without its quotes.
    const fromNode = args[1].some((token) => token.type === "template");
    return fromNode ? REGEX_SOURCE_ERROR : REGEX_LITERAL_ERROR;
  }
  const scanned = scanString(pattern.value, 0);
  if (scanned.lossy) {
    return REGEX_BACKSLASH_ERROR;
  }
  if (hasTemplateToken(scanned.value)) {
    return REGEX_TEMPLATE_ERROR;
  }
  return inExpressionTerms(regexPatternError(scanned.value));
}

// Advice given in pattern terms needs its backslashes doubled when typed here.
function inExpressionTerms(problem: string | undefined): string | undefined {
  return problem &&
    BACKSLASH_ADVICE_RE.test(problem) &&
    !problem.includes("Expression mode")
    ? `${problem.replace(TRAILING_PERIOD_RE, "")} (in Expression mode, type each backslash twice)`
    : problem;
}

/** The run-time pattern rules, applied while the condition is typed. */
function validateRegexCalls(tokens: Token[]): ValidationResult {
  const calls = tokens.filter(
    (token) => token.type === "identifier" && token.value === "matchesRegex"
  ).length;
  if (calls > MAX_REGEX_CALLS) {
    return { valid: false, error: REGEX_CALLS_ERROR };
  }
  for (const [index, token] of tokens.entries()) {
    if (token.type !== "identifier" || token.value !== "matchesRegex") {
      continue;
    }
    if (tokens[index - 1]?.value === "." || tokens[index + 1]?.value !== "(") {
      return { valid: false, error: REGEX_DIRECT_ERROR };
    }
    const args = callArguments(tokens, index + 1);
    const error = args ? regexCallError(args) : REGEX_UNCLOSED_ERROR;
    if (error) {
      return { valid: false, error };
    }
  }
  return { valid: true };
}
