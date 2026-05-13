/**
 * Server-only workflow logging functions
 * These replace the HTTP endpoint for better security
 */
import "server-only";

import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  organization,
  type TransactionHashEntry,
  workflowExecutionLogs,
  workflowExecutions,
  workflows,
} from "@/lib/db/schema";
import { classifyExecutionError } from "@/lib/errors/classify";
import { ErrorCategory, logSystemError, logSystemWarn } from "@/lib/logging";
import { getMetricsCollector } from "@/lib/metrics";
import { recordWorkflowExecutionError } from "@/lib/metrics/collectors/prometheus";
import { ANONYMOUS_ORG_SLUG } from "@/lib/metrics/db-metrics";
import {
  EXCEEDED_MAX_RETRIES_REGEX,
  FAILED_AFTER_RETRIES_REGEX,
  NO_STEP_COMPLETION_REGEX,
} from "@/lib/workflow/executor/runner-error-patterns";
import { getTransactionHashes } from "@/lib/workflow/executor/step-success-tracker";

const TERMINAL_STATUSES = new Set(["cancelled"]);

/**
 * KEEP-431 follow-up: matches the same SDK spurious error shapes that the
 * post-drain reconciler in executor.workflow.ts uses (runner-error-patterns).
 * Used to gate self-healing so a genuine error message is never overridden.
 */
function isSpuriousWorkflowError(error: string | null | undefined): boolean {
  if (!error) {
    return false;
  }
  return (
    EXCEEDED_MAX_RETRIES_REGEX.test(error) ||
    FAILED_AFTER_RETRIES_REGEX.test(error) ||
    NO_STEP_COMPLETION_REGEX.test(error)
  );
}

/**
 * Per-nodeId aggregate over workflow_execution_logs rows (top-level steps only).
 *
 * KEEP-431: A node can have multiple log rows (e.g. a cross-pod retry from the
 * SDK's "use step" boundary inserts a fresh row each time logStepStartDb runs).
 * Treat the node as succeeded if ANY of its rows is success -- only flag a
 * node as truly failed when no row succeeded for it.
 *
 * Filters out forEach iteration rows (`iteration_index` and `for_each_node_id`
 * are non-null on those). Iteration rows are scoped to a parent forEach node;
 * we only aggregate top-level steps here so we don't accidentally treat a
 * succeeded forEach with one failed iteration as fully succeeded. The forEach
 * runner is responsible for surfacing iteration failures via the parent node's
 * own success/error status.
 *
 * Returns the list of node IDs that have at least one log row but no success
 * row. Empty list means every observed node has at least one success row, so
 * the workflow body succeeded as a whole even if the SDK reported an error
 * via a spurious max-retries throw.
 */
async function listTrulyFailedNodes(executionId: string): Promise<string[]> {
  const allLogs = await db.query.workflowExecutionLogs.findMany({
    where: and(
      eq(workflowExecutionLogs.executionId, executionId),
      isNull(workflowExecutionLogs.iterationIndex),
      isNull(workflowExecutionLogs.forEachNodeId)
    ),
    columns: { nodeId: true, status: true },
  });

  const nodeSucceeded = new Map<string, boolean>();
  for (const log of allLogs) {
    if (log.status === "success") {
      nodeSucceeded.set(log.nodeId, true);
    } else if (!nodeSucceeded.has(log.nodeId)) {
      nodeSucceeded.set(log.nodeId, false);
    }
  }

  const trulyFailedNodes: string[] = [];
  for (const [nodeId, succeeded] of nodeSucceeded) {
    if (!succeeded) {
      trulyFailedNodes.push(nodeId);
    }
  }
  return trulyFailedNodes;
}

