// Label constants shared by the app (server-only modules) and the standalone
// executor service. This module must stay dependency-free: the executor
// imports it directly, so pulling in @/lib/db or "server-only" here would
// open a second connection pool or break the runner bootstrap shim.

// Label value used for workflow executions whose workflow has no organization
// (personal/anonymous workflows). Keeps per-(status, org_slug) series totals
// equal to the global total instead of silently dropping these rows.
export const ANONYMOUS_ORG_SLUG = "_anonymous";

// error_type label value for rows that carry no error (success and other
// non-error statuses). Shared by the finished counter emitters and the
// db-sourced executions gauge so PromQL joins on error_type="na" cannot
// drift between the two.
export const NA_ERROR_TYPE = "na";
