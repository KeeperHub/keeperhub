import "server-only";

import { and, asc, count, inArray, lt } from "drizzle-orm";
import { db } from "@/lib/db";
import { RunBudget, runBatched } from "@/lib/retention/batched";
import { daysBefore } from "@/lib/retention/config";
import {
  type DevkitRetentionConfig,
  getDevkitRetentionConfig,
} from "@/lib/retention/devkit-config";
import {
  devkitEvents,
  devkitRuns,
  devkitSteps,
} from "@/lib/retention/devkit-tables";

/**
 * Run statuses the DevKit runtime treats as final. On a run in one of them it
 * refuses to create a new step, hook or wait, and refuses any further run
 * transition. A run in any other status keeps its event log at any age,
 * because that log is what the runtime replays to resume the run.
 */
export const FINISHED_RUN_STATUSES = [
  "completed",
  "failed",
  "cancelled",
] as const;

function finishedRunsBefore(cutoff: Date) {
  return and(
    lt(devkitRuns.createdAt, cutoff),
    inArray(devkitRuns.status, [...FINISHED_RUN_STATUSES])
  );
}

/**
 * One page of finished runs created before `cutoff`, oldest first. Exported so
 * the database suite can EXPLAIN the exact SQL this job sends.
 */
export function selectRunBatch(cutoff: Date, limit: number) {
  return db
    .select({ id: devkitRuns.id })
    .from(devkitRuns)
    .where(finishedRunsBefore(cutoff))
    .orderBy(asc(devkitRuns.createdAt))
    .limit(limit);
}

export type DevkitRetentionResult = {
  enabled: boolean;
  dryRun: boolean;
  retentionDays: number;
  durationMs: number;
  /** Runs deleted, or runs past the window in a dry run. */
  runs: number;
  /** Steps deleted with those runs. Always 0 in a dry run. */
  steps: number;
  /** Events deleted with those runs. Always 0 in a dry run. */
  events: number;
  /** True when the runtime budget stopped the job before it drained. */
  budgetExhausted: boolean;
};

/**
 * Delete finished Workflow DevKit runs older than the window, together with
 * their steps and events.
 *
 * @workflow/world-postgres ships no age-based cleanup, so without this the
 * `workflow` schema only ever grows. The tables in it carry no foreign keys, so
 * nothing cascades: each batch deletes the events and steps of its runs before
 * the runs themselves, in one transaction, so a run row never outlives the
 * deletion of its children and a failed batch leaves nothing half-deleted.
 *
 * The job is driven by the runs. The batch select walks the created_at index
 * on workflow_runs, and the child deletes use the run_id indexes the DevKit
 * bootstrap already creates on workflow_steps and workflow_events.
 */
export async function runDevkitRetentionPurge(
  config: DevkitRetentionConfig = getDevkitRetentionConfig(),
  now: Date = new Date()
): Promise<DevkitRetentionResult> {
  const startedAt = Date.now();

  if (!config.enabled) {
    return {
      enabled: false,
      dryRun: config.dryRun,
      retentionDays: config.retentionDays,
      durationMs: 0,
      runs: 0,
      steps: 0,
      events: 0,
      budgetExhausted: false,
    };
  }

  const cutoff = daysBefore(now, config.retentionDays);
  let steps = 0;
  let events = 0;

  const result = await runBatched({
    pass: "devkit_runs",
    config,
    budget: new RunBudget(config.maxRuntimeMs),
    selectIds: (limit) => selectRunBatch(cutoff, limit),
    countEligible: async () =>
      (
        await db
          .select({ n: count() })
          .from(devkitRuns)
          .where(finishedRunsBefore(cutoff))
      )[0].n,
    apply: async (ids) => {
      const deleted = await db.transaction(async (tx) => {
        const deletedEvents = await tx
          .delete(devkitEvents)
          .where(inArray(devkitEvents.runId, ids))
          .returning({ id: devkitEvents.id });
        const deletedSteps = await tx
          .delete(devkitSteps)
          .where(inArray(devkitSteps.runId, ids))
          .returning({ id: devkitSteps.stepId });
        await tx.delete(devkitRuns).where(inArray(devkitRuns.id, ids));
        return { events: deletedEvents.length, steps: deletedSteps.length };
      });
      // Counted only once the transaction has committed.
      events += deleted.events;
      steps += deleted.steps;
    },
  });

  return {
    enabled: true,
    dryRun: config.dryRun,
    retentionDays: config.retentionDays,
    durationMs: Date.now() - startedAt,
    runs: result.rows,
    steps,
    events,
    budgetExhausted: result.budgetExhausted,
  };
}