/**
 * Cross-pod fallback for TransactionHashEntry reconstruction.
 *
 * The in-memory tracker in step-success-tracker.ts is local to the Node
 * process that ran each step. When the SDK resumes a workflow on a different
 * pod, the tracker on the finalizing pod is empty. Reconstruct entries from
 * the durable workflow_execution_logs rows so success terminations can still
 * persist the full list.
 *
 * Ordered by started_at ASC so the array matches submission order even when
 * an SDK fan-out completes out of submit order. Deduped by hash string so SDK
 * retries that re-broadcast (same logical step, two distinct hashes) keep the
 * first-seen entry. nodeId-keyed dedupe would incorrectly collapse legitimate
 * For-Each iterations that share a nodeId.
 *
 * Optional fields are omitted from the entry when not present in output_raw
 * (or, for iterationIndex, when the log row is for a non-loop node), matching
 * the in-process harvester's shape so consumers see a uniform JSON regardless
 * of which path populated the column.
 *
 * Returns [] on query failure -- losing the hash list is preferable to
 * failing the UPDATE that flips status to success.
 *
 * The transactionHash IS NOT NULL filter is pushed into Postgres so a workflow
 * that runs a non-tx step many times (e.g. a For-Each over hundreds of HTTP
 * calls) does not stream every row back to Node just to discard it in JS.
 * The JS-side type guard below stays as the authoritative check: SQL only
 * confirms the key exists in output_raw, not that the value is a 0x string.
 */
async function loadHashesFromLogs(
  executionId: string
): Promise<TransactionHashEntry[]> {
  try {
    const rows = await db.query.workflowExecutionLogs.findMany({
      where: and(
        eq(workflowExecutionLogs.executionId, executionId),
        eq(workflowExecutionLogs.status, "success"),
        sql`${workflowExecutionLogs.outputRaw}->>'transactionHash' IS NOT NULL`
      ),
      columns: {
        nodeId: true,
        nodeName: true,
        iterationIndex: true,
        outputRaw: true,
      },
      orderBy: [asc(workflowExecutionLogs.startedAt)],
    });

    const seen = new Set<string>();
    const entries: TransactionHashEntry[] = [];
    for (const row of rows) {
      const o = row.outputRaw as {
        transactionHash?: unknown;
        chainId?: unknown;
        network?: unknown;
      } | null;
      if (
        o === null ||
        typeof o !== "object" ||
        typeof o.transactionHash !== "string" ||
        !o.transactionHash.startsWith("0x") ||
        seen.has(o.transactionHash)
      ) {
        continue;
      }
      seen.add(o.transactionHash);
      entries.push({
        hash: o.transactionHash,
        nodeId: row.nodeId,
        nodeName: row.nodeName,
        ...(typeof o.chainId === "number" && { chainId: o.chainId }),
        ...(typeof o.network === "string" && { network: o.network }),
        ...(row.iterationIndex !== null && {
          iterationIndex: row.iterationIndex,
        }),
      });
    }
    return entries;
  } catch (queryError) {
    logSystemError(
      ErrorCategory.WORKFLOW_ENGINE,
      "[Workflow Logging] Failed to load transaction hashes from logs",
      queryError,
      { execution_id: executionId }
    );
    return [];
  }
}

/**
 * Resolve the TransactionHashEntry list to persist when a workflow finalizes
 * as success. Prefers the in-memory tracker (populated by withStepLoggingInner
 * during step execution); falls back to scanning workflow_execution_logs.outputRaw
 * when the tracker is empty (cross-pod resume case).
 */
async function resolveTransactionHashesForSuccess(
  executionId: string
): Promise<TransactionHashEntry[]> {
  const tracked = getTransactionHashes(executionId);
  if (tracked.length > 0) {
    return tracked;
  }
  return await loadHashesFromLogs(executionId);
}

