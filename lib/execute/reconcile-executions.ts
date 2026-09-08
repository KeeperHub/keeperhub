import "server-only";

import { and, asc, desc, eq, isNotNull, lt } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  type DirectExecution,
  type DirectExecutionReceiptEntry,
  directExecutions,
  type TransactionHashEntry,
  workflowExecutions,
} from "@/lib/db/schema";
import { ErrorCategory, logInfo, logSystemWarn, logWarn } from "@/lib/logging";
import { recordWorkflowExecutionFinished } from "@/lib/metrics/collectors/prometheus";
import { NA_ERROR_TYPE } from "@/lib/metrics/metric-constants";
import { resolveOrgSlugForCounter } from "@/lib/metrics/org-slug.server";
import {
  describeVerificationFailure,
  hasUnreadableReceipt,
  verifyExecutionReceipts,
} from "@/lib/web3/verify-receipt";

/**
 * Settles executions left in `unconfirmed`: a transaction was broadcast but
 * the chain had not yet told us whether it landed by the time the request had
 * to answer. Covers direct executions and workflow runs alike.
 *
 * Holding these open is the point. Reporting a broadcast as failed is what
 * makes a caller retry an action that already moved funds, so the row keeps its
 * hash and stays non-terminal until the chain is conclusive, or until enough
 * time has passed that a transaction still absent from every endpoint can only
 * have been dropped.
 */

// How long a broadcast can stay unseen before we accept it never landed. Well
// past any realistic mempool eviction, because concluding "dropped" for a
// transaction that later mines is the expensive direction to be wrong in.
const DROPPED_AFTER_MS = 24 * 60 * 60 * 1000;
// Give the write path's own retries room to finish before re-reading.
const MIN_AGE_MS = 30 * 1000;
// Upper bound on the rows one run reads newest-first. It bounds memory only;
// the work a run does is bounded by the time budget below.
const DEFAULT_MAX_ROWS = 2000;
// Once the eligible set exceeds DEFAULT_MAX_ROWS the newest-first read can
// never reach its tail, and the tail is exactly the set old enough to reach the
// 24h dropped verdict and leave. So every run also reads a small oldest-first
// slice and examines it before the newest-first sweep, which drains that tail
// at a bounded rate however large the backlog grows.
const OLDEST_SLICE_ROWS = 100;
// Wall-clock budget for one run. The CronJob fires every two minutes with
// concurrencyPolicy Forbid, and a receipt lookup against an endpoint that times
// out instead of answering can take tens of seconds, so without a budget one
// unreachable chain would keep a run going indefinitely and every other row
// would wait behind it.
const DEFAULT_TIME_BUDGET_MS = 60 * 1000;

export type ReconcileSummary = {
  examined: number;
  completed: number;
  failed: number;
  // Rows this run did not move to a terminal state: still open, or settled by
  // another writer before this run's guarded update reached them.
  stillUnconfirmed: number;
  // Eligible rows the run did not reach before its time budget ran out.
  deferred: number;
};

export type ReconcileReport = {
  direct: ReconcileSummary;
  workflows: ReconcileSummary;
};

type SettleOutcome = "completed" | "failed" | "unconfirmed";

type UnconfirmedDirectExecution = Pick<
  DirectExecution,
  "id" | "transactionHash" | "network" | "receipts" | "createdAt"
>;

type UnconfirmedWorkflowExecution = {
  id: string;
  workflowId: string;
  transactionHashes: TransactionHashEntry[] | null;
  startedAt: Date;
};

function emptySummary(): ReconcileSummary {
  return {
    examined: 0,
    completed: 0,
    failed: 0,
    stillUnconfirmed: 0,
    deferred: 0,
  };
}

function tally(summary: ReconcileSummary, outcome: SettleOutcome): void {
  if (outcome === "completed") {
    summary.completed += 1;
  } else if (outcome === "failed") {
    summary.failed += 1;
  } else {
    summary.stillUnconfirmed += 1;
  }
}

