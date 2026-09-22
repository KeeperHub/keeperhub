import "server-only";

import {
  and,
  count,
  eq,
  gte,
  inArray,
  isNotNull,
  lt,
  min,
  notInArray,
  type SQL,
  sql,
} from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { db } from "@/lib/db";
import { isStatementTimeout } from "@/lib/db/errors";
import {
  workflowExecutionLogs,
  workflowExecutions,
  workflows,
} from "@/lib/db/schema";
import { paygPayments } from "@/lib/db/schema-extensions";
import { feedback } from "@/lib/db/schema-feedback";
import { workflowPayments } from "@/lib/db/schema-payments";
import type { WorkflowExecutionStatus } from "@/lib/errors/execution-status";
import { logWarn } from "@/lib/logging";
import {
  daysBefore,
  getRetentionConfig,
  type RetentionConfig,
} from "@/lib/retention/config";
import {
  buildRetentionSchedule,
  resolveOrgRetentionWindows,
  resolveRecentPlanChanges,
} from "@/lib/retention/org-windows";
import {
  advanceWatermarksToFloor,
  getPurgeWatermarks,
  RETENTION_EPOCH,
  setPurgeWatermark,
} from "@/lib/retention/progress";
import { DAY_MS, SECOND_MS } from "@/lib/utils/duration";

/**
 * Statuses a run can still be picked up from. Their step logs carry
 * `output_raw`, the executor's authoritative resume input
 * (lib/workflow/executor/get-completed-step-output.step.ts), so neither the
 * plan-window pass nor the output_raw pass may touch them at any age. Typed
 * against WorkflowExecutionStatus so a new status forces a decision here.
 *
 * The floor and run-row passes deliberately do NOT apply this guard, and they
 * are the reason a skipped row cannot leak forever. The floor pass runs at the
 * longest window in use, which is as far back as any organization's data is
 * kept, so a run still sitting in a resumable status by the time it gets there
 * is not resumable by any definition -- the reaper closes a stuck run after 30
 * minutes and reconciliation force-settles an unconfirmed one after a day. Note
 * this is a shorter horizon than the configured ceiling: on a deployment where
 * every organization is on the free plan the floor is seven days, not 400.
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

/**
 * Workflow ids per statement in the plan-window drain. Small enough that the
 * planner keeps the (workflow_id, started_at) index for one chunk's runs.
 */
export const PLAN_WINDOW_WORKFLOW_CHUNK = 100;

/** Run ids per statement when the plan-window drain reads their step logs. */
export const PLAN_WINDOW_EXECUTION_CHUNK = 500;

/**
 * Most runs one read of a workflow chunk may return. A read that finds more
 * halves the time slice instead, so no single statement or array holds an
 * organization's whole backlog.
 */
export const PLAN_WINDOW_RUNS_PER_READ = 5000;

/**
 * Shortest time slice the plan-window drain will halve down to. More runs than
 * one read holds starting inside one second of one chunk is not a shape the
 * product produces, so reaching it fails the organization rather than reading
 * an unbounded set.
 */
export const PLAN_WINDOW_MIN_SLICE_MS = 1000;

/**
 * Widest time slice the plan-window drain starts an organization on, and the
 * width the doubling is allowed back up to until a read proves a wider one
 * works.
 *
 * KEEP-1360: the slice used to start at the whole remaining range and double
 * back up to it, and over a range an organization's runs are sparse in, the
 * planner stops using (workflow_id, started_at) and answers the read from the
 * global started_at index instead -- walking every organization's runs to fill
 * one page. A day is the width measured on prod at 1.3 s for a full page; the
 * same read over a year did not return in 60 s on an idle database.
 */
export const PLAN_WINDOW_INITIAL_SLICE_MS = DAY_MS;

/**
 * How long one runs read of a workflow chunk may take before the drain treats
 * its time slice as too wide.
 *
 * Well under the pool's 30 s statement_timeout, because this bound is not there
 * to protect the database -- it is the signal that the planner has left the
 * per-workflow index. A read that stays on it returns a full page in seconds
 * even over a wide slice.
 */
