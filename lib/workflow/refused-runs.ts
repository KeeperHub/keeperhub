import { and, eq, inArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { db as appDb } from "@/lib/db";
import { workflowExecutions } from "@/lib/db/schema";
import { workflowFailureAlertQueue } from "@/lib/db/schema-failure-alerts";
import type { WorkflowExecutionStatus } from "@/lib/errors/execution-status";
import { type ErrorCategory, logWarn } from "@/lib/logging";
import {
  buildAttribution,
  type TriggerSource,
} from "@/lib/security/request-attribution";

// One shape for every run refused before it started (plan limit, billing, a
// workflow that cannot run): status 'skipped', a category, billable false.

export type RefusalCategory =
  | typeof ErrorCategory.BILLING
  | typeof ErrorCategory.CONFIGURATION;

type AnyDb = PostgresJsDatabase<Record<string, unknown>>;

type RefusedRun = {
  workflowId: string;
  userId: string;
  organizationId?: string | null;
  /** Text shown on the run. */
  reason: string;
  /** Stable code for the hourly dispatch key, e.g. "execution_limit". */
  reasonCode: string;
  category: RefusalCategory;
  triggerSource: TriggerSource;
  at: Date;
  request?: Request;
  input?: Record<string, unknown>;
};

/** Hourly bucket key: refusals of one workflow for one reason share a row per hour. */
function refusedDispatchKey(
  workflowId: string,
  reasonCode: string,
  at: Date
): string {
  return `refused:${workflowId}:${reasonCode}:${at.toISOString().slice(0, 13)}`;
}

// Same upsert as the queue_alert_check trigger; a bucket update keeps status
// 'skipped', so the trigger does not fire for it.
async function queueAlertCheck(database: AnyDb, workflowId: string) {
  await database
    .insert(workflowFailureAlertQueue)
    .values({ workflowId, dueAt: sql`now()` })
    .onConflictDoUpdate({
      target: workflowFailureAlertQueue.workflowId,
      set: { dueAt: sql`now()` },
      setWhere: sql`${workflowFailureAlertQueue.dueAt} > now()`,
    });
}

function warn(message: string, workflowId: string, error: unknown): void {
  logWarn(message, {
    workflowId,
    error: error instanceof Error ? error.message : String(error),
  });
}

/**
 * Record a refused attempt in its hourly row: insert, or move completed_at to
 * `at` and add one to output.refusals. Best-effort: returns null on failure.
 */
export async function recordRefusedRun<TSchema extends Record<string, unknown>>(
  run: RefusedRun,
  database: PostgresJsDatabase<TSchema> = appDb as never
): Promise<{ id: string } | null> {
  const target = database as unknown as AnyDb;
  try {
    const [row] = await target
      .insert(workflowExecutions)
      .values({
        workflowId: run.workflowId,
        organizationId: run.organizationId ?? null,
        userId: run.userId,
        status: "skipped",
        billable: false,
        input: run.input ?? {},
        output: { refusals: 1 },
        dispatchKey: refusedDispatchKey(run.workflowId, run.reasonCode, run.at),
        error: run.reason,
        errorCategory: run.category,
        errorType: "user",
        startedAt: run.at,
        completedAt: run.at,
        ...buildAttribution({
          request: run.request,
          source: run.triggerSource,
        }),
      })
      .onConflictDoUpdate({
        target: workflowExecutions.dispatchKey,
        set: {
          completedAt: sql`greatest(${workflowExecutions.completedAt}, excluded.completed_at)`,
          error: sql`excluded.error`,
          output: sql`jsonb_build_object('refusals', coalesce((${workflowExecutions.output}->>'refusals')::int, 1) + 1)`,
        },
      })
      .returning({ id: workflowExecutions.id });
    await queueAlertCheck(target, run.workflowId);
    return row ?? null;
  } catch (error) {
    warn("[Refusal] Failed to record refused run", run.workflowId, error);
    return null;
  }
}

/**
 * Turn an existing row (pre-created phantom/pending, or a claimed run) into a
 * refused run in place. Compare-and-set on `fromStatuses`; returns the row's
 * workflowId when it matched, null otherwise.
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
  database: PostgresJsDatabase<TSchema> = appDb as never
): Promise<{ workflowId: string } | null> {
  const target = database as unknown as AnyDb;
  const [row] = await target
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
  if (!row) {
    return null;
  }
  try {
    await queueAlertCheck(target, row.workflowId);
  } catch (error) {
    warn("[Refusal] Failed to queue alert check", row.workflowId, error);
  }
  return row;
}
