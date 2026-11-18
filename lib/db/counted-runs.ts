import { type AnyColumn, type SQL, sql } from "drizzle-orm";

type RunColumns = {
  status: AnyColumn;
  completedAt: AnyColumn;
  deletedAt: AnyColumn;
  errorType: AnyColumn;
  errorCategory: AnyColumn;
  billable: AnyColumn;
};

/**
 * Finished runs a failure streak can count: no refusals (skipped, or unpaid
 * billing errors) and no platform errors. Literals only, written once for the
 * index predicate and the query, so a generic plan still matches the index.
 */
export function countedRunSql(t: RunColumns): SQL {
  return sql`(${t.status} <> 'skipped' AND ${t.completedAt} IS NOT NULL AND ${t.deletedAt} IS NULL
    AND (${t.status} <> 'error' OR (${t.errorType} IS DISTINCT FROM 'system'
      AND (${t.errorCategory} IS DISTINCT FROM 'billing' OR ${t.billable}))))`;
}