export const PLAN_WINDOW_READ_TIMEOUT_MS = 5 * SECOND_MS;

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
  /**
   * Rows deleted, or nulled for the output_raw pass. In a dry run, the rows a
   * real run would touch. The output_raw pass walks its pages to get that
   * figure, so when the budget stops it (`budgetExhausted`) the figure covers
   * only the pages it reached and is a lower bound rather than a total.
   */
  rows: number;
  /** True when the runtime budget stopped this pass before it drained. */
  budgetExhausted: boolean;
  /** Present on the passes that resolve a window per organization. */
  windows?: RetentionWindowReport[];
  /**
   * Organizations the plan-window pass left for a later run because their
   * subscription changed inside the grace period.
   */
  deferredOrganizations?: number;
  /**
   * Organizations the plan-window pass could not drain because a statement
   * failed. Each keeps the watermark of its last drained slice, and the run
   * fails once every other organization and pass has had its turn.
   */
  failedOrganizationIds?: string[];
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

/**
 * Thrown after a run that did all the work it could but could not drain every
 * organization. The route turns it into a 500, so the scheduled job still
 * reports the failure; `result` carries what the run did get done.
 */
export class RetentionPurgeIncompleteError extends Error {
  readonly result: RetentionRunResult;
  readonly failedOrganizationIds: string[];

  constructor(result: RetentionRunResult, failedOrganizationIds: string[]) {
    super(
      `Retention purge could not drain ${failedOrganizationIds.length} organization(s) in the plan-window pass: ${failedOrganizationIds.join(", ")}`
    );
    this.name = "RetentionPurgeIncompleteError";
    this.result = result;
    this.failedOrganizationIds = failedOrganizationIds;
  }
}

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
 * a parent delete with a surviving child simply fails. The one exception is
 * `workflow_step_claims`, which is ephemeral coordination state rather than
 * history and cascades on delete, so no pass here has to know about it.
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

  const floor = await purgeLogsPastFloor(
    config,
    now,
    budget,
    schedule.floorDays
  );
  passes.push(floor);

  // Record what the floor pass proved, before the per-organization pass reads
  // the watermarks. It deletes every step log past its cutoff with no
  // organization scope and no status guard, so once it drains, that instant is
  // true for every organization -- including the ones whose window is at or
  // above the floor, which never enter the pass below and would otherwise never
  // have a watermark at all.
  if (!(floor.budgetExhausted || config.dryRun)) {
    await advanceWatermarksToFloor(daysBefore(now, schedule.floorDays));
  }

  // An organization whose plan just changed is left alone for the grace
  // period, so a lapse can be undone before the shorter window deletes the
  // difference. Resolved per run, so the dry run reports the same deferral.
  const deferred = await resolveRecentPlanChanges(
    new Date(now.getTime() - config.planChangeGraceMs)
  );
  passes.push(
    await purgeLogsPastPlanWindow(
      config,
      now,
      budget,
      schedule.groups,
      deferred
    )
  );
  passes.push(await purgeSoftDeletedLogs(config, now, budget));
  passes.push(await purgeExecutionsPastFlatWindow(config, now, budget));
  // output_raw last. It carries by far the largest backlog and can spend the
  // whole budget for many runs in a row, and it is the one pass whose dry run
  // walks pages rather than counting in one statement, so a dry run can spend
  // the whole budget on it too. Any pass behind it would get no time at all.
  // Last is also the cheaper order for a real run: a run row the pass above
  // retires takes its step logs with it, so they are never nulled first.
  passes.push(await stripExpiredOutputRaw(config, now, budget));

  const result: RetentionRunResult = {
    enabled: true,
    executionsEnabled: config.executionsEnabled,
    dryRun: config.dryRun,
    durationMs: Date.now() - startedAt,
    floorDays: schedule.floorDays,
    passes,
    totalRows: passes.reduce((sum, pass) => sum + pass.rows, 0),
  };

  const failedOrganizationIds = passes.flatMap(
    (pass) => pass.failedOrganizationIds ?? []
  );
  if (failedOrganizationIds.length > 0) {
    throw new RetentionPurgeIncompleteError(result, failedOrganizationIds);
  }
  return result;
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
  return runKeysetPass({
    pass: "logs_floor",
    config,
    budget,
    selectPage: (limit, cursor) => floorPageQuery(cutoff, cursor, limit),
    countEligible: async () => (await floorCountQuery(cutoff))[0].n,
    apply: (ids) =>
      db
        .delete(workflowExecutionLogs)
        .where(inArray(workflowExecutionLogs.id, ids)),
  });
}

/**
 * One page of the floor pass: step logs past the floor cutoff, after `cursor`.
 * Exported so a test can EXPLAIN the SQL the pass really sends.
 */
