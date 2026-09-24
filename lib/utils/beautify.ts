/**
 * Formatting helpers for the config editors: the Monaco fields, the JSON
 * textarea fields, and the ABI field.
 *
 * Config values are not plain JSON or plain JavaScript: they carry template
 * references such as `{{Read Hat.result}}`, which a JSON parser or a JS parser
 * would both reject. Every entry point here therefore masks templates into
 * inert placeholders, formats the masked source, then puts the original
 * template text back verbatim.
 *
 * A reference reaches these functions in whichever form the caller holds -
 * the stored `{{@nodeId:Label.field}}` for every field today, the display
 * `{{Label.field}}` if one ever passes that - and comes back byte for byte.
 * Callers pass the stored form and write the result straight back: routing it
 * through the editor's display-to-stored mapping collapses two nodes that
 * share a label onto one id.
 */

const TEMPLATE_OPEN = "{{";
const TEMPLATE_CLOSE = "}}";
const PLACEHOLDER_STEM = "KH_TPL_";
const MIN_PLACEHOLDER_UNDERSCORES = 2;
/**
 * Two spaces, matching the repository's own sources and the `tabSize` the
 * Monaco options already set, so a formatted field looks like what pressing
 * Tab in the same editor produces.
 */
const INDENT_WIDTH = 2;

/**
 * The size above which the action is withheld.
 *
 * Formatting only adds whitespace, but whitespace has a cost: across ABIs of
 * 1000 to 3000 entries it inflates a value about 1.7x. The import route
 * refuses an export over 1 MB (`MAX_IMPORT_BYTES` in
 * app/api/workflows/import/route.ts), so a large enough field can be formatted
 * into a workflow that will not import - and there is no Minify action to put
 * it back, only undo.
 *
 * The budget below leaves a formatted field at half the import limit, so the
 * rest of the workflow still fits beside it. Sizes are in UTF-16 code units,
 * which equals bytes for the ASCII that ABIs and JSON payloads are made of,
 * and undercounts a little for text that is not - in the safe direction.
 */
const IMPORT_LIMIT_BYTES = 1_048_576;
const FORMATTING_INFLATION = 1.7;
const FIELD_SHARE_OF_IMPORT = 0.5;
export const MAX_BEAUTIFY_BYTES = Math.floor(
  (IMPORT_LIMIT_BYTES * FIELD_SHARE_OF_IMPORT) / FORMATTING_INFLATION
);

export function isWithinBeautifySize(source: string): boolean {
  return source.length <= MAX_BEAUTIFY_BYTES;
}

export type BeautifyOutcome =
  | { ok: true; value: string }
  | { ok: false; error: string };

type MaskResult = {
  masked: string;
  templates: string[];
  /**
   * Per template, whether the placeholder we substituted supplied its own
   * quotes. Restoring cannot infer this from the formatted text: a template
   * that filled a user's string entirely (`"{{A.b}}"`) and one that stood in
   * value position (`{"n": {{A.b}}}`) both read back as a quoted placeholder,
   * and stripping the quotes off the first would turn a string into a bare
   * reference.
   */
  quoted: boolean[];
  /**
   * Where each placeholder sits in the masked text, and how long the
   * reference it stands for was. A parser reports its position in the masked
   * text; these let that be mapped back to the position the user can see.
   */
  spans: { maskedStart: number; maskedLength: number; sourceLength: number }[];
  prefix: string;
};

/**
 * Build a placeholder prefix that does not already occur in the source, so a
 * value that legitimately contains `__KH_TPL_0__` cannot be corrupted when the
 * placeholders are swapped back out.
 */