/**
 * KEEP-431 follow-up: self-healing reconciliation when a step's success commit
 * lands AFTER the workflow has already been finalized to a spurious error.
 *
 * Cross-pod race scenario this closes:
 *   - Process A runs the step body, awaits logStepCompleteDb (DB UPDATE in flight)
 *   - Process B (workflow resume on a fresh pod) catches "exceeded max retries"
 *     and finalizes workflow_executions to status='error' before Process A's
 *     UPDATE commits (~100ms gap observed in prod execution joc7il55352vuya0ww9tl)
 *   - Process B's logWorkflowCompleteDb reconciliation reads stale state
 *     (combine row still 'running'), keeps status='error'
 *
 * When Process A's logStepCompleteDb finally commits, this hook fires and:
 *   - Reads workflow_executions to confirm it's parked in spurious-error state
 *   - Re-runs the per-nodeId aggregate (which now includes the just-committed
 *     success row) to check if every node has a success row
 *   - If yes, CAS-flips workflow_executions.status to success and clears error
 *   - The CAS WHERE clause guards against double-flip and against flipping a
 *     genuinely cancelled execution
 *
 * Idempotent: subsequent late commits see status != 'error' and no-op.
 * Safe: only fires when error matches the spurious-pattern regex, so a real
 * step error message is never overridden.
 */
async function selfHealWorkflowAfterLateStepCommit(
  executionId: string
): Promise<void> {
  const execution = await db.query.workflowExecutions.findFirst({
    where: eq(workflowExecutions.id, executionId),
    columns: {
      status: true,
      error: true,
      completedAt: true,
      startedAt: true,
    },
  });

  // Each early-exit emits a `noop_early_exit` counter with a `reason` label so
  // SRE can see how often the gate is exercised vs how often it actually flips.
  // The `flipped` and `noop_status_changed` counters below cover the cases
  // that progressed past all guards.
  const emitEarlyExit = (reason: string): void => {
    getMetricsCollector().incrementCounter(
      "workflow.executor.self_heal_late_commit.total",
      { outcome: "noop_early_exit", reason }
    );
  };

  if (!execution) {
    emitEarlyExit("execution_missing");
    return;
  }
  // Only fire after the workflow has been finalized -- if it's still running,
  // logWorkflowCompleteDb will handle reconciliation when it fires later.
  if (execution.completedAt === null) {
    emitEarlyExit("not_finalized");
    return;
  }
  if (execution.status !== "error") {
    emitEarlyExit("status_not_error");
    return;
  }
  if (!isSpuriousWorkflowError(execution.error)) {
    emitEarlyExit("error_not_spurious");
    return;
  }

  const trulyFailedNodes = await listTrulyFailedNodes(executionId);
  if (trulyFailedNodes.length > 0) {
    emitEarlyExit("real_failures_present");
    return;
  }

  const startMs = execution.startedAt
    ? execution.startedAt.getTime()
    : Date.now();
  const newDuration = (Date.now() - startMs).toString();

  // KEEP-470: when self-heal flips status='error' -> 'success' for a workflow
  // that finalized before its tx-producing step's success row landed, the
  // earlier logWorkflowCompleteDb call left transaction_hashes='[]'. Resolve
  // them now from durable logs so the success terminal state carries the
  // hashes that ran. Tracker may have been cleared on the originating pod;
  // loadHashesFromLogs is the durable source of truth at this point.
  const transactionHashes =
    await resolveTransactionHashesForSuccess(executionId);

  // CAS UPDATE: only flip if status is still 'error' (the state we just observed).
  // Drizzle's update returns the affected row count -- we use it to drive metrics.
  const result = await db
    .update(workflowExecutions)
    .set({
      status: "success",
      error: null,
      completedAt: new Date(),
      duration: newDuration,
      currentNodeId: null,
      currentNodeName: null,
      transactionHashes,
    })
    .where(
      and(
        eq(workflowExecutions.id, executionId),
        eq(workflowExecutions.status, "error")
      )
    );

  // pg driver returns rowCount on the underlying QueryResult; Drizzle exposes
  // it as result.rowCount on the awaited UPDATE.
  const flipped =
    (result as unknown as { rowCount?: number }).rowCount === undefined
      ? true
      : (result as unknown as { rowCount: number }).rowCount > 0;

  if (flipped) {
    // Also clear the stale STEP_INCOMPLETE_ERROR that closeOrphanedRunningLogs
    // may have written onto the (now successful) row when the workflow was
    // first finalized to error. Leaving it on a status='success' row produces
    // the paradoxical "success-with-error" UI state KEEP-431 documented.
    try {
      await db
        .update(workflowExecutionLogs)
        .set({ error: null })
        .where(
          and(
            eq(workflowExecutionLogs.executionId, executionId),
            eq(workflowExecutionLogs.status, "success")
          )
        );
    } catch (clearError) {
      logSystemError(
        ErrorCategory.WORKFLOW_ENGINE,
        "[Workflow Logging] Failed to clear stale errors on success rows after self-heal",
        clearError,
        { execution_id: executionId }
      );
    }

    getMetricsCollector().incrementCounter(
      "workflow.executor.self_heal_late_commit.total",
      { outcome: "flipped" }
    );

    logSystemWarn(
      ErrorCategory.WORKFLOW_ENGINE,
      "[Workflow Logging] Self-healed workflow status from spurious error to success after late step commit",
      execution.error ?? "unknown",
      { execution_id: executionId }
    );
  } else {
    getMetricsCollector().incrementCounter(
      "workflow.executor.self_heal_late_commit.total",
      { outcome: "noop_status_changed" }
    );
  }
}

