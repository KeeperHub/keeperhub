import "server-only";

import { and, eq, gte, inArray, isNotNull, lt, notInArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  workflowExecutionLogs,
  workflowExecutions,
  workflows,
} from "@/lib/db/schema";
import { paygPayments } from "@/lib/db/schema-extensions";
import { feedback } from "@/lib/db/schema-feedback";
import { workflowPayments } from "@/lib/db/schema-payments";
import type { WorkflowExecutionStatus } from "@/lib/errors/execution-status";
import {
  daysBefore,
  getRetentionConfig,
  type RetentionConfig,
} from "@/lib/retention/config";
import {
  groupByRetentionWindow,
  resolveOrgRetentionWindows,
} from "@/lib/retention/org-windows";

/**
 * Statuses a run can still be picked up from. Their step logs carry
 * `output_raw`, the executor's authoritative resume input
 * (lib/workflow/executor/get-completed-step-output.step.ts), so neither the
 * plan-window pass nor the output_raw pass may touch them at any age. Typed
 * against WorkflowExecutionStatus so a new status forces a decision here.
 *
 * The 400-day floor and flat passes deliberately do NOT apply this guard. A run
 * that has sat in `running` for more than a year is not resumable by any
 * definition -- the reaper closes a stuck run after 30 minutes -- and skipping
 * those rows would leak them forever, which is the failure this job exists to
 * end.
 */
const RESUMABLE_EXECUTION_STATUSES: readonly WorkflowExecutionStatus[] = [
  "pending",
  "running",
  "phantom",
  "unconfirmed",
];

/**
 * Executions scanned per statement in the per-execution pass. One execution
 * carries several step logs, so the row count a batch touches is a multiple of
 * this; keeping it well under `batchSize` holds a single statement inside the
 * pool's statement_timeout. The CronJob calls into the app pods, so the bound
 * is APP_STATEMENT_TIMEOUT_MS (30s), not the 120s role-level backstop.
 */
function executionBatchSize(config: RetentionConfig): number {
  return Math.max(50, Math.floor(config.batchSize / 10));
}

export type RetentionPassName =
  | "logs_floor"
  | "logs_plan_window"
  | "output_raw"
  | "logs_soft_deleted"
  | "executions_flat_window";

export type RetentionPassResult = {
  pass: RetentionPassName;
  /** Rows deleted, or nulled for the output_raw pass. Candidates in a dry run. */
  rows: number;
  /** True when the runtime budget stopped this pass before it drained. */
  budgetExhausted: boolean;
};

export type RetentionRunResult = {
  enabled: boolean;
  dryRun: boolean;
  durationMs: number;
  passes: RetentionPassResult[];
  totalRows: number;
};

/** Wall-clock budget shared by every pass in one run. */
class RunBudget {
  private readonly deadline: number;

  constructor(maxRuntimeMs: number) {
    this.deadline = Date.now() + maxRuntimeMs;
  }

  get exhausted(): boolean {
    return Date.now() >= this.deadline;
  }
}

/**
 * KEEP-1042: delete aged workflow execution data on a schedule.
 *
 * Five passes, deliberately ordered child-before-parent because every foreign
 * key into `workflow_executions` is ON DELETE NO ACTION -- nothing cascades, so
 * a parent delete with a surviving child simply fails.
 *
 * The per-org passes are INCREMENTAL: each looks only at the slice that crossed
 * its boundary since the last run (`lookbackDays`), because the plan windows
 * differ by three orders of magnitude and a scan from the oldest row would walk
 * millions of enterprise rows to reach a handful of free-tier ones. Anything a
 * long outage lets slip past a per-org window is still caught by the floor
 * pass, which has no join and no lookback.
 */
export async function runRetentionPurge(
  config: RetentionConfig = getRetentionConfig(),
  now: Date = new Date()
): Promise<RetentionRunResult> {
  const startedAt = Date.now();

  if (!config.enabled) {
    return {
      enabled: false,
      dryRun: config.dryRun,
      durationMs: 0,
      passes: [],
      totalRows: 0,
    };
  }

  const budget = new RunBudget(config.maxRuntimeMs);
  const passes: RetentionPassResult[] = [];

  passes.push(await purgeLogsPastFloor(config, now, budget));
  passes.push(await purgeLogsPastPlanWindow(config, now, budget));
  passes.push(await stripExpiredOutputRaw(config, now, budget));
  passes.push(await purgeSoftDeletedLogs(config, now, budget));
  passes.push(await purgeExecutionsPastFlatWindow(config, now, budget));

  return {
    enabled: true,
    dryRun: config.dryRun,
    durationMs: Date.now() - startedAt,
    passes,
    totalRows: passes.reduce((sum, pass) => sum + pass.rows, 0),
  };
}

/**
 * Pass 1. The backstop: no step log survives past the floor, whatever plan its
 * org is on. Drives idx_exec_logs_started_at with no join, which is why it can
 * afford to scan from the oldest row on every run.
 */
