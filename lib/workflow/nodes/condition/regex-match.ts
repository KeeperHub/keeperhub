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
export const MAX_REGEX_CALLS = 16;
// Budgets of pattern steps x characters tested, at about 100 ns each at worst.
// A Condition runs in the shared executor loop: about 0.5 s at most.
export const MAX_CONDITION_REGEX_WORK = 5_000_000;
// A Filter Array step runs on its own: about 2.5 s at most.
export const MAX_FILTER_REGEX_WORK = 25_000_000;
// All Condition evaluations of one pass of a workflow run, For Each
// included: about 1 s. The body replays on resume, so keep each pass small.
export const MAX_RUN_REGEX_WORK = 10_000_000;
// A compile is charged by pattern length and compiled steps, once per run and
// to the run's own budget (the root keeps what it compiled), so whether a
// condition fits depends neither on the shared cache nor on earlier nodes.
const COMPILE_WORK_PER_CHAR = 2000;
const COMPILE_WORK_PER_STEP = 400;

export const REGEX_ARITY_ERROR =
  'matchesRegex takes two values: the text and a quoted pattern, e.g. matchesRegex({{@node:Label.field}}, "^0x")';
export const REGEX_SOURCE_ERROR =
  "Type the regex pattern itself; it can't come from another node or be built from other values. To look for text from another node, use contains or starts with";
// A {{...}} typed inside a pattern: a reference, or braces meant literally.
export const REGEX_TEMPLATE_ERROR =
  "A {{...}} in a regex pattern reads as a reference, and the pattern must be typed, not taken from another node. To match braces, put a backslash before each one, as in \\{\\{ (in Expression mode, type each backslash twice: \\\\{\\\\{); to look for text from another node, use contains or starts with";
export const REGEX_BACKSLASH_ERROR =
  'In Expression mode, type each backslash in the regex pattern twice, e.g. "^\\\\d+$" for ^\\d+$';
export const REGEX_EMPTY_ERROR =
  "Enter a regex pattern, e.g. ^0x. To match empty text, use ^$";
export const REGEX_NON_TEXT_ERROR =
  "The regex test checks text, numbers or booleans, not a list or object. Test a field inside it, or use Filter Array to test each item of a list";
export const REGEX_UNDEFINED_ERROR =
  "The regex test got no value (a missing field, or a node that did not run). Add an exists rule before it";
export const REGEX_LITERAL_ERROR =
  'The regex pattern must be a single quoted string, e.g. "^0x"';
export const REGEX_DIRECT_ERROR =
  'Write matchesRegex( exactly: no space before "(" and nothing around the name, e.g. matchesRegex({{@node:Label.field}}, "^0x")';
export const REGEX_CALLS_ERROR = `A Condition can use matchesRegex at most ${MAX_REGEX_CALLS} times. Split the tests across two Condition nodes`;
export const REGEX_NEGATED_ERROR =
  'notMatchesRegex is not a function. For "does not match regex", write !matchesRegex(...)';

