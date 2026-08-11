import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  type DirectExecutionReceiptEntry,
  directExecutions,
} from "@/lib/db/schema";
import { generateId } from "@/lib/utils/id";
import {
  describeVerificationFailure,
  hasUnreadableReceipt,
  verifyExecutionReceipts,
} from "@/lib/web3/verify-receipt";

type CreateExecutionParams = {
  organizationId: string;
  apiKeyId: string;
  type: string;
  network?: string;
  input: Record<string, unknown>;
};

type CompleteParams = {
  transactionHash?: string;
  transactionLink?: string;
  // KEEP-966: chain the transaction was broadcast on. Required to
  // independently verify transactionHash; its absence on a claimed hash
  // fails the execution closed rather than skipping verification.
  chainId?: number;
  gasUsedWei?: string;
  gasPriceWei?: string;
  estimatedCostUsd?: string;
  output?: Record<string, unknown>;
};

export type CompleteExecutionOutcome = {
  status: "completed" | "failed" | "unconfirmed";
  error?: string;
};

function isInconclusive(receipts: DirectExecutionReceiptEntry[]): boolean {
  return hasUnreadableReceipt(
    receipts.map((receipt) => ({
      verified: receipt.verified,
      status: receipt.receiptStatus,
    }))
  );
}

export async function createExecution(
  params: CreateExecutionParams
): Promise<{ executionId: string }> {
  const id = generateId();

  await db.insert(directExecutions).values({
    id,
    organizationId: params.organizationId,
    apiKeyId: params.apiKeyId,
    type: params.type,
    network: params.network ?? null,
    // biome-ignore lint/suspicious/noExplicitAny: jsonb column accepts arbitrary serializable data
    input: params.input as any,
    status: "pending",
  });

  return { executionId: id };
}

export async function markRunning(executionId: string): Promise<void> {
  await db
    .update(directExecutions)
    .set({ status: "running" })
    .where(eq(directExecutions.id, executionId));
}

/**
 * KEEP-966: the single gate every direct-execute route must go through to
 * finalize an execution. Trusts nothing about `result` beyond the presence
 * of a transactionHash -- if one is present, it is independently
 * re-verified against the chain before "completed" can be written, entirely
 * regardless of whether the caller believed the write succeeded. Callers
 * MUST use the returned outcome (not their own success determination) to
 * build the HTTP response and idempotency-cache status.
 */
export async function completeExecution(
  executionId: string,
  result: CompleteParams
): Promise<CompleteExecutionOutcome> {
  let status: CompleteExecutionOutcome["status"] = "completed";
  let error: string | undefined;
  let receipts: DirectExecutionReceiptEntry[] = [];

  if (result.transactionHash) {
    if (result.chainId === undefined) {
      status = "failed";
      error = "Unable to verify transaction: missing chainId";
    } else {
      const { allVerified, results } = await verifyExecutionReceipts([
        { hash: result.transactionHash, chainId: result.chainId },
      ]);
      receipts = results.map((r) => ({
        hash: r.hash,
        chainId: r.chainId,
        verified: r.verified,
        receiptStatus: r.status,
        blockNumber: r.blockNumber,
        gasUsed: r.gasUsed,
        verifiedAt: r.verifiedAt,
      }));
      if (!allVerified) {
        // A hash we cannot see is not a hash that failed. Settling it as
        // failed is what makes a caller retry an action that already moved
        // funds, so it stays non-terminal until the chain actually answers.
        status = isInconclusive(receipts) ? "unconfirmed" : "failed";
        error = describeVerificationFailure(results);
      }
    }
  }

  const isTerminal = status !== "unconfirmed";

  await db
    .update(directExecutions)
    .set({
      status,
      error: status === "completed" ? null : error,
      transactionHash: result.transactionHash ?? null,
      receipts,
      gasUsedWei: result.gasUsedWei ?? null,
      gasPriceWei: result.gasPriceWei ?? null,
      estimatedCostUsd: result.estimatedCostUsd ?? null,
      // biome-ignore lint/suspicious/noExplicitAny: jsonb column accepts arbitrary serializable data
      output: (result.output ?? {}) as any,
      // An unconfirmed execution has not completed, and the reconciler uses a
      // null completedAt to find rows that still need settling.
      completedAt: isTerminal ? new Date() : null,
    })
    .where(eq(directExecutions.id, executionId));

  return { status, error };
}

