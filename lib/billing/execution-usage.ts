import "server-only";

import {
  countExecutionsForPeriod,
  getStoredUsageForPeriods,
  type PeriodWindow,
  periodKey,
} from "./execution-usage-periods";

export type { PeriodWindow } from "./execution-usage-periods";

export type PeriodUsage = {
  /** Billable executions the period was billed on. */
  executionsUsed: number;
  /**
   * The limit in force when the period closed, or null when the period has no
   * stored record and the caller has to fall back to the current plan.
   */
  executionLimit: number | null;
  /** True when the figure came from the stored record rather than a live count. */
  fromStoredRecord: boolean;
};

/**
 * Billable executions (billable workflow executions + direct API/MCP
 * executions) for each period, returned aligned to the input order.
 *
 * A closed period is served from `execution_usage_periods`, which froze the
 * figure when the period closed. Only a period with no stored record is counted
 * live, and that fallback is exact only while the rows it counts are still
 * there -- which is precisely what the run-row retention pass takes away. The
 * backfill is what makes sure history has records before that pass is ever
 * switched on.
 *
 * Unlike the gas-sponsorship rollup this read path deliberately does not
 * persist what it computes. Freezing a live count here would make a figure
 * permanent that may already be missing retired rows, and a wrong stored figure
 * is worse than no figure at all.
 */
export async function getExecutionsUsedForPeriods(
  organizationId: string,
  windows: PeriodWindow[]
): Promise<PeriodUsage[]> {
  const stored = await getStoredUsageForPeriods(organizationId, windows);

  return await Promise.all(
    windows.map(async ({ periodStart, periodEnd }) => {
      const record = stored.get(periodKey(periodStart, periodEnd));
      if (record) {
        return {
          executionsUsed: record.totalExecutions,
          executionLimit: record.executionLimit,
          fromStoredRecord: true,
        };
      }

      const counts = await countExecutionsForPeriod(
        organizationId,
        periodStart,
        periodEnd
      );
      return {
        executionsUsed: counts.total,
        executionLimit: null,
        fromStoredRecord: false,
      };
    })
  );
}