export function floorPageQuery(
  cutoff: Date,
  cursor: PageCursor | null,
  limit: number
) {
  return db
    .select({
      id: workflowExecutionLogs.id,
      at: sortKey(workflowExecutionLogs.startedAt),
    })
    .from(workflowExecutionLogs)
    .where(
      and(
        lt(workflowExecutionLogs.startedAt, cutoff),
        afterCursor(
          workflowExecutionLogs.startedAt,
          workflowExecutionLogs.id,
          cursor
        )
      )
    )
    .orderBy(workflowExecutionLogs.startedAt, workflowExecutionLogs.id)
    .limit(limit);
}

/**
 * How many step logs the floor pass would delete: a dry run's figure. A plain
 * range on `started_at`, which the planner answers from the index alone.
 * Exported so a test can EXPLAIN the SQL the pass really sends.
 */
export function floorCountQuery(cutoff: Date) {
  return db
    .select({ n: count() })
    .from(workflowExecutionLogs)
    .where(lt(workflowExecutionLogs.startedAt, cutoff));
}

/**
 * Pass 2. The product promise: step logs age out at the window the org's plan
 * sells (7 free, 30 pro, 90 business, or a per-org override). Organizations on
 * the longest window are not here -- pass 1 owns them.
 *
 * Each organization is walked from its watermark up to its cutoff in time
 * slices, and the watermark advances after every slice that has drained, so an
 * interrupted run resumes from its last whole slice rather than starting the
 * organization over. Rows are matched by their execution's `started_at`, not
 * their own, so a whole run's step logs retire together, and a run that can
 * still resume is skipped for the same reason the output_raw pass skips it.
 *
 * An organization is drained through its own workflows, never through one join
 * with a LIMIT. The planner prices `workflow_id` at the table-wide average runs
 * per workflow, so for an organization with a very large number of mostly idle
 * workflows it expects matches everywhere and answers that join with a
 * sequential scan of the whole step-log table, which outlives the statement
 * timeout and failed every run that reached the organization. So the drain
 * loads the organization's workflow ids, reads eligible runs for a small chunk
 * of them within one time slice, and reads step logs for a bounded list of
 * those runs. Every statement is keyed by explicit ids on an indexed column and
 * runs with sequential scans priced out (see withIndexPlans), so the planner
 * falls back to a sequential scan only when no index can answer.
 *
 * An organization that still fails is skipped from the slice it failed in, the
 * rest of the run carries on, and runRetentionPurge fails the run at the end so
 * the scheduled job still reports it.
 */
