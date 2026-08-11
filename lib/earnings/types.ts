export type SettlementStatus = "settled" | "pending" | "no_payments";

export type WorkflowEarningsRow = {
  workflowId: string;
  workflowName: string;
  listedSlug: string | null;
  grossRevenue: string;
  creatorShare: string;
  platformFee: string;
  invocationCount: number;
  topCallers: string[];
  settlementStatus: SettlementStatus;
};

/**
 * Revenue split for a single settlement chain. `grossRevenue` is USDC on Base
 * (x402) or USDC.e on Tempo (MPP) -- both pegged to USD, so summed totals are
 * meaningful even across chains for display purposes.
 */
export type ChainEarnings = {
  grossRevenue: string;
  invocationCount: number;
};

export type EarningsSummary = {
  totalGrossRevenue: string;
  totalCreatorEarnings: string;
  totalPlatformFees: string;
  totalInvocations: number;
  platformFeePercent: number;
  creatorSharePercent: number;
  perChain: {
    base: ChainEarnings;
    tempo: ChainEarnings;
  };
  workflows: WorkflowEarningsRow[];
  total: number;
  page: number;
  pageSize: number;
  hasListedWorkflows: boolean;
};
