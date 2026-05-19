import { and, eq, gt, inArray, lt, notInArray, or, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { workflowExecutionLogs, workflowExecutions } from "@/lib/db/schema";
import { walletLocks } from "@/lib/db/schema-extensions";
import { classifyExecutionError } from "@/lib/errors/classify";
import { recordExecutionErrorFinalized } from "@/lib/errors/finalize-error";
import { authenticateInternalService } from "@/lib/internal-service-auth";
import { ErrorCategory, logSystemError } from "@/lib/logging";

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
 * GET /api/internal/reaper
 *
 * Finds workflow executions stuck in "running" state with no recent activity
 * and marks them as "error" with a timeout message.
 *
 * Intended to be called by an external cron job (K8s CronJob).
 */
export async function GET(request: Request): Promise<NextResponse> {
  const auth = authenticateInternalService(request);
  if (!auth.authenticated) {
    return NextResponse.json(
      { error: auth.error ?? "Unauthorized" },
      { status: 401 }
    );
  }

  try {
    const thresholdMinutes = getThresholdMinutes();
    const runningCutoff = new Date(Date.now() - thresholdMinutes * 60 * 1000);
    const pendingCutoff = new Date(
      Date.now() - PENDING_THRESHOLD_MINUTES * 60 * 1000
    );

    // Find execution IDs that have recent step activity (should NOT be reaped)
    const activeExecutionIds = await db
      .select({
        executionId: workflowExecutionLogs.executionId,
      })
      .from(workflowExecutionLogs)
      .where(gt(workflowExecutionLogs.completedAt, runningCutoff))
      .groupBy(workflowExecutionLogs.executionId);

    const excludeIds = activeExecutionIds.map((row) => row.executionId);

    // Bulk update all stale executions in a single query.
    //
    // Two independent stuck-state predicates combined with OR:
    //   - status='running' rows that haven't recorded recent step activity
    //     within the running threshold (default 30 min). The runtime claimed
    //     the execution but stopped progressing.
    //   - status='pending' rows older than the pending threshold (5 min) with
    //     no step logs at all. The SQS executor inserted the row but the
    //     runtime never started (dispatch failed, pod crash before first
    //     step, etc). Guarded by NOT EXISTS rather than a NOT IN list because
    //     every successful execution has step logs and a NOT IN would load
    //     that entire set into the predicate.
    const staleConditions = or(
      and(
        eq(workflowExecutions.status, "running"),
        lt(workflowExecutions.startedAt, runningCutoff),
        excludeIds.length > 0
          ? notInArray(workflowExecutions.id, excludeIds)
          : undefined
      ),
      and(
        eq(workflowExecutions.status, "pending"),
        lt(workflowExecutions.startedAt, pendingCutoff),
        sql`NOT EXISTS (
          SELECT 1 FROM ${workflowExecutionLogs}
          WHERE ${workflowExecutionLogs.executionId} = ${workflowExecutions.id}
        )`
      )
    );

    // KEEP-545: reaped executions are by definition stuck/timed-out, which
    // classifies as WORKFLOW_ENGINE / system-side. Write the classification
    // columns and increment the per-org counter per reaped row.
    const reaperErrorMessage = `Execution timed out: no progress for ${thresholdMinutes} minutes`;
    const reaperClassification = classifyExecutionError(reaperErrorMessage);

    const reaped = await db
      .update(workflowExecutions)
      .set({
        status: "error",
        error: reaperErrorMessage,
        errorCategory: reaperClassification.errorCategory,
        errorType: reaperClassification.errorType,
        completedAt: new Date(),
        duration: sql`ROUND(EXTRACT(EPOCH FROM (NOW() - ${workflowExecutions.startedAt})) * 1000)`,
      })
      .where(staleConditions)
      .returning({
        id: workflowExecutions.id,
        workflowId: workflowExecutions.workflowId,
      });

    const reapedIds = reaped.map((row) => row.id);

    // KEEP-545: emit one counter increment per reaped row so the timeout
    // family shows up in the new classified counter the SLA alert watches.
    for (const row of reaped) {
      await recordExecutionErrorFinalized({
        workflowId: row.workflowId,
        errorMessage: reaperErrorMessage,
      });
    }

    // KEEP-333: Close orphaned 'running' step logs for reaped executions so
    // the UI doesn't show stuck spinners after the workflow has been marked
    // as timed out.
    if (reapedIds.length > 0) {
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

      // KEEP-344: Release any nonce locks still held by reaped executions.
      // The wallet_locks TTL would clear them on its own, but releasing them
      // here unwedges affected wallets immediately when reaper runs, instead
      // of leaving the user blocked until expires_at.
      await db
        .update(walletLocks)
        .set({
          lockedBy: null,
          lockedAt: null,
          expiresAt: sql`NOW()`,
        })
        .where(inArray(walletLocks.lockedBy, reapedIds));
    }

    return NextResponse.json({
      reapedCount: reapedIds.length,
      reapedIds,
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to reap stale executions",
      error,
      { endpoint: "/api/internal/reaper", operation: "get" }
    );
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to reap stale executions",
      },
      { status: 500 }
    );
  }
}