function purgeLogsPastFloor(
  config: RetentionConfig,
  now: Date,
  budget: RunBudget
): Promise<RetentionPassResult> {
  const cutoff = daysBefore(now, config.executionLogFloorRetentionDays);
  return runBatched({
    pass: "logs_floor",
    config,
    budget,
    selectIds: (limit) =>
      db
        .select({ id: workflowExecutionLogs.id })
        .from(workflowExecutionLogs)
        .where(lt(workflowExecutionLogs.startedAt, cutoff))
        .orderBy(workflowExecutionLogs.startedAt)
        .limit(limit),
    deleteIds: (ids) =>
      db
        .delete(workflowExecutionLogs)
        .where(inArray(workflowExecutionLogs.id, ids)),
  });
}

/**
 * Pass 2. The product promise: step logs age out at the window the org's plan
 * sells (7 free, 30 pro, 90 business, 365 enterprise, or a per-org override).
 * Orgs whose window already reaches the floor are skipped -- pass 1 owns them.
 *
 * The slice is bounded on BOTH sides so the scan stays a narrow index range.
 * Rows are matched by their execution's `started_at`, not their own, so a whole
 * run's step logs retire together, and a run that can still resume is skipped
 * for the same reason the output_raw pass skips it.
 */
async function purgeLogsPastPlanWindow(
  config: RetentionConfig,
  now: Date,
  budget: RunBudget
): Promise<RetentionPassResult> {
  const windows = await resolveOrgRetentionWindows(config);
  const groups = groupByRetentionWindow(windows, config);

  let rows = 0;
  for (const group of groups) {
    if (budget.exhausted) {
      return { pass: "logs_plan_window", rows, budgetExhausted: true };
    }
    const to = daysBefore(now, group.retentionDays);
    const from = daysBefore(now, group.retentionDays + config.lookbackDays);

    const result = await runBatched({
      pass: "logs_plan_window",
      config,
      budget,
      selectIds: (limit) =>
        db
          .select({ id: workflowExecutionLogs.id })
          .from(workflowExecutionLogs)
          .innerJoin(
            workflowExecutions,
            eq(workflowExecutions.id, workflowExecutionLogs.executionId)
          )
          .innerJoin(workflows, eq(workflows.id, workflowExecutions.workflowId))
          .where(
            and(
              inArray(workflows.organizationId, group.organizationIds),
              gte(workflowExecutions.startedAt, from),
              lt(workflowExecutions.startedAt, to),
              notInArray(workflowExecutions.status, [
                ...RESUMABLE_EXECUTION_STATUSES,
              ])
            )
          )
          .limit(limit),
      deleteIds: (ids) =>
        db
          .delete(workflowExecutionLogs)
          .where(inArray(workflowExecutionLogs.id, ids)),
    });

    rows += result.rows;
    if (result.budgetExhausted) {
      return { pass: "logs_plan_window", rows, budgetExhausted: true };
    }
  }

  return { pass: "logs_plan_window", rows, budgetExhausted: false };
}

/**
 * Pass 3. Null `output_raw` once a run can no longer resume. It is the
 * unredacted twin of `output` and costs about the same on disk, so dropping it
 * halves the payload of every aged row without deleting the row itself. The
 * redacted `output` the UI shows stays for the full plan window.
 *
 * Same bounded slice as pass 2, for the same reason: once the backlog is
 * cleared every row past the window already has a NULL, and an unbounded scan
 * would re-read the whole table to find nothing.
 */
function stripExpiredOutputRaw(
  config: RetentionConfig,
  now: Date,
  budget: RunBudget
): Promise<RetentionPassResult> {
  const to = daysBefore(now, config.outputRawRetentionDays);
  const from = daysBefore(
    now,
    config.outputRawRetentionDays + config.lookbackDays
  );

  return runBatched({
    pass: "output_raw",
    config,
    budget,
    selectIds: (limit) =>
      db
        .select({ id: workflowExecutionLogs.id })
        .from(workflowExecutionLogs)
        .innerJoin(
          workflowExecutions,
          eq(workflowExecutions.id, workflowExecutionLogs.executionId)
        )
        .where(
          and(
            gte(workflowExecutionLogs.startedAt, from),
            lt(workflowExecutionLogs.startedAt, to),
            isNotNull(workflowExecutionLogs.outputRaw),
            notInArray(workflowExecutions.status, [
              ...RESUMABLE_EXECUTION_STATUSES,
            ])
          )
        )
        .limit(limit),
    deleteIds: (ids) =>
      db
        .update(workflowExecutionLogs)
        .set({ outputRaw: null })
        .where(inArray(workflowExecutionLogs.id, ids)),
  });
}

/**
 * Pass 4. Hard-delete step logs a user already purged from the UI. KEEP-1199
 * made that purge a soft delete so the gas and network aggregates stayed whole;
 * this is where those rows finally leave, once the grace period has passed.
 */
