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
  status: "completed" | "failed";
  error?: string;
};

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
  let status: "completed" | "failed" = "completed";
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
        status = "failed";
        error = describeVerificationFailure(results);
      }
    }
  }

  await db
    .update(directExecutions)
    .set({
      status,
      error: status === "failed" ? error : null,
      transactionHash: result.transactionHash ?? null,
      receipts,
      gasUsedWei: result.gasUsedWei ?? null,
      gasPriceWei: result.gasPriceWei ?? null,
      estimatedCostUsd: result.estimatedCostUsd ?? null,
      // biome-ignore lint/suspicious/noExplicitAny: jsonb column accepts arbitrary serializable data
      output: (result.output ?? {}) as any,
      completedAt: new Date(),
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

export async function failExecution(
  executionId: string,
  error: string,
  params: FailParams = {}
): Promise<void> {
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

  await db
    .update(directExecutions)
    .set({
      status: "failed",
      error,
      ...(params.transactionHash
        ? { transactionHash: params.transactionHash }
        : {}),
      ...(receipts.length > 0 ? { receipts } : {}),
      ...(params.sponsored === undefined
        ? {}
        : // biome-ignore lint/suspicious/noExplicitAny: jsonb column accepts arbitrary serializable data
          { output: { sponsored: params.sponsored } as any }),
      completedAt: new Date(),
    })
    .where(eq(directExecutions.id, executionId));
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