function resolvePrefix(source: string): string {
  let underscores = MIN_PLACEHOLDER_UNDERSCORES;
  let at = source.indexOf(PLACEHOLDER_STEM);
  while (at !== -1) {
    let run = 0;
    while (at - run > 0 && source[at - run - 1] === "_") {
      run += 1;
    }
    if (run + 1 > underscores) {
      underscores = run + 1;
    }
    // Step by one, not by the stem's length: `KH_TPL__KH_TPL_` overlaps, and
    // a scan that skipped past the first stem would undercount the second's
    // underscores and hand back a prefix the source already contains.
    at = source.indexOf(PLACEHOLDER_STEM, at + 1);
  }
  let prefix = `${"_".repeat(underscores)}${PLACEHOLDER_STEM}`;
  // The scan above is the fast path; this is the guarantee. It costs one more
  // pass and, unlike the scan, cannot be wrong.
  while (source.includes(prefix)) {
    prefix = `_${prefix}`;
  }
  return prefix;
}

function placeholderAt(prefix: string, index: number): string {
  return `${prefix}${index}__`;
}

/**
 * The index just past a well-formed reference starting at `index`, or -1.
 *
 * A reference's body is a label and a field path: `Label.field` or
 * `@nodeId:Label.field`. It carries no brace, no quote and no line break, and
 * the resolver's own `\{\{([^}]+)\}\}` already forbids `}`. Bounding the
 * search on all four is what keeps a stray `{{` in prose - a comment about
 * another templating syntax, an unbalanced brace inside a string - from
 * swallowing everything up to the next unrelated `}}` and silently leaving
 * that whole span unformatted. Bounding on `{` alone was not enough: a gap
 * with no brace in it, `"{{ oops", "b": "x}}y"`, still swallowed.
 */
/**
 * These are stricter than the resolvers, deliberately.
 *
 * `lib/utils/template.ts` and the executor read a body as `[^}]+`, so a label
 * holding a quote or a semicolon resolves at run time, and
 * `lib/mcp/validate-workflow-web3.ts` records a decision to permit `{` there
 * for that reason. Formatting is not resolution: a candidate that reaches
 * past a string boundary here swallows the rest of the field, so the bound is
 * tighter. The cost is a field that cannot be formatted, never one that is
 * formatted wrongly - `withReferencesIntact` is what makes that true.
 */
const JSON_FORBIDDEN_IN_BODY = new Set(["{", '"', "\n", "\r", ";"]);
/**
 * JavaScript additionally rejects the quote characters. Prettier decides a
 * string's quote style by counting the quotes it can see, and it cannot see
 * one hidden inside a placeholder - so a node named `Bob's Check` produced
 * `'Hello {{Bob's Check.name}}'`, which does not parse. Leaving such a
 * reference unmasked lets Prettier account for the quote.
 *
 * The cost is that a field carrying one cannot be formatted at all: Prettier
 * cannot parse a reference in expression position, and where it can parse one
 * it may escape the quote, which the integrity check then refuses. Such a
 * field runs perfectly well - the executor resolves the reference before the
 * code is ever parsed - so this is the button declining, not the field being
 * broken. Making it work needs masking that knows whether a reference sits
 * inside a string literal, which this scanner does not track for JavaScript.
 */
const JS_FORBIDDEN_IN_BODY = new Set(["{", '"', "'", "`", "\n", "\r", ";"]);

function referenceEndAt(
  source: string,
  index: number,
  forbidden: Set<string>
): number {
  if (!source.startsWith(TEMPLATE_OPEN, index)) {
    return -1;
  }
  let cursor = index + TEMPLATE_OPEN.length;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === "}") {
      return source[cursor + 1] === "}" ? cursor + TEMPLATE_CLOSE.length : -1;
    }
    if (forbidden.has(char)) {
      return -1;
    }
    cursor += 1;
  }
  return -1;
}

/**
 * Mask templates for JavaScript.
 *
 * A bare identifier is valid everywhere a template can appear in JS - in
 * expression position (`const c = {{Setup.result}}`), inside a string literal,
 * inside a comment - so no string tracking is needed here. What a reference IS
 * still has to be bounded, which `referenceEndAt` does.
 */