function purgeSoftDeletedLogs(
  config: RetentionConfig,
  now: Date,
  budget: RunBudget
): Promise<RetentionPassResult> {
  const cutoff = daysBefore(now, config.softDeleteGraceDays);
  return runBatched({
    pass: "logs_soft_deleted",
    config,
    budget,
    selectIds: (limit) =>
      db
        .select({ id: workflowExecutionLogs.id })
        .from(workflowExecutionLogs)
        .where(lt(workflowExecutionLogs.deletedAt, cutoff))
        .limit(limit),
    deleteIds: (ids) =>
      db
        .delete(workflowExecutionLogs)
        .where(inArray(workflowExecutionLogs.id, ids)),
  });
}

/**
 * Pass 5. Run rows on ONE flat window, deliberately not the plan window.
 *
 * Every billing count reads `workflow_executions` by `started_at` with no floor
 * and no `deleted_at` filter -- month-to-date quota
 * (lib/billing/execution-limit-core.ts), overage, the hourly quota scan, and
 * the per-invoice usage column that pages back over every past invoice
 * (lib/billing/execution-usage.ts). Deleting a run row on a 7-day plan window
 * would silently rewrite what a customer was billed, so this window has to
 * outlive every billing period instead.
 *
 * Rows still referenced by a payment are skipped rather than orphaned: neither
 * payg_payments nor workflow_payments has a foreign key, so nothing in the
 * database would stop the delete.
 */
async function purgeExecutionsPastFlatWindow(
  config: RetentionConfig,
  now: Date,
  budget: RunBudget
): Promise<RetentionPassResult> {
  const cutoff = daysBefore(now, config.executionRetentionDays);
  const limit = executionBatchSize(config);
  let rows = 0;

  for (;;) {
    if (budget.exhausted) {
      return { pass: "executions_flat_window", rows, budgetExhausted: true };
    }

    const paidExecutionIds = db
      .select({ executionId: paygPayments.executionId })
      .from(paygPayments);
    const workflowPaidExecutionIds = db
      .select({ executionId: workflowPayments.executionId })
      .from(workflowPayments)
      .where(isNotNull(workflowPayments.executionId));

    const victims = await db
      .select({ id: workflowExecutions.id })
      .from(workflowExecutions)
      .where(
        and(
          lt(workflowExecutions.startedAt, cutoff),
          notInArray(workflowExecutions.id, paidExecutionIds),
          notInArray(workflowExecutions.id, workflowPaidExecutionIds)
        )
      )
      .orderBy(workflowExecutions.startedAt)
      .limit(limit);

    if (victims.length === 0) {
      return { pass: "executions_flat_window", rows, budgetExhausted: false };
    }

    const ids = victims.map((victim) => victim.id);

    if (config.dryRun) {
      return {
        pass: "executions_flat_window",
        rows: rows + ids.length,
        budgetExhausted: false,
      };
    }

    // One transaction so a run row can never survive the deletion of its own
    // logs. Children first: workflow_execution_logs and feedback both reference
    // workflow_executions ON DELETE NO ACTION.
    await db.transaction(async (tx) => {
      await tx
        .delete(workflowExecutionLogs)
        .where(inArray(workflowExecutionLogs.executionId, ids));
      await tx.delete(feedback).where(inArray(feedback.executionId, ids));
      await tx
        .delete(workflowExecutions)
        .where(inArray(workflowExecutions.id, ids));
    });

    rows += ids.length;
  }
}

type BatchedPass = {
  pass: RetentionPassName;
  config: RetentionConfig;
  budget: RunBudget;
  selectIds: (limit: number) => Promise<Array<{ id: string }>>;
  deleteIds: (ids: string[]) => Promise<unknown>;
};

/**
 * Select a bounded page of ids, then act on exactly those ids. The two-step
 * shape is what keeps memory flat: at most `batchSize` ids exist at once,
 * unlike purgeExpiredAuditEvents, which materialises every deleted id in one go
 * and would not survive this table.
 *
 * Every batch is its own statement, so no transaction is held open long enough
 * to block autovacuum -- the exact failure mode that pinned the database on
 * 2026-09-02.
 */
async function runBatched({
  pass,
  config,
  budget,
  selectIds,
  deleteIds,
}: BatchedPass): Promise<RetentionPassResult> {
  let rows = 0;

  for (;;) {
    if (budget.exhausted) {
      return { pass, rows, budgetExhausted: true };
    }

    const victims = await selectIds(config.batchSize);
    if (victims.length === 0) {
      return { pass, rows, budgetExhausted: false };
    }

    // A dry run reports the first eligible page and stops. It never loops:
    // with nothing deleted the same page would come back forever.
    if (config.dryRun) {
      return { pass, rows: rows + victims.length, budgetExhausted: false };
    }

    await deleteIds(victims.map((victim) => victim.id));
    rows += victims.length;
  }
}
