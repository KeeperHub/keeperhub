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
  buildRetentionSchedule,
  resolveOrgRetentionWindows,
} from "@/lib/retention/org-windows";
import {
  getPurgeWatermarks,
  RETENTION_EPOCH,
  setPurgeWatermark,
} from "@/lib/retention/progress";

/**
 * Statuses a run can still be picked up from. Their step logs carry
 * `output_raw`, the executor's authoritative resume input
 * (lib/workflow/executor/get-completed-step-output.step.ts), so neither the
 * plan-window pass nor the output_raw pass may touch them at any age. Typed
 * against WorkflowExecutionStatus so a new status forces a decision here.
 *
 * The floor and run-row passes deliberately do NOT apply this guard. A run that
 * has sat in `running` for more than a year is not resumable by any definition
 * -- the reaper closes a stuck run after 30 minutes -- and skipping those rows
 * would leak them forever, which is the failure this job exists to end.
 */
const RESUMABLE_EXECUTION_STATUSES: readonly WorkflowExecutionStatus[] = [
  "pending",
  "running",
  "phantom",
  "unconfirmed",
];

/**
 * Executions scanned per statement in the run-row pass. One execution carries
 * several step logs, so the row count a batch touches is a multiple of this;
 * keeping it well under `batchSize` holds a single statement inside the pool's
 * statement_timeout. The CronJob calls into the app pods, so the bound is
 * APP_STATEMENT_TIMEOUT_MS (30s), not the 120s role-level backstop.
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

/** Per-window detail, so a dry run can be read as a pre-flight check. */
export type RetentionWindowReport = {
  retentionDays: number;
  organizationCount: number;
  rows: number;
};

export type RetentionPassResult = {
  pass: RetentionPassName;
  /** Rows deleted, or nulled for the output_raw pass. Candidates in a dry run. */
  rows: number;
  /** True when the runtime budget stopped this pass before it drained. */
  budgetExhausted: boolean;
  /** Present on the passes that resolve a window per organization. */
  windows?: RetentionWindowReport[];
  /** Present when a pass did nothing because its switch is off. */
  skipped?: "disabled";
};

export type RetentionRunResult = {
  enabled: boolean;
  executionsEnabled: boolean;
  dryRun: boolean;
  durationMs: number;
  /** The window the no-join floor pass ran at, resolved from the plans in use. */
  floorDays: number;
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
 * None of the passes bounds its scan from below by a fixed lookback. An earlier
 * version did, and it meant each run only ever saw rows that had crossed their
 * boundary in the last few days: on prod that left 1.96M step-log rows and 19M
 * `output_raw` payloads that nothing would ever reach. Instead the two passes
 * that need a lower bound get it from real progress -- a per-organization
 * watermark for the plan-window pass, a self-pruning partial index for the
 * output_raw pass -- so the backlog drains on its own and a drained table costs
 * nothing to re-check.
 */
export async function runRetentionPurge(
  config: RetentionConfig = getRetentionConfig(),
  now: Date = new Date()
): Promise<RetentionRunResult> {
  const startedAt = Date.now();

  if (!config.enabled) {
    return {
      enabled: false,
      executionsEnabled: config.executionsEnabled,
      dryRun: config.dryRun,
      durationMs: 0,
      floorDays: config.executionLogFloorRetentionDays,
      passes: [],
      totalRows: 0,
    };
  }

  const budget = new RunBudget(config.maxRuntimeMs);
  const schedule = buildRetentionSchedule(
    await resolveOrgRetentionWindows(config),
    config
  );
  const passes: RetentionPassResult[] = [];

  passes.push(
    await purgeLogsPastFloor(config, now, budget, schedule.floorDays)
  );
  passes.push(
    await purgeLogsPastPlanWindow(config, now, budget, schedule.groups)
  );
  passes.push(await stripExpiredOutputRaw(config, now, budget));
  passes.push(await purgeSoftDeletedLogs(config, now, budget));
  passes.push(await purgeExecutionsPastFlatWindow(config, now, budget));

  return {
    enabled: true,
    executionsEnabled: config.executionsEnabled,
    dryRun: config.dryRun,
    durationMs: Date.now() - startedAt,
    floorDays: schedule.floorDays,
    passes,
    totalRows: passes.reduce((sum, pass) => sum + pass.rows, 0),
  };
}

/**
 * Pass 1. The backstop, and the workhorse: it runs at the LONGEST window any
 * organization is on, so the organizations holding most of the table (83% of it
 * on prod) are served by a plain index range on `started_at` with no join at
 * all, rather than by the per-organization pass below.
 */
function purgeLogsPastFloor(
  config: RetentionConfig,
  now: Date,
  budget: RunBudget,
  floorDays: number
): Promise<RetentionPassResult> {
  const cutoff = daysBefore(now, floorDays);
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
    apply: (ids) =>
      db
        .delete(workflowExecutionLogs)
        .where(inArray(workflowExecutionLogs.id, ids)),
  });
}

