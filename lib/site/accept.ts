/**
 * Accept-header content negotiation, per RFC 9110 section 12.5.1.
 *
 * Written for the acceptmarkdown.com contract, which asks for four things: serve
 * markdown when the client asks for `text/markdown`, advertise `Vary: Accept`,
 * answer 406 when nothing on offer is acceptable, and honour q-values rather
 * than pattern-matching the header string. The last one is why this is a real
 * parser and not an `includes("text/markdown")` check: a browser sends
 * `text/html,application/xhtml+xml,...,*[/]*;q=0.8`, and a naive substring test
 * on the wildcard would hand every browser a markdown download.
 */

export type MediaType = "text/markdown" | "text/html";

type AcceptEntry = {
  type: string;
  subtype: string;
  quality: number;
  /** Position in the header, used to break ties in the client's stated order. */
  order: number;
};

const MAX_ACCEPT_LENGTH = 8192;
const DEFAULT_QUALITY = 1;

function parseQuality(parameters: readonly string[]): number {
  for (const parameter of parameters) {
    const [rawKey, rawValue] = parameter.split("=");
    if (rawKey?.trim().toLowerCase() !== "q") {
      continue;
    }
    const quality = Number.parseFloat(rawValue?.trim() ?? "");
    if (Number.isNaN(quality)) {
      return DEFAULT_QUALITY;
    }
    // RFC 9110: qvalue is 0..1 inclusive. Clamp rather than reject, so a
    // sloppy client still gets a sensible answer instead of a 406.
    return Math.min(Math.max(quality, 0), 1);
  }
  return DEFAULT_QUALITY;
}

/**
 * Parse an Accept header into its media ranges. A missing header is treated as
 * `*[/]*` per RFC 9110, which is what makes a curl with no Accept get HTML.
 */
export function parseAccept(header: string | null): AcceptEntry[] {
  if (header === null || header.trim().length === 0) {
    return [{ type: "*", subtype: "*", quality: DEFAULT_QUALITY, order: 0 }];
  }
  // A header this long is either an attack or a bug; either way, falling back
  // to the wildcard serves HTML rather than spending time parsing it.
  if (header.length > MAX_ACCEPT_LENGTH) {
    return [{ type: "*", subtype: "*", quality: DEFAULT_QUALITY, order: 0 }];
  }

  const entries: AcceptEntry[] = [];
  const parts = header.split(",");
  for (let index = 0; index < parts.length; index++) {
    const [rawRange, ...parameters] = parts[index].split(";");
    const range = rawRange.trim().toLowerCase();
    if (range.length === 0) {
      continue;
    }
    const slash = range.indexOf("/");
    if (slash === -1) {
      continue;
    }
    entries.push({
      type: range.slice(0, slash),
      subtype: range.slice(slash + 1),
      quality: parseQuality(parameters),
      order: index,
    });
  }
  return entries;
}

/**
 * Specificity ranking used to pick which media range applies to a candidate,
 * per RFC 9110's "most specific reference has precedence": an exact
 * `text/markdown` beats `text/*`, which beats `*[/]*`.
 */
function specificity(entry: AcceptEntry): number {
  if (entry.type === "*") {
    return 0;
  }
  if (entry.subtype === "*") {
    return 1;
  }
  return 2;
}

function matches(entry: AcceptEntry, candidate: MediaType): boolean {
  const slash = candidate.indexOf("/");
  const type = candidate.slice(0, slash);
  const subtype = candidate.slice(slash + 1);
  if (entry.type === "*" && entry.subtype === "*") {
    return true;
  }
  if (entry.type !== type) {
    return false;
  }
  return entry.subtype === "*" || entry.subtype === subtype;
}

/** The q-value the client assigned to a candidate, or 0 if unacceptable. */
export function qualityFor(
  entries: readonly AcceptEntry[],
  candidate: MediaType
): number {
  let best: AcceptEntry | null = null;
  for (const entry of entries) {
    if (!matches(entry, candidate)) {
      continue;
    }
    if (best === null || specificity(entry) > specificity(best)) {
      best = entry;
    }
  }
  return best?.quality ?? 0;
}

export type Negotiation =
  | { kind: "markdown" }
  | { kind: "html" }
  | { kind: "not-acceptable" };

/**
 * Choose the representation to serve.
 *
 * HTML wins ties. A browser sends `text/html,...,*[/]*;q=0.8` so HTML already
 * wins on q-value, but an agent sending a bare `Accept: *[/]*` scores both at
 * 1.0 - and the right answer for an unspecific client is the representation the
 * rest of the web assumes.
 */
export function negotiate(header: string | null): Negotiation {
  const entries = parseAccept(header);
  const html = qualityFor(entries, "text/html");
  const markdown = qualityFor(entries, "text/markdown");

  if (html === 0 && markdown === 0) {
    return { kind: "not-acceptable" };
  }
  return markdown > html ? { kind: "markdown" } : { kind: "html" };
}
