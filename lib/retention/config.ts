import "server-only";

/**
 * KEEP-1042: configuration for the execution retention purge.
 *
 * Every window is an env var so an operator can slow, widen or stop the job in
 * an environment without a deploy. Defaults are the safe end of each range:
 * the job is OFF until an environment turns it on, and every window is at
 * least as long as the plan the product sells.
 */
export type RetentionConfig = {
  enabled: boolean;
  dryRun: boolean;
  /** Window for orgs that have no organization_subscriptions row. */
  defaultLogRetentionDays: number;
  /** Floor applied to every resolved per-org window. */
  minLogRetentionDays: number;
  /**
   * How far back before a cutoff each per-org pass looks. The passes are
   * incremental: a run only handles rows that crossed their boundary since the
   * last run, so the scan stays a narrow index range instead of walking the
   * whole table. Anything missed by a longer outage is still caught by the
   * global floor pass at `executionLogFloorRetentionDays`.
   */
  lookbackDays: number;
  /**
   * Backstop window for execution logs, applied to every org with no join.
   * Nothing survives past it, whatever the org's plan says.
   */
  executionLogFloorRetentionDays: number;
  /** Window after which `output_raw` is nulled on terminal executions. */
  outputRawRetentionDays: number;
  /**
   * Flat window for `workflow_executions` rows. NOT the plan window: every
   * billing count reads this table by `started_at` with no floor
   * (lib/billing/execution-limit-core.ts, lib/billing/execution-usage.ts), and
   * the invoices page pages back over every past invoice, so deleting a run
   * row rewrites history. Keep it well past the longest billing period.
   */
  executionRetentionDays: number;
  /** Grace period before a soft-deleted step log is hard-deleted. */
  softDeleteGraceDays: number;
  /** Rows touched by a single statement. */
  batchSize: number;
  /** A run stops itself here so it never overlaps the next one. */
  maxRuntimeMs: number;
};

const DEFAULTS = {
  defaultLogRetentionDays: 7,
  minLogRetentionDays: 7,
  lookbackDays: 7,
  executionLogFloorRetentionDays: 400,
  outputRawRetentionDays: 7,
  executionRetentionDays: 400,
  softDeleteGraceDays: 30,
  batchSize: 5000,
  maxRuntimeSeconds: 240,
} as const;

function readBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  return raw === "true" || raw === "1";
}

/**
 * Read a positive integer env var. A missing, unparseable or non-positive
 * value falls back to the default rather than to 0 -- a 0 window would mean
 * "delete everything", which is the one outcome a typo must never produce.
 */
function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getRetentionConfig(): RetentionConfig {
  const minLogRetentionDays = readPositiveInt(
    "EXECUTION_RETENTION_MIN_DAYS",
    DEFAULTS.minLogRetentionDays
  );
  return {
    enabled: readBool("EXECUTION_RETENTION_ENABLED", false),
    dryRun: readBool("EXECUTION_RETENTION_DRY_RUN", false),
    defaultLogRetentionDays: Math.max(
      minLogRetentionDays,
      readPositiveInt(
        "EXECUTION_RETENTION_DEFAULT_DAYS",
        DEFAULTS.defaultLogRetentionDays
      )
    ),
    minLogRetentionDays,
    lookbackDays: readPositiveInt(
      "EXECUTION_RETENTION_LOOKBACK_DAYS",
      DEFAULTS.lookbackDays
    ),
    executionLogFloorRetentionDays: readPositiveInt(
      "EXECUTION_LOG_FLOOR_RETENTION_DAYS",
      DEFAULTS.executionLogFloorRetentionDays
    ),
    outputRawRetentionDays: readPositiveInt(
      "EXECUTION_LOG_OUTPUT_RAW_RETENTION_DAYS",
      DEFAULTS.outputRawRetentionDays
    ),
    executionRetentionDays: readPositiveInt(
      "EXECUTION_RETENTION_DAYS",
      DEFAULTS.executionRetentionDays
    ),
    softDeleteGraceDays: readPositiveInt(
      "EXECUTION_RETENTION_SOFT_DELETE_GRACE_DAYS",
      DEFAULTS.softDeleteGraceDays
    ),
    batchSize: readPositiveInt(
      "EXECUTION_RETENTION_BATCH_SIZE",
      DEFAULTS.batchSize
    ),
    maxRuntimeMs:
      readPositiveInt(
        "EXECUTION_RETENTION_MAX_RUNTIME_SECONDS",
        DEFAULTS.maxRuntimeSeconds
      ) * 1000,
  };
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function daysBefore(now: Date, days: number): Date {
  return new Date(now.getTime() - days * MS_PER_DAY);
}