/**
 * Pass 2. The product promise: step logs age out at the window the org's plan
 * sells (7 free, 30 pro, 90 business, or a per-org override). Organizations on
 * the longest window are not here -- pass 1 owns them.
 *
 * Each organization is walked from its watermark up to its cutoff and the
 * watermark advances only when that range is empty, so an interrupted run
 * resumes rather than skipping. Rows are matched by their execution's
 * `started_at`, not their own, so a whole run's step logs retire together, and
 * a run that can still resume is skipped for the same reason the output_raw
 * pass skips it.
 */
async function purgeLogsPastPlanWindow(
  config: RetentionConfig,
  now: Date,
  budget: RunBudget,
  groups: Array<{ retentionDays: number; organizationIds: string[] }>
): Promise<RetentionPassResult> {
  const windows: RetentionWindowReport[] = [];
  let rows = 0;
  let budgetExhausted = false;

  for (const group of groups) {
    const cutoff = daysBefore(now, group.retentionDays);
    const watermarks = await getPurgeWatermarks(group.organizationIds);
    let groupRows = 0;

    for (const organizationId of group.organizationIds) {
      if (budget.exhausted) {
        budgetExhausted = true;
        break;
      }
      const from = watermarks.get(organizationId) ?? RETENTION_EPOCH;
      if (from >= cutoff) {
        continue;
      }

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
            .innerJoin(
              workflows,
              eq(workflows.id, workflowExecutions.workflowId)
            )
            .where(
              and(
                eq(workflows.organizationId, organizationId),
                gte(workflowExecutions.startedAt, from),
                lt(workflowExecutions.startedAt, cutoff),
                notInArray(workflowExecutions.status, [
                  ...RESUMABLE_EXECUTION_STATUSES,
                ])
              )
            )
            .limit(limit),
        apply: (ids) =>
          db
            .delete(workflowExecutionLogs)
            .where(inArray(workflowExecutionLogs.id, ids)),
      });

      groupRows += result.rows;
      if (result.budgetExhausted) {
        budgetExhausted = true;
        break;
      }
      // Drained: nothing of this organization older than the cutoff still has
      // step logs. A dry run must not claim that, since it deleted nothing.
      if (!config.dryRun) {
        await setPurgeWatermark(organizationId, cutoff);
      }
    }

    windows.push({
      retentionDays: group.retentionDays,
      organizationCount: group.organizationIds.length,
      rows: groupRows,
    });
    rows += groupRows;
    if (budgetExhausted) {
      break;
    }
  }

  return { pass: "logs_plan_window", rows, budgetExhausted, windows };
}

/**
 * Pass 3. Null `output_raw` once a run can no longer resume. It is the
 * unredacted twin of `output` and costs about the same on disk, so dropping it
 * halves the payload of every aged row without deleting the row itself. The
 * redacted `output` the UI shows stays for the full plan window, and carries
 * every non-sensitive field verbatim -- only secret-keyed values are masked.
 *
 * No lower bound. idx_exec_logs_output_raw_pending is partial on
 * `output_raw IS NOT NULL`, so it shrinks as the backlog drains and holds only
 * rows inside the window once it has: an unbounded scan over a drained table
 * reads an index that no longer contains those rows at all.
 */
function stripExpiredOutputRaw(
  config: RetentionConfig,
  now: Date,
  budget: RunBudget
): Promise<RetentionPassResult> {
  const cutoff = daysBefore(now, config.outputRawRetentionDays);
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
            lt(workflowExecutionLogs.startedAt, cutoff),
            isNotNull(workflowExecutionLogs.outputRaw),
            notInArray(workflowExecutions.status, [
              ...RESUMABLE_EXECUTION_STATUSES,
            ])
          )
        )
        .limit(limit),
    apply: (ids) =>
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
    apply: (ids) =>
      db
        .delete(workflowExecutionLogs)
        .where(inArray(workflowExecutionLogs.id, ids)),
  });
}

/**
 * Pass 5. Run rows on ONE flat window, behind a switch of its own that ships
 * off.
 *
 * Every billing count reads `workflow_executions` by `started_at` with no floor
 * and no `deleted_at` filter, and the invoices page recounts the table per
 * period on every load (lib/billing/execution-usage.ts,
 * app/api/billing/invoices/route.ts) with no date floor of its own. No durable
 * record of executions-used survives a period without overage -- free plans
 * never get one at all -- and the provider holds no recoverable figure either.
 * So deleting a run row rewrites what a customer was billed, and this pass
 * stays off until a per-period usage record exists.
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
  if (!config.executionsEnabled) {
    return {
      pass: "executions_flat_window",
      rows: 0,
      budgetExhausted: false,
      skipped: "disabled",
    };
  }

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
  apply: (ids: string[]) => Promise<unknown>;
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
  apply,
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
    // with nothing changed the same page would come back forever.
    if (config.dryRun) {
      return { pass, rows: rows + victims.length, budgetExhausted: false };
    }

    await apply(victims.map((victim) => victim.id));
    rows += victims.length;
  }
}
