/**
 * Where the matchesRegex(...) calls are in condition text that still holds
 * {{...}} references: shared by the rule parse-back and the raw-text check.
 */

import { replaceTemplateTokens } from "@/lib/workflow/template-ref";
import { maskStringLiterals } from "./string-literal";

const REGEX_CALL_RE = /\bmatchesRegex\s*\(/g;

/** JavaScript regex objects: the builder's old form, or a typed /.../.test(...). */
export const REGEX_OBJECT_RE =
  /\bnew\s+RegExp\b|\/[^/\s]+\/[a-z]*\s*\.\s*test\s*\(/;

/**
 * References and quoted text blanked, same length, so parens, commas and &&
 * inside a value or a node label are not read as structure.
 */
export function codeStructure(expression: string): string {
  const withoutReferences = replaceTemplateTokens(expression, ({ body }) =>
    "_".repeat(body.length + 4)
  );
  try {
    return maskStringLiterals(withoutReferences);
  } catch {
    return withoutReferences;
  }
}

/** Index of the ")" closing the "(" at `open`, or -1. */
export function closingParen(structure: string, open: number): number {
  let depth = 0;
  for (let i = open; i < structure.length; i++) {
    if (structure[i] === "(") {
      depth++;
    } else if (structure[i] === ")") {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
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

/** Every matchesRegex call outside quoted text, with its value spans. */
export function findRegexCalls(expression: string): RegexCall[] {
  const structure = codeStructure(expression);
  const calls: RegexCall[] = [];
  for (const match of structure.matchAll(REGEX_CALL_RE)) {
    const open = match.index + match[0].length - 1;
    const close = closingParen(structure, open);
    if (close !== -1) {
      calls.push({ open, close, args: argumentSpans(structure, open, close) });
    }
  }
  return calls;
}
