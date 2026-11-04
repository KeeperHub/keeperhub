import "server-only";

import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { member, users } from "@/lib/db/schema";
import { deliverableAddress } from "@/lib/notifications/deliverable-address";

// Which org members can be emailed, shared by quota warnings and failure alerts.

export type OrgMember = {
  userId: string;
  role: string;
  email: string | null;
  name: string | null;
  /** Where mail actually reaches them, or null (wallet-only, unverified). */
  deliverable: string | null;
};

/** Active members of the org (deactivated accounts keep member rows), optionally by role. */
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
      and(
        eq(member.organizationId, organizationId),
        isNull(users.deactivatedAt),
        roles ? inArray(member.role, roles) : undefined
      )
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
