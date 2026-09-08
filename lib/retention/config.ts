import "server-only";

/**
 * KEEP-1042: configuration for the execution retention purge.
 *
 * Every window is an env var so an operator can slow, widen or stop the job in
 * an environment without a deploy. Defaults are the safe end of each range: the
 * job is OFF until an environment turns it on, run-row deletion has a second
 * switch of its own, and every window is clamped so a typo can only ever keep
 * MORE data than intended.
 */
export type RetentionConfig = {
  enabled: boolean;
  /**
   * Second switch for the run-row pass. Deleting a `workflow_executions` row
   * rewrites what a customer was billed, because the invoices page recounts
   * that table per period and no durable usage record exists for a period
   * without overage. It stays off until one does.
   */
  executionsEnabled: boolean;
  dryRun: boolean;
  /** Window for orgs that have no organization_subscriptions row. */
  defaultLogRetentionDays: number;
  /** Floor applied to every resolved per-org window. */
  minLogRetentionDays: number;
  /**
   * Absolute ceiling for step logs. No log survives past it whatever its plan
   * says, and it caps a per-org `plan_overrides.logRetentionDays` that asks for
   * more. The pass that enforces it needs no join, so it is also the window the
   * largest group of organizations rides on.
   */
  executionLogFloorRetentionDays: number;
  /** Window after which `output_raw` is nulled on a run that cannot resume. */
  outputRawRetentionDays: number;
  /**
   * Window for `workflow_executions` rows. NOT the plan window: every billing
   * count reads this table by `started_at` with no floor
   * (lib/billing/execution-limit-core.ts, lib/billing/execution-usage.ts), and
   * the invoices page pages back over every past invoice, so deleting a run row
   * rewrites history. It is clamped so it can only ever be raised.
   */
  executionRetentionDays: number;
  /** Grace period before a soft-deleted step log is hard-deleted. */
  softDeleteGraceDays: number;
  /** Rows touched by a single statement. */
  batchSize: number;
  /** A run stops itself here so it never overlaps the next one. */
  maxRuntimeMs: number;
};

/**
 * Hard floor for the run-row window, deliberately not configurable. Billing
 * periods are monthly and the invoices page has no date floor, so a short value
 * here would move live quotas and rewrite past invoices in a single run.
 * `EXECUTION_RETENTION_DAYS` can raise the window and never lower it; the way
 * to stop the pass is `EXECUTION_RETENTION_EXECUTIONS_ENABLED`.
 */
const MIN_EXECUTION_RETENTION_DAYS = 400;

const DEFAULTS = {
  defaultLogRetentionDays: 7,
  minLogRetentionDays: 7,
  executionLogFloorRetentionDays: 400,
  outputRawRetentionDays: 7,
  executionRetentionDays: MIN_EXECUTION_RETENTION_DAYS,
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
 * Read a positive integer env var. A missing, unparseable or non-positive value
 * falls back to the default rather than to 0 -- a 0 window would mean "delete
 * everything", which is the one outcome a typo must never produce.
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
  // Every log window is clamped up to the floor, so no env value can shorten
  // retention below what the shortest plan sells.
  const atLeastMin = (name: string, fallback: number) =>
    Math.max(minLogRetentionDays, readPositiveInt(name, fallback));

  return {
    enabled: readBool("EXECUTION_RETENTION_ENABLED", false),
    executionsEnabled: readBool(
      "EXECUTION_RETENTION_EXECUTIONS_ENABLED",
      false
    ),
    dryRun: readBool("EXECUTION_RETENTION_DRY_RUN", false),
    defaultLogRetentionDays: atLeastMin(
      "EXECUTION_RETENTION_DEFAULT_DAYS",
      DEFAULTS.defaultLogRetentionDays
    ),
    minLogRetentionDays,
    executionLogFloorRetentionDays: atLeastMin(
      "EXECUTION_LOG_FLOOR_RETENTION_DAYS",
      DEFAULTS.executionLogFloorRetentionDays
    ),
    outputRawRetentionDays: atLeastMin(
      "EXECUTION_LOG_OUTPUT_RAW_RETENTION_DAYS",
      DEFAULTS.outputRawRetentionDays
    ),
    executionRetentionDays: Math.max(
      MIN_EXECUTION_RETENTION_DAYS,
      readPositiveInt(
        "EXECUTION_RETENTION_DAYS",
        DEFAULTS.executionRetentionDays
      )
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
