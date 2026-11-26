import "server-only";

import { and, eq, type SQL, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { type TransactionHashEntry, workflowExecutions } from "@/lib/db/schema";
import {
  type BundleRun,
  pendingTransactions,
} from "@/lib/db/schema-extensions";
import { classifyExecutionError } from "@/lib/errors/classify";
import { logInfo } from "@/lib/logging";
import {
  recordWorkflowExecutionError,
  recordWorkflowExecutionLateLanded,
} from "@/lib/metrics/collectors/prometheus";
import { resolveOrgSlugForCounter } from "@/lib/metrics/org-slug.server";
import {
  loadSuccessLogFacts,
  stepKey,
} from "@/lib/workflow/executor/success-log-facts";
import {
  type MinedHash,
  minedOf,
  ownerOf,
  type ReceiptView,
} from "./bundle-history";

/** Reads a receipt on a chain; null when it cannot (another chain, or no answer). */
type ChainReceiptReader = (
  chainId: number,
  hash: string
) => Promise<ReceiptView>;

/** A send of the run found on chain, and the step that made it when known. */
type Landing = {
  chainId: number;
  mined: MinedHash;
  node: BundleRun["node"];
};

const fromNotLanded = (executionId: string): SQL | undefined =>
  and(
    eq(workflowExecutions.id, executionId),
    eq(workflowExecutions.status, "not_landed")
  );

/**
 * A bundle a run gave up on was mined later: re-settle the run that owns the
 * hash. A revert ends it `error` at once; a success goes through settleRun.
 * Call after the mined row is confirmed with the mined hash.
 */
export async function settleLateLanding(
  bundleRuns: readonly BundleRun[],
  chainId: number,
  mined: MinedHash,
  readReceipt: ChainReceiptReader
): Promise<void> {
  const owner = ownerOf(bundleRuns, mined.hash);
  if (!owner) {
    return;
  }
  if (mined.succeeded) {
    await settleRun(owner.executionId, readReceipt, { chainId, mined });
    return;
  }
  const [run] = await db
    .select({ hashes: workflowExecutions.transactionHashes })
    .from(workflowExecutions)
    .where(fromNotLanded(owner.executionId));
  if (run) {
    await resettleToError(owner.executionId, run.hashes, {
      chainId,
      mined,
      node: owner.node,
    });
  }
}

/**
 * Re-settle a not landed run from its confirmed bundle rows. `success` only
 * once every not-included step (node and iteration) has a confirmed row it
 * owns with a succeeded receipt, and no step skipped behind a bundle in
 * flight; `error` when one of those reverted. Otherwise it stays not landed.
 */
export async function settleRun(
  executionId: string,
  readReceipt: ChainReceiptReader,
  known?: { chainId: number; mined: MinedHash }
): Promise<void> {
  const [run] = await db
    .select({ hashes: workflowExecutions.transactionHashes })
    .from(workflowExecutions)
    .where(fromNotLanded(executionId));
  if (!run) {
    return;
  }
  const facts = await loadSuccessLogFacts(executionId, false);
  // Under-claim: a skip behind a bundle in flight, or no miss to match.
  if (facts.signals.skippedInFlight) {
    logStaysNotLanded(executionId, "not every step sent");
    return;
  }
  if (facts.notIncludedSteps.length === 0) {
    logStaysNotLanded(executionId, "no missed step in its logs");
    return;
  }
  const rows = await db
    .select({
      chainId: pendingTransactions.chainId,
      txHash: pendingTransactions.txHash,
      status: pendingTransactions.status,
      bundleRuns: pendingTransactions.bundleRuns,
    })
    .from(pendingTransactions)
    .where(
      sql`${pendingTransactions.bundleRuns} @> ${JSON.stringify([{ executionId }])}::jsonb`
    );

  // Rows that landed on time name steps that were never missed, so they match no key.
  const landed = new Map<string, Omit<Landing, "mined"> & { hash: string }>();
  for (const key of facts.notIncludedSteps) {
    const row = rows.find((candidate) => {
      const owner = ownerOf(candidate.bundleRuns, candidate.txHash);
      return (
        candidate.status === "confirmed" &&
        owner?.executionId === executionId &&
        owner.node !== undefined &&
        stepKey(owner.node.id, owner.node.iterationIndex) === key
      );
    });
    if (!row) {
      logStaysNotLanded(executionId, "another send in it has not landed");
      return;
    }
    landed.set(`${row.chainId}:${row.txHash}`, {
      chainId: row.chainId,
      hash: row.txHash,
      node: ownerOf(row.bundleRuns, row.txHash)?.node,
    });
  }

  const landings: Landing[] = [];
  for (const { hash, ...send } of landed.values()) {
    const isKnown =
      known?.chainId === send.chainId && known.mined.hash === hash;
    const receipt = isKnown ? null : await readReceipt(send.chainId, hash);
    const mined = isKnown ? known.mined : receipt && minedOf(hash, receipt);
    if (!mined) {
      logStaysNotLanded(executionId, "a receipt could not be read");
      return;
    }
    landings.push({ ...send, mined });
  }
  const reverted = landings.find((landing) => !landing.mined.succeeded);
  if (reverted) {
    await resettleToError(executionId, run.hashes, reverted);
    return;
  }
  await resettleToSuccess(executionId, run.hashes, landings);
}

function logStaysNotLanded(executionId: string, reason: string): void {
  logInfo(`[Bundle] A late landing left its run not landed: ${reason}`, {
    execution_id: executionId,
  });
}

async function resettleToError(
  executionId: string,
  existing: readonly TransactionHashEntry[],
  landing: Landing
): Promise<void> {
  const { mined } = landing;
  const message = `Transaction reverted: a transaction in this run was mined later and reverted (block ${mined.blockNumber ?? "unknown"}, ${mined.hash})`;
  const { errorType, errorCategory } = classifyExecutionError(message);
  const [updated] = await db
    .update(workflowExecutions)
    .set({
      status: "error",
      error: message,
      errorType,
      errorCategory,
      ...landedColumns(existing, [landing], "reverted"),
    })
    .where(fromNotLanded(executionId))
    .returning({ workflowId: workflowExecutions.workflowId });
  if (!updated) {
    return;
  }
  logInfo(
    "[Bundle] A not landed run's transaction was mined later and reverted",
    {
      execution_id: executionId,
      tx_hash: mined.hash,
      block_number: String(mined.blockNumber ?? "unknown"),
    }
  );
  try {
    const orgSlug = await resolveOrgSlugForCounter(updated.workflowId);
    recordWorkflowExecutionLateLanded({ orgSlug, status: "error" });
    recordWorkflowExecutionError({ orgSlug, errorCategory, errorType });
  } catch {
    // Counter emission must never break the settle.
  }
}

async function resettleToSuccess(
  executionId: string,
  existing: readonly TransactionHashEntry[],
  landings: readonly Landing[]
): Promise<void> {
  const [updated] = await db
    .update(workflowExecutions)
    .set({
      status: "success",
      error: null,
      ...landedColumns(existing, landings, "success"),
    })
    .where(fromNotLanded(executionId))
    .returning({ workflowId: workflowExecutions.workflowId });
  if (!updated) {
    return;
  }
  logInfo("[Bundle] A not landed run's transactions were mined later", {
    execution_id: executionId,
    tx_hash: landings.map((landing) => landing.mined.hash).join(","),
  });
  try {
    recordWorkflowExecutionLateLanded({
      orgSlug: await resolveOrgSlugForCounter(updated.workflowId),
      status: "success",
    });
  } catch {
    // Counter emission must never break the settle.
  }
}

/**
 * The late hashes the run does not list yet (named only when the step is
 * known), and their fees added to its gas: once, however often it re-settles.
 */
function landedColumns(
  existing: readonly TransactionHashEntry[],
  landings: readonly Landing[],
  receiptStatus: "success" | "reverted"
): { transactionHashes?: SQL; gasUsedWei?: SQL } {
  const listed = new Set(existing.map((entry) => entry.hash));
  const fresh = landings.filter((landing) => !listed.has(landing.mined.hash));
  const entries = fresh.flatMap((landing) => {
    const entry = hashEntry(landing, receiptStatus);
    return entry ? [entry] : [];
  });
  // The fee was paid even when no entry can name its step.
  const fee = fresh.reduce(
    (total, landing) => total + (landing.mined.feeWei ?? BigInt(0)),
    BigInt(0)
  );
  return {
    ...(entries.length > 0 && {
      transactionHashes: sql`coalesce(${workflowExecutions.transactionHashes}, '[]'::jsonb) || ${JSON.stringify(entries)}::jsonb`,
    }),
    ...(fee > BigInt(0) && {
      gasUsedWei: sql`coalesce(${workflowExecutions.gasUsedWei}, 0) + ${fee.toString()}::numeric`,
    }),
  };
}

function hashEntry(
  { chainId, mined, node }: Landing,
  receiptStatus: "success" | "reverted"
): TransactionHashEntry | undefined {
  if (!node) {
    return;
  }
  return {
    hash: mined.hash,
    nodeId: node.id,
    nodeName: node.name,
    chainId,
    ...(node.iterationIndex !== undefined && {
      iterationIndex: node.iterationIndex,
    }),
    verified: true,
    receiptStatus,
    ...(mined.blockNumber !== null && { blockNumber: mined.blockNumber }),
    ...(mined.gasUnits !== null && { gasUsed: mined.gasUnits.toString() }),
    verifiedAt: new Date().toISOString(),
  };
}
