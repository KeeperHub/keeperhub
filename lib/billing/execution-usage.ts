import "server-only";

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

export type PeriodWindow = {
  periodStart: Date;
  periodEnd: Date;
};

/**
 * Billable executions (billable workflow executions + direct API/MCP executions)
 * counted within each invoice's own billing period, returned aligned to the
 * input order. A closed period's count is fixed -- it reflects exactly what that
 * invoice was billed on, including any over-limit executions (e.g. 26k against a
 * 25k plan, whose excess is billed as overage on the following invoice). Bounded
 * to the periods passed in (the visible invoices page).
 */
export function getExecutionsUsedForPeriods(
  organizationId: string,
  windows: PeriodWindow[]
): Promise<number[]> {
  return Promise.all(
    windows.map(async ({ periodStart, periodEnd }) => {
      const result = await db.execute<{ count: number }>(
        sql`SELECT
              (
                SELECT COUNT(*)::int
                  FROM workflow_executions we
                  JOIN workflows w ON we.workflow_id = w.id
                 WHERE w.organization_id = ${organizationId}
                   AND we.started_at >= ${periodStart.toISOString()}
                   AND we.started_at <  ${periodEnd.toISOString()}
                   AND we.billable = TRUE
              )
              +
              (
                SELECT COUNT(*)::int
                  FROM direct_executions de
                 WHERE de.organization_id = ${organizationId}
                   AND de.created_at >= ${periodStart.toISOString()}
                   AND de.created_at <  ${periodEnd.toISOString()}
              ) AS count`
      );
      return result[0]?.count ?? 0;
    })
  );
}