async function purgeLogsPastPlanWindow(
  config: RetentionConfig,
  now: Date,
  budget: RunBudget,
  groups: Array<{ retentionDays: number; organizationIds: string[] }>,
  deferred: Set<string>
): Promise<RetentionPassResult> {
  const windows: RetentionWindowReport[] = [];
  const failedOrganizationIds: string[] = [];
  let rows = 0;
  let budgetExhausted = false;
  let deferredOrganizations = 0;

  for (const group of groups) {
    const cutoff = daysBefore(now, group.retentionDays);
    const watermarks = await getPurgeWatermarks(group.organizationIds);
    let groupRows = 0;

    for (const organizationId of group.organizationIds) {
      if (budget.exhausted) {
        budgetExhausted = true;
        break;
      }
      // Deferred, not drained: no watermark is written, so the next run picks
      // this organization up from exactly where it stands now.
      if (deferred.has(organizationId)) {
        deferredOrganizations += 1;
        continue;
      }
      const from = watermarks.get(organizationId) ?? RETENTION_EPOCH;
      if (from >= cutoff) {
        continue;
      }

      // Counted as rows are removed, so a statement that fails after earlier
      // deletes have committed still reports them.
      const progress: DrainProgress = { rows: 0 };
      try {
        const drained = await drainPlanWindow(
          organizationId,
          from,
          cutoff,
          config,
          budget,
          progress
        );
        if (drained.budgetExhausted) {
          budgetExhausted = true;
        }
      } catch (error) {
        // One organization must not stall every organization behind it. It
        // keeps the watermark of its last drained slice, so the next run
        // starts it from there.
        failedOrganizationIds.push(organizationId);
        logWarn(
          "[Retention] Skipping an organization the plan-window pass could not drain",
          { organization_id: organizationId, error: describeError(error) }
        );
      }
      groupRows += progress.rows;
      if (budgetExhausted) {
        break;
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

  return {
    pass: "logs_plan_window",
    rows,
    budgetExhausted,
    windows,
    deferredOrganizations,
    ...(failedOrganizationIds.length > 0 ? { failedOrganizationIds } : {}),
  };
}

type Querier = Pick<typeof db, "select">;

type DrainProgress = { rows: number };

/**
 * Eligible runs of one chunk of an organization's workflows inside one time
 * slice, at most `limit` of them. Exported so a test can EXPLAIN the SQL the
 * pass really sends.
 */
export function planWindowExecutionIdsQuery(
  workflowIds: string[],
  from: Date,
  to: Date,
  limit: number,
  querier: Querier = db
) {
  return querier
    .select({ id: workflowExecutions.id })
    .from(workflowExecutions)
    .where(
      and(
        inArray(workflowExecutions.workflowId, workflowIds),
        gte(workflowExecutions.startedAt, from),
        lt(workflowExecutions.startedAt, to),
        notInArray(workflowExecutions.status, [...RESUMABLE_EXECUTION_STATUSES])
      )
    )
    .limit(limit);
}

/**
 * Step logs of a bounded list of runs. Exported so a test can EXPLAIN the SQL
 * the pass really sends.
 */
export function planWindowLogIdsQuery(
  executionIds: string[],
  limit: number,
  querier: Querier = db
) {
  return querier
    .select({ id: workflowExecutionLogs.id })
    .from(workflowExecutionLogs)
    .where(inArray(workflowExecutionLogs.executionId, executionIds))
    .limit(limit);
}

/**
 * How many step logs a bounded list of runs carries: the dry run's figure for
 * what planWindowLogIdsQuery would page through. Exported so a test can
 * EXPLAIN the SQL the pass really sends.
 */
export function planWindowLogCountQuery(
  executionIds: string[],
  querier: Querier = db
) {
  return querier
    .select({ n: count() })
    .from(workflowExecutionLogs)
    .where(inArray(workflowExecutionLogs.executionId, executionIds));
}

/**
 * Run one read with sequential scans priced out, for statements keyed by
 * explicit ids on an indexed column, optionally under a tighter
 * statement_timeout than the pool's. Both settings are local to the
 * transaction, so nothing leaks to the next query that borrows the pooled
 * connection. Each read touches a single table, so enable_seqscan reaches no
 * other relation.
 *
 * `set_config(..., true)` rather than two `SET LOCAL` statements: it is the
 * same local scope in one round trip, and the plan-window pass issues one of
 * these per workflow chunk per slice.
 */
function withIndexPlans<T>(
  query: (tx: Querier) => PromiseLike<T>,
  timeoutMs?: number
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      timeoutMs === undefined
        ? sql`SET LOCAL enable_seqscan = off`
        : sql`SELECT set_config('enable_seqscan', 'off', true), set_config('statement_timeout', ${String(timeoutMs)}, true)`
    );
    return await query(tx);
  });
}

/**
 * One organization's drain, in time slices of its runs' `started_at`.
 *
 * A slice starts at PLAN_WINDOW_INITIAL_SLICE_MS, or at the whole remaining
 * range when that is narrower. Two things make it narrower still, and both
 * resume the walk at the chunk that hit them -- the chunks before it were read
 * in full over the larger range, so they are already done for the smaller one:
 *
 * - a workflow chunk with more eligible runs in it than one read may return;
 * - a read the tighter statement_timeout cancels, which is how a slice too wide
 *   for the planner to answer from (workflow_id, started_at) announces itself
 *   (KEEP-1360). That one also latches a ceiling, so the doubling below cannot
 *   walk back into the width that was just cancelled.
 *
 * After a slice drains, the watermark moves to its end -- or to the oldest run
 * that can still resume, if one sits below it -- and the next slice doubles up
 * to the ceiling. A run cut off by the budget therefore gives up at most the
 * slice it was in.
 *
 * A dry run walks the same slices and counts instead of deleting. It writes no
 * watermark, so every dry run walks from the same place.
 */
