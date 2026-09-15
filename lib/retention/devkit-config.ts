import "server-only";

import { readBool, readPositiveInt } from "@/lib/retention/config";

/**
 * Configuration for the DevKit run retention job. Every knob is an env var so
 * an operator can slow, widen or stop the job without a deploy, and the job is
 * OFF until an environment turns it on.
 */
export type DevkitRetentionConfig = {
  enabled: boolean;
  dryRun: boolean;
  /** Age in days after which a finished run is deleted. */
  retentionDays: number;
  /** Runs deleted per transaction, together with their steps and events. */
  batchSize: number;
  /** A run stops itself here so it never overlaps the next one. */
  maxRuntimeMs: number;
};

/**
 * Floor for the window. A lower value is raised to it, so a typo can only ever
 * keep more runs than intended.
 */
const MIN_RETENTION_DAYS = 7;

const DEFAULTS = {
  retentionDays: 30,
  batchSize: 500,
  maxRuntimeSeconds: 240,
} as const;

export function getDevkitRetentionConfig(): DevkitRetentionConfig {
  return {
    enabled: readBool("DEVKIT_RETENTION_ENABLED", false),
    dryRun: readBool("DEVKIT_RETENTION_DRY_RUN", false),
    retentionDays: Math.max(
      MIN_RETENTION_DAYS,
      readPositiveInt("DEVKIT_RETENTION_DAYS", DEFAULTS.retentionDays)
    ),
    batchSize: readPositiveInt(
      "DEVKIT_RETENTION_BATCH_SIZE",
      DEFAULTS.batchSize
    ),
    maxRuntimeMs:
      readPositiveInt(
        "DEVKIT_RETENTION_MAX_RUNTIME_SECONDS",
        DEFAULTS.maxRuntimeSeconds
      ) * 1000,
  };
}