/**
 * Check if an execution has been cancelled (or otherwise terminated).
 * Used as a guard to prevent stale writes from the runtime after cancellation.
 */
async function isExecutionTerminal(executionId: string): Promise<boolean> {
  const execution = await db.query.workflowExecutions.findFirst({
    where: eq(workflowExecutions.id, executionId),
    columns: { status: true },
  });
  return !execution || TERMINAL_STATUSES.has(execution.status);
}

export type LogStepStartParams = {
  executionId: string;
  nodeId: string;
  nodeName: string;
  nodeType: string;
  input?: unknown;
  iterationIndex?: number;
  forEachNodeId?: string;
};

export type LogStepStartResult = {
  logId: string;
  startTime: number;
};

/**
 * Log the start of a step execution
 */
export async function logStepStartDb(
  params: LogStepStartParams
): Promise<LogStepStartResult> {
  // Guard: skip if execution was cancelled (runtime continues after cancel)
  if (await isExecutionTerminal(params.executionId)) {
    return { logId: "", startTime: Date.now() };
  }

  const [log] = await db
    .insert(workflowExecutionLogs)
    .values({
      executionId: params.executionId,
      nodeId: params.nodeId,
      nodeName: params.nodeName,
      nodeType: params.nodeType,
      status: "running",
      input: params.input,
      startedAt: new Date(),
      iterationIndex: params.iterationIndex ?? null,
      forEachNodeId: params.forEachNodeId ?? null,
    })
    .returning();

  return {
    logId: log.id,
    startTime: Date.now(),
  };
}

export type LogStepCompleteParams = {
  logId: string;
  startTime: number;
  status: "success" | "error";
  output?: unknown;
  outputRaw?: unknown;
  error?: string;
  executionId?: string;
};

/**
 * Log the completion of a step execution.
 *
 * Writes two output columns:
 *   `output`     -- redacted via redactSensitiveData(), for observability/UI display.
 *   `output_raw` -- unredacted executor payload; authoritative source-of-truth for
 *                   cross-process resume so downstream templates receive real values
 *                   rather than "[REDACTED]" strings.
 *
 * KEEP-431 follow-up: when status='success', the error column is explicitly
 * set to null (rather than skipped via undefined) so that any stale
 * STEP_INCOMPLETE_ERROR previously written by closeOrphanedRunningLogs is
 * cleared. After a successful UPDATE, this function also triggers
 * self-healing reconciliation in case the workflow has already been
 * finalized to a spurious error before this commit landed.
 */