async function drainPlanWindow(
  organizationId: string,
  from: Date,
  cutoff: Date,
  config: RetentionConfig,
  budget: RunBudget,
  progress: DrainProgress
): Promise<{ budgetExhausted: boolean }> {
  const workflowIds = (
    await db
      .select({ id: workflows.id })
      .from(workflows)
      .where(eq(workflows.organizationId, organizationId))
  ).map((row) => row.id);

  const end = cutoff.getTime();
  const widest = end - from.getTime();
  let sliceStart = from.getTime();
  // Widest slice still believed to be answerable from the per-workflow index.
  // Only a cancelled read lowers it, and it never rises again within this
  // organization's drain.
  let spanCeiling = widest;
  let span = Math.min(widest, PLAN_WINDOW_INITIAL_SLICE_MS);
  let firstChunk = 0;

  // Resolved once for the whole range rather than once per slice. The answer
  // for [from, sliceEnd) only ever changes the watermark when it falls below
  // sliceEnd, and the earliest skipped run of the whole range is the earliest
  // of every prefix of it that contains one, so one read is equivalent -- and
  // this pass now takes more slices per organization than it used to.
  const skipped = config.dryRun
    ? null
    : await earliestResumableStartedAt(organizationId, from, cutoff);

  while (sliceStart < end) {
    const sliceEnd = Math.min(sliceStart + span, end);
    let overflowAt: number | null = null;
    let cancelledAt: number | null = null;

    for (
      let i = firstChunk;
      i < workflowIds.length;
      i += PLAN_WINDOW_WORKFLOW_CHUNK
    ) {
      if (budget.exhausted) {
        return { budgetExhausted: true };
      }
      const workflowChunk = workflowIds.slice(
        i,
        i + PLAN_WINDOW_WORKFLOW_CHUNK
      );
      let executionIds: string[];
      try {
        executionIds = (
          await withIndexPlans(
            (tx) =>
              planWindowExecutionIdsQuery(
                workflowChunk,
                new Date(sliceStart),
                new Date(sliceEnd),
                PLAN_WINDOW_RUNS_PER_READ + 1,
                tx
              ),
            PLAN_WINDOW_READ_TIMEOUT_MS
          )
        ).map((row) => row.id);
      } catch (error) {
        if (!isStatementTimeout(error)) {
          throw error;
        }
        cancelledAt = i;
        break;
      }

      if (executionIds.length > PLAN_WINDOW_RUNS_PER_READ) {
        overflowAt = i;
        break;
      }

      const drained = await drainLogsOfExecutions(
        executionIds,
        config,
        budget,
        progress
      );
      if (drained.budgetExhausted) {
        return { budgetExhausted: true };
      }
    }

    if (cancelledAt !== null) {
      if (span <= PLAN_WINDOW_MIN_SLICE_MS) {
        throw new Error(
          `Reading the eligible runs of one chunk of this organization's workflows took longer than ${PLAN_WINDOW_READ_TIMEOUT_MS} ms over a ${PLAN_WINDOW_MIN_SLICE_MS} ms slice`
        );
      }
      // Latched, not just applied: the doubling after a drained slice would
      // otherwise walk straight back into the width that was cancelled, and
      // spend the timeout again on every sparse stretch of the range.
      spanCeiling = Math.max(Math.floor(span / 2), PLAN_WINDOW_MIN_SLICE_MS);
      span = spanCeiling;
      logWarn("[Retention] Narrowing a plan-window slice a read timed out on", {
        organization_id: organizationId,
        slice_ms: String(spanCeiling),
      });
      firstChunk = cancelledAt;
      continue;
    }

    if (overflowAt !== null) {
      if (span <= PLAN_WINDOW_MIN_SLICE_MS) {
        throw new Error(
          `More than ${PLAN_WINDOW_RUNS_PER_READ} eligible runs start within ${PLAN_WINDOW_MIN_SLICE_MS} ms in one chunk of this organization's workflows`
        );
      }
      span = Math.max(Math.floor(span / 2), PLAN_WINDOW_MIN_SLICE_MS);
      firstChunk = overflowAt;
      continue;
    }

    // Drained -- but "drained" means every read came back without the runs
    // that can still resume. Advancing past one would move the lower bound
    // beyond it, and since the bound is inclusive-below it would never be
    // selected again: a run that is phantom today and succeeds tomorrow would
    // keep its step logs until the floor pass, hundreds of days past the window
    // its plan sells. So the watermark stops at the oldest run this pass had to
    // skip. A dry run must not claim anything at all, since it deleted nothing.
    if (!config.dryRun) {
      await setPurgeWatermark(
        organizationId,
        skipped && skipped.getTime() < sliceEnd ? skipped : new Date(sliceEnd)
      );
    }

    sliceStart = sliceEnd;
    span = Math.min(span * 2, spanCeiling);
    firstChunk = 0;
  }

  return { budgetExhausted: false };
}

