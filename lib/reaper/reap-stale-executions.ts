import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflowExecutionLogs, workflowExecutions } from "@/lib/db/schema";
import { walletLocks } from "@/lib/db/schema-extensions";
import { classifyExecutionError } from "@/lib/errors/classify";
import type { ErrorCode } from "@/lib/errors/error-codes";
import { recordExecutionErrorFinalized } from "@/lib/errors/finalize-error";

const DEFAULT_THRESHOLD_MINUTES = 30;

// Pending rows that have produced no step logs are unambiguously stuck:
// the executor inserted but the runtime never started. A few minutes is
// generous for image pulls and k8s scheduling; beyond that, it's dead.
const PENDING_THRESHOLD_MINUTES = 5;

function getThresholdMinutes(): number {
  const envValue = process.env.STALE_EXECUTION_THRESHOLD_MINUTES;
  if (!envValue) {
    return DEFAULT_THRESHOLD_MINUTES;
  }
  const parsed = Number.parseInt(envValue, 10);
  return Number.isNaN(parsed) ? DEFAULT_THRESHOLD_MINUTES : parsed;
}

/**
 * Find workflow executions stuck past their threshold, mark them system_error
 * with a timeout classification, close their orphaned step logs, and release any
 * nonce locks they still hold. Returns the reaped execution ids.
 *
 * Classification tracks whether the row ever produced a step log, not just its
 * raw status. The runner writes the trigger node's step log at step START,
 * before any user action step, so a `running` row with NO step logs never
 * entered the workflow body - the pod died/never scheduled - which is an
 * infrastructure failure (P-0001), classified like `pending`/`phantom`, not a
 * workflow_engine fault (E-0001). This keeps a FailedCreatePodSandBox burst in
 * the infrastructure series the SLA alert watches. A `running` row that DID log
 * a step but then stalled is a workflow_engine timeout (E-0001).
 *
 * A never-progressed `running` row is reaped at the same (long) running
 * threshold as a stalled one, NOT the (short) pending threshold - only the
 * classification differs by step-log presence, the timing does not. A durably
 * enqueued run also sits `running` with no step logs until a worker picks it up,
 * and is indistinguishable in the DB from a pod that never scheduled; reaping
 * running+no-logs at the pending cutoff would false-fail healthy runs waiting on
 * a backed-up worker queue - exactly the incident conditions this reaper runs
 * in - and inflate the infrastructure counter it exists to keep accurate.
 */
