import { and, asc, eq, gt, isNull, lte, type SQL, sql } from "drizzle-orm";
import type { db as appDb } from "@/lib/db";
import { workflowExecutions } from "@/lib/db/schema";
import type { WorkflowExecutionStatus } from "@/lib/errors/execution-status";
import { completedStepSince } from "@/lib/reaper/completed-step-since";
import { staleExecutionThresholdMinutes } from "@/lib/reaper/stale-threshold";

// Not finished yet. 'unconfirmed' is left out: its steps are done, only the receipt is pending.
const ACTIVE_RUN_STATUSES: readonly WorkflowExecutionStatus[] = [
  "phantom",
  "pending",
  "running",
];

// The run page strips the "Execution skipped:" prefix, as for every other skip reason.
const SKIPPED_WHILE_RUNNING =
  "Execution skipped: the previous run of this workflow was still running.";

type Database = typeof appDb;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type NewRun = typeof workflowExecutions.$inferInsert;

type SkipCheckedInsert = {
  id: string;
  skipped: boolean;
  alreadyExisted: boolean;
};

// Literals, not parameters, so the partial idx_workflow_executions_live_started matches under generic plans.
const ACTIVE_STATUS_LIST = sql.raw(
  ACTIVE_RUN_STATUSES.map((status) => `'${status}'`).join(", ")
);

// Older live rows probed for a step per dispatch: about 20-30 ms at the cap (EXPLAIN, generic plan).
const OLDER_LIVE_ROWS_MAX = 1000;

/** Live, not reaped, and not another caller's run (trigger_source 'mcp'). */
function liveRunOf(workflowId: string): SQL | undefined {
  return and(
    eq(workflowExecutions.workflowId, workflowId),
    sql`${workflowExecutions.status} IN (${ACTIVE_STATUS_LIST})`,
    isNull(workflowExecutions.deletedAt),
    sql`${workflowExecutions.triggerSource} IS DISTINCT FROM 'mcp'`
  );
}

/**
 * A live run of the workflow, or null: the oldest one started within the stale
 * limit, else the oldest still progressing (a step completed since, which the
 * reaper also spares) among the newest OLDER_LIVE_ROWS_MAX older ones.
 */
async function findBlockingRun(
  tx: Pick<Transaction, "select">,
  workflowId: string,
  now: Date
): Promise<string | null> {
  const cutoff = new Date(
    now.getTime() - staleExecutionThresholdMinutes() * 60 * 1000
  );
  // Live rows only: idx_workflow_executions_live_started (workflow_id, started_at) serves it.
  const [recent] = await tx
    .select({ id: workflowExecutions.id })
    .from(workflowExecutions)
    .where(and(liveRunOf(workflowId), gt(workflowExecutions.startedAt, cutoff)))
    .orderBy(asc(workflowExecutions.startedAt))
    .limit(1);
  if (recent) {
    return recent.id;
  }
  // The newest OLDER_LIVE_ROWS_MAX older live rows (same partial index), each
  // probing idx_exec_logs_execution_id: stalled rows never reaped pile up oldest.
  const candidates = tx
    .select({
      id: workflowExecutions.id,
      startedAt: workflowExecutions.startedAt,
    })
    .from(workflowExecutions)
    .where(
      and(liveRunOf(workflowId), lte(workflowExecutions.startedAt, cutoff))
    )
    // NULLS LAST as in the index, so its scan stops at the cap instead of sorting.
    .orderBy(sql`${workflowExecutions.startedAt} DESC NULLS LAST`)
    .limit(OLDER_LIVE_ROWS_MAX)
    .as("older_live");
  const [older] = await tx
    .select({ id: candidates.id })
    .from(candidates)
    .where(completedStepSince(cutoff, candidates.id))
    .orderBy(asc(candidates.startedAt))
    .limit(1);
  return older?.id ?? null;
}

// A repeat of a dispatch (HTTP retry within ~17 s, leader overlap, late block) comes
// well within this; a Skipped row remembers each key it counted this long.
const REPEAT_WINDOW_MS = 2 * 60 * 1000;
// Upper bound on remembered keys: 2 minutes of a 17-blocks-per-second chain.
const SKIPPED_KEYS_MAX = 2048;
// completed_at (indexed) moves at most once a minute; between, a skip rewrites only output.
const SKIPPED_ROW_REFRESH_SECONDS = 60;

type Tx = Pick<Transaction, "select">;

/** The advisory lock key that serialises dispatches of one workflow. */
function skipLockKey(workflowId: string): string {
  return `skip-if-running:${workflowId}`;
}