function maskJavaScript(source: string): MaskResult {
  const prefix = resolvePrefix(source);
  const templates: string[] = [];
  const quoted: boolean[] = [];
  const spans: MaskResult["spans"] = [];
  let masked = "";
  let index = 0;

  while (index < source.length) {
    const jsEnd = referenceEndAt(source, index, JS_FORBIDDEN_IN_BODY);
    if (jsEnd !== -1) {
      const placeholder = placeholderAt(prefix, templates.length);
      spans.push({
        maskedStart: masked.length,
        maskedLength: placeholder.length,
        sourceLength: jsEnd - index,
      });
      masked += placeholder;
      quoted.push(false);
      templates.push(source.slice(index, jsEnd));
      index = jsEnd;
      continue;
    }
    masked += source[index];
    index += 1;
  }

  return { masked, quoted, spans, templates, prefix };
}

/**
 * Mask templates for JSON.
 *
 * Position matters here. A template inside a string (`"Bearer {{A.key}}"`) is
 * already in a legal spot and only needs its text swapped, but a template in
 * value position (`{"n": {{A.count}}}`) is not valid JSON at all and has to be
 * masked as a quoted string so the document parses. The two cases are told
 * apart by tracking string state, and unmasking reverses each accordingly.
 */
function maskJson(source: string): MaskResult {
  const prefix = resolvePrefix(source);
  const templates: string[] = [];
  const quoted: boolean[] = [];
  const spans: MaskResult["spans"] = [];
  let masked = "";
  let index = 0;
  let inString = false;

  while (index < source.length) {
    const char = source[index];

    if (inString) {
      if (char === "\\") {
        masked += source.slice(index, index + 2);
        index += 2;
        continue;
      }
      if (char === '"') {
        inString = false;
        masked += char;
        index += 1;
        continue;
      }
    } else if (char === '"') {
      inString = true;
      masked += char;
      index += 1;
      continue;
    }

    const jsonEnd = referenceEndAt(source, index, JSON_FORBIDDEN_IN_BODY);
    if (jsonEnd !== -1) {
      const placeholder = placeholderAt(prefix, templates.length);
      const written = inString ? placeholder : `"${placeholder}"`;
      spans.push({
        maskedStart: masked.length,
        maskedLength: written.length,
        sourceLength: jsonEnd - index,
      });
      masked += written;
      quoted.push(!inString);
      templates.push(source.slice(index, jsonEnd));
      index = jsonEnd;
      continue;
    }

    masked += char;
    index += 1;
  }

  return { masked, quoted, spans, templates, prefix };
}

/**
 * Swap placeholders back for their original template text.
 *
 * Whether a quoted placeholder gives its quotes back is decided by the mask,
 * not by the formatted text, because the two cases are indistinguishable
 * there. A replacer function is used rather than a replacement string so that
 * `$&` and friends inside a template stay literal.
 */
function restoreTemplates(formatted: string, mask: MaskResult): string {
  if (mask.templates.length === 0) {
    return formatted;
  }
  const prefix = mask.prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // One pass keeps this linear in the field's size: replacing each placeholder
  // in turn walked the whole document once per template, which on a field
  // carrying thousands of references stalled the tab for seconds.
  const pattern = new RegExp(`"${prefix}(\\d+)__"|${prefix}(\\d+)__`, "g");
  return formatted.replace(pattern, (match, quotedHit, bare) => {
    const index = Number(quotedHit ?? bare);
    const template = mask.templates[index];
    if (template === undefined) {
      return match;
    }
    if (quotedHit === undefined) {
      return template;
    }
    // The quotes around this one are ours only if we added them.
    return mask.quoted[index] ? template : `"${template}"`;
  });
}

/**
 * The first line only. Prettier attaches a code frame to a syntax error, which
 * would put a slice of the user's own field - a key, a token, whatever sat on
 * that line - into a toast, and show it in its masked form with our
 * placeholders where their references were.
 */
