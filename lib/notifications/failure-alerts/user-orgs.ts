import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { member } from "@/lib/db/schema";
import {
  isFailureAlertsEnabledForOrg,
  isFailureAlertsRolloutActive,
} from "./rollout";

/** The user's organizations with alerts switched on, so pages know without asking the API. */
export async function alertsOrgIdsForUser(userId: string): Promise<string[]> {
  if (!isFailureAlertsRolloutActive()) {
    return [];
  }
  const rows = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .where(eq(member.userId, userId));
  return rows
    .map((row) => row.organizationId)
    .filter((id) => isFailureAlertsEnabledForOrg(id));
}
