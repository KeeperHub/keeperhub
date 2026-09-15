import "server-only";

import {
  and,
  count,
  eq,
  gte,
  inArray,
  isNotNull,
  lt,
  notInArray,
  type SQL,
  sql,
} from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
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
  resolveRecentPlanChanges,
} from "@/lib/retention/org-windows";
import {
  advanceWatermarksToFloor,
  getPurgeWatermarks,
  setPurgeWatermarks,
} from "@/lib/retention/progress";

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
const RESUMABLE = new Set<string>(RESUMABLE_EXECUTION_STATUSES);

/**
 * Runs per page in the plan-window and run-row passes. One execution carries
 * several step logs, so the row count a batch touches is a multiple of this;
 * keeping it well under `batchSize` holds a single statement inside the pool's
 * statement_timeout. The CronJob calls into the app pods, so the bound is
 * APP_STATEMENT_TIMEOUT_MS (30s), not the 120s role-level backstop.
 */
function executionBatchSize(config: RetentionConfig): number {
  return Math.max(1, Math.floor(config.batchSize / 10));
}

/**
 * Organizations behind a window's front that are probed one by one before the
 * walk. Past this many, the walk starts at each organization's watermark.
 */
const MAX_LAGGARD_PROBES = 200;

/**
 * Statement timeout for one laggard probe. A dense organization held down by a
 * run stuck long ago has many runs to look through; past this the probe gives
 * up and that organization is walked from its own watermark instead.
 */
const PROBE_TIMEOUT_MS = 5000;

/** SQLSTATE query_canceled, what a statement timeout raises. */
const QUERY_CANCELED = "57014";

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
   * Rows deleted, or nulled for the output_raw pass. In a dry run, what the same
   * pages would have touched, pass by pass: nothing is removed, so a later pass
   * also counts rows an earlier pass would have taken first. With
   * budgetExhausted set, the figure covers only the pages the pass reached.
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
  /** Present when a pass did nothing because its switch is off. */
  skipped?: "disabled";
  /**
   * Why the pass stopped early. `rows` still counts what the pages before the
   * failure committed.
   */
  error?: string;
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
  /** Set when a pass failed. The passes after it did not run. */
  failedPass?: RetentionPassName;
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
  // A failed pass comes back as a result, not a throw, carrying the rows its
  // earlier pages committed. The run stops there and the route reports the
  // partial result as a failure, so the work already done still shows.
  const finish = (failedPass?: RetentionPassName): RetentionRunResult => ({
    enabled: true,
    executionsEnabled: config.executionsEnabled,
    dryRun: config.dryRun,
    durationMs: Date.now() - startedAt,
    floorDays: schedule.floorDays,
    passes,
    totalRows: passes.reduce((sum, pass) => sum + pass.rows, 0),
    ...(failedPass && { failedPass }),
  });

  const floorCutoff = daysBefore(now, schedule.floorDays);
  const floor = await purgeLogsPastFloor(config, budget, floorCutoff);
  passes.push(floor);
  if (floor.error) {
    return finish(floor.pass);
  }

  // Record what the floor pass proved, before the per-organization pass reads
  // the watermarks. It deletes every step log past its cutoff with no
  // organization scope and no status guard, so once it drains, that instant is
  // true for every organization -- including the ones whose window is at or
  // above the floor, which never enter the pass below and would otherwise never
  // have a watermark at all.
  if (!(floor.budgetExhausted || config.dryRun)) {
    const error = await attempt(() => advanceWatermarksToFloor(floorCutoff));
    if (error !== undefined) {
      passes[passes.length - 1] = { ...floor, error };
      return finish(floor.pass);
    }
  }

  const planWindow = await purgeLogsPastPlanWindow(
    config,
    now,
    budget,
    schedule.groups,
    floorCutoff
  );
  passes.push(planWindow);
  if (planWindow.error) {
    return finish(planWindow.pass);
  }

  const outputRaw = await stripExpiredOutputRaw(config, now, budget);
  passes.push(outputRaw);
  if (outputRaw.error) {
    return finish(outputRaw.pass);
  }

  const softDeleted = await purgeSoftDeletedLogs(config, now, budget);
  passes.push(softDeleted);
  if (softDeleted.error) {
    return finish(softDeleted.pass);
  }

  const executions = await purgeExecutionsPastFlatWindow(config, now, budget);
  passes.push(executions);
  return finish(executions.error ? executions.pass : undefined);
}

