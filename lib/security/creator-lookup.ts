import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { member, users } from "@/lib/db/schema";

export type ActivityCreator = {
  name: string | null;
  email: string | null;
  role: string | null;
};

/**
 * Resolve creator name/email and org role for a set of user ids so the
 * activity-history fallback can attribute a pre-audit "created" entry to
 * whoever created the resource. Returns a map keyed by user id.
 */
export async function loadCreators(
  userIds: Array<string | null>,
  organizationId: string
): Promise<Map<string, ActivityCreator>> {
  const ids = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: member.role,
    })
    .from(users)
    .leftJoin(
      member,
      and(
        eq(member.userId, users.id),
        eq(member.organizationId, organizationId)
      )
    )
    .where(inArray(users.id, ids));
  return new Map(
    rows.map((r) => [r.id, { name: r.name, email: r.email, role: r.role }])
  );
}