export async function logStepCompleteDb(
  params: LogStepCompleteParams
): Promise<void> {
  // Guard: skip if execution was cancelled (runtime continues after cancel)
  if (params.executionId && (await isExecutionTerminal(params.executionId))) {
    return;
  }

  const duration = Date.now() - params.startTime;
  // On success rows, force-clear the error column. Drizzle treats undefined
  // as "skip in UPDATE", which would leave a stale STEP_INCOMPLETE_ERROR
  // attached if closeOrphanedRunningLogs wrote one before this commit.
  const errorValue: string | null =
    params.status === "success" ? null : (params.error ?? null);

  await db
    .update(workflowExecutionLogs)
    .set({
      status: params.status,
      output: params.output,
      outputRaw: params.outputRaw,
      error: errorValue,
      completedAt: new Date(),
      duration: duration.toString(),
    })
    .where(eq(workflowExecutionLogs.id, params.logId));

  // KEEP-431 follow-up: self-heal a spurious-error workflow if this commit
  // arrived after the workflow was finalized. Wrap in try/catch so a
  // self-heal failure never breaks step logging.
  if (params.status === "success" && params.executionId) {
    try {
      await selfHealWorkflowAfterLateStepCommit(params.executionId);
    } catch (healError) {
      logSystemError(
        ErrorCategory.WORKFLOW_ENGINE,
        "[Workflow Logging] Self-heal after late step commit threw; ignoring",
        healError,
        { execution_id: params.executionId }
      );
    }
  }
}

export type LogWorkflowCompleteParams = {
  executionId: string;
  status: "success" | "error";
  output?: unknown;
  error?: string;
  startTime: number;
};

const STEP_INCOMPLETE_ERROR = "Step did not record completion";

/**
 * Close any step log rows still in 'running' for the given execution.
 * Used when the workflow reaches a terminal state to prevent orphaned
 * 'running' rows from showing as stuck spinners in the UI.
 */
async function closeOrphanedRunningLogs(
  executionId: string,
  finalStatus: "success" | "error"
): Promise<void> {
  const now = new Date();
  await db
    .update(workflowExecutionLogs)
    .set({
      status: finalStatus,
      completedAt: now,
      // Only attach an error message when closing as error
      error: finalStatus === "error" ? STEP_INCOMPLETE_ERROR : undefined,
    })
    .where(
      and(
        eq(workflowExecutionLogs.executionId, executionId),
        eq(workflowExecutionLogs.status, "running")
      )
    );
}

/**
 * Log the completion of a workflow execution
 */
