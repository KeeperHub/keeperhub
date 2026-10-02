/**
 * The characters that must not reach text a person reads.
 *
 * Covers: C0 + DEL + C1 controls, line/paragraph separators, zero-width
 * chars (ZWSP/ZWNJ/ZWJ/LRM/RLM), bidi overrides (LRE/RLE/PDF/LRO/RLO),
 * bidi isolates (LRI/RLI/FSI/PDI), Arabic letter mark, BOM, and soft hyphen.
 *
 * A bidi override reorders the text it sits in, so a string can render as
 * something other than what it says; zero-width characters hide differences
 * between two values that look identical. Both are how an upstream step's
 * output lies about itself once it is rendered - in a node label, in an alert
 * summary, in a link label beside the href it claims to describe.
 *
 * Callers differ in two ways and only two, so both are arguments here rather
 * than a reason to keep a second copy of the class: whether tab, newline and
 * carriage return survive, and whether a removed character leaves a space
 * behind. This module has no imports, deliberately - one of its readers is
 * bundled into the browser and another cannot pull in the plugin registry.
 */

const ALL_CONTROL_CHARS_RE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing exactly these is the point
  /[\u0000-\u001f\u007f-\u009f\u00ad\ufeff\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

// The same class, less tab (U+0009), newline (U+000A) and carriage return
// (U+000D). U+2028 and U+2029 stay in it: they are line breaks no author
// types and every renderer treats differently.
const CONTROL_CHARS_KEEPING_LINE_BREAKS_RE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing exactly these is the point
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\ufeff\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

export type StripControlCharsOptions = {
  /** Keep tab, newline and carriage return - for a field allowed lines. */
  keepLineBreaks?: boolean;
  /** What each removed character becomes. Defaults to removal. */
  replacement?: string;
};

/** Remove them. Returns the value unchanged when it carries none. */
export function stripControlChars(
  value: string,
  options: StripControlCharsOptions = {}
): string {
  const pattern = options.keepLineBreaks
    ? CONTROL_CHARS_KEEPING_LINE_BREAKS_RE
    : ALL_CONTROL_CHARS_RE;
  return value.replace(pattern, options.replacement ?? "");
}
