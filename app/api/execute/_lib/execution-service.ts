import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  type DirectExecutionReceiptEntry,
  directExecutions,
} from "@/lib/db/schema";
import type { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { generateId } from "@/lib/utils/id";
import type { RevertKind } from "@/lib/web3/decode-revert-error";
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
      // A hash with no chain to check it against is unverifiable, not failed --
      // the same argument the `!allVerified` branch below already makes. It
      // matters more now that `failed` releases the idempotency key: calling an
      // unread broadcast "failed" would free the key for a retry that
      // re-broadcasts a transaction which may already have landed.
      status = "unconfirmed";
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
        //
        // The spentASafeNonce half mirrors the guard in failExecution below:
        // `safe_inner_failure` is conclusive about the inner call, not the
        // transaction -- the outer execTransaction mined, so the Safe nonce
        // and the owner signatures for it are spent, and `failed` maps to
        // `release` in idempotency-disposition. Releasing here lets a retry
        // spend a second nonce and a second signature set. Latent for the
        // reason failExecution's comment gives (safeTxGas=0 makes the outer
        // transaction revert first), but the guard belongs at both
        // chokepoints, not one.
        const spentASafeNonce = receipts.some(
          (receipt) => receipt.receiptStatus === "safe_inner_failure"
        );
        status =
          isInconclusive(receipts) || spentASafeNonce
            ? "unconfirmed"
            : "failed";
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
      // An unconfirmed execution has not completed, so it carries no
      // completedAt. The reconciler finds rows that still need settling by
      // status = 'unconfirmed' (lib/execute/reconcile-executions.ts), not by a
      // null completedAt.
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
  broadcastAttempted?: boolean;
  transactionLink?: string;
  rejection?: RevertKind;
  errorClass?: ExecutionErrorType;
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

  // A hash without a `chainId` cannot be verified. Fail closed here as well as
  // at route disposition call sites: `FailParams` permits the pair to come apart,
  // and missing verification data must never be treated as proof of a conclusive
  // failure. Such a row remains unconfirmed until reconciliation can adjudicate
  // it with enough chain context.
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

  // A hash that re-verifies as *successful* means the write threw after its
  // transaction had already landed: the throw was ours (a receipt we could not
  // read the first time, a post-broadcast timeout), not the chain's verdict.
  // Recording that as a definite failure is the same mistake in the opposite
  // direction -- it invites a retry that re-runs an action which already took
  // effect. Left non-terminal, the reconciler re-reads the receipt and settles
  // the row as `completed`, which is what actually happened.
  const landedSuccessfully = receipts.some((receipt) => receipt.verified);

  // `safe_inner_failure` is conclusive about the INNER call and not about the
  // transaction. verify-receipt only reaches that branch below its
  // `receipt.status === 0` early return, so the outer `execTransaction` mined:
  // the Safe's nonce was consumed and the owner signatures for that nonce were
  // spent. `failed` maps to `release` in idempotency-disposition, and releasing
  // here lets a retry spend a second nonce and a second signature set. The
  // release contract is "nothing landed", and something landed -- not the work
  // the caller wanted, but a transaction the chain has accounted for.
  //
  // Latent at the time of writing: transactions this codebase builds pass
  // safeTxGas=0, baseGas=0, gasPrice=0, so Safe's own require reverts the outer
  // transaction to status 0 and the plain status check above catches it first
  // (see the reachability note in lib/web3/verify-receipt.ts). A path that
  // submits a Safe transaction it did not construct -- executing one queued in
  // the Safe UI, where the proposer sets safeTxGas -- reaches this immediately.
  const spentASafeNonce = receipts.some(
    (receipt) => receipt.receiptStatus === "safe_inner_failure"
  );

  const hashlessAttemptStillInFlight =
    params.broadcastAttempted === true && !params.transactionHash;
  const hashWithoutChainContext =
    Boolean(params.transactionHash) && params.chainId === undefined;
  const status =
    hashlessAttemptStillInFlight ||
    hashWithoutChainContext ||
    (receipts.length > 0 &&
      (isInconclusive(receipts) || landedSuccessfully || spentASafeNonce))
      ? "unconfirmed"
      : "failed";

  const failureOutput: Record<string, unknown> = {};
  if (params.sponsored !== undefined) {
    failureOutput.sponsored = params.sponsored;
  }
  if (params.broadcastAttempted !== undefined) {
    failureOutput.broadcastAttempted = params.broadcastAttempted;
  }
  if (params.transactionLink) {
    failureOutput.transactionLink = params.transactionLink;
  }
  if (params.rejection) {
    failureOutput.rejection = params.rejection;
  }
  if (params.errorClass) {
    failureOutput.errorClass = params.errorClass;
  }

  await db
    .update(directExecutions)
    .set({
      status,
      error,
      ...(params.transactionHash
        ? { transactionHash: params.transactionHash }
        : {}),
      ...(receipts.length > 0 ? { receipts } : {}),
      ...(Object.keys(failureOutput).length > 0
        ? // biome-ignore lint/suspicious/noExplicitAny: jsonb column accepts arbitrary serializable data
          { output: failureOutput as any }
        : {}),
      // The reconciler finds rows still needing settlement by
      // status = 'unconfirmed' (lib/execute/reconcile-executions.ts); an
      // unconfirmed row carries no completedAt because it has not finished.
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
 * Records caller-supplied config keys the route did not honor.
 *
 * A rejected field still belongs in the audit log -- a smuggled
 * `web3Connection: "eoa"` is a bypass attempt worth seeing -- but it must not
 * sit at the top level where a reader could mistake it for a value that took
 * effect. This moves each named key out of `auditBase` and records it under
 * `_rejectedConfig` instead, keying off the caller's original request so it
 * works whether or not `auditBase` has already been stripped. Keys the caller
 * did not send are not recorded, so `_rejectedConfig` is absent on a clean
 * request. Merges into an existing `_rejectedConfig` so the helper can be
 * applied more than once.
 */
export function withRejectedConfig(
  auditBase: Record<string, unknown>,
  callerConfig: Record<string, unknown>,
  keys: readonly string[]
): Record<string, unknown> {
  const rejected: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in callerConfig) {
      rejected[key] = callerConfig[key];
    }
  }
  if (Object.keys(rejected).length === 0) {
    return auditBase;
  }
  const base = Object.fromEntries(
    Object.entries(auditBase).filter(([key]) => !keys.includes(key))
  );
  const existing = base._rejectedConfig;
  return {
    ...base,
    _rejectedConfig: {
      ...(typeof existing === "object" && existing !== null ? existing : {}),
      ...rejected,
    },
  };
}

/**
 * Records a signer override the caller supplied but the route did not honor.
 *
 * Org-custodied direct executions always resolve the signer via org policy, so
 * a caller-supplied `web3Connection` (the per-node signer-mode selector) never
 * influences the write.
 */
export function withRejectedSignerOverride(
  auditBase: Record<string, unknown>,
  callerConfig: Record<string, unknown>
): Record<string, unknown> {
  return withRejectedConfig(auditBase, callerConfig, ["web3Connection"]);
}