const MAX_CACHED_PATTERNS = 256;
const SYNTAX_ERROR_PREFIX = "error parsing regexp: ";
const LOOKAROUND_RE = /`\(\?<?[=!]/;
const BACKREFERENCE_RE = /invalid escape sequence: `\\([1-9]|k)/;
const UNICODE_ESCAPE_RE = /invalid escape sequence: `\\u/;
// JavaScript-style /pattern/flags: refused when it has flags or regex syntax
// inside, so a plain path such as /api/ can still be matched literally.
const SLASH_DELIMITED_RE = /^\/([\s\S]*)\/([gimsuy]*)$/;
const REGEX_SYNTAX_RE = /[\^$\\[(*+?{|]/;
const BAD_ESCAPE_RE = /invalid escape sequence/;
const REPETITION_OPERATOR_RE = /operator: `([^`]*)`/;
const REPEAT_RANGE_RE = /\{(\d+),(\d+)\}/;
const TRAILING_BACKSLASH_RE = /trailing backslash/;
const REPETITION_RE = /repetition operator/;
const REPEAT_COUNT_RE = /invalid repeat count/;

const BACKTICK_RE = /`/g;

// Compiled patterns, and the message for refused ones.
const compiled = new Map<string, RE2JS | string>();

export type CompiledRegex = RE2JS;

function formatCount(count: number): string {
  return count.toLocaleString("en-US");
}

// What to do next for the RE2 errors people hit most.
function syntaxHint(detail: string): string {
  if (BAD_ESCAPE_RE.test(detail)) {
    return ". Remove that backslash, or write \\\\ to match a backslash";
  }
  if (TRAILING_BACKSLASH_RE.test(detail)) {
    return ". Write \\\\ to match a backslash";
  }
  if (REPETITION_RE.test(detail)) {
    const operator = REPETITION_OPERATOR_RE.exec(detail)?.[1] ?? "";
    const anyText = operator.startsWith("*")
      ? " For any text, use .* (dot, then star)."
      : "";
    return `. To match ${operator[0] ?? "it"} itself, put a backslash before it.${anyText}`;
  }
  if (REPEAT_COUNT_RE.test(detail)) {
    // Refused for a reversed range, or for counts over 1,000 (nested ones
    // multiply: (a{100}){20} is 2,000).
    const range = REPEAT_RANGE_RE.exec(detail);
    return range && Number(range[1]) > Number(range[2])
      ? ". Write the smaller number first, e.g. {2,5}"
      : `. Repeat counts go up to 1,000, nested ones multiplied, and the whole pattern must compile to at most ${formatCount(MAX_REGEX_PROGRAM_SIZE)} steps (a range or a repeated group costs more), so use smaller counts`;
  }
  return "";
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
  const hint = syntaxHint(detail);
  return `Invalid regex pattern: ${detail.replace(BACKTICK_RE, '"')}${hint}`;
}

const EXPRESSION_NOTE_RE = / \(in Expression mode[^)]*\)/;

/** A message without its Condition-only Expression mode note (Filter Array has none). */
export function withoutExpressionNote(message: string): string {
  return message.replace(EXPRESSION_NOTE_RE, "");
}

// One message for both modes: Expression mode needs three backslashes, since
// the condition's own quotes take one level of escaping.
function quoteWrappedError(quote: string): string {
  return `The regex pattern is wrapped in quotes, which would be matched as part of the text. Remove them. To match a quote, put a backslash before it (in Expression mode, type \\\\\\${quote}: three backslashes, then the quote)`;
}

// One quoted string, e.g. "ok" or "a\"b"; not 'yes'|'no', which only starts
// and ends with a quote.
function isQuoteWrapped(pattern: string): boolean {
  const quote = pattern[0];
  if (pattern.length < 2 || pattern.at(-1) !== quote) {
    return false;
  }
  if (quote !== '"' && quote !== "'") {
    return false;
  }
  // Wrapped only if no quote inside stands unescaped (an even run of
  // backslashes before it leaves it unescaped: "a\\"b" has a bare quote).
  let backslashes = 0;
  for (const ch of pattern.slice(1, -1)) {
    if (ch === quote && backslashes % 2 === 0) {
      return false;
    }
    backslashes = ch === "\\" ? backslashes + 1 : 0;
  }
  // "a\" ends in an escaped quote, so it is not wrapped either.
  return backslashes % 2 === 0;
}

function compileUncached(pattern: string, ignoreCase: boolean): RE2JS {
  // Both read as literal characters, which is almost never what was meant.
  const slashes = SLASH_DELIMITED_RE.exec(pattern);
  if (
    pattern.length > 1 &&
    slashes &&
    (slashes[2] !== "" || REGEX_SYNTAX_RE.test(slashes[1]))
  ) {
    throw new Error(
      "Leave out the /.../ around the regex pattern; the slashes and flags would be matched as text. To ignore case, start the pattern with (?i)"
    );
  }
  if (isQuoteWrapped(pattern)) {
    throw new Error(quoteWrappedError(pattern[0]));
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
  ignoreCase = false,
  budget?: RegexBudget
): CompiledRegex {
  if (pattern === "") {
    throw new Error(REGEX_EMPTY_ERROR);
  }
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
    throw new Error(
      `Regex pattern is ${formatCount(pattern.length)} characters; the limit is ${MAX_REGEX_PATTERN_LENGTH}. Shorten it, or split the test in two`
    );
  }
  const key = `${ignoreCase ? "i" : "-"}${pattern}`;
  const own = budget?.compiledFor(key);
  if (own) {
    return own;
  }
  budget?.chargeCompile(pattern.length * COMPILE_WORK_PER_CHAR);
  const cached = compiled.get(key);
  if (cached) {
    // Least recently used goes first: a hit moves the entry to the end.
    compiled.delete(key);
    compiled.set(key, cached);
    if (typeof cached === "string") {
      throw new Error(cached);
    }
    budget?.chargeCompile(cached.programSize() * COMPILE_WORK_PER_STEP);
    budget?.keepCompiled(key, cached);
    return cached;
  }
  let entry: RE2JS | string;
  try {
    entry = compileUncached(pattern, ignoreCase);
  } catch (error) {
    // A refused pattern is remembered too, so it is not compiled again.
    entry = error instanceof Error ? error.message : String(error);
  }
  if (compiled.size >= MAX_CACHED_PATTERNS) {
    const oldest = compiled.keys().next().value;
    if (oldest !== undefined) {
      compiled.delete(oldest);
    }
  }
  compiled.set(key, entry);
  if (typeof entry === "string") {
    throw new Error(entry);
  }
  budget?.chargeCompile(entry.programSize() * COMPILE_WORK_PER_STEP);
  budget?.keepCompiled(key, entry);
  return entry;
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

export type RegexBudgetScope = "node" | "run";

/** Raised when a node or a whole run has spent its matching budget. */
export class RegexBudgetError extends Error {
  constructor(limit: number, scope: RegexBudgetScope, steps?: number) {
    const pattern =
      steps === undefined
        ? ""
        : `this pattern has ${formatCount(steps)} steps, and `;
    const where =
      scope === "run"
        ? "The regex tests in this workflow run reached the run's matching limit"
        : "The regex test reached this node's matching limit";
    super(
      `${where}: ${pattern}steps x characters tested may total ${formatCount(limit)}. Test fewer or shorter values, or use a simpler pattern`
    );
    this.name = "RegexBudgetError";
  }
}

/** The matching budget of one Condition evaluation or one Filter Array step. */
export class RegexBudget {
  private remaining: number;
  private readonly limit: number;
  private readonly scope: RegexBudgetScope;
  // A node's budget also draws on its run's, when there is one.
  private readonly parent: RegexBudget | undefined;
  // Patterns this budget paid to compile, kept on the root only. The budget
  // bounds how many, and a run keeps them even if the cache evicts.
  private readonly compiledHere: Map<string, CompiledRegex> | undefined;

  constructor(
    limit: number,
    options: { scope?: RegexBudgetScope; parent?: RegexBudget } = {}
  ) {
    this.limit = limit;
    this.remaining = limit;
    this.scope = options.scope ?? "node";
    this.parent = options.parent;
    this.compiledHere = options.parent ? undefined : new Map();
  }

  private spend(units: number, steps?: number): void {
    this.remaining -= units;
    if (this.remaining < 0) {
      throw new RegexBudgetError(this.limit, this.scope, steps);
    }
    this.parent?.spend(units, steps);
  }

  chargeCompile(units: number): void {
    this.root().spend(units);
  }

  private root(): RegexBudget {
    return this.parent ? this.parent.root() : this;
  }

  /** A pattern this budget's run already paid to compile. */
  compiledFor(key: string): CompiledRegex | undefined {
    return this.root().compiledHere?.get(key);
  }

  keepCompiled(key: string, regex: CompiledRegex): void {
    this.root().compiledHere?.set(key, regex);
  }

  charge(regex: CompiledRegex, textLength: number): void {
    const steps = regex.programSize();
    this.spend(steps * textLength, steps);
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