/**
 * Delete the step logs of `executionIds`, a bounded list of runs at a time, or
 * count them in a dry run.
 */
async function drainLogsOfExecutions(
  executionIds: string[],
  config: RetentionConfig,
  budget: RunBudget,
  progress: DrainProgress
): Promise<{ budgetExhausted: boolean }> {
  for (let i = 0; i < executionIds.length; i += PLAN_WINDOW_EXECUTION_CHUNK) {
    const executionChunk = executionIds.slice(
      i,
      i + PLAN_WINDOW_EXECUTION_CHUNK
    );
    if (config.dryRun) {
      if (budget.exhausted) {
        return { budgetExhausted: true };
      }
      const [{ n }] = await withIndexPlans((tx) =>
        planWindowLogCountQuery(executionChunk, tx)
      );
      progress.rows += n;
      continue;
    }
    for (;;) {
      if (budget.exhausted) {
        return { budgetExhausted: true };
      }
      const victims = await withIndexPlans((tx) =>
        planWindowLogIdsQuery(executionChunk, config.batchSize, tx)
      );
      if (victims.length === 0) {
        break;
      }
      await db.delete(workflowExecutionLogs).where(
        inArray(
          workflowExecutionLogs.id,
          victims.map((victim) => victim.id)
        )
      );
      progress.rows += victims.length;
    }
  }
  return { budgetExhausted: false };
}

/** A one-line reason for a skipped organization, without bound parameters. */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const cause = (error as { cause?: { code?: unknown; message?: unknown } })
    .cause;
  const reason =
    typeof cause?.message === "string" ? cause.message : error.message;
  const code = typeof cause?.code === "string" ? ` (${cause.code})` : "";
  return `${reason.split("\n")[0].slice(0, 200)}${code}`;
}

/**
 * The oldest run in `[from, cutoff)` that the plan-window pass had to skip
 * because it can still resume, or null when it skipped nothing.
 *
 * Same join and the same range as the drain query, minus the step-log side: the
 * question is which run held the pass up, not how many logs it carries. The
 * range bound is inclusive below, so writing this instant as the watermark
 * re-selects that run on the next pass with no epsilon needed.
 */
async function earliestResumableStartedAt(
  organizationId: string,
  from: Date,
  cutoff: Date
): Promise<Date | null> {
  const rows = await db
    .select({ oldest: min(workflowExecutions.startedAt) })
    .from(workflowExecutions)
    .innerJoin(workflows, eq(workflows.id, workflowExecutions.workflowId))
    .where(
      and(
        eq(workflows.organizationId, organizationId),
        gte(workflowExecutions.startedAt, from),
        lt(workflowExecutions.startedAt, cutoff),
        inArray(workflowExecutions.status, [...RESUMABLE_EXECUTION_STATUSES])
      )
    );
  return rows[0]?.oldest ?? null;
}

/**
 * Pass 3. Hard-delete step logs a user already purged from the UI. KEEP-1199
 * made that purge a soft delete so the gas and network aggregates stayed whole;
 * this is where those rows finally leave, once the grace period has passed.
 */
function purgeSoftDeletedLogs(
  config: RetentionConfig,
  now: Date,
  budget: RunBudget
): Promise<RetentionPassResult> {
  const cutoff = daysBefore(now, config.softDeleteGraceDays);
  return runKeysetPass({
    pass: "logs_soft_deleted",
    config,
    budget,
    selectPage: (limit, cursor) => softDeletedPageQuery(cutoff, cursor, limit),
    countEligible: async () => (await softDeletedCountQuery(cutoff))[0].n,
    apply: (ids) =>
      db
        .delete(workflowExecutionLogs)
        .where(inArray(workflowExecutionLogs.id, ids)),
  });
}

/**
 * One page of the soft-delete pass: step logs purged before `cutoff`, after
 * `cursor`. Exported so a test can EXPLAIN the SQL the pass really sends.
 */
export function softDeletedPageQuery(
  cutoff: Date,
  cursor: PageCursor | null,
  limit: number
) {
  return db
    .select({
      id: workflowExecutionLogs.id,
      at: sortKey(workflowExecutionLogs.deletedAt),
    })
    .from(workflowExecutionLogs)
    .where(
      and(
        lt(workflowExecutionLogs.deletedAt, cutoff),
        afterCursor(
          workflowExecutionLogs.deletedAt,
          workflowExecutionLogs.id,
          cursor
        )
      )
    )
    .orderBy(workflowExecutionLogs.deletedAt, workflowExecutionLogs.id)
    .limit(limit);
}

