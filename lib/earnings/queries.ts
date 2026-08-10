import "server-only";

import { and, count, desc, eq, inArray, isNotNull, sum } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";
import { workflowPayments } from "@/lib/db/schema-payments";
import { logWarn } from "@/lib/logging";
import type {
  ChainEarnings,
  EarningsSummary,
  SettlementStatus,
  WorkflowEarningsRow,
} from "./types";

const DEFAULT_PLATFORM_FEE_PERCENT = 30;

/**
 * Parses PLATFORM_FEE_PERCENT from the environment.
 *
 * Falls back to DEFAULT_PLATFORM_FEE_PERCENT and logs a warning when:
 *   - the env var is unset
 *   - the value cannot be parsed as a finite integer
 *   - the value is outside the valid range [0, 100]
 *
 * Crucially, a legitimate `PLATFORM_FEE_PERCENT=0` (e.g. fee waiver promo
 * or self-hosted instance) is preserved -- the previous `parsed || 30`
 * coercion silently turned 0 into 30.
 */
export function parsePlatformFeePercent(envValue: string | undefined): number {
  if (envValue === undefined) {
    return DEFAULT_PLATFORM_FEE_PERCENT;
  }
  const parsed = Number.parseInt(envValue, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    logWarn(
      `[earnings] Invalid PLATFORM_FEE_PERCENT="${envValue}", falling back to ${DEFAULT_PLATFORM_FEE_PERCENT}`
    );
    return DEFAULT_PLATFORM_FEE_PERCENT;
  }
  return parsed;
}

/**
 * IMPORTANT: this module computes revenue figures using JS numbers, not
 * BigInt or a decimal library. That is intentional for the current scope --
 * these values feed the earnings dashboard for DISPLAY ONLY, where
 * formatUsdc() rounds to two decimals and float artifacts are invisible.
 *
 * Two assumptions hold this together:
 *
 *   1. amountUsdc is stored as human-readable USD (e.g. "1.50"), so the
 *      Number() casts in getEarningsSummary() do not lose precision until
 *      lifetime org revenue exceeds ~9 quadrillion dollars.
 *   2. No code path uses these numbers to drive on-chain payouts, ACH
 *      transfers, or any other money movement. They are read by the UI
 *      and that is the end of their journey.
 *
 * If either assumption changes -- in particular, if these values are ever
 * fed into a payout pipeline -- this module MUST switch to BigInt or a
 * decimal library before that integration ships. Float arithmetic
 * compounds error across multiplications and you will lose cents (or
 * worse) at scale. computeRevenueSplit and getEarningsSummary are the
 * places that need rewriting.
 */
export function computeRevenueSplit(
  gross: number,
  platformFeePercent: number
): { creatorShare: number; platformFee: number } {
  const creatorShare = gross * ((100 - platformFeePercent) / 100);
  const platformFee = gross - creatorShare;
  return { creatorShare, platformFee };
}

export function formatUsdc(amount: number): string {
  return `$${amount.toFixed(2)} USDC`;
}

export function deriveSettlementStatus(
  invocationCount: number
): SettlementStatus {
  return invocationCount > 0 ? "settled" : "no_payments";
}

type CallerRow = {
  workflowId: string;
  payerAddress: string;
  callCount: number;
};

export function groupTopCallers(rows: CallerRow[]): Map<string, string[]> {
  const grouped = new Map<string, CallerRow[]>();

  for (const row of rows) {
    const existing = grouped.get(row.workflowId);
    if (existing) {
      existing.push(row);
    } else {
      grouped.set(row.workflowId, [row]);
    }
  }

  const result = new Map<string, string[]>();
  for (const [workflowId, callerRows] of grouped) {
    const sorted = [...callerRows].sort((a, b) => b.callCount - a.callCount);
    result.set(
      workflowId,
      sorted.slice(0, 3).map((r) => r.payerAddress)
    );
  }

  return result;
}