/**
 * Pass 1. The backstop, and the workhorse: it runs at the LONGEST window any
 * organization is on, so the organizations holding most of the table (83% of it
 * on prod) are served by a plain index range on `started_at` with no join at
 * all, rather than by the per-organization pass below.
 */
function purgeLogsPastFloor(
  config: RetentionConfig,
  budget: RunBudget,
  cutoff: Date
): Promise<RetentionPassResult> {
  return runBatched({
    pass: "logs_floor",
    config,
    budget,
    selectPage: (limit, cursor) =>
      db
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
        .limit(limit),
    apply: async (keys) => {
      await db.delete(workflowExecutionLogs).where(
        inArray(
          workflowExecutionLogs.id,
          keys.map((key) => key.id)
        )
      );
      return keys.length;
    },
  });
}

/** One run of a plan-window page, with what the walk checks in code. */
type RunKey = BatchKey & {
  startedAt: Date;
  organizationId: string | null;
  status: WorkflowExecutionStatus;
};

/**
 * Pass 2. The product promise: step logs age out at the window the org's plan
 * sells (7 free, 30 pro, 90 business, or a per-org override). Organizations on
 * the longest window are not here -- pass 1 owns them.
 *
 * One walk per window over every run in the window's range, ordered by
 * `(started_at, id)`, with each run's organization checked here rather than in
 * SQL. A walk per organization put that filter in the query, and for an
 * organization with few runs the planner still walked the whole started_at
 * index looking for a page it could never fill. Without the filter a page is
 * simply the next runs by started_at, and a run of an organization on another
 * window is passed over. Rows are matched by their execution's `started_at`,
 * not their own, so a whole run's step logs retire together.
 *
 * The range starts where the window's organizations still have work (see
 * resolveWalkFrom) and never below the floor cutoff. Everything older belongs
 * to pass 1, and a dry run, which moves no watermark, would otherwise count
 * those rows twice.
 */
