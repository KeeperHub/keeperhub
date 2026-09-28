import "server-only";

import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { executionRetentionProgress } from "@/lib/db/schema";
import type { RetentionConfig } from "@/lib/retention/config";

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
 *
 * GREATEST, so the watermark can only ever move forward. The plan-window pass
 * clamps the value it writes to the oldest run it had to skip, which means two
 * consecutive runs can legitimately try to write different instants for the
 * same organization; taking the larger keeps the claim monotonic. The claim is
 * read by the analytics layer as "this is what has actually been removed", so
 * it must never overstate, and lowering it later would strand rows below it.
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
      set: {
        executionsPurgedThrough: sql`GREATEST(${executionRetentionProgress.executionsPurgedThrough}, excluded.executions_purged_through)`,
        updatedAt: sql`now()`,
      },
    });
}

/**
 * Raise every organization's watermark to the instant the floor pass has
 * cleared. The floor pass carries no organization scope and no resumable-status
 * guard, so once it drains, "no step log of any organization survives before
 * this instant" is a fact about rows rather than a prediction from a plan.
 *
 * Two things depend on it. An organization whose window is at or above the
 * floor never enters the per-organization pass at all, so this is the only
 * place it ever gets a watermark - and without one the analytics layer cannot
 * tell a customer what was removed. And it bounds the clamp below: a run stuck
 * in a resumable status holds its organization's watermark at its own
 * `started_at`, but only until the floor pass deletes its logs outright.
 */
export async function advanceWatermarksToFloor(through: Date): Promise<void> {
  // sql.param, not a bare Date. postgres.js has no encoder for a raw JS Date in
  // a template hole and throws ERR_INVALID_ARG_TYPE on the whole statement;
  // binding it through the column carries the timestamp type mapper.
  const cutoff = sql.param(
    through,
    executionRetentionProgress.executionsPurgedThrough
  );
  await db.execute(sql`
    INSERT INTO execution_retention_progress (organization_id, executions_purged_through, updated_at)
    SELECT id, ${cutoff}, now() FROM organization
    ON CONFLICT (organization_id) DO UPDATE
      SET executions_purged_through = GREATEST(
            execution_retention_progress.executions_purged_through,
            excluded.executions_purged_through
          ),
          updated_at = now()
    WHERE execution_retention_progress.executions_purged_through < excluded.executions_purged_through
  `);
}

/**
 * The instant before which this organization's step logs really have been
 * removed, or null when nothing has been removed at all.
 *
 * Step logs age out at the plan window while the run row lives far longer, so a
 * run can legitimately be listed with no steps behind it, and a reader has to
 * tell "this run recorded nothing" from "this is older than what we kept".
 *
 * This answers that from the watermark rather than from the plan, because the
 * plan is a prediction and the watermark is a record. The job ships off in
 * production and dry on staging: a plan-derived answer would tell a customer
 * their data was removed while every row was still sitting in the table. It
 * also cannot run ahead of the job -- a backlog still draining, an organization
 * the runtime budget has not reached yet, or a window that was widened
 * yesterday all report the instant actually reached, not the intended one.
 */
export async function getOrgLogRetentionCutoff(
  organizationId: string,
  config: RetentionConfig
): Promise<Date | null> {
  if (!config.enabled || config.dryRun) {
    return null;
  }
  const rows = await db
    .select({
      executionsPurgedThrough:
        executionRetentionProgress.executionsPurgedThrough,
    })
    .from(executionRetentionProgress)
    .where(eq(executionRetentionProgress.organizationId, organizationId))
    .limit(1);

  return rows[0]?.executionsPurgedThrough ?? null;
}