export async function logWorkflowCompleteDb(
  params: LogWorkflowCompleteParams
): Promise<void> {
  const duration = Date.now() - params.startTime;

  // KEEP-1549: Reconcile spurious SDK errors.
  // The Workflow DevKit can throw "exceeded max retries" AFTER all steps
  // succeed. If we're about to write status='error', check whether any
  // node log actually failed. If none did, the error is spurious.
  //
  // KEEP-333: 'running' logs mean a step was started but never recorded
  // completion (e.g. the worker was killed mid-step). That is not a
  // spurious SDK error - the workflow really is incomplete. Keep 'error'
  // and close the orphaned rows below so the UI doesn't show stuck
  // spinners.
  //
  // KEEP-431: Aggregate by nodeId rather than counting raw rows. Under
  // cross-pod SDK checkpoint resume, a step that already succeeded on pod A
  // can be re-fired on pod B, leaving an orphan 'running' or 'error' row
  // from the interrupted retry while the original success row is intact.
  // Treat a node as succeeded if it has at least one success row -- only
  // flag the workflow as failed when a node has no success row at all.
  // This is the difference between "step really is incomplete" (no success
  // row anywhere) and "framework retry was interrupted after the body
  // already recorded success" (success row exists, orphan running/error
  // row from the retry). Critical for x402/call_workflow paid callers who
  // hit large fan-in workflows where the cross-pod resume is the norm.
  let resolvedStatus: "success" | "error" = params.status;
  let resolvedError: string | undefined = params.error;

  if (params.status === "error") {
    // KEEP-532: warn, not error -- at this point we do not yet know whether
    // the failure is user-caused (e.g. user's HTTP step hit a dead URL) or a
    // real engine fault. logSystemError here unconditionally tripped the
    // workflow_engine system-error metric on every user-config failure.
    // Reconciliation below decides the final status; this call is just for
    // forensic context (ALS org/owner labels attached).
    logSystemWarn(
      ErrorCategory.WORKFLOW_ENGINE,
      "[Workflow Logging] Execution completed with error, checking node logs for reconciliation",
      params.error ?? "unknown",
      { execution_id: params.executionId }
    );

    try {
      const trulyFailedNodes = await listTrulyFailedNodes(params.executionId);

      if (trulyFailedNodes.length === 0) {
        // KEEP-532: Recovery event -- spurious SDK error overridden to success.
        // Not an error condition; warn-level keeps it in traces without paging.
        logSystemWarn(
          ErrorCategory.WORKFLOW_ENGINE,
          "[Workflow Logging] No node-level errors found, overriding spurious SDK error to success",
          params.error ?? "unknown",
          { execution_id: params.executionId }
        );
        resolvedStatus = "success";
        resolvedError = undefined;
      }
      // Confirmed-error path is not itself an error event - skip logging.
    } catch (queryError) {
      logSystemError(
        ErrorCategory.WORKFLOW_ENGINE,
        "[Workflow Logging] Failed to query node logs for reconciliation, keeping original error status",
        queryError,
        { execution_id: params.executionId }
      );
    }
  }

  // Close orphaned 'running' logs before updating the execution so that
  // any concurrent reader sees a consistent snapshot.
  try {
    await closeOrphanedRunningLogs(params.executionId, resolvedStatus);
  } catch (closeError) {
    logSystemError(
      ErrorCategory.WORKFLOW_ENGINE,
      "[Workflow Logging] Failed to close orphaned running logs",
      closeError,
      { execution_id: params.executionId }
    );
  }

  // KEEP-470: populate transaction_hashes atomically with the status flip.
  // Only resolve on success; error terminations keep the default '[]'::jsonb.
  // The UPDATE writes status and hashes in the same statement so no consumer
  // can observe status='success' with hashes missing for a run that produced
  // them. The resolver prefers the in-memory tracker but falls back to a
  // SELECT against workflow_execution_logs for the cross-pod resume case
  // (tracker on finalizing pod is empty after an SDK checkpoint).
  const transactionHashes: TransactionHashEntry[] =
    resolvedStatus === "success"
      ? await resolveTransactionHashesForSuccess(params.executionId)
      : [];

  // KEEP-545: classify the error so the row carries error_category and
  // is_user_error at write time. Success rows get null for both columns.
  const classification =
    resolvedStatus === "error" ? classifyExecutionError(resolvedError) : null;

  const updated = await db
    .update(workflowExecutions)
    .set({
      status: resolvedStatus,
      output: params.output,
      error: resolvedError,
      errorCategory: classification?.errorCategory ?? null,
      isUserError: classification?.isUserError ?? null,
      completedAt: new Date(),
      duration: duration.toString(),
      // Clear current step on completion
      currentNodeId: null,
      currentNodeName: null,
      transactionHashes,
    })
    .where(
      and(
        eq(workflowExecutions.id, params.executionId),
        ne(workflowExecutions.status, "cancelled"),
        // KEEP-431 follow-up: defense in depth. If selfHealWorkflowAfterLateStepCommit
        // already CAS-flipped status to 'success', a stray late call to
        // logWorkflowCompleteDb (e.g. a duplicate triggerStep _workflowComplete from
        // an executor catch path) must not overwrite the healed state with another
        // 'error'. Excluding the 'success' state from the WHERE makes this UPDATE
        // a no-op once self-heal has won the race.
        ne(workflowExecutions.status, "success")
      )
    )
    .returning({ workflowId: workflowExecutions.workflowId });

  // KEEP-545: increment the per-execution-error counter only when this
  // UPDATE actually flipped a row to 'error'. The WHERE clause excludes
  // already-cancelled/healed rows, so `updated` is empty in those races
  // and we correctly skip the counter increment for the lost write.
  if (resolvedStatus === "error" && updated.length > 0 && classification) {
    const workflowId = updated[0].workflowId;
    try {
      const orgSlug = await resolveOrgSlugForCounter(workflowId);
      recordWorkflowExecutionError({
        orgSlug,
        errorCategory: classification.errorCategory,
        isUserError: classification.isUserError,
      });
    } catch {
      // Counter emission must never break finalization.
    }
  }
}