/**
 * The rule the integrity check reads references by.
 *
 * Deliberately not the masker's rule. The JavaScript masker excludes a body
 * holding a quote, which is exactly the class that gets altered - checking
 * with that rule would look straight past the thing it exists to catch. It is
 * still tighter than "anything between braces", because prose like
 * `"{{ oops", "b": "x}}"` would otherwise read as a reference whose whitespace
 * legitimately moved, and a correctly formatted field would be refused.
 */
const REFERENCE_CHECK_FORBIDDEN = new Set(["{", '"', "\n", "\r", ";"]);

/** Every reference in the text, by the rule above. */
function collectReferences(source: string, forbidden: Set<string>): string[] {
  const found: string[] = [];
  let index = 0;
  while (index < source.length) {
    const end = referenceEndAt(source, index, forbidden);
    if (end === -1) {
      index += 1;
      continue;
    }
    found.push(source.slice(index, end));
    index = end;
  }
  return found;
}

export const REFERENCES_CHANGED_REASON =
  "Formatting would have altered a workflow reference in this field, so it was left unchanged.";

/**
 * The last word on whether a formatted value may be handed back.
 *
 * Masking keeps a formatter away from a reference, but not every reference can
 * be masked: one whose body holds a quote is left in place on the JavaScript
 * side, because Prettier has to see that quote to pick the string's own. It
 * then also escapes it - `{{Bob's N.x}}` came back `{{Bob\'s N.x}}`, which the
 * display resolver no longer matches and a node rename no longer rewrites.
 *
 * Rather than enumerate the ways a formatter might reach a reference, this
 * compares the references in the result against the ones that went in and
 * refuses if they differ. A refusal is recoverable; a field that silently
 * stopped pointing at the right node is not.
 */
function withReferencesIntact(
  source: string,
  formatted: string
): BeautifyOutcome {
  const before = collectReferences(source, REFERENCE_CHECK_FORBIDDEN);
  const after = collectReferences(formatted, REFERENCE_CHECK_FORBIDDEN);
  const same =
    before.length === after.length &&
    before.every((run, index) => run === after[index]);
  return same
    ? { ok: true, value: formatted }
    : { ok: false, error: REFERENCES_CHANGED_REASON };
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return (
      error.message.split("\n")[0].trim() || "Could not format this value."
    );
  }
  return "Could not format this value.";
}

const JSON_STRUCTURAL = new Set(["{", "}", "[", "]", ",", ":"]);

/**
 * Split JSON into structural characters and verbatim literals.
 *
 * Literals are carried as the exact source text, never as parsed values. That
 * is the whole point: `JSON.parse` turns `12345678901234567890` into a double
 * and hands back `12345678901234567000`, which would silently corrupt a wei
 * amount the moment someone pressed Beautify. A formatter must change
 * whitespace and nothing else.
 */
function tokenizeJson(source: string): string[] {
  const tokens: string[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index];

    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      index += 1;
      continue;
    }

    if (JSON_STRUCTURAL.has(char)) {
      tokens.push(char);
      index += 1;
      continue;
    }

    if (char === '"') {
      let end = index + 1;
      while (end < source.length) {
        if (source[end] === "\\") {
          end += 2;
          continue;
        }
        if (source[end] === '"') {
          end += 1;
          break;
        }
        end += 1;
      }
      tokens.push(source.slice(index, end));
      index = end;
      continue;
    }

    // A number, true, false or null: copied exactly as written.
    let end = index;
    while (end < source.length) {
      const next = source[end];
      if (
        JSON_STRUCTURAL.has(next) ||
        next === " " ||
        next === "\t" ||
        next === "\n" ||
        next === "\r"
      ) {
        break;
      }
      end += 1;
    }
    tokens.push(source.slice(index, end));
    index = end;
  }

  return tokens;
}

function indentOf(depth: number): string {
  return " ".repeat(depth * INDENT_WIDTH);
}

