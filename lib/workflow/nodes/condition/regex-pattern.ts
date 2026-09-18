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

const BODY_QUANTIFIER_BRACE_PATTERN = /^\{\d*,?\d*\}$/;
const HEX_TWO_PATTERN = /^[0-9a-fA-F]{2}$/;
const HEX_FOUR_PATTERN = /^[0-9a-fA-F]{4}$/;
const HEX_ANY_PATTERN = /^[0-9a-fA-F]+$/;
const QUANTIFIER_BOUNDS_PATTERN = /^(\d+)(?:,(\d*))?$/;

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
    // A quantifier that cannot repeat the group in more than one way cannot
    // backtrack, so it does not trigger this rule. Reading `?` as one refused
    // `^(0x)?[0-9a-f]{40}$` and `^\d+(\.\d+)?$`, which are the first two patterns
    // an author reaches for, and a fixed count is no different.
    if (!isAmbiguous(quantifierAt(source, group.end + 1))) {
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

/** The two edges of an atom: what its first and last atoms admit, and whether
 *  either edge can give characters back. */
type AtomEdges = {
  leading: AtomSet;
  leadingAmbiguous: boolean;
  trailing: AtomSet;
  trailingAmbiguous: boolean;
};

type Atom = {
  set: AtomSet;
  next: number;
  /**
   * Present only for a group. A non-group atom's edges are its own set, and the
   * ambiguity at them is whatever quantifier the caller reads beside it, so the
   * caller supplies that default rather than this function inventing one.
   */
  edges?: AtomEdges;
};

/**
 * One atom at `index`: a class, a group, an escape, an anchor or a literal.
 * A group's set is the union of the sets inside it, which is what makes an
 * alternation's branches count as one atom here, and its edges describe the
 * first and last atoms of its body so a group can be compared against its
 * neighbours by the characters that actually touch them.
 */
function atomAt(source: string, index: number): Atom {
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
    const bodyStart = groupBodyStart(source, index);
    return {
      set: groupSet(source, bodyStart, end),
      edges: groupBodyEdges(source, bodyStart, end),
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

/**
 * The edges of a group's body, which is what lets an unquantified group be
 * compared against its neighbours.
 *
 * `(a*)` repeated is the case: the group as a whole carries no quantifier, so
 * `isAmbiguous` says nothing about it, and the body's trailing `a*` is the only
 * thing that shows characters can be given back across the `)`. The same holds
 * the other way for `a+(a+)$`, where the ambiguity the group presents is
 * whatever leads its body.
 *
 * The body walks the same way `groupSet` does, and folds an atom whose
 * quantifier permits zero occurrences into the trailing edge rather than letting
 * it replace it, because such an atom can disappear and leave the atom before it
 * touching the `)`.
 */
function groupBodyEdges(
  source: string,
  bodyStart: number,
  end: number
): AtomEdges {
  let leading: AtomSet = "none";
  let leadingAmbiguous = false;
  let trailing: AtomSet = "none";
  let trailingAmbiguous = false;
  let sawAtom = false;
  let index = bodyStart;

  while (index < end) {
    const atom = atomAt(source, index);
    const quantifier = quantifierAt(source, atom.next);
    const edges = atom.edges ?? {
      leading: atom.set,
      leadingAmbiguous: false,
      trailing: atom.set,
      trailingAmbiguous: false,
    };
    const ambiguous = isAmbiguous(quantifier) || edges.trailingAmbiguous;

    if (atom.set !== "none") {
      if (!sawAtom) {
        leading = edges.leading;
        leadingAmbiguous = isAmbiguous(quantifier) || edges.leadingAmbiguous;
        sawAtom = true;
      }
      if (quantifier !== null && quantifier.min === 0) {
        trailing = unionSets(trailing, edges.trailing);
        trailingAmbiguous = trailingAmbiguous || ambiguous;
      } else {
        trailing = edges.trailing;
        trailingAmbiguous = ambiguous;
      }
    }

    index = quantifier === null ? atom.next : quantifier.next;
  }

  return { leading, leadingAmbiguous, trailing, trailingAmbiguous };
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

function unionSets(left: AtomSet, right: AtomSet): AtomSet {
  if (left === "none") {
    return right;
  }
  if (right === "none") {
    return left;
  }
  if (left === "any" || right === "any") {
    return "any";
  }
  const union = new Set(left);
  for (const value of right) {
    union.add(value);
  }
  return union;
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
 * them.
 *
 * `hasNestedQuantifier` only looks at quantifiers applied to a `(...)` group, so
 * `a+a+$` was never examined. Measured against the caps this operator enforces
 * (`new RegExp(src).test("a".repeat(4096) + "!")`): 34.8 s for two terms, and
 * 16 terms of `a+` return after 55 s on a 37 character input. The pattern cap
 * alone allows hundreds of terms, so the shape has to be refused rather than
 * bounded.
 *
 * Two things make the shape reach further than two bare atoms, and both were
 * missed by the first version of this guard:
 *
 * - An unquantified group carries its body's ambiguity across the `)`. `(a*)`
 *   repeated has no quantifier for `isAmbiguous` to read, and the split is
 *   between the group's trailing `a*` and whatever follows. Measured at the
 *   enforced caps against a 25 character value: 8 groups take 698 ms, 10 take
 *   7.7 s, 12 take 72 s, 14 take 160 s, and the 512 character pattern cap admits
 *   about 127 of them. The same holds for the body's leading atom, which is what
 *   `a+(a+)$` uses.
 * - An atom whose quantifier permits zero occurrences does not separate the atoms
 *   around it, because it can vanish. `a+b?a+$` splits between the two `a+` with
 *   a `b?` between them.
 *
 * Conservative in the same way as `hasNestedQuantifier`, and for the same
 * reason: it also refuses `\w+\d+$` (28 ms at the cap) and `.*\s+$` (0.1 ms),
 * which do not stall. Telling an ambiguous split from a harmless one needs a
 * real regex analysis, and the cost of the false refusal is a pattern the author
 * can rewrite. It remains a syntactic guard, so it is a race against the next
 * shape by construction rather than a bound on evaluation.
 *
 * Deliberately not reported for `[a-z]+[0-9]+`, `\d{4}-\d{2}-\d{2}$` or
 * `(?:0x)?[0-9a-f]+`: the sets do not overlap at the point of contact, so each
 * character belongs to exactly one atom and there is nothing to split.
 */
export function hasAdjacentQuantifiedAtoms(source: string): boolean {
  let previous: AtomSet = "none";
  let previousWasAmbiguous = false;
  let index = 0;
  while (index < source.length) {
    const atom = atomAt(source, index);
    const quantifier = quantifierAt(source, atom.next);
    const edges = atom.edges ?? {
      leading: atom.set,
      leadingAmbiguous: false,
      trailing: atom.set,
      trailingAmbiguous: false,
    };
    // A group with no quantifier of its own is still ambiguous when the body it
    // closes over can give characters back.
    const ambiguous = isAmbiguous(quantifier) || edges.trailingAmbiguous;

    if (atom.set === "none") {
      previous = "none";
      previousWasAmbiguous = false;
    } else {
      if (
        ambiguous &&
        previousWasAmbiguous &&
        setsOverlap(previous, edges.leading)
      ) {
        return true;
      }
      if (quantifier !== null && quantifier.min === 0) {
        // Can vanish, so it does not end the boundary: fold it into the
        // candidate rather than replacing what came before it.
        previous = unionSets(previous, edges.trailing);
        previousWasAmbiguous = previousWasAmbiguous || ambiguous;
      } else {
        previous = edges.trailing;
        previousWasAmbiguous = ambiguous;
      }
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
/**
 * Bounds on the shape, checked in one pass before either heuristic walks the
 * pattern.
 *
 * Both heuristics are syntactic, so both recurse through the nesting they are
 * examining: `atomAt` on a group calls `groupSet` and `groupBodyEdges` over the
 * body, and `hasAdjacentQuantifiedAtoms` walks it a third time, which doubles the
 * cost per level. A pattern of nothing but nested parentheses around one literal,
 * with no quantifier anywhere, costs 4.9 seconds at depth 24 and is admitted at
 * every layer, so the guard was itself the denial of service it exists to prevent.
 * The number of groups bounds the other family: `^(?:a|a)(?:a|a)...$` needs no
 * nested quantifier and no adjacency, and its cost is 2^n in the group count, so
 * 26 groups is 2.3 seconds and the 512-character cap admits around 73.
 *
 * Both are interim bounds rather than properties of the language, and they are
 * stated as such: the shapes they refuse are refused for what they cost this
 * checker, not for being unsafe in the engine. The fix they stand in for is a
 * non-backtracking engine or evaluation off the event loop, which is the decision
 * this branch escalates rather than settles.
 */
const MAX_NESTING_DEPTH = 8;
const MAX_GROUP_COUNT = 16;

/** The shape bounds, or `null` when the pattern is within them. */
function complexityProblem(source: string): string | null {
  let depth = 0;
  let deepest = 0;
  let groups = 0;
  let inClass = false;
  // A while loop rather than a for: the scan skips the character after a
  // backslash, which `for...of` cannot express and which the linter reads as an
  // index-only for loop over the string.
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    index += 1;
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
      groups += 1;
      depth += 1;
      deepest = Math.max(deepest, depth);
      continue;
    }
    if (char === ")" && depth > 0) {
      depth -= 1;
    }
  }
  if (deepest > MAX_NESTING_DEPTH) {
    return `Regex pattern nests groups more than ${MAX_NESTING_DEPTH} deep, which the checker refuses because it walks that nesting. Rewrite it with fewer levels, for example flatten the groups or use a character class`;
  }
  if (groups > MAX_GROUP_COUNT) {
    return `Regex pattern uses more than ${MAX_GROUP_COUNT} groups. Split it into separate conditions, or simplify it: each group multiplies the work the checker does on the ones inside it`;
  }
  return null;
}

export function regexPatternProblem(source: string): string | null {
  if (source.length > MAX_REGEX_PATTERN_LENGTH) {
    return `Regex pattern is longer than ${MAX_REGEX_PATTERN_LENGTH} characters`;
  }
  const complexity = complexityProblem(source);
  if (complexity !== null) {
    return complexity;
  }
  if (hasNestedQuantifier(source)) {
    return "Regex pattern applies a quantifier to a group containing a quantifier or an alternation, which can backtrack without bound. Rewrite it without the nesting, for example ^0x[0-9a-fA-F]{40}$";
  }
  if (hasAdjacentQuantifiedAtoms(source)) {
    return "Regex pattern applies two quantifiers in a row to the same characters, so the match can be split between them without bound. Rewrite it without the repetition, for example use one [0-9a-f]+ instead of [0-9a-f]+[0-9a-f]+";
  }
  return null;
}