/**
 * Resolve the org slug that owns the workflow behind an execution, falling
 * back to ANONYMOUS_ORG_SLUG for personal/anonymous workflows so the
 * counter always emits a series (the SLA alert filters by `org_slug=~`).
 */
async function resolveOrgSlugForCounter(workflowId: string): Promise<string> {
  const row = await db
    .select({ slug: organization.slug })
    .from(workflows)
    .leftJoin(organization, eq(workflows.organizationId, organization.id))
    .where(eq(workflows.id, workflowId))
    .limit(1);
  return row[0]?.slug ?? ANONYMOUS_ORG_SLUG;
}

// ============================================================================
// Progress Tracking Functions
// ============================================================================

export type InitializeProgressParams = {
  executionId: string;
  totalSteps: number;
};

/**
 * Initialize progress tracking at the start of workflow execution.
 * Sets total step count and resets progress counters.
 */
export async function initializeProgress(
  params: InitializeProgressParams
): Promise<void> {
  await db
    .update(workflowExecutions)
    .set({
      totalSteps: params.totalSteps.toString(),
      completedSteps: "0",
      executionTrace: [],
      currentNodeId: null,
      currentNodeName: null,
      lastSuccessfulNodeId: null,
      lastSuccessfulNodeName: null,
    })
    .where(eq(workflowExecutions.id, params.executionId));
}

export type UpdateCurrentStepParams = {
  executionId: string;
  currentNodeId: string;
  currentNodeName: string;
};

/**
 * Update the currently executing step.
 * Called when a step starts execution.
 */
export async function updateCurrentStep(
  params: UpdateCurrentStepParams
): Promise<void> {
  await db
    .update(workflowExecutions)
    .set({
      currentNodeId: params.currentNodeId,
      currentNodeName: params.currentNodeName,
    })
    .where(
      and(
        eq(workflowExecutions.id, params.executionId),
        ne(workflowExecutions.status, "cancelled")
      )
    );
}

export type IncrementCompletedStepsParams = {
  executionId: string;
  nodeId: string;
  nodeName: string;
  success: boolean;
};

/**
 * Increment the completed steps counter and append to the execution trace.
 * Called when a step completes (success or error).
 *
 * Uses a single atomic UPDATE so concurrent fan-out steps (for-each, parallel
 * branches) cannot overwrite each other's trace entries or counter increments.
 * The WHERE clause replaces the pre-read terminal-status guard, eliminating
 * the TOCTOU race against cancellation.
 *
 * Returns void; the UPDATE silently affects 0 rows when the execution is
 * cancelled (or has been deleted). Callers should not depend on the trace
 * being incremented for late-arriving step completions on cancelled runs.
 */
export async function incrementCompletedSteps(
  params: IncrementCompletedStepsParams
): Promise<void> {
  await db
    .update(workflowExecutions)
    .set({
      completedSteps: sql`(COALESCE(${workflowExecutions.completedSteps}, '0')::int + 1)::text`,
      executionTrace: sql`COALESCE(${workflowExecutions.executionTrace}, '[]'::jsonb) || ${JSON.stringify([params.nodeId])}::jsonb`,
      currentNodeId: null,
      currentNodeName: null,
      ...(params.success
        ? {
            lastSuccessfulNodeId: params.nodeId,
            lastSuccessfulNodeName: params.nodeName,
          }
        : {}),
    })
    .where(
      and(
        eq(workflowExecutions.id, params.executionId),
        ne(workflowExecutions.status, "cancelled")
      )
    );
}
