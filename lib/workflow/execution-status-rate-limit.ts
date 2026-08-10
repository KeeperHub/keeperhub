import "server-only";

import {
  checkIpRateLimit,
  getClientIp,
  type RateLimitResult,
} from "@/lib/mcp/rate-limit";
import type { DualAuthContext } from "@/lib/middleware/auth-helpers";

/** Anonymous / invalid-token share polls, keyed per IP per pod. */
export const EXEC_STATUS_ANON_IP_LIMIT = 60;
/**
 * Session / kh_ / OAuth callers, keyed per principal per pod.
 *
 * Sized against what the app itself generates, not against a round number: the
 * canvas polls this exact endpoint every 500 ms while a run is in flight
 * (components/workflow/workflow-toolbar.tsx, app/workflows/[workflowId]/page.tsx),
 * i.e. 120 requests/min per open workflow tab. 1200 leaves room for ten
 * concurrent tabs before a real user is throttled; their pollers only
 * console.error on failure, so tripping this reads as a permanently frozen run.
 */
export const EXEC_STATUS_AUTH_LIMIT = 1200;
export const EXEC_STATUS_WINDOW_MS = 60_000;

/**
 * Always-on rate limit for execution status share surfaces (JSON + HTML).
 *
 * Authenticated callers are bucketed by principal, not by IP. Bucketing them by
 * IP put teammates behind one office NAT, one user's several tabs, and every
 * in-pod MCP call (which carries no forwarded-for header and so keys as the
 * literal "unknown") into a single shared budget nobody could stay under.
 * Anonymous callers still key on IP - that is the enumeration surface the limit
 * exists for, and there is no principal to key on.
 *
 * Takes the already-resolved auth context so a request resolves auth once.
 */
export function checkExecutionStatusRateLimit(
  request: Request,
  authContext: DualAuthContext
): RateLimitResult {
  const principal = resolvePrincipalKey(authContext);
  if (principal) {
    return checkIpRateLimit(
      `exec-status:auth:${principal}`,
      EXEC_STATUS_AUTH_LIMIT,
      EXEC_STATUS_WINDOW_MS
    );
  }
  return checkIpRateLimit(
    `exec-status:anon:${getClientIp(request)}`,
    EXEC_STATUS_ANON_IP_LIMIT,
    EXEC_STATUS_WINDOW_MS
  );
}

/**
 * Per-user where a user resolved, else per-organization for API-key callers
 * that carry no user. A failed credential resolves to neither and falls back
 * to the anonymous IP bucket, so a garbage Bearer can never buy the higher
 * budget.
 */
function resolvePrincipalKey(authContext: DualAuthContext): string | null {
  if ("error" in authContext) {
    return null;
  }
  if (authContext.userId) {
    return `user:${authContext.userId}`;
  }
  if (authContext.organizationId) {
    return `org:${authContext.organizationId}`;
  }
  return null;
}
