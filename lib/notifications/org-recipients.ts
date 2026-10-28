import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { member, users } from "@/lib/db/schema";
import { deliverableAddress } from "@/lib/notifications/deliverable-address";

/**
 * Who in an organization can be emailed, shared by every notification that
 * goes to members (execution-quota warnings, workflow failure alerts).
 */

export type OrgMember = {
  userId: string;
  role: string;
  email: string | null;
  name: string | null;
  /** Where mail actually reaches them, or null (wallet-only, unverified). */
  deliverable: string | null;
};

/** Members of the org, optionally only those with one of these roles. */
export async function loadOrgMembers(
  organizationId: string,
  roles?: string[]
): Promise<OrgMember[]> {
  const rows = await db
    .select({
      userId: member.userId,
      role: member.role,
      email: users.email,
      emailVerified: users.emailVerified,
      stepUpEmail: users.stepUpEmail,
      name: users.name,
    })
    .from(member)
    .innerJoin(users, eq(users.id, member.userId))
    .where(
      roles
        ? and(
            eq(member.organizationId, organizationId),
            inArray(member.role, roles)
          )
        : eq(member.organizationId, organizationId)
    );
  return rows.map((row) => ({
    userId: row.userId,
    role: row.role,
    email: row.email,
    name: row.name,
    deliverable: deliverableAddress(row),
  }));
}

/** The distinct addresses mail can reach, in member order. */
export function reachableEmails(members: OrgMember[]): string[] {
  return [
    ...new Set(
      members
        .map((m) => m.deliverable)
        .filter((email): email is string => Boolean(email))
    ),
  ];
}
