/**
 * Analytics Dashboard Types
 *
 * Unified types for the analytics dashboard that normalize
 * workflow_executions and direct_executions into a single view.
 */

import type { TransactionHashEntry } from "@/lib/db/schema";
import type { ExecutionErrorType } from "@/lib/errors/execution-error-type";

export type { TransactionHashEntry } from "@/lib/db/schema";

export type TimeRange = "1h" | "24h" | "7d" | "30d" | "custom";

export type RunSource = "workflow" | "direct";

export type DirectType = "transfer" | "contract-call" | "check-and-execute";

export type UnifiedStatus =
  | "pending"
  | "running"
  | "success"
  | "error"
  | "cancelled"
  | "completed"
  | "failed";

export type NormalizedStatus =
  | "pending"
  | "running"
  | "success"
  | "error"
  | "system_error"
  | "external_error"
  | "cancelled";

export type UnifiedRun = {
  id: string;
  source: RunSource;
  status: NormalizedStatus;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  workflowId: string | null;
  workflowName: string | null;
  directType: DirectType | null;
  network: string | null;
  /** Distinct networks (chain ids) the run produced on-chain writes on. */
  networks: string[];
  /** Total native gas cost (wei) sponsored across the run's transactions. */
  gasCostWei: string | null;
  /**
   * KEEP-470: Ordered list of on-chain writes the run recorded.
   *
   * Workflow runs surface every tx-producing node's hash in submission order;
   * direct runs surface their single hash as a one-element array (so consumers
   * can render workflow + direct runs through the same code path). Empty
   * array means the run produced no on-chain writes (or, for workflows
   * that finalized before this migration, the column hasn't been backfilled).
   */
  transactionHashes: TransactionHashEntry[];
  gasUsedWei: string | null;
  totalSteps: number | null;
  completedSteps: number | null;
  error: string | null;
  errorCode: string | null;
  errorType: ExecutionErrorType | null;
  errorCategory: string | null;
};

export type AnalyticsSummary = {
  totalRuns: number;
  successCount: number;
  errorCount: number;
  cancelledCount: number;
  successRate: number;
  avgDurationMs: number | null;
  /** Gas paid by the org's own wallet over the range, in wei. */
  totalGasWei: string;
  /**
   * Gas paid by KeeperHub sponsorship over the range, in wei, read from the
   * gas-credit ledger. Disjoint from `totalGasWei`, so the headline figure the
   * Gas Spent KPI renders is the two added together.
   */
  sponsoredGasWei: string;
  activeRuns: number;
  previousPeriod: {
    totalRuns: number;
    successCount: number;
    errorCount: number;
    cancelledCount: number;
    avgDurationMs: number | null;
    totalGasWei: string;
    sponsoredGasWei: string;
  } | null;
};

export type TimeSeriesBucket = {
  timestamp: string;
  success: number;
  error: number;
  cancelled: number;
  pending: number;
  running: number;
};

export type NetworkBreakdown = {
  network: string;
  totalGasWei: string;
  executionCount: number;
  successCount: number;
  errorCount: number;
};

export type RunsFilters = {
  range: TimeRange;
  status?: NormalizedStatus;
  source?: RunSource;
  cursor?: string;
  limit?: number;
  customStart?: string;
  customEnd?: string;
};

export type RunsResponse = {
  runs: UnifiedRun[];
  nextCursor: string | null;
  total: number;
  page: number;
  pageSize: number;
};

export type StepLog = {
  id: string;
  nodeId: string;
  nodeName: string;
  nodeType: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  error: string | null;
  iterationIndex: number | null;
  forEachNodeId: string | null;
  /** Chain id this step ran on, when it was an on-chain write. */
  network: string | null;
  /** Native gas cost (wei) of this step's transaction, when known. */
  gasCostWei: string | null;
  /** True when KeeperHub sponsored the gas for this step's transaction. */
  sponsored: boolean;
};

export type AnalyticsStreamEvent = {
  type: "summary" | "new-run" | "run-updated" | "heartbeat";
  data: AnalyticsSummary | UnifiedRun | { timestamp: string };
};
