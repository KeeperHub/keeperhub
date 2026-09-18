/**
 * Trailing-slash normalisation for base URLs.
 *
 * This regex had been declared eighteen times across the app under three
 * names (TRAILING_SLASH, TRAILING_SLASH_RE, RE_TRAILING_SLASH) in two
 * different flavours: /\/$/ strips one slash, /\/+$/ strips every trailing
 * slash. Both flavours shipped under the name TRAILING_SLASH, so a base URL
 * ending in "//" normalised to "https://host/" in the OAuth metadata routes
 * and to "https://host" in the MCP internal-URL builder, and copying the line
 * between files silently changed which.
 *
 * Every caller appends "/<path>" to the result, so stripping all of them is
 * the behaviour they all want.
 */

const TRAILING_SLASHES = /\/+$/;

export function stripTrailingSlashes(value: string): string {
  return value.replace(TRAILING_SLASHES, "");
}