export async function reapStaleExecutions(
  thresholdMinutes: number = getThresholdMinutes()
): Promise<string[]> {
  const runningCutoff = new Date(Date.now() - thresholdMinutes * 60 * 1000);
  const pendingCutoff = new Date(
    Date.now() - PENDING_THRESHOLD_MINUTES * 60 * 1000
  );

  // Whether an execution has produced ANY step log. The runner writes the
  // trigger step's log before the first user step, so its presence means the
  // pod entered the workflow body.
  const hasStepLogs = sql`EXISTS (
    SELECT 1 FROM ${workflowExecutionLogs}
    WHERE ${workflowExecutionLogs.executionId} = ${workflowExecutions.id}
  )`;
  const noStepLogs = sql`NOT ${hasStepLogs}`;

  // A step that COMPLETED after the running cutoff means the execution is still
  // progressing - never reap it even past the running threshold.
  //
  // This correlates on execution_id, so Postgres probes
  // idx_exec_logs_execution_id once per reap candidate, and the candidate set is
  // a handful of rows. The earlier form pre-selected every recently completed
  // step id in one pass and passed the result to NOT IN. No index covered
  // completed_at, so that pass sequentially scanned the whole log table - 23M
  // rows and 22 GB on prod - to return about a thousand ids. It took 150 to 175
  // seconds on every 10-minute run, and it started failing outright once a 120s
  // statement_timeout landed on the role.
  const noRecentlyCompletedStep = sql`NOT EXISTS (
    SELECT 1 FROM ${workflowExecutionLogs}
    WHERE ${workflowExecutionLogs.executionId} = ${workflowExecutions.id}
      AND ${workflowExecutionLogs.completedAt} > ${sql.param(runningCutoff, workflowExecutionLogs.completedAt)}
  )`;

  const staleConditions = or(
    // running, older than the running threshold (default 30 min), not recently
    // active. Covers both a run that progressed then stalled and one that never
    // produced a step log; the CASEs below split them by step-log presence into
    // workflow_engine/E-0001 vs infrastructure/P-0001. Both wait the full
    // running threshold: a never-progressed running row is indistinguishable in
    // the DB from a healthy run still queued for a worker (see the doc above).
    and(
      eq(workflowExecutions.status, "running"),
      lt(workflowExecutions.startedAt, runningCutoff),
      noRecentlyCompletedStep
    ),
    // pending + no step logs, older than the pending threshold -> P-0001.
    and(
      eq(workflowExecutions.status, "pending"),
      lt(workflowExecutions.startedAt, pendingCutoff),
      noStepLogs
    ),
    // phantom, older than the pending threshold -> P-0005 (never picked up).
    and(
      eq(workflowExecutions.status, "phantom"),
      lt(workflowExecutions.startedAt, pendingCutoff)
    )
  );

  const reaperErrorMessage = `Execution timed out: no progress for ${thresholdMinutes} minutes`;
  const reaperClassification = classifyExecutionError(reaperErrorMessage);

  const reaped = await db
    .update(workflowExecutions)
    .set({
      status: "system_error",
      error: reaperErrorMessage,
      // errorCategory tracks step-log presence: only a 'running' row that
      // actually produced a step log is a workflow_engine fault; pending,
      // phantom, and never-logged running rows are infrastructure. Keeping
      // FailedCreatePodSandBox out of the workflow_engine series matters for the
      // SLA alert.
      errorCategory: sql<string>`CASE
        WHEN ${workflowExecutions.status} = 'running' AND ${hasStepLogs} THEN 'workflow_engine'
        ELSE 'infrastructure' END`,
      errorType: reaperClassification.errorType,
      // running-with-logs -> timed out (E-0001); phantom -> never picked up
      // (P-0005); pending and never-logged running -> never started (P-0001).
      errorCode: sql<ErrorCode>`CASE
        WHEN ${workflowExecutions.status} = 'phantom' THEN 'P-0005'
        WHEN ${workflowExecutions.status} = 'running' AND ${hasStepLogs} THEN 'E-0001'
        ELSE 'P-0001' END`,
      completedAt: new Date(),
      duration: sql`ROUND(EXTRACT(EPOCH FROM (NOW() - ${workflowExecutions.startedAt})) * 1000)`,
    })
    .where(staleConditions)
    .returning({
      id: workflowExecutions.id,
      workflowId: workflowExecutions.workflowId,
      errorCategory: workflowExecutions.errorCategory,
    });

  const reapedIds = reaped.map((row) => row.id);

  // Emit one classified counter increment per reaped row (SLA alert source).
  // persistedStatus is the status we actually wrote above, so the finished
  // counter's status label matches the DB.
  for (const row of reaped) {
    await recordExecutionErrorFinalized({
      workflowId: row.workflowId,
      errorMessage: reaperErrorMessage,
      persistedStatus: "system_error",
      errorCategory: row.errorCategory ?? undefined,
    });
  }

  if (reapedIds.length > 0) {
    // Close orphaned 'running' step logs so the UI doesn't show stuck spinners.
    await db
      .update(workflowExecutionLogs)
      .set({
        status: "error",
        error: "Step did not record completion",
        completedAt: new Date(),
      })
      .where(
        and(
          inArray(workflowExecutionLogs.executionId, reapedIds),
          eq(workflowExecutionLogs.status, "running")
        )
      );

    // Release nonce locks still held by reaped executions, but only ones that
    // have already lapsed. A lock whose expires_at is still in the future is
    // being renewed by a live heartbeat, and clearing it hands the wallet to a
    // waiter while the holder is mid-write: the waiter reads getTransactionCount
    // and computes the very nonce the holder is about to broadcast at. A holder
    // that is genuinely dead stops beating and lapses within one TTL, which is
    // far inside the (much longer) threshold that got it reaped in the first
    // place, so nothing that used to be unwedged here stays wedged.
    await db
      .update(walletLocks)
      .set({ lockedBy: null, lockedAt: null, expiresAt: sql`NOW()` })
      .where(
        and(
          inArray(walletLocks.lockedBy, reapedIds),
          lt(walletLocks.expiresAt, sql`NOW()`)
        )
      );
  }

  return reapedIds;
}
