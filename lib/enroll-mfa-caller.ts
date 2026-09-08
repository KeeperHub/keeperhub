import { auth } from "@/lib/auth";
import { isAnonymousUserShape } from "@/lib/auth-anonymous-guard";
import {
  decodePendingSignupCookie,
  readPendingSignupCookie,
} from "@/lib/pending-signup-cookie";

/**
 * /api/user/totp/setup and /api/user/totp/enroll accept TWO auth
 * shapes:
 *
 *   - sessioned: a normal Better Auth session cookie. Used by
 *     existing users who haven't enrolled yet (the "force-enroll on
 *     every request" proxy path) and by users rotating an
 *     authenticator from the manage dialog.
 *
 *   - pending-signup: a signed pending_signup_mfa cookie set during
 *     the credential/OAuth signup intercept. No session row exists
 *     yet. The session is minted for the first time inside the
 *     enroll route on successful verify.
 *
 * This helper resolves "who is calling?" from whichever auth shape
 * is on the request. The caller doesn't need to know which one was
 * used unless it cares about minting the session at completion (only
 * the enroll route does that, when `pendingSignupPayload` is set).
 */

export type EnrollMfaCaller =
  | { kind: "session"; userId: string; email: string }
  | {
      kind: "pending-signup";
      userId: string;
      email: string;
      redirect: string;
    }
  | { kind: "anonymous"; reason: "no_auth" | "anonymous_user" | "no_email" };

export async function resolveEnrollMfaCaller(
  headers: Headers
): Promise<EnrollMfaCaller> {
  const secret = process.env.BETTER_AUTH_SECRET;

  if (secret) {
    const pendingValue = readPendingSignupCookie(headers);
    if (pendingValue) {
      const decoded = decodePendingSignupCookie(pendingValue, secret);
      if (decoded.ok) {
        return {
          kind: "pending-signup",
          userId: decoded.payload.userId,
          email: decoded.payload.email,
          redirect: decoded.payload.redirect,
        };
      }
    }
  }

  const session = await auth.api.getSession({ headers });
  if (!session?.user) {
    return { kind: "anonymous", reason: "no_auth" };
  }
  if (isAnonymousUserShape(session.user)) {
    return { kind: "anonymous", reason: "anonymous_user" };
  }
  if (!session.user.email) {
    return { kind: "anonymous", reason: "no_email" };
  }
  return {
    kind: "session",
    userId: session.user.id,
    email: session.user.email,
  };
}