/**
 * How many purged step logs the soft-delete pass would delete: a dry run's
 * figure. A range on the partial index that holds only purged rows. Exported so
 * a test can EXPLAIN the SQL the pass really sends.
 */
export function softDeletedCountQuery(cutoff: Date) {
  return db
    .select({ n: count() })
    .from(workflowExecutionLogs)
    .where(lt(workflowExecutionLogs.deletedAt, cutoff));
}

/**
 * Pass 4. Run rows on ONE flat window, behind a switch of its own that ships
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

  // Retired only when nothing has been paid for the run. `payg_payments`
  // declares execution_id NOT NULL, but `workflow_payments` does not -- a
  // calldata-only sale carries no execution -- and one NULL row would make
  // `NOT IN` answer NULL for every candidate, turning this pass into a silent
  // no-op. The isNotNull below is what keeps that from happening.
  const eligible = and(
    lt(workflowExecutions.startedAt, cutoff),
    notInArray(
      workflowExecutions.id,
      db.select({ executionId: paygPayments.executionId }).from(paygPayments)
    ),
    notInArray(
      workflowExecutions.id,
      db
        .select({ executionId: workflowPayments.executionId })
        .from(workflowPayments)
        .where(isNotNull(workflowPayments.executionId))
    )
  );

  if (config.dryRun) {
    if (budget.exhausted) {
      return { pass: "executions_flat_window", rows: 0, budgetExhausted: true };
    }
    const [{ n }] = await db
      .select({ n: count() })
      .from(workflowExecutions)
      .where(eligible);
    return {
      pass: "executions_flat_window",
      rows: n,
      budgetExhausted: false,
    };
  }

  for (;;) {
    if (budget.exhausted) {
      return { pass: "executions_flat_window", rows, budgetExhausted: true };
    }

    const victims = await db
      .select({ id: workflowExecutions.id })
      .from(workflowExecutions)
      .where(eligible)
      .orderBy(workflowExecutions.startedAt)
      .limit(limit);

    if (victims.length === 0) {
      return { pass: "executions_flat_window", rows, budgetExhausted: false };
    }

    const ids = victims.map((victim) => victim.id);

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

/**
 * Pass 5. Null `output_raw` once a run can no longer resume. It is the
 * unredacted twin of `output` and costs about the same on disk, so dropping it
 * halves the payload of every aged row without deleting the row itself. The
 * redacted `output` the UI shows stays for the full plan window, and carries
 * every non-sensitive field verbatim -- only secret-keyed values are masked.
 *
 * No lower bound. idx_exec_logs_output_raw_pending is partial on
 * `output_raw IS NOT NULL`, so it shrinks as the backlog drains and holds only
 * rows inside the window once it has. The pass pages along that index by
 * `(started_at, id)`, so a page costs the same however many rows ahead of it
 * this run has already nulled.
 *
 * A row whose run can still resume is filtered out of its page, and the cursor
 * moves past it with the rest. It is not lost: every run starts again at the
 * front of the index, so the next run reads it again and nulls it once the run
 * has finished.
 *
 * Its dry run walks the same pages instead of counting. A count has to join
 * every eligible step log to its run for the status check, which on a large
 * table plans as a sequential scan of both and cannot finish inside the
 * statement timeout.
 */
function stripExpiredOutputRaw(
  config: RetentionConfig,
  now: Date,
  budget: RunBudget
): Promise<RetentionPassResult> {
  const cutoff = daysBefore(now, config.outputRawRetentionDays);
  return runKeysetPass({
    pass: "output_raw",
    config,
    budget,
    selectPage: (limit, cursor) => outputRawPageQuery(cutoff, cursor, limit),
    apply: (ids) =>
      db
        .update(workflowExecutionLogs)
        .set({ outputRaw: null })
        .where(inArray(workflowExecutionLogs.id, ids)),
  });
}

/**
 * One page of the output_raw pass: step logs past `cutoff` that still carry
 * `output_raw` and whose run cannot resume, after `cursor`. Exported so a test
 * can EXPLAIN the SQL the pass really sends.
 */
