import type { DirectExecutionReceiptEntry } from "@/lib/db/schema";
import type { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import type { RevertKind } from "@/lib/web3/decode-revert-error";

/**
 * `unconfirmed` is non-terminal and means a transaction was broadcast but the
 * chain has not yet told us whether it landed. It is deliberately not `failed`:
 * a caller that reads "failed" for a transaction that actually succeeded will
 * retry, and a retry of a fund-moving action is the thing we most need to
 * avoid. Clients should keep polling; a reconciliation sweep settles the row to
 * completed or failed once the chain answers.
 */
export type ExecutionStatus =
  | "pending"
  | "running"
  | "unconfirmed"
  | "completed"
  | "failed";

export type ExecuteResponse = {
  executionId: string;
  status: ExecutionStatus;
  transactionHash?: string | null;
  transactionLink?: string | null;
  // Present only when status is "failed". Includes the on-chain
  // reconciliation failure message (e.g. reverted, receipt not found) when
  // that's what failed the execution, not just a self-reported broadcast error.
  // Omitted for `unconfirmed`: that status is non-terminal and poll-only.
  // Callers must not treat a missing or present `error` as a signal to retry.
  error?: string;
  // Typed revert classification from the write step, when available.
  rejection?: RevertKind;
  errorClass?: ExecutionErrorType;
};

export type ExecutionStatusResponse = {
  executionId: string;
  status: ExecutionStatus;
  type: string;
  transactionHash: string | null;
  transactionLink: string | null;
  sponsored: boolean;
  // Per-hash on-chain verification evidence behind `status`.
  // completeExecution() has persisted this since the reconciliation gate
  // landed; without it on the
  // response a caller can see that an execution was gated but not what the
  // gate observed. Empty for executions that claimed no transaction hash.
  receipts: DirectExecutionReceiptEntry[];
  result: unknown;
  error: string | null;
  gasUsedWei: string | null;
  gasPriceWei: string | null;
  estimatedCostUsd: string | null;
  retryCount: number;
  network: string | null;
  createdAt: string;
  completedAt: string | null;
};

export type ExecuteErrorResponse = {
  error: string;
  details?: string;
  field?: string;
};

export type RetryConfig = {
  maxRetries?: number;
  timeoutMs?: number;
};

export type NodeExecuteRequest = {
  actionType: string;
  config: Record<string, unknown>;
  integrationId?: string;
  network?: string;
  retry?: RetryConfig;
};
