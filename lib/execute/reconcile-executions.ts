import "server-only";

import { and, asc, eq, isNotNull, lt } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  type DirectExecution,
  type DirectExecutionReceiptEntry,
  directExecutions,
  type TransactionHashEntry,
  workflowExecutions,
} from "@/lib/db/schema";
import { ErrorCategory, logInfo, logSystemWarn } from "@/lib/logging";
import { recordWorkflowExecutionFinished } from "@/lib/metrics/collectors/prometheus";
import { NA_ERROR_TYPE } from "@/lib/metrics/metric-constants";
import { resolveOrgSlugForCounter } from "@/lib/metrics/org-slug.server";
import {
  describeVerificationFailure,
  hasUnreadableReceipt,
  verifyExecutionReceipts,
} from "@/lib/web3/verify-receipt";

/**
 * Settles direct executions left in `unconfirmed`: a transaction was broadcast
 * but the chain had not yet told us whether it landed by the time the request
 * had to answer.
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
const DEFAULT_BATCH_SIZE = 200;

export type ReconcileSummary = {
  examined: number;
  completed: number;
  failed: number;
  stillUnconfirmed: number;
};

export type ReconcileReport = {
  direct: ReconcileSummary;
  workflows: ReconcileSummary;
};

function emptySummary(examined: number): ReconcileSummary {
  return { examined, completed: 0, failed: 0, stillUnconfirmed: 0 };
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

type SettleOutcome = "completed" | "failed" | "unconfirmed";

function resolveChainId(execution: DirectExecution): number | null {
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

async function settle(
  executionId: string,
  status: "completed" | "failed",
  receipts: DirectExecutionReceiptEntry[],
  error: string | null
): Promise<void> {
  await db
    .update(directExecutions)
    .set({ status, error, receipts, completedAt: new Date() })
    .where(eq(directExecutions.id, executionId));
}

async function reconcileOne(
  execution: DirectExecution,
  now: Date
): Promise<"completed" | "failed" | "unconfirmed"> {
  const chainId = resolveChainId(execution);
  const hash = execution.transactionHash;
  if (!hash || chainId === null) {
    await settle(
      execution.id,
      "failed",
      execution.receipts,
      "Unable to verify transaction: chain could not be resolved"
    );
    return "failed";
  }

  const { allVerified, results } = await verifyExecutionReceipts([
    { hash, chainId },
  ]);
  const receipts = toReceiptEntries(results);

  if (allVerified) {
    await settle(execution.id, "completed", receipts, null);
    return "completed";
  }

  const conclusive = results.every(
    (result) =>
      result.status === "reverted" || result.status === "safe_inner_failure"
  );
  if (conclusive) {
    await settle(
      execution.id,
      "failed",
      receipts,
      describeVerificationFailure(results)
    );
    return "failed";
  }

  const age = now.getTime() - execution.createdAt.getTime();
  if (age >= DROPPED_AFTER_MS) {
    await settle(
      execution.id,
      "failed",
      receipts,
      `Transaction ${hash} was broadcast but never appeared on chain; treating it as dropped after ${Math.round(
        DROPPED_AFTER_MS / 3_600_000
      )}h`
    );
    return "failed";
  }

  await db
    .update(directExecutions)
    .set({ receipts })
    .where(eq(directExecutions.id, execution.id));
  return "unconfirmed";
}

/**
 * Settle one unconfirmed workflow run.
 *
 * A workflow claims many hashes, so it settles to success only when every hash
 * verifies, and to error only when at least one is conclusively bad. While any
 * hash is merely unreadable the run stays open.
 */
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

async function reconcileWorkflow(
  execution: {
    id: string;
    workflowId: string;
    transactionHashes: TransactionHashEntry[] | null;
    startedAt: Date;
  },
  now: Date
): Promise<SettleOutcome> {
  const entries = execution.transactionHashes ?? [];
  const verifiable = entries.filter(
    (entry): entry is TransactionHashEntry & { chainId: number } =>
      entry.chainId !== undefined
  );

  if (verifiable.length === 0) {
    await db
      .update(workflowExecutions)
      .set({
        status: "error",
        error: "On-chain verification failed: no verifiable transaction hashes",
      })
      .where(eq(workflowExecutions.id, execution.id));
    await recordSettled(execution.workflowId, "error");
    return "failed";
  }

  const { allVerified, results } = await verifyExecutionReceipts(
    verifiable.map((entry) => ({ hash: entry.hash, chainId: entry.chainId }))
  );

  if (allVerified) {
    await db
      .update(workflowExecutions)
      .set({ status: "success", error: null, completedAt: new Date() })
      .where(eq(workflowExecutions.id, execution.id));
    await recordSettled(execution.workflowId, "success");
    return "completed";
  }

  const stillUnreadable = hasUnreadableReceipt(results);
  const age = now.getTime() - execution.startedAt.getTime();
  if (stillUnreadable && age < DROPPED_AFTER_MS) {
    return "unconfirmed";
  }

  await db
    .update(workflowExecutions)
    .set({
      status: "error",
      error: stillUnreadable
        ? `Transactions were broadcast but never appeared on chain; treating them as dropped after ${Math.round(
            DROPPED_AFTER_MS / 3_600_000
          )}h`
        : describeVerificationFailure(results),
      completedAt: new Date(),
    })
    .where(eq(workflowExecutions.id, execution.id));
  await recordSettled(execution.workflowId, "error");
  return "failed";
}

export async function reconcileUnconfirmedExecutions(
  now: Date = new Date(),
  batchSize: number = DEFAULT_BATCH_SIZE
): Promise<ReconcileReport> {
  const cutoff = new Date(now.getTime() - MIN_AGE_MS);

  const pending = await db
    .select()
    .from(directExecutions)
    .where(
      and(
        eq(directExecutions.status, "unconfirmed"),
        isNotNull(directExecutions.transactionHash),
        lt(directExecutions.createdAt, cutoff)
      )
    )
    .orderBy(asc(directExecutions.createdAt))
    .limit(batchSize);

  const direct = emptySummary(pending.length);

  for (const execution of pending) {
    try {
      tally(direct, await reconcileOne(execution, now));
    } catch (error) {
      direct.stillUnconfirmed += 1;
      logSystemWarn(
        ErrorCategory.NETWORK_RPC,
        "[Reconciler] Failed to re-verify an unconfirmed execution; leaving it open",
        error instanceof Error ? error : new Error(String(error)),
        { execution_id: execution.id }
      );
    }
  }

  const pendingWorkflows = await db
    .select({
      id: workflowExecutions.id,
      workflowId: workflowExecutions.workflowId,
      transactionHashes: workflowExecutions.transactionHashes,
      startedAt: workflowExecutions.startedAt,
    })
    .from(workflowExecutions)
    .where(
      and(
        eq(workflowExecutions.status, "unconfirmed"),
        lt(workflowExecutions.startedAt, cutoff)
      )
    )
    .orderBy(asc(workflowExecutions.startedAt))
    .limit(batchSize);

  const workflows = emptySummary(pendingWorkflows.length);

  for (const execution of pendingWorkflows) {
    try {
      tally(workflows, await reconcileWorkflow(execution, now));
    } catch (error) {
      workflows.stillUnconfirmed += 1;
      logSystemWarn(
        ErrorCategory.NETWORK_RPC,
        "[Reconciler] Failed to re-verify an unconfirmed workflow run; leaving it open",
        error instanceof Error ? error : new Error(String(error)),
        { execution_id: execution.id }
      );
    }
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
