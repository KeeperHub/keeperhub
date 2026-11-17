import "server-only";

import { inArray } from "drizzle-orm";
import { walletAddressFromEmail } from "@/lib/auth/wallet-constants";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

/** The account each user signed in with: their email, or the wallet address for a wallet login. */
export async function signInAccounts(
  userIds: string[]
): Promise<Map<string, string>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(inArray(users.id, ids));
  return new Map(
    rows.flatMap((row) => {
      if (!row.email) {
        return [];
      }
      const account = walletAddressFromEmail(row.email) ?? row.email;
      return [[row.id, account] as const];
    })
  );
}
