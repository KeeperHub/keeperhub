import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { db as appDb } from "@/lib/db";
import { workflowExecutions } from "@/lib/db/schema";
import type { WorkflowExecutionStatus } from "@/lib/errors/execution-status";
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

export type SkipCheckedInsert = {
  id: string;
  skipped: boolean;
  alreadyExisted: boolean;
};

/**
 * The oldest live run of the workflow, or null. Runs started through the
 * listed-workflow call endpoint (trigger_source 'mcp') are other callers' runs
 * and do not count; neither does a run older than the reaper's stale limit.
 */
export async function findBlockingRun(
  tx: Pick<Transaction, "select">,
  workflowId: string,
  now: Date = new Date()
): Promise<string | null> {
  const cutoff = new Date(
    now.getTime() - staleExecutionThresholdMinutes() * 60 * 1000
  );
  // workflow_id + started_at range: idx_workflow_executions_workflow_started can serve it.
  const [row] = await tx
    .select({ id: workflowExecutions.id })
    .from(workflowExecutions)
    .where(
      and(
        eq(workflowExecutions.workflowId, workflowId),
        gt(workflowExecutions.startedAt, cutoff),
        inArray(workflowExecutions.status, [...ACTIVE_RUN_STATUSES]),
        isNull(workflowExecutions.deletedAt),
        sql`${workflowExecutions.triggerSource} IS DISTINCT FROM 'mcp'`
      )
    )
    .orderBy(asc(workflowExecutions.startedAt))
    .limit(1);
  return row?.id ?? null;
}

// A repeat of a dispatch (HTTP retry within ~17 s, leader overlap, late block) comes
// well within this; a Skipped row remembers each key it counted this long.
const REPEAT_WINDOW_MS = 2 * 60 * 1000;
// Upper bound on remembered keys: 2 minutes of a 17-blocks-per-second chain.
const SKIPPED_KEYS_MAX = 2048;

type Tx = Pick<Transaction, "select">;

/** The advisory lock key that serialises dispatches of one workflow. */
export function skipLockKey(workflowId: string): string {
  return `skip-if-running:${workflowId}`;
}

/** This workflow's Skipped row that counted the dispatch key in the repeat window, if any. */
async function findSkippedKey(
  tx: Tx,
  workflowId: string,
  dispatchKey: string,
  now: Date
): Promise<string | null> {
  const windowStart = new Date(now.getTime() - REPEAT_WINDOW_MS);
  // A row still counting started at most the stale limit before its last skip.
  const oldestStart = new Date(
    windowStart.getTime() - staleExecutionThresholdMinutes() * 60 * 1000
  );
  // Served by the partial idx_workflow_executions_skipped_behind (workflow_id, completed_at);
  // where it is missing, the started_at bound lets idx_workflow_executions_workflow_started serve it.
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
        gt(workflowExecutions.startedAt, oldestStart),
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
          completedAt: sql`greatest(${workflowExecutions.completedAt}, excluded.completed_at)`,
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
