/**
 * Bounds on a `matchesRegex` pattern and on the value it is applied to.
 *
 * Condition expressions evaluate in the executor process at
 * `executor.workflow.ts:555` with no timeout, unlike Code nodes, which run under
 * a vm CPU budget and a wall-clock timeout (`lib/sandbox/child-source.ts`). A
 * backtracking pattern therefore stalls the executor synchronously and no timer
 * interrupts it, while the matched value can arrive from a webhook.
 *
 * The length caps stop a pattern or a value nobody would type by hand. They do
 * not stop catastrophic backtracking on their own, because `(a+)+$` is seven
 * characters, and there is no `re2` or `safe-regex` in the dependency tree to
 * fall back on. `regexPatternProblem` covers that shape separately.
 */

export const MAX_REGEX_PATTERN_LENGTH = 512;

/** Generous: the operands this operator is written for are addresses, ids and
 *  short labels. It bounds the work a single match can do, not a legitimate
 *  long string. */
export const MAX_REGEX_VALUE_LENGTH = 4096;

const QUANTIFIER_BRACE_PATTERN = /^\{\d*,?\d*\}/;
const BODY_QUANTIFIER_BRACE_PATTERN = /^\{\d*,?\d*\}$/;
const HEX_TWO_PATTERN = /^[0-9a-fA-F]{2}$/;
const HEX_FOUR_PATTERN = /^[0-9a-fA-F]{4}$/;
const HEX_ANY_PATTERN = /^[0-9a-fA-F]+$/;
const QUANTIFIER_BOUNDS_PATTERN = /^(\d+)(?:,(\d*))?$/;

/** True when the character at `index` quantifies whatever precedes it. */
function isQuantifierAt(source: string, index: number): boolean {
  const char = source[index];
  if (char === "*" || char === "+" || char === "?") {
    return true;
  }
  if (char === "{") {
    const close = source.indexOf("}", index);
    if (close === -1) {
      return false;
    }
    return QUANTIFIER_BRACE_PATTERN.test(source.slice(index, close + 1));
  }
  return false;
}

/**
 * Where a group's own pattern starts, past its type prefix.
 *
 * `(?:` is non-capturing, `(?=` and `(?!` are lookaheads, `(?<=` and `(?<!`
 * lookbehinds and `(?<name>` a named capture. Each carries a `?` that the body
 * scan below would read as a quantifier applied to the character before it, so
 * every quantified non-capturing group was refused - including safe ones such
 * as `(?:ab)+` and `(?:0x)?[0-9a-f]+`.
 */
function groupBodyStart(source: string, openIndex: number): number {
  if (source[openIndex + 1] !== "?") {
    return openIndex + 1;
  }
  const marker = source[openIndex + 2];
  if (marker === ":") {
    return openIndex + 3;
  }
  if (marker === "<") {
    // `(?<=` and `(?<!` are lookbehinds; anything else is a named capture,
    // whose name runs to the closing `>`.
    const afterMarker = source[openIndex + 3];
    if (afterMarker === "=" || afterMarker === "!") {
      return openIndex + 4;
    }
    const nameEnd = source.indexOf(">", openIndex + 3);
    return nameEnd === -1 ? openIndex + 3 : nameEnd + 1;
  }
  if (marker === "=" || marker === "!") {
    return openIndex + 3;
  }
  // An unrecognised `(?` sequence: only the `?` is known to be syntax.
  return openIndex + 2;
}

/** True when the body of a group carries a quantifier or an alternation at its
 *  own level, ignoring character classes, escapes and group prefixes. */
