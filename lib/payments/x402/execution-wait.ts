import "server-only";

import { and, desc, eq } from "drizzle-orm";
import {
  ETHEREUM_MAINNET_CHAIN_ID,
  KEEPERHUB_ERC_8004_AGENT_ID,
} from "@/lib/agentic-wallet/constants";
import { db } from "@/lib/db";
import { workflowExecutionLogs, workflowExecutions } from "@/lib/db/schema";
import { isErrorStatus } from "@/lib/errors/execution-status";

/**
 * Default timeout for waiting on read-workflow completion before falling back
 * to the async `{executionId, status: "running"}` response. Kept under typical
 * HTTP/MCP client timeouts (~30s) so clients don't time out on us.
 */
export const DEFAULT_CALL_WAIT_TIMEOUT_MS = 25_000;
const DEFAULT_POLL_INTERVAL_MS = 1000;

type TerminalStatus =
  | "success"
  | "error"
  | "system_error"
  | "cancelled"
  | "skipped";

type ExecutionResult = {
  status: TerminalStatus;
  output: unknown;
  error: string | null;
};

function isTerminalStatus(status: string): status is TerminalStatus {
  return (
    status === "success" ||
    isErrorStatus(status) ||
    status === "cancelled" ||
    // A refused run never starts, so a caller waiting on it must stop here
    // rather than poll until the timeout.
    status === "skipped"
  );
}

function loadReceiptRow(executionId: string) {
  return db.query.workflowExecutions.findFirst({
    where: eq(workflowExecutions.id, executionId),
    columns: {
      status: true,
      output: true,
      error: true,
      transactionHashes: true,
      gasUsedWei: true,
      completedAt: true,
    },
  });
}

export type ExecutionReceiptRow = NonNullable<
  Awaited<ReturnType<typeof loadReceiptRow>>
>;

export type ExecutionReceiptPoll = {
  row: ExecutionReceiptRow | null;
  completed: boolean;
};

/**
 * Poll the execution row until it reaches a terminal state (success, error,
 * cancelled) or the timeout elapses. Always returns the last-seen row (so
 * callers can read the receipt on timeout too); `row` is null only when the
 * execution does not exist, and `completed` is true only on a terminal state.
 */
