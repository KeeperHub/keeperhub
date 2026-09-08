import "server-only";

import { inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { executionRetentionProgress } from "@/lib/db/schema";

/**
 * KEEP-1042: the per-organization watermark the step-log purge resumes from.
 *
 * Read once per run for every organization the run will touch, then written
 * back only when that organization's range has fully drained. Advancing only on
 * a full drain is what makes an interrupted run resume instead of skipping: the
 * runtime budget can cut a run off mid-organization, and the next run has to
 * start from the same place rather than from wherever it happened to stop.
 */

/** Everything before this is treated as unpurged on the first ever run. */
export const RETENTION_EPOCH = new Date(0);

export async function getPurgeWatermarks(
  organizationIds: string[]
): Promise<Map<string, Date>> {
  if (organizationIds.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({
      organizationId: executionRetentionProgress.organizationId,
      executionsPurgedThrough:
        executionRetentionProgress.executionsPurgedThrough,
    })
    .from(executionRetentionProgress)
    .where(inArray(executionRetentionProgress.organizationId, organizationIds));

  return new Map(
    rows.map((row) => [row.organizationId, row.executionsPurgedThrough])
  );
}

/**
 * Record that every execution of this organization started before `through`
 * has had its step logs removed. Upsert rather than insert: an organization is
 * written once per run for as long as it keeps producing work.
 */
export async function setPurgeWatermark(
  organizationId: string,
  through: Date
): Promise<void> {
  await db
    .insert(executionRetentionProgress)
    .values({ organizationId, executionsPurgedThrough: through })
    .onConflictDoUpdate({
      target: executionRetentionProgress.organizationId,
      set: { executionsPurgedThrough: through, updatedAt: sql`now()` },
    });
}
