import { eq } from "drizzle-orm";
import { isWalletEmail } from "@/lib/auth/wallet-constants";
import { db } from "@/lib/db";
import { accounts, users } from "@/lib/db/schema";
import { isAnonymousUser } from "@/lib/is-anonymous";

/**
 * The authentication kind of an account. This is the single axis the MFA /
 * step-up authorization branches on, so it lives in one place instead of being
 * re-derived (isWalletEmail / providerId / isAnonymous) per route.
 */
export type AccountKind = "wallet" | "oauth" | "email" | "anonymous";

/**
 * OAuth providers KeeperHub supports. Single source for the list previously
 * duplicated across the user / password routes.
 */
export const OAUTH_PROVIDERS = ["github", "google"] as const;

/**
 * Classify an account from already-loaded fields. Pure, no DB.
 *
 * Order matters and earlier wins: anonymous, then wallet (synthetic SIWE
 * email), then OAuth (by providerId), else email/password. When `providerId`
 * is not supplied an OAuth account cannot be told apart from an email account
 * and is reported as "email" -- fine for callers that only branch on
 * wallet-vs-not (the authorization guard); use `getAccountKind` when the
 * precise oauth/email split matters (e.g. settings UI).
 */
export function classifyAccountKind(input: {
  email: string | null | undefined;
  name?: string | null;
  isAnonymous?: boolean | null;
  providerId?: string | null;
}): AccountKind {
  if (input.isAnonymous === true || isAnonymousUser(input)) {
    return "anonymous";
  }
  if (isWalletEmail(input.email) || input.providerId === "siwe") {
    return "wallet";
  }
  if (
    input.providerId &&
    (OAUTH_PROVIDERS as readonly string[]).includes(input.providerId)
  ) {
    return "oauth";
  }
  return "email";
}

/**
 * Server-side: load the one account row needed to classify precisely
 * (oauth vs email), combined with the user's anonymity / wallet markers.
 */
export async function getAccountKind(userId: string): Promise<AccountKind> {
  const [user] = await db
    .select({
      email: users.email,
      name: users.name,
      isAnonymous: users.isAnonymous,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) {
    return "anonymous";
  }
  const account = await db.query.accounts.findFirst({
    where: eq(accounts.userId, userId),
    columns: { providerId: true },
  });
  return classifyAccountKind({
    email: user.email,
    name: user.name,
    isAnonymous: user.isAnonymous,
    providerId: account?.providerId ?? null,
  });
}
