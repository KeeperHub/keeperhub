import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, users } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";

/**
 * Fire-once bookkeeping for the signup channels (Discord webhook, MailerLite).
 *
 * `isFreshSignup` bounds how stale a re-event can be, but it cannot make the
 * send happen once: `afterEmailVerification` fires on every `verifyEmail`, so
 * a user who re-verifies several times inside the window announces themselves
 * several times. This lives apart from the guard so that module stays free of
 * database imports.
 */

/** How the account authenticated, as reported on the signup notification. */
export type SignupMethod = "GitHub" | "Google" | "Email" | "Wallet" | "OAuth";

const PROVIDER_METHODS: Record<string, SignupMethod> = {
  github: "GitHub",
  google: "Google",
  credential: "Email",
  siwe: "Wallet",
};

/**
 * Claim the right to announce this account. The conditional update means
 * exactly one caller ever observes the transition, whichever hook reaches it
 * first and even when two verifications land concurrently.
 *
 * Returns false when the account was already announced, when the row is gone,
 * or when the write fails. Failing closed is deliberate: a missed notification
 * is a smaller problem than the duplicate ones being fixed here.
 */
export async function claimSignupNotification(
  userId: string
): Promise<boolean> {
  try {
    const claimed = await db
      .update(users)
      .set({ signupNotifiedAt: new Date() })
      .where(and(eq(users.id, userId), isNull(users.signupNotifiedAt)))
      .returning({ id: users.id });
    return claimed.length > 0;
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[SignupNotification] Failed to claim signup notification",
      error,
      { user_id: userId }
    );
    return false;
  }
}

/**
 * Name the provider the account actually authenticated with.
 *
 * The previous derivation was `user.image ? "OAuth" : "Email"`, so any account
 * carrying an avatar reported OAuth regardless of the flow that ran. Read the
 * account row instead. `fallback` covers the ordering window on OAuth signup
 * where the user row exists before its account row does.
 */
export async function resolveSignupMethod(
  userId: string,
  fallback: SignupMethod
): Promise<SignupMethod> {
  try {
    const rows = await db
      .select({ providerId: accounts.providerId })
      .from(accounts)
      .where(eq(accounts.userId, userId));
    for (const row of rows) {
      const method = PROVIDER_METHODS[row.providerId];
      if (method) {
        return method;
      }
    }
    return fallback;
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[SignupNotification] Failed to resolve signup method",
      error,
      { user_id: userId }
    );
    return fallback;
  }
}
