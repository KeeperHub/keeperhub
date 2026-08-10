/**
 * Server-only workflow logging functions
 * These replace the HTTP endpoint for better security
 */
import "server-only";

import { and, asc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/lib/db";
import {
  extractLogGasUsedWei,
  extractLogNetwork,
  logOutputField,
} from "@/lib/db/execution-log-fields";
import {
  type TransactionHashEntry,
  workflowExecutionLogs,
  workflowExecutions,
} from "@/lib/db/schema";
import {
  applyErrorClassHint,
  classifyExecutionError,
  isDefaultClassification,
} from "@/lib/errors/classify";
import type { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import {
  ERROR_STATUSES,
  type ErrorStatus,
  isErrorStatus,
  statusForErrorType,
} from "@/lib/errors/execution-status";
import { ErrorCategory, logSystemError, logSystemWarn } from "@/lib/logging";
import { getMetricsCollector } from "@/lib/metrics";
import {
  recordWorkflowExecutionError,
  recordWorkflowExecutionFinished,
  recordWorkflowExecutionHealed,
} from "@/lib/metrics/collectors/prometheus";
import { NA_ERROR_TYPE } from "@/lib/metrics/metric-constants";
import { resolveOrgSlugForCounter } from "@/lib/metrics/org-slug.server";
import { toJsonSafe } from "@/lib/utils/json-safe";
import {
  describeVerificationFailure,
  hasUnreadableReceipt,
  type ReceiptVerificationResult,
  verifyExecutionReceipts,
} from "@/lib/web3/verify-receipt";
import {
  EXCEEDED_MAX_RETRIES_REGEX,
  FAILED_AFTER_RETRIES_REGEX,
  NO_STEP_COMPLETION_REGEX,
} from "@/lib/workflow/executor/runner-error-patterns";
import { getTransactionHashes } from "@/lib/workflow/executor/step-success-tracker";
import { computeTrulyFailedNodes } from "@/lib/workflow/executor/truly-failed-nodes";

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
 * Per-nodeId aggregate over workflow_execution_logs rows.
 *
 * KEEP-431: A node can have multiple log rows (e.g. a cross-pod retry from the
 * SDK's "use step" boundary inserts a fresh row each time logStepStartDb runs).
 * Treat the node as succeeded if ANY of its rows is success -- only flag a
 * node as truly failed when no row succeeded for it. For Each iteration
 * failures are surfaced via the parent loop node. See `computeTrulyFailedNodes`
 * for the full contract.
 *
 * Empty list means the workflow body succeeded as a whole even if the SDK
 * reported a spurious error.
 */
async function listTrulyFailedNodes(executionId: string): Promise<string[]> {
  const allLogs = await db.query.workflowExecutionLogs.findMany({
    where: eq(workflowExecutionLogs.executionId, executionId),
    columns: {
      nodeId: true,
      status: true,
      iterationIndex: true,
      forEachNodeId: true,
    },
  });

  return computeTrulyFailedNodes(allLogs);
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

function mergeReceiptResults(
  entries: TransactionHashEntry[],
  results: ReceiptVerificationResult[]
): TransactionHashEntry[] {
  const byHash = new Map(results.map((result) => [result.hash, result]));
  return entries.map((entry) => {
    const result = byHash.get(entry.hash);
    if (!result) {
      return entry;
    }
    return {
      ...entry,
      verified: result.verified,
      receiptStatus: result.status,
      blockNumber: result.blockNumber,
      gasUsed: result.gasUsed,
      verifiedAt: result.verifiedAt,
    };
  });
}

type ReconcileTransactionHashesResult =
  | { ok: true; hashes: TransactionHashEntry[] }
  | {
      ok: false;
      hashes: TransactionHashEntry[];
      error: string;
      // False when at least one hash could not be read at all. The run did not
      // fail; we could not see whether it succeeded, and calling that an error
      // is what makes a caller re-run an already-broadcast transaction.
      conclusive: boolean;
    };

/**
 * KEEP-966: independently re-verify every claimed transaction hash against
 * the chain before a workflow execution is allowed to finalize as success.
 * Shared by logWorkflowCompleteDb and selfHealWorkflowAfterLateStepCommit --
 * both are places that can write status: "success", so both must gate on
 * this rather than trusting the step-level self-reports that fed into
 * `hashes`. Fail-closed: a hash missing chainId (cannot be verified at all)
 * fails the whole batch, same as a hash that positively fails verification.
 */
async function reconcileTransactionHashes(
  hashes: TransactionHashEntry[]
): Promise<ReconcileTransactionHashesResult> {
  if (hashes.length === 0) {
    return { ok: true, hashes };
  }

  const verifiable = hashes.filter(
    (entry): entry is TransactionHashEntry & { chainId: number } =>
      entry.chainId !== undefined
  );
  if (verifiable.length < hashes.length) {
    // A hash we can never verify is a defect in what the step reported, not an
    // unread receipt, so this stays a conclusive failure.
    return {
      ok: false,
      hashes,
      error:
        "On-chain verification failed: missing chainId for one or more transaction hashes",
      conclusive: true,
    };
  }

  const { allVerified, results } = await verifyExecutionReceipts(
    verifiable.map((entry) => ({ hash: entry.hash, chainId: entry.chainId }))
  );
  const merged = mergeReceiptResults(hashes, results);

  if (!allVerified) {
    return {
      ok: false,
      hashes: merged,
      error: describeVerificationFailure(results),
      conclusive: !hasUnreadableReceipt(results),
    };
  }
  return { ok: true, hashes: merged };
}

/**
 * Resolve the run-total gas (sum of per-step `gasUsed`, in wei) to persist when
 * a workflow reaches a terminal state.
 *
 * Aggregates this one execution's durable logs (cheap via
 * idx_exec_logs_execution_id) using the same extraction the /analytics reads
 * and the backfill use, so the denormalised column agrees value-for-value with
 * a JSON recompute. Returns null when the run produced no gas-bearing step.
 *
 * Resolved on error finalizes too, not just success: a gas-bearing step (e.g.
 * an approve) can commit its gas before a later step fails the run, and the
 * /analytics gas total counts that gas regardless of run status. Gating on
 * success would silently drop it once the reads move to the column.
 *
 * Sourced from the DB, not the in-memory step-success-tracker, on purpose. The
 * tracker holds raw step outputs whose gasUsed shape could diverge from the
 * logged `output`; using it would fork gas computation into two paths and let
 * writer-populated rows disagree with backfilled ones. A single extraction
 * path - this query, shared with the backfill and the reads - is worth one
 * indexed single-execution aggregate per finalize.
 */
async function resolveGasTotal(executionId: string): Promise<string | null> {
  try {
    const rows = await db
      .select({
        gasUsedWei: sql<
          string | null
        >`SUM(CAST(${logOutputField("gasUsed")} AS NUMERIC))`,
      })
      .from(workflowExecutionLogs)
      .where(
        and(
          eq(workflowExecutionLogs.executionId, executionId),
          sql`${logOutputField("gasUsed")} IS NOT NULL`
        )
      );
    return rows[0]?.gasUsedWei ?? null;
  } catch (queryError) {
    logSystemError(
      ErrorCategory.WORKFLOW_ENGINE,
      "[Workflow Logging] Failed to resolve gas total at finalize",
      queryError,
      { execution_id: executionId }
    );
    return null;
  }
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
      workflowId: true,
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
  if (!isErrorStatus(execution.status)) {
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
  const [resolvedHashes, gasUsedWei] = await Promise.all([
    resolveTransactionHashesForSuccess(executionId),
    resolveGasTotal(executionId),
  ]);

  // KEEP-966: self-heal only ever flips error -> success, so it must pass the
  // same on-chain reconciliation gate as logWorkflowCompleteDb before it's
  // allowed to write "success". A failure here means simply not flipping --
  // the row stays in whatever error state it was already finalized to; no
  // new write is needed on this branch.
  const reconciled = await reconcileTransactionHashes(resolvedHashes);
  if (resolvedHashes.length > 0 && !reconciled.ok) {
    emitEarlyExit("receipt_verification_failed");
    return;
  }
  const transactionHashes = reconciled.hashes;

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
      gasUsedWei,
    })
    .where(
      and(
        eq(workflowExecutions.id, executionId),
        inArray(workflowExecutions.status, [...ERROR_STATUSES])
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

    // The finished counter already recorded this execution as error/system_error
    // at finalize time and cannot be decremented; emit the org-labelled healed
    // series so per-org success-rate dashboards can compensate.
    try {
      recordWorkflowExecutionHealed({
        orgSlug: await resolveOrgSlugForCounter(execution.workflowId),
      });
    } catch {
      // Counter emission must never break the self-heal path.
    }

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
      input: toJsonSafe(params.input),
      network: extractLogNetwork(params.input),
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
      output: toJsonSafe(params.output),
      outputRaw: toJsonSafe(params.outputRaw),
      gasUsedWei: extractLogGasUsedWei(params.output),
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

export async function updateForEachLogToError(params: {
  executionId: string;
  nodeId: string;
  error: string;
}): Promise<void> {
  await db
    .update(workflowExecutionLogs)
    .set({ status: "error", error: params.error })
    .where(
      and(
        eq(workflowExecutionLogs.executionId, params.executionId),
        eq(workflowExecutionLogs.nodeId, params.nodeId),
        isNull(workflowExecutionLogs.iterationIndex)
      )
    );
}

export type LogWorkflowCompleteParams = {
  executionId: string;
  status: "success" | "error";
  output?: unknown;
  error?: string;
  /**
   * Authoritative error type declared by the failing step. When present it
   * overrides the message-string classifier for the persisted error_type.
   */
  errorClass?: ExecutionErrorType;
  startTime: number;
};

const STEP_INCOMPLETE_ERROR = "Step did not record completion";
const CANCELLED_DUE_TO_SIBLING_ERROR =
  "Cancelled: workflow stopped because another step errored";

/**
 * Pick the message attached to step rows that were still 'running' when the
 * workflow finalized as error.
 *
 * Two distinct failure shapes share this code path:
 *   1. The worker died mid-step. No sibling row carries a real error, so
 *      the orphan IS the only failure signal -- keep STEP_INCOMPLETE_ERROR.
 *   2. A peer step threw and the executor finalized the workflow before this
 *      step's "use step" boundary committed. The peer carries the actionable
 *      error; the orphan was just collateral. Attribute it clearly so the UI
 *      doesn't mis-identify the trigger/peer as the failure source.
 */
async function pickOrphanCloseErrorMessage(
  executionId: string
): Promise<string> {
  const siblings = await db.query.workflowExecutionLogs.findMany({
    where: and(
      eq(workflowExecutionLogs.executionId, executionId),
      eq(workflowExecutionLogs.status, "error"),
      isNotNull(workflowExecutionLogs.error),
      ne(workflowExecutionLogs.error, STEP_INCOMPLETE_ERROR)
    ),
    columns: { id: true },
    limit: 1,
  });
  return siblings.length > 0
    ? CANCELLED_DUE_TO_SIBLING_ERROR
    : STEP_INCOMPLETE_ERROR;
}

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
  const errorMessage =
    finalStatus === "error"
      ? await pickOrphanCloseErrorMessage(executionId)
      : undefined;
  await db
    .update(workflowExecutionLogs)
    .set({
      status: finalStatus,
      completedAt: now,
      // Only attach an error message when closing as error
      error: errorMessage,
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
  // Run-total gas is denormalised onto the same terminal UPDATE, sourced the
  // same way as the hashes, so the /analytics summary and spend-cap reads can
  // aggregate a first-class column instead of re-scanning the logs JSONB.
  // Hashes are success-only (error rows keep '[]'), but gas is resolved on
  // error finalizes too - see resolveGasTotal for why.
  const [transactionHashes, gasUsedWei] = await Promise.all([
    resolvedStatus === "success"
      ? resolveTransactionHashesForSuccess(params.executionId)
      : Promise.resolve<TransactionHashEntry[]>([]),
    resolveGasTotal(params.executionId),
  ]);

  // KEEP-966: independently reconcile every claimed hash against the chain
  // before "success" can be written. Runs after the KEEP-1549 spurious-error
  // override above, so a demotion here wins over "no node-level errors
  // found" -- a hash that fails on-chain reconciliation overrides that
  // override. On demotion, still persist the enriched (non-empty) entries --
  // this is the "per-execution receipts" deliverable: an operator needs to
  // see which hash failed and why, not just that the run errored.
  let verifiedTransactionHashes = transactionHashes;
  // Set when a claimed hash could not be read at all. The run is neither a
  // success we can assert nor a failure we can assert, so it finalizes to a
  // non-terminal state and the reconciler settles it once the chain answers.
  // Demoting it to error instead would tell an operator a broadcast run failed
  // and invite a re-run of transactions that may already have landed.
  let unreadableReceipts = false;
  if (resolvedStatus === "success" && transactionHashes.length > 0) {
    const reconciled = await reconcileTransactionHashes(transactionHashes);
    verifiedTransactionHashes = reconciled.hashes;
    if (!reconciled.ok) {
      unreadableReceipts = !reconciled.conclusive;
      resolvedStatus = "error";
      resolvedError = reconciled.error;
    }
  }

  // KEEP-545: classify the error so the row carries error_category and
  // error_type at write time. Success rows get null for both columns.
  // KEEP-880: a step that knows the true nature of its failure (e.g. a
  // third-party dependency outage) declares an errorClass; it overrides the
  // message-string classifier, which is fragile for the long tail of
  // integration error shapes.
  const classification =
    resolvedStatus === "error"
      ? applyErrorClassHint(
          classifyExecutionError(resolvedError),
          params.errorClass
        )
      : null;

  // KEEP-853: a confidently system/infra-classified failure persists as
  // system_error so it is visible and filterable apart from user/workflow
  // errors. An unmatched failure that only defaulted to "system" stays a plain
  // error for the user-facing status (its errorType is still written as
  // "system" below, so alerting is unchanged). Step logs and the success-path
  // stay on resolvedStatus; only the execution row's status carries the split.
  // An unread receipt is not an error outcome, so the row carries no error
  // classification even though resolvedStatus was set to error above to reuse
  // the non-success branches.
  const persistedClassification = unreadableReceipts ? null : classification;

  let executionStatus: "success" | "unconfirmed" | ErrorStatus =
    resolvedStatus === "error"
      ? statusForErrorType(
          classification && !isDefaultClassification(classification)
            ? classification.errorType
            : null
        )
      : resolvedStatus;
  if (unreadableReceipts) {
    executionStatus = "unconfirmed";
  }

  // Self-join alias so RETURNING can expose the pre-update status (the FROM
  // clause reads the statement snapshot, i.e. the row as it was before this
  // UPDATE). The counters below must know whether this finalize was the
  // first terminal transition or a re-finalization of an already-terminal
  // row (reaped by the reaper, or a duplicate _workflowComplete).
  const prevExecution = alias(workflowExecutions, "prev_execution");

  const updated = await db
    .update(workflowExecutions)
    .set({
      status: executionStatus,
      output: toJsonSafe(params.output),
      error: resolvedError,
      errorCategory: persistedClassification?.errorCategory ?? null,
      errorType: persistedClassification?.errorType ?? null,
      errorCode: persistedClassification?.code ?? null,
      completedAt: new Date(),
      duration: duration.toString(),
      // Clear current step on completion
      currentNodeId: null,
      currentNodeName: null,
      transactionHashes: verifiedTransactionHashes,
      gasUsedWei,
    })
    .from(prevExecution)
    .where(
      and(
        eq(workflowExecutions.id, params.executionId),
        eq(prevExecution.id, workflowExecutions.id),
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
    .returning({
      workflowId: workflowExecutions.workflowId,
      previousStatus: prevExecution.status,
    });

  // KEEP-545: increment the counters only when this UPDATE performed the
  // first non-terminal -> terminal transition. The WHERE clause excludes
  // already-cancelled/healed rows (updated is empty in those races), and the
  // previousStatus gate excludes rows that were already error/system_error:
  // a reaped execution whose pod later finishes, or a duplicate
  // _workflowComplete, still overwrites the row with the fresher result but
  // must not emit a second sample - counters are append-only, so the first
  // terminal sample stands. resolvedStatus is post-reconciliation, so
  // spurious errors already flipped to success are counted as success here.
  // An unconfirmed run has not finished, so it emits no sample here. The
  // reconciler emits one when it settles, which keeps the counter meaning
  // "finished" and keeps a success rate computed from it correct.
  if (
    updated.length > 0 &&
    !isErrorStatus(updated[0].previousStatus) &&
    executionStatus !== "unconfirmed"
  ) {
    const workflowId = updated[0].workflowId;
    try {
      const orgSlug = await resolveOrgSlugForCounter(workflowId);
      if (persistedClassification) {
        recordWorkflowExecutionError({
          orgSlug,
          errorCategory: persistedClassification.errorCategory,
          errorType: persistedClassification.errorType,
        });
      }
      recordWorkflowExecutionFinished({
        status: executionStatus,
        orgSlug,
        errorType: persistedClassification?.errorType ?? NA_ERROR_TYPE,
      });
    } catch {
      // Counter emission must never break finalization.
    }
  }
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
