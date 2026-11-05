import { and, eq, inArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { DispatchRefusalReason } from "@/lib/billing/dispatch-refusal";
import { workflowExecutions } from "@/lib/db/schema";
import { workflowFailureAlertQueue } from "@/lib/db/schema-failure-alerts";
import type { WorkflowExecutionStatus } from "@/lib/errors/execution-status";
import { type ErrorCategory, logWarn } from "@/lib/logging";
import { REFUSED_RUNS_THRESHOLD } from "@/lib/notifications/failure-alerts/constants";
import { withBackstopCapture } from "@/lib/security/backstop-capture";
import {
  buildAttribution,
  type TriggerSource,
} from "@/lib/security/request-attribution";

// One shape for every run refused before it started (plan limit, billing, a
// workflow that cannot run): status 'skipped', a category, billable false.

export type RefusalCategory =
  | typeof ErrorCategory.BILLING
  | typeof ErrorCategory.CONFIGURATION;

type Attribution = Parameters<typeof buildAttribution>[0];

type RefusedRun = {
  workflowId: string;
  userId: string;
  organizationId?: string | null;
  /** Text shown on the run. */
  reason: string;
  /** Stable code for the hourly dispatch key. */
  reasonCode: DispatchRefusalReason;
  category: RefusalCategory;
  triggerSource: TriggerSource;
  at: Date;
  request?: Request;
  /** The credential that made the call, as on an accepted run. */
  credential?: Pick<
    Attribution,
    "userApiKeyId" | "orgApiKeyId" | "credentialType" | "credentialLabel"
  >;
  input?: Record<string, unknown>;
};

/** Once the alert can open, a busy row is rewritten at most once a minute. */
const REFUSED_ROW_REFRESH_SECONDS = 60;

/** Hourly bucket key: refusals of one workflow for one reason share a row per hour. */
function refusedDispatchKey(
  workflowId: string,
  reasonCode: string,
  at: Date
): string {
  return `refused:${workflowId}:${reasonCode}:${at.toISOString().slice(0, 13)}`;
}

// Same upsert as the queue_alert_check trigger, which a bucket update (status
// stays 'skipped') does not fire. Best-effort: the refusal is already stored.
async function queueAlertCheck<TSchema extends Record<string, unknown>>(
  database: PostgresJsDatabase<TSchema>,
  workflowId: string
): Promise<void> {
  try {
    await database
      .insert(workflowFailureAlertQueue)
      .values({ workflowId, dueAt: sql`now()` })
      .onConflictDoUpdate({
        target: workflowFailureAlertQueue.workflowId,
        set: { dueAt: sql`now()` },
        setWhere: sql`${workflowFailureAlertQueue.dueAt} > now()`,
      });
  } catch (error) {
    warn("[Refusal] Failed to queue alert check", workflowId, error);
  }
}

function warn(message: string, workflowId: string, error: unknown): void {
  logWarn(message, {
    workflowId,
    error: error instanceof Error ? error.message : String(error),
  });
}

/**
 * Record a refused attempt in its hourly row: insert, or move completed_at to
 * `at` and add one to output.refusals. Throws on a failed write. Returns
 * whether the row changed: a row that can already alert and was refreshed in
 * the last minute is left as is.
 */
export async function insertRefusedRun<TSchema extends Record<string, unknown>>(
  run: RefusedRun,
  database: PostgresJsDatabase<TSchema>
): Promise<boolean> {
  const refusals = sql`coalesce((${workflowExecutions.output}->>'refusals')::int, 1)`;
  const changed = await withBackstopCapture(
    {
      workflowId: run.workflowId,
      userId: run.userId,
      source: run.triggerSource,
    },
    () =>
      database
        .insert(workflowExecutions)
        .values({
          workflowId: run.workflowId,
          organizationId: run.organizationId ?? null,
          userId: run.userId,
          status: "skipped",
          billable: false,
          input: run.input ?? {},
          output: { refusals: 1 },
          dispatchKey: refusedDispatchKey(
            run.workflowId,
            run.reasonCode,
            run.at
          ),
          error: run.reason,
          errorCategory: run.category,
          errorType: "user",
          startedAt: run.at,
          completedAt: run.at,
          ...buildAttribution({
            ...run.credential,
            request: run.request,
            source: run.triggerSource,
          }),
        })
        .onConflictDoUpdate({
          target: workflowExecutions.dispatchKey,
          set: {
            completedAt: sql`greatest(${workflowExecutions.completedAt}, excluded.completed_at)`,
            error: sql`excluded.error`,
            output: sql`jsonb_build_object('refusals', ${refusals} + 1)`,
          },
          // Throttles a hot trigger: the alert only needs the threshold and a
          // newest refusal at most a minute stale.
          setWhere: sql`${refusals} < ${REFUSED_RUNS_THRESHOLD} OR ${workflowExecutions.completedAt} <= excluded.completed_at - make_interval(secs => ${REFUSED_ROW_REFRESH_SECONDS})`,
        })
        .returning({ id: workflowExecutions.id })
  );
  if (changed.length === 0) {
    return false;
  }
  await queueAlertCheck(database, run.workflowId);
  return true;
}

/**
 * Best-effort insertRefusedRun for paths whose response must not fail on it.
 * Returns false only when the write failed.
 */
export async function recordRefusedRun<TSchema extends Record<string, unknown>>(
  run: RefusedRun,
  database: PostgresJsDatabase<TSchema>
): Promise<boolean> {
  try {
    await insertRefusedRun(run, database);
    return true;
  } catch (error) {
    warn("[Refusal] Failed to record refused run", run.workflowId, error);
    return false;
  }
}

/**
 * Turn an existing row (pre-created phantom/pending, or a claimed run) into a
 * refused run in place. Compare-and-set on `fromStatuses`; returns the row's
 * workflowId when it matched, null otherwise. The status change to 'skipped'
 * queues the alert check through the queue_alert_check trigger.
 */
export async function markRunRefused<TSchema extends Record<string, unknown>>(
  params: {
    executionId: string;
    fromStatuses: readonly WorkflowExecutionStatus[];
    reason: string;
    category: RefusalCategory;
    at: Date;
    input?: Record<string, unknown>;
  },
  database: PostgresJsDatabase<TSchema>
): Promise<{ workflowId: string } | null> {
  const [row] = await database
    .update(workflowExecutions)
    .set({
      status: "skipped",
      error: params.reason,
      errorCategory: params.category,
      errorType: "user",
      // Never started, so it consumes no quota (a claim flips billable on).
      billable: false,
      output: { refusals: 1 },
      completedAt: params.at,
      ...(params.input ? { input: params.input } : {}),
    })
    .where(
      and(
        eq(workflowExecutions.id, params.executionId),
        inArray(workflowExecutions.status, [...params.fromStatuses])
      )
    )
    .returning({ workflowId: workflowExecutions.workflowId });
  return row ?? null;
}