async function purgeLogsPastPlanWindow(
  config: RetentionConfig,
  now: Date,
  budget: RunBudget,
  groups: Array<{ retentionDays: number; organizationIds: string[] }>,
  floorCutoff: Date
): Promise<RetentionPassResult> {
  const windows: RetentionWindowReport[] = [];
  let rows = 0;
  let deferredOrganizations = 0;
  const result = (
    outcome: { budgetExhausted?: boolean; error?: string } = {}
  ): RetentionPassResult => ({
    pass: "logs_plan_window",
    rows,
    budgetExhausted: outcome.budgetExhausted ?? false,
    windows,
    deferredOrganizations,
    ...(outcome.error !== undefined && { error: outcome.error }),
  });

  // Pages may already have committed when a lookup or a watermark write
  // throws, so a throw becomes this pass's error instead of losing its rows.
  try {
    // An organization whose plan just changed is left alone for the grace
    // period, so a lapse can be undone before the shorter window deletes the
    // difference. Resolved per run, so the dry run reports the same deferral.
    const deferred = await resolveRecentPlanChanges(
      new Date(now.getTime() - config.planChangeGraceMs)
    );

    for (const group of groups) {
      const cutoff = daysBefore(now, group.retentionDays);
      const report: RetentionWindowReport = {
        retentionDays: group.retentionDays,
        organizationCount: group.organizationIds.length,
        rows: 0,
      };
      windows.push(report);

      const starts = await resolveWalkStarts(
        group.organizationIds,
        deferred,
        floorCutoff,
        cutoff
      );
      deferredOrganizations += starts.deferred;
      if (starts.from.size === 0) {
        continue;
      }

      // The oldest run per organization the walk had to skip because it can
      // still resume, read off the probes and the pages themselves. The
      // watermark stops there, so a run that finishes after the walk passed it
      // is picked up by a later run instead of being left below the watermark
      // for good.
      const skipped = new Map<string, Date>();
      const walkFrom = await resolveWalkFrom(starts.from, skipped, budget);
      if (walkFrom === null) {
        return result({ budgetExhausted: true });
      }
      const lowest = earliest(walkFrom);
      const deletable = (page: RunKey[]): string[] => {
        const ids: string[] = [];
        for (const run of page) {
          const start =
            run.organizationId === null
              ? undefined
              : walkFrom.get(run.organizationId);
          if (
            run.organizationId === null ||
            start === undefined ||
            run.startedAt < start
          ) {
            continue;
          }
          if (!RESUMABLE.has(run.status)) {
            ids.push(run.id);
            continue;
          }
          const pin = skipped.get(run.organizationId);
          if (pin === undefined || run.startedAt < pin) {
            skipped.set(run.organizationId, run.startedAt);
          }
        }
        return ids;
      };

      const walk = await walkPages<RunKey>({
        config,
        budget,
        pageSize: executionBatchSize(config),
        selectPage: (limit, cursor) =>
          db
            .select({
              id: workflowExecutions.id,
              at: sortKey(workflowExecutions.startedAt),
              startedAt: workflowExecutions.startedAt,
              organizationId: workflows.organizationId,
              status: workflowExecutions.status,
            })
            .from(workflowExecutions)
            .innerJoin(
              workflows,
              eq(workflows.id, workflowExecutions.workflowId)
            )
            .where(
              and(
                gte(workflowExecutions.startedAt, lowest),
                lt(workflowExecutions.startedAt, cutoff),
                afterCursor(
                  workflowExecutions.startedAt,
                  workflowExecutions.id,
                  cursor
                )
              )
            )
            .orderBy(workflowExecutions.startedAt, workflowExecutions.id)
            .limit(limit),
        apply: async (page) => {
          const ids = deletable(page);
          if (ids.length === 0) {
            return 0;
          }
          const deleted = await db
            .delete(workflowExecutionLogs)
            .where(inArray(workflowExecutionLogs.executionId, ids));
          return deleted.count;
        },
        measure: async (page) => {
          const ids = deletable(page);
          if (ids.length === 0) {
            return 0;
          }
          const [{ n }] = await db
            .select({ n: count() })
            .from(workflowExecutionLogs)
            .where(inArray(workflowExecutionLogs.executionId, ids));
          return n;
        },
      });

      report.rows = walk.rows;
      rows += walk.rows;

      // Drained: every run in the range was handled, up to the cutoff. Stopped
      // by the budget or an error: every run before the last one handled was,
      // so progress is recorded there and the next run continues instead of
      // starting the window over. That instant is the millisecond floor of the
      // run's started_at and the lower bound is inclusive, so a run sharing it
      // is walked again rather than skipped. A dry run claims nothing, since it
      // deleted nothing.
      const stopped = walk.budgetExhausted || walk.error !== undefined;
      const reached = stopped ? walk.last?.startedAt : cutoff;
      if (reached && !config.dryRun) {
        const writeError = await attempt(() =>
          setPurgeWatermarks(watermarksReached(starts.from, skipped, reached))
        );
        if (writeError !== undefined) {
          return result({
            error:
              walk.error === undefined
                ? writeError
                : `${walk.error}; recording progress also failed: ${writeError}`,
          });
        }
      }

      if (walk.error !== undefined) {
        return result({ error: walk.error });
      }
      if (walk.budgetExhausted) {
        return result({ budgetExhausted: true });
      }
    }
  } catch (error) {
    return result({ error: describeError(error) });
  }

  return result();
}

/**
 * Where each organization's walk starts: its watermark, raised to the floor
 * cutoff. Organizations already at their cutoff are left out, and so are the
 * deferred ones -- no watermark is written for those, so the next run picks
 * them up from exactly where they stand.
 */
async function resolveWalkStarts(
  organizationIds: string[],
  deferred: Set<string>,
  floorCutoff: Date,
  cutoff: Date
): Promise<{ from: Map<string, Date>; deferred: number }> {
  const watermarks = await getPurgeWatermarks(organizationIds);
  const from = new Map<string, Date>();
  let deferredCount = 0;
  for (const organizationId of organizationIds) {
    if (deferred.has(organizationId)) {
      deferredCount += 1;
      continue;
    }
    const watermark = watermarks.get(organizationId);
    const start =
      watermark && watermark > floorCutoff ? watermark : floorCutoff;
    if (start < cutoff) {
      from.set(organizationId, start);
    }
  }
  return { from, deferred: deferredCount };
}

