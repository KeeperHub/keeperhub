/**
 * Regex for `matches regex` (Condition and Filter Array), on RE2 (re2js): a match
 * costs about steps x text length, both capped and budgeted per node and run.
 */

import { RE2JS, RE2JSSyntaxException } from "re2js";

const MAX_REGEX_PATTERN_LENGTH = 512;
const MAX_REGEX_PROGRAM_SIZE = 1000;
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
// A compile is charged by length and steps, once per run, to the run's budget,
// whether or not the pattern is cached.
const COMPILE_WORK_PER_CHAR = 2000;
const COMPILE_WORK_PER_STEP = 400;
// All of a workflow's Condition patterns, compiled at the start of each run,
// so the run keeps at least one Condition's full matching budget.
const MAX_WORKFLOW_COMPILE_WORK = MAX_RUN_REGEX_WORK - MAX_CONDITION_REGEX_WORK;

export const REGEX_ARITY_ERROR =
  'matchesRegex takes two values: the text and a quoted pattern, e.g. matchesRegex({{@node:Label.field}}, "^0x"). To ignore case, start the pattern with (?i)';
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
  'Write the regex pattern as one "..." or \'...\' string, e.g. "^0x"';
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
const NESTED_REPETITION_RE = /nested repetition/;
const FIRST_REPEAT_RE = /^(?:\{[^}]*\}|[*+?])\??(?=.)/;
const REPEAT_COUNT_RE = /invalid repeat count/;

const BACKTICK_RE = /`/g;

// Compiled patterns, and the message for refused ones.
const compiled = new Map<string, RE2JS | string>();

type CompiledRegex = RE2JS;

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
    // "*+": the first repeat is fine; RE2 refuses the one after it.
    if (NESTED_REPETITION_RE.test(detail)) {
      // The first repeat may be lazy ("*?"); the refused one follows it.
      const first = FIRST_REPEAT_RE.exec(operator)?.[0] ?? "";
      const refused = operator.slice(first.length);
      return `. Two repeats in a row: to match ${refused[0] ?? "the second"} as text, put a backslash before it`;
    }
    const anyText = operator.startsWith("*")
      ? ". For any text, use .* (dot, then star)"
      : "";
    return `${anyText}. To match ${operator[0] ?? "it"} itself, put a backslash before it`;
  }
  if (REPEAT_COUNT_RE.test(detail)) {
    // A reversed range, or counts over 1,000 (nested ones multiply).
    const range = REPEAT_RANGE_RE.exec(detail);
    return range && Number(range[1]) > Number(range[2])
      ? ". Write the smaller number first, e.g. {2,5}"
      : `. Use smaller counts. Nested counts multiply: (a{100}){20} repeats 2,000 times. The whole pattern must compile to at most ${formatCount(MAX_REGEX_PROGRAM_SIZE)} steps, about one per repeated character; ranges and groups cost more`;
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

// Leads every message about a workflow's patterns together.
export const REGEX_WORKFLOW_COMPILE_ERROR =
  "Together, the regex patterns in this workflow's Conditions are too long";

/** Past the workflow cap: how far past, given the patterns' total cost. */
export function workflowCompileError(work: number, atLeast = false): string {
  const share = Math.max(
    101,
    Math.round((work / MAX_WORKFLOW_COMPILE_WORK) * 100)
  );
  const amount = atLeast ? "more than" : "about";
  return `${REGEX_WORKFLOW_COMPILE_ERROR}: ${amount} ${formatCount(share)}% of the limit, which is about 2,000 characters in all (fewer with {n} repeats)`;
}

// Past the cap the rest are still compiled, to name the costliest Condition
// and say how far over, within three more caps: exact up to 400%.
const MEASURE_PAST_CAP_WORK = 3 * MAX_WORKFLOW_COMPILE_WORK;

type WorkflowPatternsResult =
  | { refused: string; at: number }
  | { work: number; largest: number; atLeast: boolean };

/**
 * Compiles each Condition's patterns into `budget` (a fresh run budget, with
 * room for the cap and one more pattern), each distinct one once, up to the
 * workflow cap; past it, the rest are measured in a budget of their own.
 * Returns why a pattern is refused (with `reportRefused`), or, past the cap,
 * the total cost (`atLeast` when measuring ran out) and the Condition (by
 * position) whose patterns cost the most.
 */
export function prepareWorkflowPatterns(
  conditions: readonly (readonly string[])[],
  budget: RegexBudget,
  { reportRefused }: { reportRefused: boolean }
): WorkflowPatternsResult | undefined {
  const seen = new Set<string>();
  const measure = new RegexBudget(MEASURE_PAST_CAP_WORK, { scope: "run" });
  let over = false;
  let atLeast = false;
  let largest = { at: -1, cost: -1 };
  for (const [at, patterns] of conditions.entries()) {
    const before = budget.used() + measure.used();
    for (const pattern of patterns) {
      if (seen.has(pattern)) {
        continue;
      }
      seen.add(pattern);
      if (over) {
        atLeast ||= measuredPastCap(pattern, measure);
        continue;
      }
      try {
        compileRegex(pattern, false, budget);
      } catch (error) {
        if (reportRefused) {
          return {
            refused: error instanceof Error ? error.message : String(error),
            at,
          };
        }
      }
      over = budget.used() > MAX_WORKFLOW_COMPILE_WORK;
    }
    const cost = budget.used() + measure.used() - before;
    if (cost > largest.cost) {
      largest = { at, cost };
    }
  }
  return over
    ? { work: budget.used() + measure.used(), largest: largest.at, atLeast }
    : undefined;
}

// Compiles a pattern past the cap into `measure`; true once it runs out.
function measuredPastCap(pattern: string, measure: RegexBudget): boolean {
  try {
    compileRegex(pattern, false, measure);
  } catch (error) {
    // A refused pattern is charged for its length only, as at run start.
    return error instanceof RegexBudgetError;
  }
  return false;
}

type RegexBudgetScope = "node" | "run";

/** Raised when a node or a whole run has spent its matching budget. */
export class RegexBudgetError extends Error {
  constructor(limit: number, scope: RegexBudgetScope, steps?: number) {
    const where =
      scope === "run"
        ? "The regex tests in this workflow run reached the run's matching limit"
        : "The regex test reached this node's matching limit";
    // Without steps, the charge was compiling patterns, not testing text.
    super(
      steps === undefined
        ? `${where} of ${formatCount(limit)} while preparing the patterns. Each pattern costs ${formatCount(COMPILE_WORK_PER_CHAR)} per character plus ${formatCount(COMPILE_WORK_PER_STEP)} per step of the compiled pattern, and each test costs steps x characters tested. Use fewer or shorter patterns, or test fewer values`
        : `${where}: this pattern has ${formatCount(steps)} steps, and steps x characters tested may total ${formatCount(limit)}. Test fewer or shorter values, or use a simpler pattern`
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

  /** What the run (the root budget) has spent so far. */
  used(): number {
    const root = this.root();
    return root.limit - root.remaining;
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