function bodyHasQuantifierOrAlternation(body: string): boolean {
  let inClass = false;
  let escaped = false;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (inClass) {
      if (char === "]") {
        inClass = false;
      }
      continue;
    }
    if (char === "[") {
      inClass = true;
      continue;
    }
    if (char === "(") {
      // A nested group's prefix is syntax too: `((?:ab))?` applies its `?` to a
      // body carrying no quantifier, so the scan has to step over the prefix
      // here as well as at the top level.
      index = groupBodyStart(body, index) - 1;
      continue;
    }
    if (char === "*" || char === "+" || char === "?" || char === "|") {
      return true;
    }
    if (char === "{") {
      const close = body.indexOf("}", index);
      if (
        close !== -1 &&
        BODY_QUANTIFIER_BRACE_PATTERN.test(body.slice(index, close + 1))
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * True when a quantifier is applied to a group that itself contains a quantifier
 * or an alternation, the shape that backtracks catastrophically.
 *
 * Deliberately conservative: it also rejects `(foo|bar)+`, which cannot
 * backtrack, because separating the two cases needs a real regex analysis. The
 * cost is a rejected pattern an author can rewrite; the alternative is an
 * unbounded match inside the executor.
 */
export function hasNestedQuantifier(source: string): boolean {
  const groups: { start: number; end: number }[] = [];
  const open: number[] = [];
  let inClass = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (inClass) {
      if (char === "]") {
        inClass = false;
      }
      continue;
    }
    if (char === "[") {
      inClass = true;
      continue;
    }
    if (char === "(") {
      open.push(index);
      continue;
    }
    if (char === ")" && open.length > 0) {
      const start = open.pop();
      if (start !== undefined) {
        groups.push({ start, end: index });
      }
    }
  }

  for (const group of groups) {
    if (!isQuantifierAt(source, group.end + 1)) {
      continue;
    }
    if (
      bodyHasQuantifierOrAlternation(
        source.slice(groupBodyStart(source, group.start), group.end)
      )
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The characters one atom can consume, or `"any"` when it cannot be bounded
 * (`\D`, a negated class, a backreference), or `"none"` for an atom that
 * consumes nothing at all (an anchor or a zero-width assertion).
 */
type AtomSet = Set<string> | "any" | "none";

const DIGIT_CHARS = "0123456789";
const WORD_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_";
const SPACE_CHARS =
  " \t\n\r\v\f\u00a0\u1680\u2000\u2028\u2029\u202f\u205f\u3000\ufeff";

function chars(text: string): Set<string> {
  return new Set(Array.from(text));
}

/** Index of the `]` closing the class opened at `openIndex`, or -1. */
function classEnd(source: string, openIndex: number): number {
  for (let index = openIndex + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "]") {
      return index;
    }
  }
  return -1;
}

/** Index of the `)` closing the group opened at `openIndex`, or -1. */
function parenEnd(source: string, openIndex: number): number {
  let depth = 0;
  let inClass = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (inClass) {
      if (char === "]") {
        inClass = false;
      }
      continue;
    }
    if (char === "[") {
      inClass = true;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

/** The character a `\xNN` or `\uNNNN` sequence names, or null. */
function escapedChar(
  source: string,
  index: number
): { set: AtomSet; next: number } | null {
  const marker = source[index + 1];
  if (marker === "x") {
    const hex = source.slice(index + 2, index + 4);
    if (!HEX_TWO_PATTERN.test(hex)) {
      return null;
    }
    return {
      set: new Set([String.fromCharCode(Number.parseInt(hex, 16))]),
      next: index + 4,
    };
  }
  if (marker === "u") {
    if (source[index + 2] === "{") {
      const close = source.indexOf("}", index + 3);
      const hex = close === -1 ? "" : source.slice(index + 3, close);
      if (close === -1 || !HEX_ANY_PATTERN.test(hex)) {
        return null;
      }
      return {
        set: new Set([String.fromCodePoint(Number.parseInt(hex, 16))]),
        next: close + 1,
      };
    }
    const hex = source.slice(index + 2, index + 6);
    if (!HEX_FOUR_PATTERN.test(hex)) {
      return null;
    }
    return {
      set: new Set([String.fromCharCode(Number.parseInt(hex, 16))]),
      next: index + 6,
    };
  }
  return null;
}

/**
 * One atom at `index`: a class, a group, an escape, an anchor or a literal.
 * A group's set is the union of the sets inside it, which is what makes an
 * alternation's branches count as one atom here.
 */
function atomAt(source: string, index: number): { set: AtomSet; next: number } {
  const char = source[index];
  if (char === "[") {
    const end = classEnd(source, index);
    if (end === -1) {
      return { set: "any", next: index + 1 };
    }
    return { set: classSet(source, index, end), next: end + 1 };
  }
  if (char === "(") {
    const end = parenEnd(source, index);
    if (end === -1) {
      return { set: "any", next: index + 1 };
    }
    return {
      set: groupSet(source, groupBodyStart(source, index), end),
      next: end + 1,
    };
  }
  if (char === ".") {
    return { set: "any", next: index + 1 };
  }
  if (char === "^" || char === "$") {
    return { set: "none", next: index + 1 };
  }
  if (char === "\\") {
    const marker = source[index + 1];
    if (marker === "d") {
      return { set: chars(DIGIT_CHARS), next: index + 2 };
    }
    if (marker === "w") {
      return { set: chars(WORD_CHARS), next: index + 2 };
    }
    if (marker === "s") {
      return { set: chars(SPACE_CHARS), next: index + 2 };
    }
    if (marker === "D" || marker === "W" || marker === "S") {
      return { set: "any", next: index + 2 };
    }
    if (marker === "b" || marker === "B") {
      return { set: "none", next: index + 2 };
    }
    const escaped = escapedChar(source, index);
    if (escaped !== null) {
      return escaped;
    }
    if (marker !== undefined && marker >= "1" && marker <= "9") {
      return { set: "any", next: index + 2 };
    }
    return { set: new Set([marker ?? "\\"]), next: index + 2 };
  }
  return { set: new Set([char]), next: index + 1 };
}

/** The union of the sets of the atoms inside a group's body. */
function groupSet(source: string, bodyStart: number, end: number): AtomSet {
  const union = new Set<string>();
  let index = bodyStart;
  while (index < end) {
    const atom = atomAt(source, index);
    if (atom.set === "any") {
      return "any";
    }
    if (atom.set !== "none") {
      for (const value of atom.set) {
        union.add(value);
      }
    }
    const quantifier = quantifierAt(source, atom.next);
    index = quantifier === null ? atom.next : quantifier.next;
  }
  return union.size === 0 ? "none" : union;
}

/** The set of characters a class (`[...]`) admits, or `"any"` when negated. */
function classSet(
  source: string,
  openIndex: number,
  closeIndex: number
): AtomSet {
  let index = openIndex + 1;
  if (source[index] === "^") {
    return "any";
  }
  const union = new Set<string>();
  while (index < closeIndex) {
    const char = source[index];
    if (char === "\\") {
      const marker = source[index + 1];
      if (marker === "d") {
        for (const value of DIGIT_CHARS) {
          union.add(value);
        }
      } else if (marker === "w") {
        for (const value of WORD_CHARS) {
          union.add(value);
        }
      } else if (marker === "s") {
        for (const value of SPACE_CHARS) {
          union.add(value);
        }
      } else if (marker === "D" || marker === "W" || marker === "S") {
        return "any";
      } else {
        const escaped = escapedChar(source, index);
        if (escaped !== null) {
          if (escaped.set === "any") {
            return "any";
          }
          for (const value of escaped.set as Set<string>) {
            union.add(value);
          }
          index = escaped.next;
          continue;
        }
        union.add(marker ?? "\\");
      }
      index += 2;
      continue;
    }
    if (source[index + 1] === "-" && index + 2 < closeIndex) {
      const from = char.codePointAt(0) ?? 0;
      const to = source[index + 2].codePointAt(0) ?? 0;
      if (to >= from && to - from <= 4096) {
        for (let code = from; code <= to; code += 1) {
          union.add(String.fromCodePoint(code));
        }
      }
      index += 3;
      continue;
    }
    union.add(char);
    index += 1;
  }
  return union;
}

type Quantifier = { min: number; max: number; next: number };

/** The quantifier applied to the atom ending at `index`, or null. */
function quantifierAt(source: string, index: number): Quantifier | null {
  const char = source[index];
  const lazy = (next: number): number =>
    source[next] === "?" || source[next] === "+" ? next + 1 : next;
  if (char === "*") {
    return { min: 0, max: Number.POSITIVE_INFINITY, next: lazy(index + 1) };
  }
  if (char === "+") {
    return { min: 1, max: Number.POSITIVE_INFINITY, next: lazy(index + 1) };
  }
  if (char === "?") {
    return { min: 0, max: 1, next: lazy(index + 1) };
  }
  if (char === "{") {
    const close = source.indexOf("}", index);
    if (close === -1) {
      return null;
    }
    const body = source.slice(index + 1, close);
    const bounds = QUANTIFIER_BOUNDS_PATTERN.exec(body);
    if (bounds === null) {
      return null;
    }
    const min = Number.parseInt(bounds[1], 10);
    const max =
      bounds[2] === undefined || bounds[2] === ""
        ? Number.POSITIVE_INFINITY
        : Number.parseInt(bounds[2], 10);
    return { min, max, next: lazy(close + 1) };
  }
  return null;
}

/** True when a quantifier lets the atom repeat in more than one way, which is
 *  what makes a split between two atoms ambiguous. A fixed count or a `?` does
 *  not: `a{2}a{2}` and `a?a?` have exactly one way to match. */
function isAmbiguous(quantifier: Quantifier | null): boolean {
  if (quantifier === null) {
    return false;
  }
  const unbounded =
    quantifier.max === Number.POSITIVE_INFINITY || quantifier.max >= 2;
  return unbounded && quantifier.max > quantifier.min;
}

function setsOverlap(left: AtomSet, right: AtomSet): boolean {
  if (left === "none" || right === "none") {
    return false;
  }
  if (left === "any" || right === "any") {
    return true;
  }
  for (const value of left) {
    if (right.has(value)) {
      return true;
    }
  }
  return false;
}

/**
 * True when two adjacent quantified atoms can split the same input between
 * them, with no parentheses involved.
 *
 * `hasNestedQuantifier` only looks at quantifiers applied to a `(...)` group, so
 * `a+a+$` was never examined. Measured against the caps this operator enforces
 * (`new RegExp(src).test("a".repeat(4096) + "!")`): 34.8 s for two terms, and
 * 16 terms of `a+` return after 55 s on a 37 character input. The pattern cap
 * alone allows hundreds of terms, so the shape has to be refused rather than
 * bounded.
 *
 * Conservative in the same way as `hasNestedQuantifier`, and for the same
 * reason: it also refuses `\w+\d+$` (28 ms at the cap) and `.*\s+$` (0.1 ms),
 * which do not stall. Telling an ambiguous split from a harmless one needs a
 * real regex analysis, and the cost of the false refusal is a pattern the author
 * can rewrite.
 *
 * Deliberately not reported for `[a-z]+[0-9]+` or `\d{4}-\d{2}-\d{2}`: the sets
 * do not overlap, so each character belongs to exactly one atom and there is
 * nothing to split.
 */
export function hasAdjacentQuantifiedAtoms(source: string): boolean {
  let previous: AtomSet = "none";
  let previousWasAmbiguous = false;
  let index = 0;
  while (index < source.length) {
    const atom = atomAt(source, index);
    const quantifier = quantifierAt(source, atom.next);
    const ambiguous = isAmbiguous(quantifier);

    if (atom.set === "none") {
      previous = "none";
      previousWasAmbiguous = false;
    } else {
      if (
        ambiguous &&
        previousWasAmbiguous &&
        setsOverlap(previous, atom.set)
      ) {
        return true;
      }
      previous = atom.set;
      previousWasAmbiguous = ambiguous;
    }

    if (source[index] === "(") {
      // A group's own body can carry the same shape: `(a+a+)` is one atom here,
      // and the split happens inside it.
      const end = parenEnd(source, index);
      if (
        end !== -1 &&
        hasAdjacentQuantifiedAtoms(
          source.slice(groupBodyStart(source, index), end)
        )
      ) {
        return true;
      }
    }

    index = quantifier === null ? atom.next : quantifier.next;
  }
  return false;
}

/** The reason a pattern is refused, or null when it is admitted. */
export function regexPatternProblem(source: string): string | null {
  if (source.length > MAX_REGEX_PATTERN_LENGTH) {
    return `Regex pattern is longer than ${MAX_REGEX_PATTERN_LENGTH} characters`;
  }
  if (hasNestedQuantifier(source)) {
    return "Regex pattern applies a quantifier to a group containing a quantifier or an alternation, which can backtrack without bound. Rewrite it without the nesting, for example ^0x[0-9a-fA-F]{40}$";
  }
  if (hasAdjacentQuantifiedAtoms(source)) {
    return "Regex pattern applies two quantifiers in a row to the same characters, so the match can be split between them without bound. Rewrite it without the repetition, for example use one [0-9a-f]+ instead of [0-9a-f]+[0-9a-f]+";
  }
  return null;
}
