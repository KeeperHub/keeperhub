import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { member } from "@/lib/db/schema";

export type OrgRole = "owner" | "admin" | "member";

/**
 * The caller's role in an organization, or null if they are not a member.
 * Used to gate audit-trail / history reads, which (for now) are limited to
 * organization owners and admins.
 */
export async function getOrgRole(
  userId: string,
  organizationId: string
): Promise<OrgRole | null> {
  const [row] = await db
    .select({ role: member.role })
    .from(member)
    .where(
      and(eq(member.userId, userId), eq(member.organizationId, organizationId))
    )
    .limit(1);
  if (!row) {
    return null;
  }
  return row.role as OrgRole;
}

/** Owners and admins can see audit trails / history. Members cannot (yet). */
export async function isOrgAdmin(
  userId: string,
  organizationId: string
): Promise<boolean> {
  const role = await getOrgRole(userId, organizationId);
  return role === "owner" || role === "admin";
}
