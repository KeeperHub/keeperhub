/**
 * String literals in condition expressions: one scanner, shared by the
 * interpreter, the validators and the builder's parse-back, so all of them
 * agree on where a string starts and ends.
 */

const HEX_RE = /^[0-9a-fA-F]+$/;

// Escapes a regex reads the same either way. Any other (\d, \., \b, \x2e)
// drops or changes a backslash, which silently changes a regex pattern.
const EXACT_ESCAPES = new Set(["\\", '"', "'", "n", "r", "t"]);

export type ScannedString = {
  value: string;
  /** Index just past the closing quote. */
  next: number;
  /** True when an escape dropped or changed a backslash, e.g. "\d" is "d". */
  lossy: boolean;
};

function decodeHexEscape(
  src: string,
  backslashIndex: number,
  count: number
): { value: string; next: number } {
  const hex = src.slice(backslashIndex + 2, backslashIndex + 2 + count);
  if (hex.length < count || !HEX_RE.test(hex)) {
    throw new Error("Invalid escape sequence in string literal");
  }
  return {
    value: String.fromCodePoint(Number.parseInt(hex, 16)),
    next: backslashIndex + 2 + count,
  };
}

function decodeUnicodeEscape(
  src: string,
  backslashIndex: number
): { value: string; next: number } {
  const afterU = backslashIndex + 2;
  if (src[afterU] === "{") {
    const end = src.indexOf("}", afterU);
    if (end === -1) {
      throw new Error("Invalid escape sequence in string literal");
    }
    const hex = src.slice(afterU + 1, end);
    if (hex.length === 0 || !HEX_RE.test(hex)) {
      throw new Error("Invalid escape sequence in string literal");
    }
    return {
      value: String.fromCodePoint(Number.parseInt(hex, 16)),
      next: end + 1,
    };
  }
  return decodeHexEscape(src, backslashIndex, 4);
}

const SIMPLE_ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
  v: "\v",
  "0": "\0",
};

function decodeEscape(
  src: string,
  backslashIndex: number
): { value: string; next: number } {
  const esc = src[backslashIndex + 1];
  if (esc === undefined) {
    throw new Error("Unterminated string literal");
  }
  if (esc === "x") {
    return decodeHexEscape(src, backslashIndex, 2);
  }
  if (esc === "u") {
    return decodeUnicodeEscape(src, backslashIndex);
  }
  const simple = SIMPLE_ESCAPES[esc];
  if (simple !== undefined) {
    return { value: simple, next: backslashIndex + 2 };
  }
  return { value: esc, next: backslashIndex + 2 };
}

export function scanString(src: string, start: number): ScannedString {
  const quote = src[start];
  let i = start + 1;
  let out = "";
  let lossy = false;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      lossy ||= !EXACT_ESCAPES.has(src[i + 1] ?? "");
      const decoded = decodeEscape(src, i);
      out += decoded.value;
      i = decoded.next;
      continue;
    }
    if (ch === quote) {
      return { value: out, next: i + 1, lossy };
    }
    out += ch;
    i += 1;
  }
  throw new Error("Unterminated string literal");
}

/**
 * The expression with every string literal's contents replaced by "_", quotes
 * and length kept, so text checks skip what the interpreter reads as data.
 * Throws on an unterminated string, which the interpreter rejects too.
 */
export function maskStringLiterals(expression: string): string {
  let out = "";
  let i = 0;
  while (i < expression.length) {
    const ch = expression[i];
    if (ch !== '"' && ch !== "'") {
      out += ch;
      i += 1;
      continue;
    }
    const { next } = scanString(expression, i);
    out += `${ch}${"_".repeat(next - i - 2)}${ch}`;
    i = next;
  }
  return out;
}