/**
 * Where the SQL walk has to start for each organization. The walk is shared by
 * the whole window, so its lower bound is the lowest of these, and a single
 * organization far behind the rest would send every run back over the runs of
 * all the others. That happens for ordinary reasons: a new organization gets
 * the floor cutoff as its first watermark, a deferred one keeps an old one,
 * and a run stuck in a resumable status holds one down.
 *
 * So each organization behind the window's front is probed on its own,
 * through its workflows, for the two things that can matter below the front:
 * the earliest finished run that still has step logs, and the earliest run
 * that can still resume. The walk starts that organization at the first, or at
 * the front when there is none, and the second becomes its pin up front. A
 * probe that times out leaves the organization at its own watermark, which is
 * slower for the walk but still correct.
 *
 * Resolves to null when the budget runs out while probing.
 */
async function resolveWalkFrom(
  from: Map<string, Date>,
  skipped: Map<string, Date>,
  budget: RunBudget
): Promise<Map<string, Date> | null> {
  const front = latest(from);
  const laggards = [...from].filter(([, start]) => start < front);
  if (laggards.length > MAX_LAGGARD_PROBES) {
    return from;
  }

  const walkFrom = new Map(from);
  for (const [organizationId, start] of laggards) {
    if (budget.exhausted) {
      return null;
    }
    const probe = await probeLaggard(organizationId, start, front);
    if (probe === null) {
      continue;
    }
    walkFrom.set(organizationId, probe.work ?? front);
    if (probe.pinned) {
      skipped.set(organizationId, probe.pinned);
    }
  }
  return walkFrom;
}

/**
 * For one organization, within `[from, front)`: the earliest finished run that
 * still has step logs, and the earliest run that can still resume. A lateral
 * lookup per workflow, so each is an index seek on (workflow_id, started_at)
 * rather than a walk of the run table for a match. Null when it timed out.
 */
async function probeLaggard(
  organizationId: string,
  from: Date,
  front: Date
): Promise<{ work: Date | null; pinned: Date | null } | null> {
  const lower = sql.param(from, workflowExecutions.startedAt);
  const upper = sql.param(front, workflowExecutions.startedAt);
  const resumable = sql.join(
    RESUMABLE_EXECUTION_STATUSES.map((status) => sql`${status}`),
    sql`, `
  );
  const probe = sql`
    SELECT
      (SELECT min(r.started_at)
         FROM workflows w
         CROSS JOIN LATERAL (
           SELECT e.started_at
             FROM workflow_executions e
            WHERE e.workflow_id = w.id
              AND e.started_at >= ${lower} AND e.started_at < ${upper}
              AND e.status NOT IN (${resumable})
              AND EXISTS (
                SELECT 1 FROM workflow_execution_logs l WHERE l.execution_id = e.id
              )
            ORDER BY e.started_at
            LIMIT 1
         ) r
        WHERE w.organization_id = ${organizationId})::text AS work,
      (SELECT min(r.started_at)
         FROM workflows w
         CROSS JOIN LATERAL (
           SELECT e.started_at
             FROM workflow_executions e
            WHERE e.workflow_id = w.id
              AND e.started_at >= ${lower} AND e.started_at < ${upper}
              AND e.status IN (${resumable})
            ORDER BY e.started_at
            LIMIT 1
         ) r
        WHERE w.organization_id = ${organizationId})::text AS pinned
  `;

  try {
    const rows = await db.transaction(async (tx) => {
      await tx.execute(
        sql.raw(`SET LOCAL statement_timeout = ${PROBE_TIMEOUT_MS}`)
      );
      return await tx.execute<{ work: string | null; pinned: string | null }>(
        probe
      );
    });
    const row = rows[0];
    return {
      work: parseTimestampText(row?.work),
      pinned: parseTimestampText(row?.pinned),
    };
  } catch (error) {
    if (isStatementTimeout(error)) {
      return null;
    }
    throw error;
  }
}

/** True for a statement timeout, whether or not the driver error is wrapped. */
function isStatementTimeout(error: unknown): boolean {
  const code = (value: unknown): unknown =>
    value && typeof value === "object" && "code" in value
      ? (value as { code: unknown }).code
      : undefined;
  return (
    code(error) === QUERY_CANCELED ||
    (error instanceof Error && code(error.cause) === QUERY_CANCELED)
  );
}

