/**
 * Regex matching for the `matches regex` operator (Condition and Filter Array).
 *
 * Patterns run on RE2 (re2js): no backtracking, so a match costs about
 * (compiled program size) x (text length). Both factors are capped, and a run
 * has a budget of their product, so no pattern or input can stall the executor.
 */

import { RE2JS, RE2JSSyntaxException } from "re2js";

export const MAX_REGEX_PATTERN_LENGTH = 512;
export const MAX_REGEX_PROGRAM_SIZE = 1000;
export const MAX_REGEX_TEXT_LENGTH = 4096;
// Compiling is not charged to the budget, so the number of calls is capped.
export const MAX_REGEX_CALLS = 16;
// Up to about 4 s of matching at the worst measured cost per step.
export const MAX_REGEX_RUN_WORK = 25_000_000;

export const REGEX_ARITY_ERROR =
  'matchesRegex takes two values: the text and a quoted pattern, e.g. matchesRegex({{@node:Label.field}}, "^0x")';
export const REGEX_SOURCE_ERROR =
  "Type the regex pattern itself; it can't come from another node or be built from other values. To look for text from another node, use contains or starts with";
export const REGEX_BACKSLASH_ERROR =
  'In a typed condition, double each backslash in the regex pattern, e.g. "^\\\\d+$" for ^\\d+$';
export const REGEX_EMPTY_ERROR =
  "Enter a regex pattern; an empty one matches everything";
export const REGEX_NON_TEXT_ERROR =
  "Matches regex tests text, numbers or booleans, not a list or object";
export const REGEX_CALLS_ERROR = `A condition can use matchesRegex at most ${MAX_REGEX_CALLS} times`;

const MAX_CACHED_PATTERNS = 256;
const SYNTAX_ERROR_PREFIX = "error parsing regexp: ";
const LOOKAROUND_RE = /`\(\?<?[=!]/;
const BACKREFERENCE_RE = /invalid escape sequence: `\\([1-9]|k)/;
const UNICODE_ESCAPE_RE = /invalid escape sequence: `\\u/;
const SLASH_DELIMITED_RE = /^\/.*\/[dgimsuvy]*$/;
const QUOTE_WRAPPED_RE = /^(["'])[\s\S]*\1$/;
const BACKTICK_RE = /`/g;

const compiled = new Map<string, RE2JS>();

export type CompiledRegex = RE2JS;

function formatCount(count: number): string {
  return count.toLocaleString("en-US");
}

function describeSyntaxError(message: string): string {
  if (LOOKAROUND_RE.test(message)) {
    return "Lookahead and lookbehind, such as (?= or (?<!, are not supported in regex patterns. Test that part separately, e.g. with a second Condition or Filter Array";
  }
  if (BACKREFERENCE_RE.test(message)) {
    return "Back-references such as \\1 or \\k<name> are not supported in regex patterns. Repeat the group's pattern instead";
  }
  if (UNICODE_ESCAPE_RE.test(message)) {
    return "\\u escapes are not supported in regex patterns. Write \\x{00e9} for é, or type the character itself";
  }
  const detail = message.startsWith(SYNTAX_ERROR_PREFIX)
    ? message.slice(SYNTAX_ERROR_PREFIX.length)
    : message;
  return `Invalid regex pattern: ${detail.replace(BACKTICK_RE, '"')}`;
}

function compileUncached(pattern: string, ignoreCase: boolean): RE2JS {
  // Both read as literal characters, which is almost never what was meant.
  if (pattern.length > 1 && SLASH_DELIMITED_RE.test(pattern)) {
    throw new Error(
      "Leave out the /.../ around the regex pattern (write \\/ for a literal slash). To ignore case, start it with (?i)"
    );
  }
  if (pattern.length > 1 && QUOTE_WRAPPED_RE.test(pattern)) {
    throw new Error(
      'Leave out the quotes around the regex pattern; they would have to appear in the text. To match quoted text, write \\"ok\\"'
    );
  }
  let regex: RE2JS;
  try {
    regex = RE2JS.compile(pattern, ignoreCase ? RE2JS.CASE_INSENSITIVE : 0);
  } catch (error) {
    if (error instanceof RE2JSSyntaxException) {
      throw new Error(describeSyntaxError(error.message));
    }
    throw error;
  }
  const size = regex.programSize();
  if (size > MAX_REGEX_PROGRAM_SIZE) {
    throw new Error(
      `Regex pattern is too complex: it compiles to ${formatCount(size)} steps; the limit is ${formatCount(MAX_REGEX_PROGRAM_SIZE)}. Use fewer or smaller {n} repeats`
    );
  }
  return regex;
}

/** A typed pattern as it is read in both nodes: exactly as typed, ends trimmed. */
export function readRegexPattern(typed: string): string {
  return typed.trim();
}

/** Compiles a pattern, or throws an Error whose message is safe to show. */
export function compileRegex(
  pattern: string,
  ignoreCase = false
): CompiledRegex {
  if (pattern === "") {
    throw new Error(REGEX_EMPTY_ERROR);
  }
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
    throw new Error(
      `Regex pattern is ${formatCount(pattern.length)} characters; the limit is ${MAX_REGEX_PATTERN_LENGTH}`
    );
  }
  const key = `${ignoreCase ? "i" : "-"}${pattern}`;
  const cached = compiled.get(key);
  if (cached) {
    return cached;
  }
  const regex = compileUncached(pattern, ignoreCase);
  if (compiled.size >= MAX_CACHED_PATTERNS) {
    const oldest = compiled.keys().next().value;
    if (oldest !== undefined) {
      compiled.delete(oldest);
    }
  }
  compiled.set(key, regex);
  return regex;
}

/** The message `compileRegex` would throw, or undefined for a usable pattern. */
export function regexPatternError(
  pattern: string,
  ignoreCase = false
): string | undefined {
  try {
    compileRegex(pattern, ignoreCase);
    return;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Raised when one run has spent its matching budget. */
export class RegexBudgetError extends Error {
  constructor(steps: number) {
    super(
      `Matches regex reached this node's matching limit: this pattern has ${formatCount(steps)} steps, and steps x characters tested may total ${formatCount(MAX_REGEX_RUN_WORK)}. Test fewer or shorter values, or a simpler pattern`
    );
    this.name = "RegexBudgetError";
  }
}

/** The matching budget of one Condition evaluation or one Filter Array run. */
export class RegexBudget {
  private remaining = MAX_REGEX_RUN_WORK;

  charge(regex: CompiledRegex, textLength: number): void {
    const steps = regex.programSize();
    this.remaining -= steps * textLength;
    if (this.remaining < 0) {
      throw new RegexBudgetError(steps);
    }
  }
}

export function regexTextTooLong(text: string): string | undefined {
  if (text.length <= MAX_REGEX_TEXT_LENGTH) {
    return;
  }
  return `Text is ${formatCount(text.length)} characters; matches regex tests at most ${formatCount(MAX_REGEX_TEXT_LENGTH)}. Test a shorter field`;
}

/** True when the pattern matches anywhere in the text, like RegExp#test. */
export function regexMatches(
  regex: CompiledRegex,
  text: string,
  budget: RegexBudget
): boolean {
  const tooLong = regexTextTooLong(text);
  if (tooLong) {
    throw new Error(tooLong);
  }
  budget.charge(regex, text.length);
  return regex.matcher(text).find();
}
