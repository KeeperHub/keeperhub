import "server-only";

import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db";
import { workflowExecutions, workflowFailureIncidents } from "@/lib/db/schema";
import { REFUSAL_GROUP_MS } from "./constants";

// Refused incidents of one org with one reason category (e.g. a plan's run
// limit) share one alert, one page, one reminder and one recovery.

export type RefusedMember = {
  id: string;
  workflowId: string;
  openedAt: Date;
  lastFailedAt: Date;
};

type Reader = Tx | typeof db;

/** The category of the refusal an incident stores (billing, configuration). */
export async function refusalCategoryOf(
  executionId: string | null,
  reader: Reader = db
): Promise<string | null> {
  if (!executionId) {
    return null;
  }
  const [run] = await reader
    .select({ errorCategory: workflowExecutions.errorCategory })
    .from(workflowExecutions)
    .where(eq(workflowExecutions.id, executionId))
    .limit(1);
  return run?.errorCategory ?? null;
}

/** Open refused incidents of the org whose newest refusal has this category, oldest first. */
export async function openRefusedGroup(
  organizationId: string,
  category: string | null,
  reader: Reader = db
): Promise<RefusedMember[]> {
  return await reader
    .select({
      id: workflowFailureIncidents.id,
      workflowId: workflowFailureIncidents.workflowId,
      openedAt: workflowFailureIncidents.openedAt,
      lastFailedAt: workflowFailureIncidents.lastFailedAt,
    })
    .from(workflowFailureIncidents)
    .innerJoin(
      workflowExecutions,
      eq(workflowExecutions.id, workflowFailureIncidents.lastFailedExecutionId)
    )
    .where(
      and(
        eq(workflowFailureIncidents.organizationId, organizationId),
        eq(workflowFailureIncidents.openedBy, "refused"),
        isNull(workflowFailureIncidents.resolvedAt),
        sql`${workflowExecutions.errorCategory} IS NOT DISTINCT FROM ${category}`
      )
    )
    .orderBy(
      asc(workflowFailureIncidents.openedAt),
      asc(workflowFailureIncidents.id)
    );
}

/** Opened while an earlier member was open, within a day of it: told about in that one's messages. */
export function isQuietMember(
  member: Pick<RefusedMember, "id" | "openedAt">,
  group: Pick<RefusedMember, "id" | "openedAt">[]
): boolean {
  const at = member.openedAt.getTime();
  return group.some((other) => {
    const otherAt = other.openedAt.getTime();
    const earlier = otherAt < at || (otherAt === at && other.id < member.id);
    return other.id !== member.id && earlier && at - otherAt < REFUSAL_GROUP_MS;
  });
}

/** What a member's messages list: itself and the quiet members after it, up to the next one that speaks. */
export function listedWith(
  member: RefusedMember,
  group: RefusedMember[]
): RefusedMember[] {
  if (isQuietMember(member, group)) {
    return [];
  }
  const start = group.findIndex((other) => other.id === member.id);
  const listed = [member];
  if (start < 0) {
    return listed;
  }
  for (const other of group.slice(start + 1)) {
    if (!isQuietMember(other, group)) {
      break;
    }
    listed.push(other);
  }
  return listed;
}
