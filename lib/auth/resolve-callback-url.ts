/**
 * Same-origin callbackURL resolver — open-redirect guard (FUNNEL-02 / 54-02).
 *
 * Social OAuth sign-in passes a `callbackURL` to the provider. If that value
 * originates from user-controlled intent.redirectTo, an attacker could supply
 * a scheme-relative or absolute URL (e.g. "//evil.com") and redirect the
 * victim post-sign-in to an attacker-controlled page.
 *
 * This function accepts only paths that are unambiguously same-origin:
 *   - Must start with exactly one "/" (scheme-relative "//" is rejected)
 *   - Must not contain "://" (rejects "https://", "http://", etc.)
 *   - Must not contain a backslash (rejects "/\evil.com", "\evil.com")
 *   - Must not contain percent-encoded double-slash (%2f%2f) or backslash (%5c)
 *     — some OAuth providers decode the callbackURL path before redirecting,
 *     which would resolve "/%2f%2fevil.com" to "//evil.com" at redirect time.
 *
 * Any value that fails these checks — including undefined or empty string —
 * is replaced with `fallbackPath`.
 */
export function resolveCallbackUrl(
  redirectTo: string | undefined,
  fallbackPath: string
): string {
  if (!redirectTo) {
    return fallbackPath;
  }

  // Must start with exactly one "/" — "//..." is scheme-relative.
  if (!redirectTo.startsWith("/") || redirectTo.startsWith("//")) {
    return fallbackPath;
  }

  // Reject embedded scheme separator (e.g. "/scan/..//evil.com://…").
  if (redirectTo.includes("://")) {
    return fallbackPath;
  }

  // Reject backslash — browsers parse "/\evil.com" as "//evil.com" on Windows.
  if (redirectTo.includes("\\")) {
    return fallbackPath;
  }

  // Reject percent-encoded double-slash ("%2f%2f") and encoded backslash ("%5c").
  // Some OAuth providers decode callbackURL paths before redirecting; a value
  // like "/%2f%2fevil.com" would resolve to "//evil.com" after normalization.
  const lower = redirectTo.toLowerCase();
  if (lower.includes("%2f%2f") || lower.includes("%5c")) {
    return fallbackPath;
  }

  return redirectTo;
}
