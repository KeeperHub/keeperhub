/**
 * Trusted origins for cookie-authenticated requests.
 *
 * Source of truth shared by:
 * - better-auth config (`lib/auth.ts`) — guards `/api/auth/**`
 * - root `proxy.ts` — guards all other `/api/**` POST/PATCH/PUT/DELETE
 * - `lib/middleware/auth-helpers.ts` — defence-in-depth on session-authed routes
 *
 * This module is Edge-runtime safe (no Node-only imports) so the root
 * middleware can use it directly. See KEEP-240.
 *
 * Wildcard syntax matches better-auth's behaviour: `*` matches any sequence
 * of characters except `/` and `\`. So `https://*.keeperhub.com` matches
 * `https://app.keeperhub.com` and `https://app.staging.keeperhub.com` alike.
 */

// HTTPS localhost variants are dev-only: Brave / SIWE wallets require a secure
// origin so local HTTPS dev (pnpm dev:https) needs https://localhost:*, but
// these must not be trusted in production or CI (no real HTTPS localhost cert).
const DEV_HTTPS_ORIGINS: readonly string[] =
  process.env.NODE_ENV === "development"
    ? ["https://localhost:*", "https://127.0.0.1:*"]
    : [];

export const TRUSTED_ORIGINS: readonly string[] = [
  // HTTP localhost poses no CSRF risk (same machine only) and must work in
  // all environments including CI (NODE_ENV=test) so worktrees on any port pass.
  "http://localhost:*",
  ...DEV_HTTPS_ORIGINS,
  // start custom keeperhub code //
  "http://127.0.0.1:*", // CLI browser auth callback (dynamic port)
  // end keeperhub code //
  "https://*.keeperhub.com",
];

const REGEX_META = new Set([
  ".",
  "+",
  "^",
  "$",
  "{",
  "}",
  "(",
  ")",
  "|",
  "[",
  "]",
  "\\",
  "?",
]);

function compilePattern(pattern: string): RegExp {
  let result = "";
  for (const char of pattern) {
    if (char === "*") {
      result += "[^/\\\\]*";
    } else if (REGEX_META.has(char)) {
      result += `\\${char}`;
    } else {
      result += char;
    }
  }
  return new RegExp(`^${result}$`);
}

const COMPILED_PATTERNS: ReadonlyArray<{ pattern: string; regex: RegExp }> =
  TRUSTED_ORIGINS.map((pattern) => ({
    pattern,
    regex: compilePattern(pattern),
  }));

/**
 * Normalises an `Origin` or `Referer` header value to a bare origin
 * (`scheme://host[:port]`). Returns `null` if the value cannot be parsed.
 */
export function normaliseOrigin(
  value: string | null | undefined
): string | null {
  if (!value || value === "null") {
    return null;
  }
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Returns true when the given origin matches any entry in `TRUSTED_ORIGINS`.
 * The input must be a full origin (e.g. `https://app.keeperhub.com`).
 */
export function isTrustedOrigin(origin: string): boolean {
  for (const { regex } of COMPILED_PATTERNS) {
    if (regex.test(origin)) {
      return true;
    }
  }
  return false;
}

/**
 * Boundary-anchored regex matching the better-auth session cookie name in a
 * Cookie header, regardless of the `__Secure-` prefix added in production.
 * The leading `(?:^|;\s*)` anchor avoids false positives where the substring
 * appears inside another cookie's value or as a suffix of an unrelated name.
 *
 * The pinning test in `tests/unit/trusted-origins.test.ts` asserts this regex
 * still matches the cookie name better-auth generates, so a future better-auth
 * upgrade that renames the cookie fails CI rather than silently disabling
 * the CSRF check. See KEEP-240.
 */
export const SESSION_COOKIE_RE =
  /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=/;

/**
 * Returns true when the request's Cookie header carries a better-auth
 * session token. Used by the proxy and `getDualAuthContext` to decide
 * whether the request is potentially session-authenticated and therefore
 * subject to the origin check. Cookieless callers (Bearer / API key) and
 * callers that only carry unrelated cookies (Cloudflare Access tokens,
 * analytics, etc.) bypass the check.
 */
export function hasSessionCookie(headers: Headers): boolean {
  const cookie = headers.get("cookie");
  return cookie ? SESSION_COOKIE_RE.test(cookie) : false;
}
