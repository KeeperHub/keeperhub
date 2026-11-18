import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { member, users } from "@/lib/db/schema";
import type { OrgRole } from "@/lib/organization/role-label";

export type { OrgRole } from "@/lib/organization/role-label";

/**
 * The caller's role in an organization, or null if they are not a member or
 * their account is deactivated. The single role lookup for authorization.
 */
export async function getOrgRole(
  userId: string,
  organizationId: string
): Promise<OrgRole | null> {
  const [row] = await db
    .select({ role: member.role })
    .from(member)
    .innerJoin(users, eq(member.userId, users.id))
    .where(
      and(
        eq(member.userId, userId),
        eq(member.organizationId, organizationId),
        isNull(users.deactivatedAt)
      )
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
