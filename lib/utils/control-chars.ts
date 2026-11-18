/**
 * The characters that must not reach text a person reads: every control
 * (Unicode Cc - C0, DEL, C1), every format character (Cf - zero-width chars,
 * bidi overrides and isolates, soft hyphen, BOM, tag characters) and the line
 * and paragraph separators (Zl, Zp).
 *
 * A bidi override reorders the text it sits in, so a string can render as
 * something other than what it says; zero-width and tag characters hide
 * differences between two values that look identical. Both are how an
 * upstream step's output lies about itself once it is rendered - in a node
 * label, in an alert summary, in a link label beside the href it claims to
 * describe. Whole categories, not a hand-picked list, so none is missed.
 *
 * Callers differ in two ways and only two, so both are arguments here rather
 * than a reason to keep a second copy of the class: whether tab, newline and
 * carriage return survive, and what a removed character leaves behind.
 * This module has no imports, deliberately - one of its readers is bundled
 * into the browser and another cannot pull in the plugin registry.
 */

const ALL_CONTROL_CHARS_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

// The same class, less tab (U+0009), newline (U+000A) and carriage return
// (U+000D). U+2028 and U+2029 stay in it: they are line breaks no author
// types and every renderer treats differently.
const CONTROL_CHARS_KEEPING_LINE_BREAKS_RE =
  /(?![\t\n\r])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

export type StripControlCharsOptions = {
  /** Keep tab, newline and carriage return - for a field allowed lines. */
  keepLineBreaks?: boolean;
  /** What each removed character becomes: a string, or one made from it. */
  replacement?: string | ((char: string) => string);
};

/** Remove or replace them. Returns the value unchanged when it carries none. */
export function stripControlChars(
  value: string,
  options: StripControlCharsOptions = {}
): string {
  const pattern = options.keepLineBreaks
    ? CONTROL_CHARS_KEEPING_LINE_BREAKS_RE
    : ALL_CONTROL_CHARS_RE;
  const { replacement = "" } = options;
  // A function, so a string replacement's $& or $1 is never read as a pattern.
  const replace =
    typeof replacement === "string" ? (): string => replacement : replacement;
  return value.replace(pattern, replace);
}
