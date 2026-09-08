"use client";

import { toast } from "sonner";
import { sanitizeNextPath } from "@/lib/sanitize-next-path";

/**
 * Server-side guard error codes returned by the helpers in
 * lib/middleware/owner-mfa-guard.ts. Mirrored here so the client can
 * branch UX without parsing error strings.
 */
export type GuardErrorCode =
  | "not_owner"
  | "not_admin_or_owner"
  | "mfa_not_enrolled"
  | "mfa_enrollment_required"
  | "mfa_pending";

export type GuardErrorBody = {
  error?: string;
  code?: GuardErrorCode | string;
};

type Handlers = {
  /**
   * Called when an action-scoped guard says the user must enroll TOTP
   * before doing this specific action (mfa_not_enrolled). The callsite
   * typically opens Settings -> Security so the user can self-serve.
   */
  onEnrollMfa?: () => void;
  /**
   * Called when the proxy-level mandate gate refuses any further
   * action because the account itself has no TOTP enrolled
   * (mfa_enrollment_required). The callsite typically routes to
   * /enroll-mfa, optionally with a `next` query, where the user lands
   * in an undismissable enrollment wizard.
   */
  onForceEnroll?: (currentPath: string) => void;
  /**
   * Called when the server says the session is flagged and step-up has
   * not been completed (mfa_pending). The callsite typically routes to
   * /verify-mfa, optionally with a `next` query.
   */
  onPendingMfa?: (currentPath: string) => void;
};

/**
 * Reads a 403 response from one of the gated routes and dispatches
 * the right UX. Returns true if the response was a guard error this
 * helper handled (the caller should stop, not throw or display its
 * own error). Returns false otherwise, so the caller falls through to
 * its existing error path.
 *
 * Server contract is the discriminated GuardError shape defined in
 * lib/middleware/owner-mfa-guard.ts. Anything outside that contract
 * (5xx, 400 validation errors, plain 403 without a code) is left to
 * the caller.
 */
export async function handleGuardError(
  response: Response,
  handlers: Handlers = {}
): Promise<boolean> {
  if (response.status !== 403) {
    return false;
  }
  let body: GuardErrorBody;
  try {
    body = (await response.clone().json()) as GuardErrorBody;
  } catch {
    return false;
  }
  const code = body.code;
  if (code === "mfa_not_enrolled") {
    toast.error(
      body.error ??
        "Enable two-factor authentication on your account before this action."
    );
    handlers.onEnrollMfa?.();
    return true;
  }
  if (code === "mfa_enrollment_required") {
    toast.error(
      body.error ??
        "Two-factor authentication is required on your account. Set it up to continue."
    );
    const currentPath =
      typeof window === "undefined"
        ? "/"
        : sanitizeNextPath(window.location.pathname + window.location.search);
    handlers.onForceEnroll?.(currentPath);
    return true;
  }
  if (code === "mfa_pending") {
    toast.error(
      body.error ?? "Verify your second factor to continue this action."
    );
    const currentPath =
      typeof window === "undefined"
        ? "/"
        : sanitizeNextPath(window.location.pathname + window.location.search);
    handlers.onPendingMfa?.(currentPath);
    return true;
  }
  if (code === "not_owner") {
    toast.error(
      body.error ??
        "Only an organization owner can perform this action. Ask the org owner to do it."
    );
    return true;
  }
  if (code === "not_admin_or_owner") {
    toast.error(
      body.error ??
        "Only organization admins and owners can perform this action."
    );
    return true;
  }
  return false;
}
