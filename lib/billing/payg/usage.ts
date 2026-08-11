import "server-only";

import { getPaygSettings } from "./config-store";
import { getPaygSpentRaw, getPaygUsage } from "./payments";
import { getPaygPeriod, startOfUtcDay } from "./period";

export type PaygCurrentUsage = {
  startedAt: Date;
  periodStart: Date;
  periodEnd: Date;
  periodExecutions: number;
  periodSpentRaw: bigint;
  dailySpentRaw: bigint;
  /** 0n blocks all spend rather than meaning "unset". */
  dailyCapRaw: bigint;
  periodCapRaw: bigint;
  chainId: number;
};

/**
 * Current-period PAYG usage for reporting + guard rails: executions charged and
 * USDC spent this period, today's spend, and the caps in force. Every free-tier
 * org has usage to report, on its own caps or the defaults.
 */
export async function getCurrentPaygUsage(
  organizationId: string
): Promise<PaygCurrentUsage> {
  const config = await getPaygSettings(organizationId);
  const period = getPaygPeriod(config.startedAt);
  const [usage, dailySpentRaw] = await Promise.all([
    getPaygUsage(organizationId, period.start, period.end),
    getPaygSpentRaw(organizationId, startOfUtcDay()),
  ]);
  return {
    startedAt: config.startedAt,
    periodStart: period.start,
    periodEnd: period.end,
    periodExecutions: usage.executions,
    periodSpentRaw: usage.spentRaw,
    dailySpentRaw,
    dailyCapRaw: BigInt(config.dailyCapRaw),
    periodCapRaw: BigInt(config.periodCapRaw),
    chainId: config.chainId,
  };
}
