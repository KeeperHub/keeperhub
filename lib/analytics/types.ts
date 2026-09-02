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
  | "skipped"
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
  // Refused before it started (over the plan limit, a gated action, an unpaid
  // pay-as-you-go charge). Its own status so it stays out of the error count and
  // the success-rate denominator.
  | "skipped"
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
  /**
   * Distinct networks (chain ids) the run's steps targeted - not only the ones
   * it produced on-chain writes on. A run that fails before broadcast still
   * names its chain here, which is the point: a chainless failed run is
   * unattributable in the audit trail. The widening is visible on mixed-chain
   * runs, where a read-only step on another chain now joins the list.
   */
  networks: string[];
  /**
   * The subset of `networks` the run actually spent gas on. Distinct from
   * `networks` because the runs table asks two different questions of the same
   * run: which chains it touched (the Network column) and which chains its gas
   * landed on (the Gas cell, which can only render an amount when that is one
   * chain - two chains' native tokens do not add).
   */
  gasNetworks: string[];
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
  skippedCount: number;
  successRate: number;
  avgDurationMs: number | null;
  /** Every wei the runs burned over the range, sponsored gas included. */
  totalGasWei: string;
  /**
   * The sponsored portion of `totalGasWei`, in wei, read from the gas-credit
   * ledger and scoped to the same runs. A subset, NOT a disjoint figure: the
   * Gas Spent KPI renders `totalGasWei` as the headline and derives the
   * wallet-paid share by subtracting this. Adding the two double counts.
   */
  sponsoredGasWei: string;
  activeRuns: number;
  previousPeriod: {
    totalRuns: number;
    successCount: number;
    errorCount: number;
    cancelledCount: number;
    skippedCount: number;
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
  skipped: number;
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

/**
 * Server-side filters the runs listing accepts. Every dimension is a set, so a
 * reader can hold several values of one dimension open at once (all three error
 * statuses, two networks). Values inside a dimension OR together; the
 * dimensions AND together.
 */
/**
 * How a run's on-chain cost was met. "sponsored" is a run with a leg KeeperHub
 * covered from gas credit; "wallet" is a run that spent more than the credit
 * covered, so the org's own funds paid for part of it; "free" is a run that
 * only read, or never reached a broadcast.
 *
 * Sponsored and wallet deliberately overlap. A run that starts sponsored and
 * falls back to direct signing genuinely is both, and filing it under only one
 * would hide it from the other filter.
 */
export type GasSpend = "sponsored" | "wallet" | "free";

export type RunQueryFilters = {
  statuses?: NormalizedStatus[];
  gas?: GasSpend[];
  sources?: RunSource[];
  networks?: string[];
  /** Inclusive lower bound on run duration, in milliseconds. */
  durationMinMs?: number;
  /** Exclusive upper bound on run duration, in milliseconds. */
  durationMaxMs?: number;
  /** Matches a workflow name or a run id, case-insensitively. */
  search?: string;
};

/**
 * Run count per normalized status over the current window, used for the counts
 * beside each option in the status filter. Counted with every other filter
 * applied but with the status filter itself lifted, so a count answers "how
 * many rows would ticking this add", not "how many are showing now".
 */
export type StatusFacets = Partial<Record<NormalizedStatus, number>>;

export type RunsFilters = RunQueryFilters & {
  range: TimeRange;
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
