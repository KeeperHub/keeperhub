/**
 * Whitelists a string before it can be used as a post-auth redirect
 * target (the `?next=` param on /verify-mfa, /verify-ip, /enroll-mfa,
 * and the `redirect` field on every pending-OAuth cookie payload).
 *
 * Rejects:
 *   - non-strings, empty strings
 *   - anything not starting with "/" (blocks absolute URLs and
 *     "javascript:" / "data:" payloads)
 *   - protocol-relative URLs like "//evil.com/path"
 *   - backslash-bearing paths (some browsers normalise to "/")
 *   - paths whose first segment is an internal Next.js / Sentry
 *     surface that should never be a user-visible destination
 *     (Sentry tunnel `/monitoring`, `/api/`, `/_next/`, ...)
 *   - percent-encoded versions of any of the above
 *   - parent-traversal segments (`..`)
 *
 * Anything rejected falls back to "/" so the worst case is "user
 * lands on the home page after sign-in", never "user lands on a
 * dead-end internal endpoint that 404s with their URL still pinned".
 */

const FORBIDDEN_PREFIXES: readonly string[] = [
  "/monitoring", // Sentry tunnel (next.config.ts: tunnelRoute)
  "/api/",
  "/_next/",
  "/__nextjs_",
];

const FORBIDDEN_PATHS: ReadonlySet<string> = new Set(["/404", "/500"]);

const QUERY_OR_FRAGMENT = /[?#]/;

function isForbidden(pathOnly: string): boolean {
  for (const prefix of FORBIDDEN_PREFIXES) {
    if (pathOnly === prefix || pathOnly.startsWith(`${prefix}/`)) {
      return true;
    }
    // Bare prefix without trailing slash: /monitoring?... still matches
    if (
      pathOnly.startsWith(prefix) &&
      pathOnly.length > prefix.length &&
      pathOnly[prefix.length] !== "/"
    ) {
      // Only true if the prefix ends with something that isn't part of
      // a longer route segment. /monitoring is short enough to stand
      // alone, /api/ already includes the trailing slash. Treat any
      // exact prefix match as forbidden so /monitoring?... is caught.
      return true;
    }
  }
  return FORBIDDEN_PATHS.has(pathOnly);
}

export function sanitizeNextPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    return "/";
  }
  if (!value.startsWith("/")) {
    return "/";
  }
  if (value.startsWith("//")) {
    return "/";
  }
  if (value.includes("\\")) {
    return "/";
  }

  const queryIdx = value.search(QUERY_OR_FRAGMENT);
  const pathOnly = queryIdx === -1 ? value : value.slice(0, queryIdx);

  if (pathOnly.split("/").includes("..")) {
    return "/";
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathOnly);
  } catch {
    return "/";
  }

  if (isForbidden(pathOnly) || isForbidden(decoded)) {
    return "/";
  }

  return value;
}
