/**
 * KEEP-612: detection helper for the sessions backstop trigger installed in
 * migration 0090 (block_sessions_for_deactivated_users). The trigger raises
 * SQLSTATE 'KH001' with a fixed message when a session insert is attempted
 * for a deactivated user.
 *
 * The session.create.before hook in lib/auth.ts is the primary gate and
 * normally prevents the insert; KH001 only fires when that gate is bypassed
 * (a new OAuth provider, a direct session insert, a hook regression) -- a
 * fired backstop means the app path was bypassed, which is exactly what the
 * detection layer pages on.
 *
 * Better Auth wraps adapter errors before they reach onAPIError, so the
 * postgres SQLSTATE may sit on a nested `cause` rather than the top-level
 * error. We walk the cause chain (bounded) and, as a last resort, match the
 * trigger's fixed RAISE message in case a wrapper normalised the SQLSTATE
 * away entirely. Kept dependency-free so it is unit-testable without
 * constructing the Better Auth config.
 */

import { logSecurityEvent } from "@/lib/logging";

export const KH001_SQLSTATE = "KH001";

// Owned by migration 0090's RAISE EXCEPTION message. Keep in sync if the
// trigger text changes.
export const KH001_MESSAGE_FRAGMENT = "Session owner is deactivated";

const MAX_CAUSE_DEPTH = 5;

export function isKh001SessionBackstop(error: unknown): boolean {
  let current: unknown = error;
  for (
    let depth = 0;
    depth < MAX_CAUSE_DEPTH && current && typeof current === "object";
    depth++
  ) {
    const code = (current as { code?: unknown }).code;
    if (code === KH001_SQLSTATE) {
      return true;
    }
    const message = (current as { message?: unknown }).message;
    if (
      typeof message === "string" &&
      message.includes(KH001_MESSAGE_FRAGMENT)
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * If `error` is a KH001 sessions-backstop reject, emit the detection signal
 * (Sentry + structured stdout) and return true. No-op + false otherwise.
 *
 * Called from the Better Auth `onAPIError` handler in lib/auth.ts. Extracted
 * here so the emit wiring -- not just the predicate -- is unit-testable
 * without constructing the Better Auth config. Best-effort: a Sentry
 * transport failure never propagates (the caller is an error handler).
 */
export function reportSessionBackstop(error: unknown): boolean {
  if (!isKh001SessionBackstop(error)) {
    return false;
  }
  logSecurityEvent("backstop_session_blocked", undefined, {
    tags: { security: "backstop_session_blocked", surface: "session" },
  });
  return true;
}
