import { eq } from "drizzle-orm";
import { isWalletEmail } from "@/lib/auth/wallet-constants";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

/**
 * The address that should receive security / account notification mail for a
 * user.
 *
 * Email/TOTP accounts use their login email. Wallet (SIWE) accounts have a
 * synthetic, undeliverable login identity (`<address>@wallet.keeperhub.com`),
 * so they are notified at the verified step-up email they enrolled
 * (`users.stepUpEmail`). Wallet users who have not enrolled an email have no
 * deliverable address, so this returns null and the caller skips sending.
 */
export async function getDeliverableEmail(
  userId: string,
  loginEmail: string | null | undefined
): Promise<string | null> {
  if (!isWalletEmail(loginEmail)) {
    return loginEmail ?? null;
  }
  const [row] = await db
    .select({ stepUpEmail: users.stepUpEmail })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.stepUpEmail ?? null;
}