/** Re-emit the token stream one value per line. */
function printJsonTokens(tokens: string[]): string {
  let out = "";
  let depth = 0;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const next = tokens[i + 1];

    if (token === "{" || token === "[") {
      const closer = token === "{" ? "}" : "]";
      if (next === closer) {
        out += token + closer;
        i += 1;
        continue;
      }
      depth += 1;
      out += `${token}\n${indentOf(depth)}`;
      continue;
    }

    if (token === "}" || token === "]") {
      depth -= 1;
      out += `\n${indentOf(depth)}${token}`;
      continue;
    }

    if (token === ",") {
      out += `,\n${indentOf(depth)}`;
      continue;
    }

    if (token === ":") {
      out += ": ";
      continue;
    }

    out += token;
  }

  return out;
}

/**
 * Re-indent JSON with two spaces, preserving templates and every literal.
 *
 * `JSON.parse` runs for validation only and its result is discarded: a field
 * that cannot be formatted is a field that will not parse at execution time
 * either, so the caller gets a message worth surfacing rather than a silent
 * no-op. The output is built from the source text instead, so numbers, string
 * escapes and duplicate keys come through exactly as the user wrote them.
 */
const JSON_POSITION = /at position (\d+)/;

/** A masked offset, moved back to the offset the user can see. */
function toSourceOffset(maskedOffset: number, mask: MaskResult): number {
  let shift = 0;
  for (const span of mask.spans) {
    if (span.maskedStart + span.maskedLength > maskedOffset) {
      break;
    }
    shift += span.sourceLength - span.maskedLength;
  }
  return maskedOffset + shift;
}

/**
 * Where the parser gave up, in line and column the user can count to.
 *
 * The parser reads the masked text, so its offset has to be mapped back
 * before it means anything - a placeholder is shorter than the reference it
 * stands for, and every one before the error moves the number. The message
 * itself is not reused: V8 quotes a slice of the source on its first line,
 * which here would be the masked source, placeholders and all.
 */
function lineAndColumn(
  source: string,
  offset: number
): { line: number; column: number } {
  let line = 1;
  let lastBreak = -1;
  const limit = Math.min(offset, source.length);
  for (let index = 0; index < limit; index += 1) {
    if (source[index] === "\n") {
      line += 1;
      lastBreak = index;
    }
  }
  return { line, column: offset - lastBreak };
}

const JS_POSITION = /\((\d+):(\d+)\)/;

/**
 * The offset of a 1-based line and column. The inverse of `lineAndColumn`.
 *
 * Prettier reports a position rather than an offset, so its numbers have to be
 * turned back into one before `toSourceOffset` can move them.
 */
function offsetAt(source: string, line: number, column: number): number {
  let offset = 0;
  let current = 1;
  while (current < line) {
    const next = source.indexOf("\n", offset);
    if (next === -1) {
      return source.length;
    }
    offset = next + 1;
    current += 1;
  }
  return offset + Math.max(0, column - 1);
}

/**
 * Prettier's message with its position moved into the user's coordinates.
 *
 * The parser reads the masked text, where every placeholder is shorter than
 * the reference it stands for, so a reference earlier on the line drags the
 * column left - onto the middle of the user's own reference. The line is
 * always right; only the column moves. The phrase is kept as Prettier wrote
 * it, since "Missing semicolon" says more than any wording of ours.
 */
function describeJavaScriptFailure(
  error: unknown,
  mask: MaskResult,
  source: string
): string {
  const message = describeError(error);
  const at = JS_POSITION.exec(message);
  if (!at) {
    return message;
  }
  const maskedOffset = offsetAt(mask.masked, Number(at[1]), Number(at[2]));
  const mapped = lineAndColumn(source, toSourceOffset(maskedOffset, mask));
  return message.replace(at[0], `(${mapped.line}:${mapped.column})`);
}

function describeJsonFailure(
  error: unknown,
  mask: MaskResult,
  source: string
): string {
  const base = "This is not valid JSON, so the field was left unchanged.";
  const raw = error instanceof Error ? error.message : "";
  const at = JSON_POSITION.exec(raw);
  if (!at) {
    return base;
  }
  const { line, column } = lineAndColumn(
    source,
    toSourceOffset(Number(at[1]), mask)
  );
  return `${base} The parser stopped at line ${line}, column ${column}.`;
}