async function pollExecutionReceipt(
  executionId: string,
  timeoutMs: number,
  pollIntervalMs: number
): Promise<ExecutionReceiptPoll> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const row = await loadReceiptRow(executionId);
    if (!row) {
      return { row: null, completed: false };
    }
    if (isTerminalStatus(row.status)) {
      return { row, completed: true };
    }
    if (Date.now() + pollIntervalMs >= deadline) {
      return { row, completed: false };
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

/**
 * Poll until the execution reaches a terminal state or the timeout elapses,
 * returning the receipt row plus a `completed` flag. Unlike
 * waitForExecutionCompletion, the row is returned on timeout too so the caller
 * does not need a second read for the transaction hashes / gas / completedAt.
 */
export function waitForExecutionReceipt(
  executionId: string,
  timeoutMs: number = DEFAULT_CALL_WAIT_TIMEOUT_MS,
  pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS
): Promise<ExecutionReceiptPoll> {
  return pollExecutionReceipt(executionId, timeoutMs, pollIntervalMs);
}

/**
 * Poll workflowExecutions.status until it reaches a terminal state (success,
 * error, cancelled) or the timeout elapses. Returns null on timeout.
 */
export async function waitForExecutionCompletion(
  executionId: string,
  timeoutMs: number = DEFAULT_CALL_WAIT_TIMEOUT_MS,
  pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS
): Promise<ExecutionResult | null> {
  if (timeoutMs <= 0) {
    return null;
  }
  const { row } = await pollExecutionReceipt(
    executionId,
    timeoutMs,
    pollIntervalMs
  );
  if (!(row && isTerminalStatus(row.status))) {
    return null;
  }
  return {
    status: row.status,
    output: row.output,
    error: row.error ?? null,
  };
}

/**
 * Resolve the payload returned inline to the caller for a completed read
 * workflow. outputMapping shape is `{ nodeId?: string, fields?: string[] }`:
 *   - If nodeId is set, fetch that node's successful log output.
 *   - If fields is set, pick only those keys from the node output.
 *   - Otherwise, return the workflow-level output as-is.
 */
export async function applyOutputMapping(
  executionId: string,
  workflowOutput: unknown,
  outputMapping: Record<string, unknown> | null | undefined
): Promise<unknown> {
  if (!outputMapping || typeof outputMapping !== "object") {
    return workflowOutput;
  }
  const mapping = outputMapping as { nodeId?: unknown; fields?: unknown };
  const nodeId = typeof mapping.nodeId === "string" ? mapping.nodeId : null;
  if (!nodeId) {
    return workflowOutput;
  }

  const log = await db.query.workflowExecutionLogs.findFirst({
    where: and(
      eq(workflowExecutionLogs.executionId, executionId),
      eq(workflowExecutionLogs.nodeId, nodeId),
      eq(workflowExecutionLogs.status, "success")
    ),
    orderBy: [desc(workflowExecutionLogs.completedAt)],
  });
  const nodeOutput = log?.output ?? workflowOutput;

  if (
    Array.isArray(mapping.fields) &&
    mapping.fields.length > 0 &&
    nodeOutput &&
    typeof nodeOutput === "object"
  ) {
    const picked: Record<string, unknown> = {};
    for (const field of mapping.fields) {
      if (typeof field === "string") {
        picked[field] = (nodeOutput as Record<string, unknown>)[field];
      }
    }
    return picked;
  }
  return nodeOutput;
}

// ERC-8004 feedback CTA appended to every successful workflow execution
// response. The calling agent (LLM) reads this and can prompt the user to
// rate the workflow, then invoke the keeperhub-wallet `feedback`
// MCP tool to submit on-chain feedback to the ERC-8004 ReputationRegistry.
//
// Hardcoded to the canonical KeeperHub agent on Ethereum mainnet (NFT 31875).
// User instruction "any agent" is honoured at the SUBMISSION layer (the
// /api/agentic-wallet/feedback route accepts an override agentId); this CTA
// just suggests the default target.
export type FeedbackCta = {
  prompt: string;
  tool: string;
  context: {
    executionId: string;
    agent: {
      registry: "erc-8004";
      chainId: number;
      id: string;
      explorerUrl: string;
    };
  };
};

const KEEPERHUB_FEEDBACK_CTA: Omit<FeedbackCta, "context"> = {
  prompt:
    "Was this workflow useful? Rate it (1-5) on the ERC-8004 ReputationRegistry — your wallet signs and submits on-chain in one call. Use the keeperhub-wallet `feedback` tool with this executionId.",
  tool: "keeperhub-wallet:feedback",
};

function buildFeedbackCta(executionId: string): FeedbackCta {
  return {
    ...KEEPERHUB_FEEDBACK_CTA,
    context: {
      executionId,
      agent: {
        registry: "erc-8004",
        chainId: ETHEREUM_MAINNET_CHAIN_ID,
        id: String(KEEPERHUB_ERC_8004_AGENT_ID),
        explorerUrl: `https://8004scan.io/agents/ethereum/${KEEPERHUB_ERC_8004_AGENT_ID}`,
      },
    },
  };
}

export type CallCompletionResponse =
  | {
      executionId: string;
      status: "success";
      output: unknown;
      feedback: FeedbackCta;
    }
  | { executionId: string; status: "error"; error: string }
  | { executionId: string; status: "running" };

/**
 * Wait for the read-workflow execution to complete, then build the response
 * payload. On timeout, returns `{status: "running"}` so clients can fall back
 * to polling the existing status/logs endpoints.
 */
export async function buildCallCompletionResponse(
  executionId: string,
  outputMapping: Record<string, unknown> | null | undefined,
  timeoutMs: number = DEFAULT_CALL_WAIT_TIMEOUT_MS
): Promise<CallCompletionResponse> {
  const result = await waitForExecutionCompletion(executionId, timeoutMs);
  if (!result) {
    return { executionId, status: "running" };
  }
  if (result.status === "success") {
    const output = await applyOutputMapping(
      executionId,
      result.output,
      outputMapping
    );
    return {
      executionId,
      status: "success",
      output,
      feedback: buildFeedbackCta(executionId),
    };
  }
  if (result.status === "cancelled") {
    return { executionId, status: "error", error: "Execution cancelled" };
  }
  if (result.status === "skipped") {
    return {
      executionId,
      status: "error",
      error: result.error ?? "Execution skipped",
    };
  }
  return {
    executionId,
    status: "error",
    error: result.error ?? "Execution failed",
  };
}