function resolveChainId(execution: UnconfirmedDirectExecution): number | null {
  const fromReceipt = execution.receipts.find(
    (receipt) => receipt.chainId !== undefined
  )?.chainId;
  if (fromReceipt !== undefined) {
    return fromReceipt;
  }
  const parsed = Number(execution.network);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function toReceiptEntries(
  results: Awaited<ReturnType<typeof verifyExecutionReceipts>>["results"]
): DirectExecutionReceiptEntry[] {
  return results.map((result) => ({
    hash: result.hash,
    chainId: result.chainId,
    verified: result.verified,
    receiptStatus: result.status,
    blockNumber: result.blockNumber,
    gasUsed: result.gasUsed,
    verifiedAt: result.verifiedAt,
  }));
}

// Every write below is guarded on the row still being unconfirmed, so a run
// never overwrites a verdict something else reached first. Reports whether this
// call performed the transition, so a run that lost the race does not tally a
// settle it did not make - the same reason settleWorkflow reads `returning`.
async function settle(
  executionId: string,
  status: "completed" | "failed",
  receipts: DirectExecutionReceiptEntry[],
  error: string | null
): Promise<boolean> {
  const updated = await db
    .update(directExecutions)
    .set({ status, error, receipts, completedAt: new Date() })
    .where(
      and(
        eq(directExecutions.id, executionId),
        eq(directExecutions.status, "unconfirmed")
      )
    )
    .returning({ id: directExecutions.id });
  return updated.length > 0;
}

// A settle that matched no row means another writer reached a verdict first;
// this run neither completed nor failed the row, so it reports the outcome it
// did reach.
function settledOutcome(
  settled: boolean,
  verdict: "completed" | "failed"
): SettleOutcome {
  return settled ? verdict : "unconfirmed";
}

async function reconcileOne(
  execution: UnconfirmedDirectExecution,
  now: Date
): Promise<SettleOutcome> {
  const chainId = resolveChainId(execution);
  const hash = execution.transactionHash;
  if (!hash || chainId === null) {
    const settled = await settle(
      execution.id,
      "failed",
      execution.receipts,
      "Unable to verify transaction: chain could not be resolved"
    );
    return settledOutcome(settled, "failed");
  }

  const { allVerified, results } = await verifyExecutionReceipts([
    { hash, chainId },
  ]);
  const receipts = toReceiptEntries(results);

  if (allVerified) {
    const settled = await settle(execution.id, "completed", receipts, null);
    return settledOutcome(settled, "completed");
  }

  const conclusive = results.every(
    (result) =>
      result.status === "reverted" || result.status === "safe_inner_failure"
  );
  if (conclusive) {
    const settled = await settle(
      execution.id,
      "failed",
      receipts,
      describeVerificationFailure(results)
    );
    return settledOutcome(settled, "failed");
  }

  const age = now.getTime() - execution.createdAt.getTime();
  if (age >= DROPPED_AFTER_MS) {
    const settled = await settle(
      execution.id,
      "failed",
      receipts,
      `Transaction ${hash} was broadcast but never appeared on chain; treating it as dropped after ${Math.round(
        DROPPED_AFTER_MS / 3_600_000
      )}h`
    );
    return settledOutcome(settled, "failed");
  }

  await db
    .update(directExecutions)
    .set({ receipts })
    .where(
      and(
        eq(directExecutions.id, execution.id),
        eq(directExecutions.status, "unconfirmed")
      )
    );
  return "unconfirmed";
}

/**
 * Emit the finished sample that logWorkflowCompleteDb deliberately skipped for
 * an unconfirmed run, so the counter still means "finished" and a success rate
 * computed from it stays correct.
 */
async function recordSettled(
  workflowId: string,
  status: "success" | "error"
): Promise<void> {
  try {
    recordWorkflowExecutionFinished({
      status,
      orgSlug: await resolveOrgSlugForCounter(workflowId),
      errorType: NA_ERROR_TYPE,
    });
  } catch {
    // Counter emission must never break reconciliation.
  }
}

/**
 * Apply a verdict to a workflow run that is still unconfirmed. The finished
 * sample is emitted only when this call performed the transition: a late
 * finalizer or a second reconciler run that settled the row first has already
 * emitted it, and the counter is append-only.
 */
async function settleWorkflow(
  execution: UnconfirmedWorkflowExecution,
  status: "success" | "error",
  error: string | null
): Promise<void> {
  const updated = await db
    .update(workflowExecutions)
    .set({ status, error, completedAt: new Date() })
    .where(
      and(
        eq(workflowExecutions.id, execution.id),
        eq(workflowExecutions.status, "unconfirmed")
      )
    )
    .returning({ id: workflowExecutions.id });
  if (updated.length > 0) {
    await recordSettled(execution.workflowId, status);
  }
}

/**
 * Settle one unconfirmed workflow run.
 *
 * A workflow claims many hashes, so it settles to success only when every hash
 * verifies, and to error only when at least one is conclusively bad. While any
 * hash is merely unreadable the run stays open.
 */
async function reconcileWorkflow(
  execution: UnconfirmedWorkflowExecution,
  now: Date
): Promise<SettleOutcome> {
  const entries = execution.transactionHashes ?? [];
  const verifiable = entries.filter(
    (entry): entry is TransactionHashEntry & { chainId: number } =>
      entry.chainId !== undefined
  );

  if (verifiable.length === 0) {
    await settleWorkflow(
      execution,
      "error",
      "On-chain verification failed: no verifiable transaction hashes"
    );
    return "failed";
  }

  const { allVerified, results } = await verifyExecutionReceipts(
    verifiable.map((entry) => ({ hash: entry.hash, chainId: entry.chainId }))
  );

  if (allVerified) {
    await settleWorkflow(execution, "success", null);
    return "completed";
  }

  const stillUnreadable = hasUnreadableReceipt(results);
  const age = now.getTime() - execution.startedAt.getTime();
  if (stillUnreadable && age < DROPPED_AFTER_MS) {
    return "unconfirmed";
  }

  await settleWorkflow(
    execution,
    "error",
    stillUnreadable
      ? `Transactions were broadcast but never appeared on chain; treating them as dropped after ${Math.round(
          DROPPED_AFTER_MS / 3_600_000
        )}h`
      : describeVerificationFailure(results)
  );
  return "failed";
}

/**
 * Re-verify rows in order until the list is exhausted or the deadline passes.
 * The deadline is checked between rows, so a run can overshoot it by one
 * lookup; rows not reached are reported as deferred and picked up next run.
 */
async function drain<T extends { id: string }>(
  rows: T[],
  deadline: number,
  reconcile: (row: T) => Promise<SettleOutcome>,
  failureMessage: string
): Promise<ReconcileSummary> {
  const summary = emptySummary();
  for (const row of rows) {
    if (Date.now() >= deadline) {
      summary.deferred = rows.length - summary.examined;
      break;
    }
    summary.examined += 1;
    try {
      tally(summary, await reconcile(row));
    } catch (error) {
      summary.stillUnconfirmed += 1;
      logSystemWarn(
        ErrorCategory.NETWORK_RPC,
        failureMessage,
        error instanceof Error ? error : new Error(String(error)),
        { execution_id: row.id }
      );
    }
  }
  return summary;
}

/**
 * Put the oldest slice at the front of the newest-first read, dropping the rows
 * both reads returned. When the eligible set fits under the row cap the two
 * reads cover the same rows and this only reorders them.
 */
function tailFirst<T extends { id: string }>(oldest: T[], newest: T[]): T[] {
  const inSlice = new Set(oldest.map((row) => row.id));
  return [...oldest, ...newest.filter((row) => !inSlice.has(row.id))];
}

/**
 * Rows are read newest first, then examined behind a small oldest-first slice.
 *
 * A row that has sat unconfirmed for hours has already been re-read many times
 * and is the least likely to change, while a row broadcast a minute ago usually
 * settles on its first re-read, so the bulk of a run's budget goes to the fresh
 * end. But a newest-first read alone never reaches the tail of a set larger
 * than `maxRows`, and under inflow at or above the drain rate that tail is
 * exactly the set old enough to reach the 24h dropped verdict and leave. The
 * slice keeps that tail draining at up to OLDEST_SLICE_ROWS rows per run.
 *
 * Direct rows get at most half the budget so a slow direct backlog cannot
 * starve workflow rows; whatever they leave unused rolls over.
 */
export async function reconcileUnconfirmedExecutions(
  now: Date = new Date(),
  maxRows: number = DEFAULT_MAX_ROWS,
  timeBudgetMs: number = DEFAULT_TIME_BUDGET_MS
): Promise<ReconcileReport> {
  const cutoff = new Date(now.getTime() - MIN_AGE_MS);
  const startedAt = Date.now();
  const sliceRows = Math.min(OLDEST_SLICE_ROWS, maxRows);

  const directColumns = {
    id: directExecutions.id,
    transactionHash: directExecutions.transactionHash,
    network: directExecutions.network,
    receipts: directExecutions.receipts,
    createdAt: directExecutions.createdAt,
  };
  const directEligible = and(
    eq(directExecutions.status, "unconfirmed"),
    isNotNull(directExecutions.transactionHash),
    lt(directExecutions.createdAt, cutoff)
  );
  const [newestDirect, oldestDirect] = await Promise.all([
    db
      .select(directColumns)
      .from(directExecutions)
      .where(directEligible)
      .orderBy(desc(directExecutions.createdAt))
      .limit(maxRows),
    db
      .select(directColumns)
      .from(directExecutions)
      .where(directEligible)
      .orderBy(asc(directExecutions.createdAt))
      .limit(sliceRows),
  ]);

  const direct = await drain(
    tailFirst(oldestDirect, newestDirect),
    startedAt + timeBudgetMs / 2,
    (execution) => reconcileOne(execution, now),
    "[Reconciler] Failed to re-verify an unconfirmed execution; leaving it open"
  );

  const workflowColumns = {
    id: workflowExecutions.id,
    workflowId: workflowExecutions.workflowId,
    transactionHashes: workflowExecutions.transactionHashes,
    startedAt: workflowExecutions.startedAt,
  };
  const workflowEligible = and(
    eq(workflowExecutions.status, "unconfirmed"),
    lt(workflowExecutions.startedAt, cutoff)
  );
  const [newestWorkflows, oldestWorkflows] = await Promise.all([
    db
      .select(workflowColumns)
      .from(workflowExecutions)
      .where(workflowEligible)
      .orderBy(desc(workflowExecutions.startedAt))
      .limit(maxRows),
    db
      .select(workflowColumns)
      .from(workflowExecutions)
      .where(workflowEligible)
      .orderBy(asc(workflowExecutions.startedAt))
      .limit(sliceRows),
  ]);

  const workflows = await drain(
    tailFirst(oldestWorkflows, newestWorkflows),
    startedAt + timeBudgetMs,
    (execution) => reconcileWorkflow(execution, now),
    "[Reconciler] Failed to re-verify an unconfirmed workflow run; leaving it open"
  );

  if (direct.deferred > 0 || workflows.deferred > 0) {
    logWarn(
      "[Reconciler] Time budget exhausted before every unconfirmed row was examined",
      {
        direct_deferred: String(direct.deferred),
        workflow_deferred: String(workflows.deferred),
        budget_ms: String(timeBudgetMs),
      }
    );
  }

  if (direct.examined > 0 || workflows.examined > 0) {
    logInfo("[Reconciler] Settled unconfirmed executions", {
      direct_examined: String(direct.examined),
      direct_completed: String(direct.completed),
      direct_failed: String(direct.failed),
      workflow_examined: String(workflows.examined),
      workflow_completed: String(workflows.completed),
      workflow_failed: String(workflows.failed),
    });
  }

  return { direct, workflows };
}
