import { isWalletEmail } from "@/lib/auth/wallet-constants";

/**
 * Detects anonymous/temporary users by checking name and email patterns.
 * Works with session user objects, API responses, or any object with name/email.
 */
export function isAnonymousUser(
  user: { name?: string | null; email?: string | null } | null | undefined
): boolean {
  if (!user) {
    return true;
  }
  return (
    user.name === "Anonymous" ||
    Boolean(user.email?.includes("@http://")) ||
    Boolean(user.email?.includes("@https://")) ||
    Boolean(user.email?.startsWith("temp-"))
  );
}

type SessionLike = {
  user?: {
    name?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
  } | null;
} | null;

/**
 * True when the visitor should still be guided to sign in: either anonymous or
 * signed up but not yet email-verified. Mirrors the condition that renders the
 * Sign In button in components/workflows/user-menu.tsx.
 *
 * Wallet (SIWE) users have a synthetic email and no real inbox to verify, so
 * emailVerified may be false even though they are fully authenticated.
 */
export function isNewUserSession(session: SessionLike | undefined): boolean {
  const user = session?.user;
  if (isWalletEmail(user?.email)) {
    return false;
  }
  return isAnonymousUser(user) || user?.emailVerified !== true;
}
