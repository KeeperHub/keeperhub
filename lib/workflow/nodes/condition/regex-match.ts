/**
 * Regex matching for the `matches regex` operator (Condition and Filter Array).
 *
 * Patterns run on RE2 (re2js), which matches in time linear in the text and
 * never backtracks, so a pattern cannot stall the executor. The length caps
 * bound memory and the worst-case time per match.
 */

import { RE2JS, RE2JSSyntaxException } from "re2js";

export const MAX_REGEX_PATTERN_LENGTH = 512;
export const MAX_REGEX_TEXT_LENGTH = 4096;

const MAX_CACHED_PATTERNS = 256;
const SYNTAX_ERROR_PREFIX = "error parsing regexp: ";
const LOOKAROUND_RE = /`\(\?<?[=!]/;
const BACKREFERENCE_RE = /invalid escape sequence: `\\(\d|k)/;

const compiled = new Map<string, RE2JS>();

export type CompiledRegex = RE2JS;

function describeSyntaxError(message: string): string {
  if (LOOKAROUND_RE.test(message)) {
    return "Lookahead and lookbehind ((?=, (?!, (?<=, (?<!) are not supported in regex patterns";
  }
  if (BACKREFERENCE_RE.test(message)) {
    return "Back-references (\\1, \\k<name>) are not supported in regex patterns";
  }
  const detail = message.startsWith(SYNTAX_ERROR_PREFIX)
    ? message.slice(SYNTAX_ERROR_PREFIX.length)
    : message;
  return `Invalid regex pattern: ${detail}`;
}

/** Compiles a pattern, or throws an Error whose message is safe to show. */
export function compileRegex(
  pattern: string,
  ignoreCase = false
): CompiledRegex {
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
    throw new Error(
      `Regex pattern is ${pattern.length} characters; the limit is ${MAX_REGEX_PATTERN_LENGTH}`
    );
  }
  const key = `${ignoreCase ? "i" : "-"}${pattern}`;
  const cached = compiled.get(key);
  if (cached) {
    return cached;
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

/** True when the pattern matches anywhere in the text, like RegExp#test. */
export function regexMatches(regex: CompiledRegex, text: string): boolean {
  if (text.length > MAX_REGEX_TEXT_LENGTH) {
    throw new Error(
      `Text is ${text.length} characters; matches regex tests at most ${MAX_REGEX_TEXT_LENGTH}`
    );
  }
  return regex.matcher(text).find();
}