export function beautifyJson(source: string): BeautifyOutcome {
  if (source.trim() === "") {
    return { ok: true, value: source };
  }

  const mask = maskJson(source);

  try {
    JSON.parse(mask.masked);
  } catch (error) {
    return { ok: false, error: describeJsonFailure(error, mask, source) };
  }

  const formatted = printJsonTokens(tokenizeJson(mask.masked));
  return withReferencesIntact(source, restoreTemplates(formatted, mask));
}

/**
 * Re-print JavaScript with Prettier, preserving templates.
 *
 * Prettier is imported on demand so its parser and printer stay out of the
 * editor bundle until someone actually presses the button.
 */
export async function beautifyJavaScript(
  source: string
): Promise<BeautifyOutcome> {
  if (source.trim() === "") {
    return { ok: true, value: source };
  }

  const mask = maskJavaScript(source);

  try {
    const [standalone, babel, estree] = await Promise.all([
      import("prettier/standalone"),
      import("prettier/plugins/babel"),
      import("prettier/plugins/estree"),
    ]);

    const formatted = await standalone.format(mask.masked, {
      // babel-ts is a superset of babel, so a field declared as typescript
      // formats rather than failing on its first annotation.
      parser: "babel-ts",
      plugins: [babel, estree],
      semi: true,
      singleQuote: true,
      tabWidth: INDENT_WIDTH,
      // A placeholder is a valid identifier, so the default "as-needed" would
      // unquote an object key that is nothing but a reference - putting back
      // `{ {{A.k}}: 1 }` where the user wrote `{ "{{A.k}}": 1 }`. That is the
      // same class of change as stripping a reference's quotes in JSON.
      quoteProps: "preserve",
    });

    return withReferencesIntact(source, restoreTemplates(formatted, mask));
  } catch (error) {
    return { ok: false, error: describeJavaScriptFailure(error, mask, source) };
  }
}

// Not jsonc: the validation step is JSON.parse, which rejects comments.
const JSON_LANGUAGES = new Set(["json"]);
const JAVASCRIPT_LANGUAGES = new Set(["javascript", "js", "typescript", "ts"]);

/**
 * Languages the button is offered for. SQL and the plain-text variants are
 * deliberately absent - there is no formatter behind them, and a button that
 * does nothing is worse than no button.
 */
export function canBeautifyLanguage(language: string): boolean {
  const normalized = language.toLowerCase();
  return JSON_LANGUAGES.has(normalized) || JAVASCRIPT_LANGUAGES.has(normalized);
}

/**
 * One line naming what the action will produce, for the control's tooltip.
 * Says the target format and the indent, which is the part a user cannot
 * guess from the label alone.
 */
export const TOO_LARGE_REASON =
  "This field is too large to reformat. Formatting it would leave the workflow too big to import.";

export function describeBeautifyTarget(language: string): string {
  const normalized = language.toLowerCase();
  if (JSON_LANGUAGES.has(normalized)) {
    return `Reformat as JSON, ${INDENT_WIDTH}-space indent. Workflow references are kept as they are.`;
  }
  if (JAVASCRIPT_LANGUAGES.has(normalized)) {
    return `Reformat as JavaScript, ${INDENT_WIDTH}-space indent. Workflow references are kept as they are.`;
  }
  return "No formatter is available for this field.";
}

export function beautifySource(
  source: string,
  language: string
): Promise<BeautifyOutcome> {
  if (!isWithinBeautifySize(source)) {
    return Promise.resolve({
      ok: false,
      error: TOO_LARGE_REASON,
    });
  }
  const normalized = language.toLowerCase();
  if (JSON_LANGUAGES.has(normalized)) {
    return Promise.resolve(beautifyJson(source));
  }
  if (JAVASCRIPT_LANGUAGES.has(normalized)) {
    return beautifyJavaScript(source);
  }
  return Promise.resolve({
    ok: false,
    error: `No formatter is available for ${language}.`,
  });
}
