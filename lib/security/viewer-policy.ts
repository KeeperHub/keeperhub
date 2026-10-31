/**
 * Which state-changing API calls a viewer's session may still make.
 *
 * A viewer reads everything in the organization and changes nothing, so the
 * proxy denies every POST/PUT/PATCH/DELETE under /api/ for them by default.
 * The exemptions are the caller's own account (profile, password, MFA,
 * sessions, revoking their own webhook keys), leaving or joining an
 * organization, POSTs that only read, and endpoints that never authenticate
 * with a browser session. Better Auth's own organization endpoints stay
 * reachable because its access control rejects viewers on every org-changing
 * action.
 */

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const VIEWER_EXEMPT_EXACT_PATHS = new Set<string>([
  "/api/user",
  "/api/user/delete",
  "/api/user/display-name",
  "/api/user/forgot-password",
  "/api/user/password",
  "/api/user/verify-ip",
  "/api/user/wallet/prices",
  "/api/feedback",
  "/api/hub/view",
  "/api/web3/fetch-abi",
  "/api/gas/estimate",
]);

const VIEWER_EXEMPT_PREFIXES: readonly string[] = [
  "/api/auth/",
  "/api/user/onboarding/",
  "/api/user/sessions/",
  "/api/user/step-up/",
  "/api/user/totp/",
  "/api/user/rpc-preferences/",
  "/api/organizations/invitations/",
  "/api/oauth/",
  "/api/internal/",
  "/api/admin/",
  "/api/cron/",
  "/api/billing/webhooks/",
];

const VIEWER_EXEMPT_PATTERNS: readonly RegExp[] = [
  /^\/api\/organizations\/[^/]+\/leave$/,
  // A Hub vote is the caller's own, not a change to the organization.
  /^\/api\/workflows\/[^/]+\/rate$/,
  // Revoking one of your own webhook keys only removes access.
  /^\/api\/api-keys\/[^/]+$/,
  /^\/api\/workflows\/[^/]+\/webhook(?:\/|$)/,
  /^\/api\/mcp\/workflows\/[^/]+\/call(?:\/|$)/,
];

// Approving a CLI device login mints an API key for the active organization.
const VIEWER_BLOCKED_AUTH_PATHS = new Set<string>(["/api/auth/device/approve"]);

const ORG_PATH_PATTERN = /^\/api\/organizations\/([^/]+)(?:\/|$)/;
const NON_ORG_ID_SEGMENTS = new Set(["invitations", "circuit-breaker"]);

export const VIEWER_READ_ONLY_ERROR = {
  error: "Viewers have read-only access to this organization",
  code: "viewer_read_only",
} as const;

export function isStateChangingMethod(method: string): boolean {
  return STATE_CHANGING_METHODS.has(method.toUpperCase());
}

function normalisePath(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;
}

/** True when a viewer session may make this state-changing API call. */
export function isViewerExemptMutation(pathname: string): boolean {
  const path = normalisePath(pathname);
  if (VIEWER_BLOCKED_AUTH_PATHS.has(path)) {
    return false;
  }
  if (VIEWER_EXEMPT_EXACT_PATHS.has(path)) {
    return true;
  }
  for (const prefix of VIEWER_EXEMPT_PREFIXES) {
    if (path.startsWith(prefix)) {
      return true;
    }
  }
  for (const pattern of VIEWER_EXEMPT_PATTERNS) {
    if (pattern.test(path)) {
      return true;
    }
  }
  return false;
}

/** True when the proxy must check the caller's role before this request. */
export function requiresViewerCheck(method: string, pathname: string): boolean {
  return (
    pathname.startsWith("/api/") &&
    isStateChangingMethod(method) &&
    !isViewerExemptMutation(pathname)
  );
}

/** The organization id in an /api/organizations/<id>/... path, if any. */
export function orgIdFromPath(pathname: string): string | null {
  const match = ORG_PATH_PATTERN.exec(pathname);
  const segment = match?.[1];
  if (!segment || NON_ORG_ID_SEGMENTS.has(segment)) {
    return null;
  }
  try {
    return decodeURIComponent(segment);
  } catch {
    // A malformed escape is not an org id; the route answers it with a 404.
    return null;
  }
}
