/**
 * Where the matchesRegex(...) calls are in condition text that still holds
 * {{...}} references: shared by the rule parse-back and the raw-text check.
 */

import { replaceTemplateTokens } from "@/lib/workflow/template-ref";
import { MAX_REGEX_CALLS } from "./regex-match";
import { maskStringLiterals } from "./string-literal";

// A direct call; x.matchesRegex(, (matchesRegex)( or "matchesRegex (" is not.
const REGEX_CALL_RE = /(?<![\w$.])matchesRegex\(/g;
const REGEX_NAME_RE = /(?<![\w$])matchesRegex(?![\w$])/g;

/** JavaScript regex objects: the builder's old form, or a typed /.../.test(...). */
export const REGEX_OBJECT_RE =
  /\bnew\s+RegExp\b|\/[^/\s]+\/[a-z]*\s*\.\s*test\s*\(/;

/**
 * References and quoted text blanked, same length, so parens, commas and &&
 * inside a value or a node label are not read as structure.
 */
export function codeStructure(expression: string): string {
  return maskedStructure(expression) ?? expression;
}

// Undefined when a quote is never closed: no reliable structure to read.
export function maskedStructure(expression: string): string | undefined {
  const withoutReferences = replaceTemplateTokens(expression, ({ body }) =>
    "_".repeat(body.length + 4)
  );
  try {
    return maskStringLiterals(withoutReferences);
  } catch {
    return;
  }
}

// Each "(" mapped to its ")" in one pass, so finding a call's end never
// rescans the text.
function pairParens(structure: string): Map<number, number> {
  const pairs = new Map<number, number>();
  const open: number[] = [];
  for (let i = 0; i < structure.length; i++) {
    if (structure[i] === "(") {
      open.push(i);
    } else if (structure[i] === ")") {
      const start = open.pop();
      if (start !== undefined) {
        pairs.set(start, i);
      }
    }
  }
  return pairs;
}

export type RegexCall = {
  /** Index of the call's "(" and its matching ")". */
  open: number;
  close: number;
  /** [start, end) of each value between the parens, split at top-level commas. */
  args: [number, number][];
};

function argumentSpans(
  structure: string,
  open: number,
  close: number
): [number, number][] {
  const spans: [number, number][] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < close; i++) {
    if (structure[i] === "(") {
      depth++;
    } else if (structure[i] === ")") {
      depth--;
    } else if (structure[i] === "," && depth === 0) {
      spans.push([start, i]);
      start = i + 1;
    }
  }
  spans.push([start, close]);
  return spans;
}

/** True when matchesRegex appears outside quoted text, in any form. */
export function mentionsRegex(expression: string): boolean {
  return mentionsRegexIn(codeStructure(expression));
}

/** mentionsRegex on a codeStructure already computed. */
export function mentionsRegexIn(structure: string): boolean {
  REGEX_NAME_RE.lastIndex = 0;
  return REGEX_NAME_RE.test(structure);
}

/**
 * True when matchesRegex appears outside quoted text other than as a direct
 * call, e.g. (matchesRegex)(...): the call checks below would miss it.
 */
export function hasIndirectRegexUse(expression: string): boolean {
  const structure = maskedStructure(expression);
  if (structure === undefined) {
    return false;
  }
  const names = structure.match(REGEX_NAME_RE)?.length ?? 0;
  const calls = structure.match(REGEX_CALL_RE)?.length ?? 0;
  return names !== calls;
}

/**
 * The matchesRegex calls outside quoted text, with their value spans, up to
 * `limit` of them: more than the cap is refused anyway, and stopping there
 * keeps the scan linear in the text.
 */
export function findRegexCalls(
  expression: string,
  limit = MAX_REGEX_CALLS + 1
): RegexCall[] {
  const structure = maskedStructure(expression);
  return structure === undefined ? [] : regexCallsIn(structure, limit);
}

/** findRegexCalls on a maskedStructure already computed. */
export function regexCallsIn(
  structure: string,
  limit = MAX_REGEX_CALLS + 1
): RegexCall[] {
  const calls: RegexCall[] = [];
  const pairs = pairParens(structure);
  for (const match of structure.matchAll(REGEX_CALL_RE)) {
    const open = match.index + match[0].length - 1;
    const close = pairs.get(open);
    if (close !== undefined) {
      calls.push({ open, close, args: argumentSpans(structure, open, close) });
      if (calls.length >= limit) {
        break;
      }
    }
  }
  return calls;
}