/** This workflow's Skipped row that counted the dispatch key in the repeat window, if any. */
async function findSkippedKey(
  tx: Tx,
  workflowId: string,
  dispatchKey: string,
  now: Date
): Promise<string | null> {
  // completed_at can trail the row's newest key by up to the refresh interval.
  const windowStart = new Date(
    now.getTime() - REPEAT_WINDOW_MS - SKIPPED_ROW_REFRESH_SECONDS * 1000
  );
  // Served by the partial idx_workflow_executions_skipped_behind (workflow_id, completed_at).
  // No started_at bound: a row counts for as long as its blocker progresses.
  const [row] = await tx
    .select({ id: workflowExecutions.id })
    .from(workflowExecutions)
    .where(
      and(
        eq(workflowExecutions.workflowId, workflowId),
        // Literals, not parameters, so the planned partial index matches under generic plans.
        sql`${workflowExecutions.status} = 'skipped'`,
        sql`${workflowExecutions.dispatchKey} LIKE 'skipped-behind:%'`,
        gt(workflowExecutions.completedAt, windowStart),
        sql`jsonb_exists(${workflowExecutions.output}->'keys', ${dispatchKey}::text)`
      )
    )
    .limit(1);
  return row?.id ?? null;
}

/**
 * Insert a phantom run unless a run of the workflow is live. A skipped dispatch
 * adds one to a single Skipped row per blocking run instead. The advisory lock
 * serialises dispatches of one workflow from the check to the write.
 */
export function insertPhantomUnlessRunning(
  database: Database,
  values: NewRun & { workflowId: string; dispatchKey: string },
  now: Date = new Date()
): Promise<SkipCheckedInsert> {
  const key = values.dispatchKey;
  return database.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${skipLockKey(values.workflowId)}))`
    );
    // A dispatch already made (phantom, or a skip counted) must not run or count again.
    const existing = await findByDispatchKey(tx, key);
    if (existing) {
      return { ...existing, alreadyExisted: true };
    }
    const countedSkip = await findSkippedKey(tx, values.workflowId, key, now);
    if (countedSkip) {
      return { id: countedSkip, skipped: true, alreadyExisted: true };
    }
    const blockingRunId = await findBlockingRun(tx, values.workflowId, now);
    if (!blockingRunId) {
      const [created] = await tx
        .insert(workflowExecutions)
        .values({ ...values, status: "phantom", billable: false })
        .onConflictDoNothing({ target: workflowExecutions.dispatchKey })
        .returning({ id: workflowExecutions.id });
      if (created) {
        return { id: created.id, skipped: false, alreadyExisted: false };
      }
      // An unflagged dispatch of the same key won the insert.
      return { ...(await requireRow(tx, key)), alreadyExisted: true };
    }
    // output.refusals is the count the run page shows; output.keys maps each counted key to its epoch ms.
    const keys = sql`${workflowExecutions.output}->'keys'`;
    const nowMs = now.getTime();
    const [skipped] = await tx
      .insert(workflowExecutions)
      .values({
        ...values,
        status: "skipped",
        billable: false,
        error: SKIPPED_WHILE_RUNNING,
        output: { refusals: 1, keys: { [key]: nowMs } },
        dispatchKey: `skipped-behind:${blockingRunId}`,
        startedAt: now,
        completedAt: now,
      })
      .onConflictDoUpdate({
        target: workflowExecutions.dispatchKey,
        set: {
          completedAt: sql`CASE WHEN coalesce(${workflowExecutions.completedAt}, '-infinity') <= excluded.completed_at - make_interval(secs => ${SKIPPED_ROW_REFRESH_SECONDS}) THEN excluded.completed_at ELSE ${workflowExecutions.completedAt} END`,
          // Keys older than the repeat window are dropped; newest kept up to the cap.
          output: sql`jsonb_build_object(
            'refusals', coalesce((${workflowExecutions.output}->>'refusals')::int, 1) + 1,
            'keys', (SELECT coalesce(jsonb_object_agg(k, v), '{}'::jsonb) FROM (
              SELECT k, v FROM jsonb_each(
                CASE WHEN jsonb_typeof(${keys}) = 'object' THEN ${keys} ELSE '{}'::jsonb END
                || jsonb_build_object(${key}::text, ${nowMs}::bigint)) AS e(k, v)
              WHERE (v #>> '{}')::bigint > ${nowMs - REPEAT_WINDOW_MS}::bigint
              ORDER BY (v #>> '{}')::bigint DESC LIMIT ${SKIPPED_KEYS_MAX}) kept))`,
        },
        // Already counted on this row (a repeat older than the lookup window).
        setWhere: sql`NOT coalesce(jsonb_exists(${keys}, ${key}::text), false)`,
      })
      .returning({ id: workflowExecutions.id });
    if (skipped) {
      return { id: skipped.id, skipped: true, alreadyExisted: false };
    }
    const counted = await requireRow(tx, `skipped-behind:${blockingRunId}`);
    return { id: counted.id, skipped: true, alreadyExisted: true };
  });
}

async function findByDispatchKey(
  tx: Tx,
  dispatchKey: string
): Promise<{ id: string; skipped: boolean } | null> {
  const [row] = await tx
    .select({ id: workflowExecutions.id, status: workflowExecutions.status })
    .from(workflowExecutions)
    .where(eq(workflowExecutions.dispatchKey, dispatchKey))
    .limit(1);
  return row ? { id: row.id, skipped: row.status === "skipped" } : null;
}

async function requireRow(
  tx: Tx,
  dispatchKey: string
): Promise<{ id: string; skipped: boolean }> {
  const row = await findByDispatchKey(tx, dispatchKey);
  if (!row) {
    throw new Error(`Dispatch key conflict without a row: ${dispatchKey}`);
  }
  return row;
}
