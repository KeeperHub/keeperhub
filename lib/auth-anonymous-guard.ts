import { logSecurityEvent } from "@/lib/logging";

/**
 * Anonymous-user gate for sensitive account operations.
 *
 * The anonymous Better Auth plugin issues throwaway accounts (name =
 * "Anonymous", email starts with "temp-") that are intentionally
 * disposable. Letting them enroll TOTP, configure recovery codes, or
 * gate sessions on MFA is incoherent — there's no permanent identity to
 * protect, and any "second factor" they'd configure is lost the moment
 * the anonymous session expires.
 *
 * Use isAnonymousUserShape on the user object returned by
 * auth.api.getSession to decide whether to refuse a request or hide a
 * setting from the UI.
 */
export function isAnonymousUserShape(user: {
  email?: string | null;
  name?: string | null;
  isAnonymous?: boolean | null;
}): boolean {
  if (user.isAnonymous === true) {
    return true;
  }
  if (user.name === "Anonymous") {
    return true;
  }
  if (typeof user.email === "string" && user.email.startsWith("temp-")) {
    return true;
  }
  return false;
}

/**
 * Emits the security telemetry for a refused anonymous principal. Best-effort
 * and never throws, mirroring the deactivated-login signal so abuse of the
 * free-compute path surfaces in the same dashboards.
 */
export function logAnonymousExecutionBlock(
  surface: string,
  userId: string | null | undefined,
  extra?: Record<string, string>
): void {
  logSecurityEvent(
    "anonymous_execution_blocked",
    { surface, userId: userId ?? null, ...extra },
    {
      tags: { security: "anonymous_execution_blocked", surface },
      user: userId ? { id: userId } : undefined,
      extra,
    }
  );
}
