import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

/**
 * Better Auth's OAuth callback flow has no built-in awareness of our
 * users.deactivated_at column. The default behaviour, when a deactivated
 * user signs back in via Google or GitHub, is:
 *   1. accounts row lookup by (provider, account_id) -- may miss if we
 *      wiped it during incident response.
 *   2. fallback match by email -- finds the existing users row.
 *   3. fresh accounts row gets created linking provider back to user.
 *   4. fresh sessions row gets created.
 *
 * Step 4 hands the deactivated account a live session cookie. Mirror the
 * deactivation gate that already exists in authenticateApiKey and
 * authenticateOAuthToken (MCP) so every auth path closes the same hole.
 *
 * Returning false from a Better Auth `databaseHooks.*.create.before` hook
 * aborts the write. We use that contract directly so the call sites can
 * stay thin.
 */
export async function isUserDeactivated(userId: string): Promise<boolean> {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { deactivatedAt: true },
  });
  return Boolean(user?.deactivatedAt);
}
