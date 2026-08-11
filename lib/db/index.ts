import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getDatabaseUrl } from "./connection-utils";
import {
  accounts,
  addressBookEntry,
  addressBookEntryRelations,
  apiKeys,
  chains,
  chainsRelations,
  executionDebt,
  explorerConfigs,
  explorerConfigsRelations,
  integrations,
  mcpOauthAuthCodes,
  mcpOauthClients,
  mcpOauthRefreshTokens,
  organizationApiKeys,
  organizationSubscriptions,
  overageBillingRecords,
  pendingTransactions,
  publicTags,
  sessions,
  tags,
  tagsRelations,
  userRpcPreferences,
  userRpcPreferencesRelations,
  users,
  verifications,
  walletLocks,
  workflowExecutionLogs,
  workflowExecutions,
  workflowExecutionsRelations,
  workflowPublicTags,
  workflowSchedules,
  workflowSchedulesRelations,
  workflows,
} from "./schema";
import { scanResults } from "./schema-scan";

// Construct schema object for drizzle
const schema = {
  users,
  sessions,
  accounts,
  verifications,
  workflows,
  workflowExecutions,
  workflowExecutionLogs,
  workflowExecutionsRelations,
  workflowSchedules,
  workflowSchedulesRelations,
  apiKeys,
  executionDebt,
  mcpOauthAuthCodes,
  mcpOauthClients,
  mcpOauthRefreshTokens,
  organizationApiKeys,
  organizationSubscriptions,
  overageBillingRecords,
  pendingTransactions,
  publicTags,
  walletLocks,
  workflowPublicTags,
  addressBookEntry,
  addressBookEntryRelations,
  tags,
  tagsRelations,
  integrations,
  chains,
  chainsRelations,
  explorerConfigs,
  explorerConfigsRelations,
  userRpcPreferences,
  userRpcPreferencesRelations,
  scanResults,
};

const connectionString = getDatabaseUrl();

// For migrations
export const migrationClient = postgres(connectionString, { max: 1 });

// Use global singleton to prevent connection exhaustion during HMR
const globalForDb = globalThis as unknown as {
  queryClient: ReturnType<typeof postgres> | undefined;
  db: PostgresJsDatabase<typeof schema> | undefined;
  metricsClient: ReturnType<typeof postgres> | undefined;
  metricsDb: PostgresJsDatabase<typeof schema> | undefined;
};

// For queries - reuse connection in development
const queryClient =
  globalForDb.queryClient ?? postgres(connectionString, { max: 10 });
export const db = globalForDb.db ?? drizzle(queryClient, { schema });

// Dedicated pool for the /api/metrics/db scrape aggregations. The collector
// issues its queries concurrently (Promise.all in refreshDbMetricsNow); this
// pool's max:2 caps how many run on the DB at once. The 2026-05-29 incident
// was up to ~10 heavy GROUP BYs over workflow_executions /
// workflow_execution_logs stacking in the same window (the app pool's max:10)
// and saturating CPU. Capping at 2 bounds concurrency far below that while
// letting the few heavy queries pair up instead of fully serialising -
// measured end-to-end the refresh is ~5-7s at prod scale serialised vs ~3-4s
// at 2-wide, comfortably under the 12s db-metrics scrapeTimeout. The queries
// are index-only scans now (migration 0095), so 2-wide is low CPU. DO NOT
// raise max without re-measuring the refresh against the scrapeTimeout (see
// KEEP-682). Composes with the updateDbMetrics cache; idle_timeout releases
// idle connections between scrape bursts.
//
// statement_timeout is set once on every metrics-pool connection (not per
// query) as a backstop: a single runaway aggregation -- e.g. a query-plan
// regression as workflow_executions grows -- is cancelled with 57014 and
// caught per section (-> default gauges) instead of hanging the scrape past
// its timeout. Kept below the db-metrics scrapeTimeout and overridable via
// METRICS_STATEMENT_TIMEOUT_MS.
const parsedMetricsTimeoutMs = Number.parseInt(
  process.env.METRICS_STATEMENT_TIMEOUT_MS ?? "",
  10
);
const METRICS_STATEMENT_TIMEOUT_MS =
  Number.isFinite(parsedMetricsTimeoutMs) && parsedMetricsTimeoutMs > 0
    ? parsedMetricsTimeoutMs
    : 8000;

const metricsClient =
  globalForDb.metricsClient ??
  postgres(connectionString, {
    max: 2,
    idle_timeout: 20,
    connection: { statement_timeout: METRICS_STATEMENT_TIMEOUT_MS },
  });
export const metricsDb =
  globalForDb.metricsDb ?? drizzle(metricsClient, { schema });

if (process.env.NODE_ENV !== "production") {
  globalForDb.queryClient = queryClient;
  globalForDb.db = db;
  globalForDb.metricsClient = metricsClient;
  globalForDb.metricsDb = metricsDb;
}