export async function getEarningsSummary(
  organizationId: string,
  page: number,
  pageSize: number
): Promise<EarningsSummary> {
  const platformFeePercent = parsePlatformFeePercent(
    process.env.PLATFORM_FEE_PERCENT
  );
  const creatorSharePercent = 100 - platformFeePercent;

  const orgFilter = and(
    eq(workflows.organizationId, organizationId),
    eq(workflows.isListed, true)
  );

  const [countResult] = await db
    .select({ count: count() })
    .from(workflows)
    .where(orgFilter);
  const total = Number(countResult?.count ?? 0);

  if (total === 0) {
    return {
      totalGrossRevenue: formatUsdc(0),
      totalCreatorEarnings: formatUsdc(0),
      totalPlatformFees: formatUsdc(0),
      totalInvocations: 0,
      platformFeePercent,
      creatorSharePercent,
      perChain: {
        base: { grossRevenue: formatUsdc(0), invocationCount: 0 },
        tempo: { grossRevenue: formatUsdc(0), invocationCount: 0 },
      },
      workflows: [],
      total: 0,
      page,
      pageSize,
      hasListedWorkflows: false,
    };
  }

  const offset = (page - 1) * pageSize;

  const listedWorkflows = await db
    .select({
      id: workflows.id,
      name: workflows.name,
      listedSlug: workflows.listedSlug,
    })
    .from(workflows)
    .where(orgFilter)
    .orderBy(desc(workflows.listedAt))
    .limit(pageSize)
    .offset(offset);

  // All org workflow IDs needed for aggregate totals
  const allOrgWorkflowIds = await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(orgFilter);
  const orgWorkflowIds = allOrgWorkflowIds.map((w) => w.id);

  const pageWorkflowIds = listedWorkflows.map((w) => w.id);

  // Aggregate totals across all org workflows (for KPI cards)
  const [orgTotals] = await db
    .select({
      grossRevenue: sum(workflowPayments.amountUsdc),
      invocationCount: count(workflowPayments.id),
    })
    .from(workflowPayments)
    .where(inArray(workflowPayments.workflowId, orgWorkflowIds));

  const totalGross = Number(orgTotals?.grossRevenue ?? "0");
  const totalInvocations = orgTotals?.invocationCount ?? 0;

  // Per-chain breakdown so creators see Base (x402/USDC) vs Tempo (MPP/USDC.e)
  // split instead of just an aggregate. See docs/workflows/marketplace.md.
  const perChainRows = await db
    .select({
      chain: workflowPayments.chain,
      grossRevenue: sum(workflowPayments.amountUsdc),
      invocationCount: count(workflowPayments.id),
    })
    .from(workflowPayments)
    .where(inArray(workflowPayments.workflowId, orgWorkflowIds))
    .groupBy(workflowPayments.chain);

  const perChain = buildPerChainEarnings(perChainRows);

  // Per-workflow revenue for the current page only
  const revenueRows = await db
    .select({
      workflowId: workflowPayments.workflowId,
      grossRevenue: sum(workflowPayments.amountUsdc),
      invocationCount: count(workflowPayments.id),
    })
    .from(workflowPayments)
    .where(inArray(workflowPayments.workflowId, pageWorkflowIds))
    .groupBy(workflowPayments.workflowId)
    .orderBy(desc(sum(workflowPayments.amountUsdc)));

  const callerRows = await db
    .select({
      workflowId: workflowPayments.workflowId,
      payerAddress: workflowPayments.payerAddress,
      callCount: count(workflowPayments.id),
    })
    .from(workflowPayments)
    .where(
      and(
        inArray(workflowPayments.workflowId, pageWorkflowIds),
        isNotNull(workflowPayments.payerAddress)
      )
    )
    .groupBy(workflowPayments.workflowId, workflowPayments.payerAddress)
    .orderBy(desc(count(workflowPayments.id)));

  const topCallersMap = groupTopCallers(
    callerRows
      .filter(
        (r): r is typeof r & { payerAddress: string } => r.payerAddress !== null
      )
      .map((r) => ({
        workflowId: r.workflowId,
        payerAddress: r.payerAddress,
        callCount: r.callCount,
      }))
  );

  const revenueByWorkflowId = new Map(
    revenueRows.map((r) => [r.workflowId, r])
  );

  const paginatedRows: WorkflowEarningsRow[] = listedWorkflows.map(
    (workflow) => {
      const revenue = revenueByWorkflowId.get(workflow.id);
      const gross = Number(revenue?.grossRevenue ?? "0");
      const invocationCount = revenue?.invocationCount ?? 0;
      const { creatorShare, platformFee } = computeRevenueSplit(
        gross,
        platformFeePercent
      );

      return {
        workflowId: workflow.id,
        workflowName: workflow.name,
        listedSlug: workflow.listedSlug,
        grossRevenue: formatUsdc(gross),
        creatorShare: formatUsdc(creatorShare),
        platformFee: formatUsdc(platformFee),
        invocationCount,
        topCallers: topCallersMap.get(workflow.id) ?? [],
        settlementStatus: deriveSettlementStatus(invocationCount),
      };
    }
  );

  const { creatorShare: totalCreatorEarnings, platformFee: totalPlatformFees } =
    computeRevenueSplit(totalGross, platformFeePercent);

  return {
    totalGrossRevenue: formatUsdc(totalGross),
    totalCreatorEarnings: formatUsdc(totalCreatorEarnings),
    totalPlatformFees: formatUsdc(totalPlatformFees),
    totalInvocations,
    platformFeePercent,
    creatorSharePercent,
    perChain,
    workflows: paginatedRows,
    total,
    page,
    pageSize,
    hasListedWorkflows: true,
  };
}

type PerChainRow = {
  chain: string;
  grossRevenue: string | null;
  invocationCount: number;
};

/**
 * Reshapes the chain-grouped SQL result into the fixed { base, tempo } shape
 * expected by the UI. Missing chains default to zero so the UI never has to
 * null-check.
 */
export function buildPerChainEarnings(rows: PerChainRow[]): {
  base: ChainEarnings;
  tempo: ChainEarnings;
} {
  const base: ChainEarnings = {
    grossRevenue: formatUsdc(0),
    invocationCount: 0,
  };
  const tempo: ChainEarnings = {
    grossRevenue: formatUsdc(0),
    invocationCount: 0,
  };
  for (const row of rows) {
    const gross = Number(row.grossRevenue ?? "0");
    const entry: ChainEarnings = {
      grossRevenue: formatUsdc(gross),
      invocationCount: row.invocationCount,
    };
    if (row.chain === "base") {
      base.grossRevenue = entry.grossRevenue;
      base.invocationCount = entry.invocationCount;
    } else if (row.chain === "tempo") {
      tempo.grossRevenue = entry.grossRevenue;
      tempo.invocationCount = entry.invocationCount;
    }
  }
  return { base, tempo };
}