type FailParams = {
  // Present when the write reached the chain and failed there.
  // A failed execution that broadcast a real transaction must still record
  // which transaction, and what the chain says about it -- that is the case
  // an operator most needs the receipt for. Omitted for pre-broadcast
  // failures (validation, policy, RPC), where there is nothing to reconcile.
  transactionHash?: string;
  chainId?: number;
  // Whether the write was routed through the gas-sponsored path. Recorded
  // separately because `output` is not written on the failure path, and the
  // status route derives `sponsored` from it -- without this a sponsored
  // failure reports sponsored: false.
  sponsored?: boolean;
};

/**
 * Finalize a failed execution.
 *
 * A failure that carries a transaction hash is not automatically terminal. The
 * write path can report failure for a send that is already on the network and
 * may still land, most notably a gas-sponsored transaction Turnkey accepted but
 * whose receipt no endpoint could read. Calling that "failed" is what invites
 * the retry that broadcasts a second transaction from the same wallet, so the
 * chain decides: conclusive receipt means failed, no readable receipt means
 * `unconfirmed` and the reconciler keeps watching.
 */
export async function failExecution(
  executionId: string,
  error: string,
  params: FailParams = {}
): Promise<{ status: "failed" | "unconfirmed" }> {
  let receipts: DirectExecutionReceiptEntry[] = [];

  if (params.transactionHash && params.chainId !== undefined) {
    const { results } = await verifyExecutionReceipts([
      { hash: params.transactionHash, chainId: params.chainId },
    ]);
    receipts = results.map((r) => ({
      hash: r.hash,
      chainId: r.chainId,
      verified: r.verified,
      receiptStatus: r.status,
      blockNumber: r.blockNumber,
      gasUsed: r.gasUsed,
      verifiedAt: r.verifiedAt,
    }));
  }

  const status =
    receipts.length > 0 && isInconclusive(receipts) ? "unconfirmed" : "failed";

  await db
    .update(directExecutions)
    .set({
      status,
      error,
      ...(params.transactionHash
        ? { transactionHash: params.transactionHash }
        : {}),
      ...(receipts.length > 0 ? { receipts } : {}),
      ...(params.sponsored === undefined
        ? {}
        : // biome-ignore lint/suspicious/noExplicitAny: jsonb column accepts arbitrary serializable data
          { output: { sponsored: params.sponsored } as any }),
      // The reconciler finds rows still needing settlement by their null
      // completedAt, so an unconfirmed row must not carry one.
      completedAt: status === "failed" ? new Date() : null,
    })
    .where(eq(directExecutions.id, executionId));

  return { status };
}

export async function setRetryCount(
  executionId: string,
  count: number
): Promise<void> {
  await db
    .update(directExecutions)
    .set({ retryCount: count })
    .where(eq(directExecutions.id, executionId));
}

const SENSITIVE_FIELDS = ["privateKey", "secret", "password", "mnemonic"];

export function redactInput(
  input: Record<string, unknown>
): Record<string, unknown> {
  const redacted = { ...input };

  if (typeof redacted.abi === "string" && redacted.abi.length > 100) {
    redacted.abi = `${redacted.abi.slice(0, 100)}... (truncated)`;
  }

  for (const key of SENSITIVE_FIELDS) {
    if (key in redacted) {
      redacted[key] = "[REDACTED]";
    }
  }

  return redacted;
}

/**
 * Records a signer override the caller supplied but the route did not honor.
 *
 * Org-custodied direct executions always resolve the signer via org policy, so
 * a caller-supplied `web3Connection` (the per-node signer-mode selector) never
 * influences the write. We still want it in the audit log -- a smuggled
 * `web3Connection: "eoa"` is a bypass attempt worth seeing -- but it must not
 * sit at the top level where a reader could mistake it for a value that took
 * effect. This moves any top-level `web3Connection` out of `auditBase` and
 * records it under `_rejectedConfig` instead, keying off the caller's original
 * request so it works whether or not `auditBase` has already been stripped.
 */
export function withRejectedSignerOverride(
  auditBase: Record<string, unknown>,
  callerConfig: Record<string, unknown>
): Record<string, unknown> {
  if (!("web3Connection" in callerConfig)) {
    return auditBase;
  }
  const { web3Connection: _omit, ...base } = auditBase;
  return {
    ...base,
    _rejectedConfig: { web3Connection: callerConfig.web3Connection },
  };
}
