/**
 * Analytics Dashboard Types
 *
 * Unified types for the analytics dashboard that normalize
 * workflow_executions and direct_executions into a single view.
 */

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

export type NormalizedStatus = "pending" | "running" | "success" | "error";

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
  transactionHash: string | null;
  gasUsedWei: string | null;
  totalSteps: number | null;
  completedSteps: number | null;
};

export type AnalyticsSummary = {
  totalRuns: number;
  successCount: number;
  errorCount: number;
  successRate: number;
  avgDurationMs: number | null;
  totalGasWei: string;
  activeRuns: number;
  previousPeriod: {
    totalRuns: number;
    successCount: number;
    errorCount: number;
    avgDurationMs: number | null;
    totalGasWei: string;
  } | null;
};

export type TimeSeriesBucket = {
  timestamp: string;
  success: number;
  error: number;
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
};

export type AnalyticsStreamEvent = {
  type: "summary" | "new-run" | "run-updated" | "heartbeat";
  data: AnalyticsSummary | UnifiedRun | { timestamp: string };
};