export function outputRawPageQuery(
  cutoff: Date,
  cursor: PageCursor | null,
  limit: number
) {
  return db
    .select({
      id: workflowExecutionLogs.id,
      at: sortKey(workflowExecutionLogs.startedAt),
    })
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
        ]),
        afterCursor(
          workflowExecutionLogs.startedAt,
          workflowExecutionLogs.id,
          cursor
        )
      )
    )
    .orderBy(workflowExecutionLogs.startedAt, workflowExecutionLogs.id)
    .limit(limit);
}

/**
 * Where the next page starts: the sort key of the last row the previous page
 * returned. `at` is the timestamp as Postgres prints it, see sortKey.
 */
export type PageCursor = { at: string; id: string };

/** One row of a page: its id and the timestamp the pass orders by. */
type PageRow = { id: string; at: string };

type KeysetPass = {
  pass: RetentionPassName;
  config: RetentionConfig;
  budget: RunBudget;
  /** The next page after `cursor`, ordered by the `(at, id)` it compares. */
  selectPage: (
    limit: number,
    cursor: PageCursor | null
  ) => PromiseLike<PageRow[]>;
  /** Act on exactly the ids of one page. Never called in a dry run. */
  apply: (ids: string[]) => PromiseLike<unknown>;
  /**
   * The dry run's figure in one statement, for a pass whose predicate an index
   * answers on its own. Without it a dry run walks the pages instead.
   */
  countEligible?: () => PromiseLike<number>;
};

/**
 * `(at, id) > (cursor.at, cursor.id)`: start a page right after the last row of
 * the previous one. Postgres answers the row comparison with an index range on
 * `at` and checks `id` on the rows at the boundary, so the page stays on the
 * pass's timestamp index.
 */
function afterCursor(
  at: PgColumn,
  id: PgColumn,
  cursor: PageCursor | null
): SQL | undefined {
  if (!cursor) {
    return;
  }
  // Every column a pass orders by is `timestamp without time zone`.
  return sql`(${at}, ${id}) > (${cursor.at}::timestamp, ${cursor.id})`;
}

/**
 * A page's sort timestamp as text. The columns keep microseconds and a JS Date
 * keeps milliseconds, so a cursor read back as a Date sits just before its own
 * row: the next page returns that row again, and a page of one never moves.
 */
function sortKey(column: PgColumn): SQL<string> {
  return sql<string>`${column}::text`;
}

/**
 * Walk a pass in pages ordered by `(timestamp, id)`, each starting right after
 * the last row of the page before, and act on exactly the ids of each page. The
 * two-step shape is what keeps memory flat: at most `batchSize` ids exist at
 * once, unlike purgeExpiredAuditEvents, which materialises every deleted id in
 * one go and would not survive this table.
 *
 * Every page is its own statement, so no transaction is held open long enough
 * to block autovacuum -- the exact failure mode that pinned the database on
 * 2026-09-02.
 *
 * The cursor keeps the cost of a page flat. A deleted or nulled row stays in
 * the index until vacuum removes it, so a page that started again at the front
 * each time had to walk past everything the run had already done, and got
 * slower the further the run went.
 *
 * A dry run counts in one statement where the pass supplies `countEligible`.
 * Otherwise it reads the same pages and writes nothing; the cursor still moves,
 * so the walk ends. A walk makes no progress from one dry run to the next, so
 * one that outlasts the budget reports how far it got, with `budgetExhausted`
 * set, and every pass behind it reports nothing -- which is why a pass that can
 * count does, and why the one that cannot runs last.
 */
async function runKeysetPass({
  pass,
  config,
  budget,
  selectPage,
  apply,
  countEligible,
}: KeysetPass): Promise<RetentionPassResult> {
  if (config.dryRun && countEligible) {
    if (budget.exhausted) {
      return { pass, rows: 0, budgetExhausted: true };
    }
    return { pass, rows: await countEligible(), budgetExhausted: false };
  }

  let rows = 0;
  let cursor: PageCursor | null = null;

  for (;;) {
    if (budget.exhausted) {
      return { pass, rows, budgetExhausted: true };
    }

    const page = await selectPage(config.batchSize, cursor);
    const last = page.at(-1);
    if (!last) {
      return { pass, rows, budgetExhausted: false };
    }

    if (!config.dryRun) {
      await apply(page.map((row) => row.id));
    }
    rows += page.length;
    cursor = { at: last.at, id: last.id };
  }
}
