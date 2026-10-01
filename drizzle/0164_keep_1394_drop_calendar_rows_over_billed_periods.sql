-- Remove `calendar_month` usage rows that overlap a provider cycle recorded in
-- `overage_billing_records`.
--
-- The calendar-month close did not read `overage_billing_records` when it worked
-- out which windows a provider cycle already accounts for. A cycle billed before
-- `execution_usage_periods` existed was therefore unknown to it, and it wrote
-- whole-month rows across that cycle: the paid limit, an overage count for
-- executions already invoiced, and a charge of zero.
--
-- The close now treats every overage record as coverage, so it can no longer
-- write such a row. This removes the ones written before that, using the same
-- overlap rule. The close then rewrites the part of each month that no cycle
-- covers, clipped to the cycle boundary, on its next run.
--
-- Idempotent: a second run matches nothing. Only `calendar_month` rows are
-- touched; a `subscription` row is the record of the cycle itself.
DELETE FROM "execution_usage_periods" AS p
USING "overage_billing_records" AS o
WHERE p."source" = 'calendar_month'
  AND o."organization_id" = p."organization_id"
  AND p."period_start" < o."period_end"
  AND o."period_start" < p."period_end";