/**
 * A `timestamp` Postgres printed as text, as a Date. The fraction is cut to
 * milliseconds, never rounded up, so the instant can only be at or before the
 * real one -- the safe side for a lower bound and for a watermark.
 */
function parseTimestampText(text: string | null | undefined): Date | null {
  return text ? new Date(`${text.replace(" ", "T")}Z`) : null;
}

function earliest(instants: Map<string, Date>): Date {
  return new Date(
    Math.min(...[...instants.values()].map((instant) => instant.getTime()))
  );
}

function latest(instants: Map<string, Date>): Date {
  return new Date(
    Math.max(...[...instants.values()].map((instant) => instant.getTime()))
  );
}

/**
 * The watermark each walked organization has earned: the instant the walk
 * reached, held back to the oldest run it had to skip. Only organizations it
 * moves forward are returned.
 */
function watermarksReached(
  from: Map<string, Date>,
  skipped: Map<string, Date>,
  reached: Date
): Map<string, Date> {
  const through = new Map<string, Date>();
  for (const [organizationId, start] of from) {
    const pin = skipped.get(organizationId);
    const mark = pin && pin < reached ? pin : reached;
    if (mark > start) {
      through.set(organizationId, mark);
    }
  }
  return through;
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
  const eligible = and(
    lt(workflowExecutionLogs.startedAt, cutoff),
    isNotNull(workflowExecutionLogs.outputRaw),
    notInArray(workflowExecutions.status, [...RESUMABLE_EXECUTION_STATUSES])
  );
  return runBatched({
    pass: "output_raw",
    config,
    budget,
    selectPage: (limit, cursor) =>
      db
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
            eligible,
            afterCursor(
              workflowExecutionLogs.startedAt,
              workflowExecutionLogs.id,
              cursor
            )
          )
        )
        .orderBy(workflowExecutionLogs.startedAt, workflowExecutionLogs.id)
        .limit(limit),
    apply: async (keys) => {
      await db
        .update(workflowExecutionLogs)
        .set({ outputRaw: null })
        .where(
          inArray(
            workflowExecutionLogs.id,
            keys.map((key) => key.id)
          )
        );
      return keys.length;
    },
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
    selectPage: (limit, cursor) =>
      db
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
        .limit(limit),
    apply: async (keys) => {
      await db.delete(workflowExecutionLogs).where(
        inArray(
          workflowExecutionLogs.id,
          keys.map((key) => key.id)
        )
      );
      return keys.length;
    },
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
function purgeExecutionsPastFlatWindow(
  config: RetentionConfig,
  now: Date,
  budget: RunBudget
): Promise<RetentionPassResult> {
  if (!config.executionsEnabled) {
    return Promise.resolve({
      pass: "executions_flat_window",
      rows: 0,
      budgetExhausted: false,
      skipped: "disabled",
    });
  }

  const cutoff = daysBefore(now, config.executionRetentionDays);

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

  return runBatched({
    pass: "executions_flat_window",
    config,
    budget,
    pageSize: executionBatchSize(config),
    selectPage: (limit, cursor) =>
      db
        .select({
          id: workflowExecutions.id,
          at: sortKey(workflowExecutions.startedAt),
        })
        .from(workflowExecutions)
        .where(
          and(
            eligible,
            afterCursor(
              workflowExecutions.startedAt,
              workflowExecutions.id,
              cursor
            )
          )
        )
        .orderBy(workflowExecutions.startedAt, workflowExecutions.id)
        .limit(limit),
    apply: async (keys) => {
      const ids = keys.map((key) => key.id);
      // One transaction so a run row can never survive the deletion of its own
      // logs. Children first: workflow_execution_logs and feedback both
      // reference workflow_executions ON DELETE NO ACTION.
      await db.transaction(async (tx) => {
        await tx
          .delete(workflowExecutionLogs)
          .where(inArray(workflowExecutionLogs.executionId, ids));
        await tx.delete(feedback).where(inArray(feedback.executionId, ids));
        await tx
          .delete(workflowExecutions)
          .where(inArray(workflowExecutions.id, ids));
      });
      return ids.length;
    },
  });
}

/**
 * The sort key of the last row a page returned; the next page starts after it.
 * `at` is the timestamp as Postgres prints it, see sortKey.
 */
type BatchCursor = { at: string; id: string };

/** One row of a page: its id and the timestamp the pass orders by. */
type BatchKey = { id: string; at: string };

type PageWalkSpec<K extends BatchKey> = {
  config: RetentionConfig;
  budget: RunBudget;
  /** Rows per page. Defaults to `config.batchSize`. */
  pageSize?: number;
  /** The next page after `cursor`, ordered by `(at, id)`. */
  selectPage: (limit: number, cursor: BatchCursor | null) => Promise<K[]>;
  /** Act on one page; resolves to the rows it touched. */
  apply: (page: K[]) => Promise<number>;
  /**
   * The rows `apply` would touch, for a dry run. Omitted where a page is the
   * rows themselves; the plan-window pass pages by run and counts their logs.
   */
  measure?: (page: K[]) => Promise<number>;
};

type PageWalk<K extends BatchKey> = {
  rows: number;
  budgetExhausted: boolean;
  /** The last row of the last page acted on, or null before the first. */
  last: K | null;
  error?: string;
};

/**
 * `(at, id) > (cursor.at, cursor.id)`: start a page right after the previous
 * one. Without it every page re-read the rows earlier pages had already
 * cleared -- on prod a sequential scan of the step-log table per page -- until
 * one page ran past the statement timeout and failed the run.
 */
function afterCursor(
  at: PgColumn,
  id: PgColumn,
  cursor: BatchCursor | null
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

/** The query error plus its database cause, which carries the actual reason. */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  return error.cause instanceof Error
    ? `${error.message}: ${error.cause.message}`
    : error.message;
}

/**
 * Walk a pass in pages, each starting after the last row the previous page
 * returned, and act on exactly the rows of each page. At most one page of ids
 * exists at a time, unlike purgeExpiredAuditEvents, which materialises every
 * deleted id in one go and would not survive this table. Every page is its own
 * statement, so no transaction is held open long enough to block autovacuum --
 * the failure mode that pinned the database on 2026-09-02.
 *
 * The cursor keeps every page the same cost however much the pass has already
 * cleared, because a page never goes back over rows behind it.
 *
 * A dry run walks the same pages and writes nothing. The cursor still moves,
 * so the walk ends -- never a count over the whole table, which on prod is a
 * full scan of the step-log table and cannot finish inside the timeout.
 *
 * A failure is returned rather than thrown, with the rows the earlier pages
 * already committed, so a run that dies partway still reports what it did.
 */
async function walkPages<K extends BatchKey>({
  config,
  budget,
  pageSize,
  selectPage,
  apply,
  measure,
}: PageWalkSpec<K>): Promise<PageWalk<K>> {
  const limit = pageSize ?? config.batchSize;
  let rows = 0;
  let last: K | null = null;

  try {
    for (;;) {
      if (budget.exhausted) {
        return { rows, budgetExhausted: true, last };
      }

      const cursor = last ? { at: last.at, id: last.id } : null;
      const page = await selectPage(limit, cursor);
      const end = page.at(-1);
      if (!end) {
        return { rows, budgetExhausted: false, last };
      }

      if (config.dryRun) {
        rows += measure ? await measure(page) : page.length;
      } else {
        rows += await apply(page);
      }
      last = end;
    }
  } catch (error) {
    return { rows, budgetExhausted: false, last, error: describeError(error) };
  }
}

/** A pass that is one page walk from start to finish. */
async function runBatched<K extends BatchKey>({
  pass,
  ...spec
}: PageWalkSpec<K> & {
  pass: RetentionPassName;
}): Promise<RetentionPassResult> {
  const { rows, budgetExhausted, error } = await walkPages(spec);
  return {
    pass,
    rows,
    budgetExhausted,
    ...(error !== undefined && { error }),
  };
}

/** Run one step outside a page walk; resolves to its error, if it threw. */
async function attempt(
  step: () => Promise<unknown>
): Promise<string | undefined> {
  try {
    await step();
    return;
  } catch (error) {
    return describeError(error);
  }
}
