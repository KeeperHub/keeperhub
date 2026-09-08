import "server-only";

import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getMetricsCollector } from "@/lib/metrics";
import {
  fetchCompletedStepOutputAtIterationStep,
  fetchCompletedStepOutputStep,
  fetchCompletedStepOutputsBatchStep,
} from "@/lib/workflow/executor/get-completed-step-output.step";
import {
  getStepSuccess,
  getSuccessfulSteps,
  type IterationKey,
} from "@/lib/workflow/executor/step-success-tracker";

/**
 * Kill-switch: set KH_EXECUTOR_AUTHORITY_DB_FALLBACK=false to disable DB-backed
 * step authority and revert to tracker-only behaviour. Use as an ops emergency
 * rollback if DB-fallback misbehaves in production.
 *
 * Default: true (DB fallback enabled).
 */
const DB_FALLBACK_ENABLED =
  process.env.KH_EXECUTOR_AUTHORITY_DB_FALLBACK !== "false";

/**
 * Returns true when the error is a PostgreSQL statement timeout (SQLSTATE 57014).
 * Drizzle wraps the driver error in DrizzleQueryError with the original on
 * error.cause, so we check both levels.
 */
function isStatementTimeout(err: unknown): boolean {
  const candidates = [err, (err as { cause?: unknown })?.cause];
  return candidates.some(
    (e) =>
      e !== null &&
      typeof e === "object" &&
      (e as { code?: unknown }).code === "57014"
  );
}

export type CompletedStepOutput = {
  output: unknown;
  source: "tracker" | "db";
};

/**
 * Per-execution in-flight DB promise cache, keyed on `"${executionId}:${nodeId}"`.
 *
 * Multiple convergence nodes can concurrently ask for the same predecessor
 * output. This cache coalesces all concurrent callers onto a single DB query
 * for the same key within one workflow body execution. The promise is retained
 * only for the lifetime of the first caller; subsequent callers within the same
 * microtask checkpoint await the same promise. Cleared via clearOutputCache().
 *
 * Rejection handling: if the DB query rejects, the cache key is evicted so a
 * subsequent call can retry cleanly. The rejected promise does NOT stay cached.
 */
const inflightQueries = new Map<string, Promise<CompletedStepOutput | null>>();

/**
 * Clear the output cache for an execution. Call in the finally block after
 * a workflow body completes (same lifecycle as clearExecution in step-success-tracker).
 */
export function clearOutputCache(executionId: string): void {
  const prefix = `${executionId}:`;
  for (const key of inflightQueries.keys()) {
    if (key.startsWith(prefix)) {
      inflightQueries.delete(key);
    }
  }
}

/**
 * Query `workflow_execution_logs` for a single (executionId, nodeId) success row
 * via the "use step" boundary. This keeps Node.js-only modules (postgres, nanoid)
 * out of the "use workflow" bundle.
 *
 * When iterationKey is provided, the iteration-scoped query is used so the row
 * matches `(forEachNodeId, iterationIndex)` exactly. When omitted, the
 * top-level query filters iteration rows out (legacy behaviour).
 */
async function queryDb(
  executionId: string,
  nodeId: string,
  iterationKey?: IterationKey
): Promise<CompletedStepOutput | null> {
  const row = iterationKey
    ? await fetchCompletedStepOutputAtIterationStep(
        executionId,
        nodeId,
        iterationKey.forEachNodeId,
        iterationKey.iterationIndex
      )
    : await fetchCompletedStepOutputStep(executionId, nodeId);

  if (!row) {
    return null;
  }

  return { output: row.outputRaw, source: "db" };
}

function buildCacheKey(
  executionId: string,
  nodeId: string,
  iterationKey?: IterationKey
): string {
  if (!iterationKey) {
    return `${executionId}:${nodeId}`;
  }
  return `${executionId}:${nodeId}:${iterationKey.forEachNodeId}:${iterationKey.iterationIndex}`;
}

/**
 * Resolve the latest completed output for a step, consulting the in-process
 * tracker first (fast path, no I/O) and falling back to workflow_execution_logs
 * on a tracker miss (cross-process resume path).
 *
 * Returns null when neither source has a success record -- the step has not
 * yet completed or was never recorded.
 *
 * Single-flight guarantee: multiple concurrent calls for the same
 * (executionId, nodeId) within one workflow body execution share a single
 * DB query.
 *
 * Error containment: if the DB query rejects, the cache key is evicted, a
 * structured warning is logged, a counter is incremented, and null is returned.
 * The caller falls back to the closure value. Rejection cannot poison subsequent
 * calls for the same key.
 *
 * Kill-switch: when KH_EXECUTOR_AUTHORITY_DB_FALLBACK=false the DB read is
 * skipped entirely and null is returned on a tracker miss (pre-fix behaviour).
 */
export function getCompletedStepOutput(
  executionId: string,
  nodeId: string,
  iterationKey?: IterationKey
): Promise<CompletedStepOutput | null> {
  const trackerEntry = getStepSuccess(executionId, nodeId, iterationKey);
  if (trackerEntry !== undefined) {
    return Promise.resolve({
      output: trackerEntry.output,
      source: "tracker" as const,
    });
  }

  if (!DB_FALLBACK_ENABLED) {
    return Promise.resolve(null);
  }

  const cacheKey = buildCacheKey(executionId, nodeId, iterationKey);
  const inflight = inflightQueries.get(cacheKey);
  if (inflight !== undefined) {
    return inflight;
  }

  const query = queryDb(executionId, nodeId, iterationKey).then(
    (result) => {
      getMetricsCollector().incrementCounter(
        "workflow.executor.tracker_db_fallback.total",
        {
          source: "single",
          outcome: result === null ? "miss" : "hit",
        }
      );
      return result;
    },
    (err: unknown) => {
      inflightQueries.delete(cacheKey);
      const outcome = isStatementTimeout(err) ? "timeout" : "error";
      logSystemError(
        ErrorCategory.WORKFLOW_ENGINE,
        "[getCompletedStepOutput] DB fallback query failed; returning null",
        err instanceof Error ? err : new Error(String(err)),
        {
          execution_id: executionId,
          node_id: nodeId,
          db_error_class:
            err instanceof Error ? err.constructor.name : "unknown",
        }
      );
      getMetricsCollector().incrementCounter(
        "workflow.executor.tracker_db_fallback.total",
        { source: "single", outcome }
      );
      return null;
    }
  );

  inflightQueries.set(cacheKey, query);
  return query;
}

/**
 * Batch variant of getCompletedStepOutput for fan-in convergence.
 *
 * Issues a single WHERE execution_id = $1 AND node_id = ANY($2) AND status =
 * 'success' query for all nodeIds that are not already in the tracker. Returns
 * a Map<nodeId, CompletedStepOutput> containing only nodes for which a DB row
 * was found. Tracker hits are resolved before the DB query and merged in.
 *
 * Same kill-switch, error containment, and iteration-row exclusion semantics as
 * getCompletedStepOutput. This is the preferred path for mergeFromAuthority to
 * reduce sequential DB round-trips on cold-pod 9-fan-in convergence.
 *
 * Replay determinism: the batch step is issued for the full `nodeIds` list on
 * every call, never for "the subset the tracker is missing". The tracker is
 * process-local memory populated by step bodies, and step bodies do not re-run
 * on replay -- so a cold process sees a miss and creates the step while a warm
 * replay of the same convergence sees a hit and skips it. The DevKit records
 * that step_created event on the first pass, finds no matching call on the
 * second, and aborts the run with "Unconsumed event in event log". Keeping the
 * call unconditional keeps the step sequence identical across replays. The
 * tracker is still consulted, but only to fill values the DB has not committed
 * yet -- never to decide whether the step happens.
 */
export async function getCompletedStepOutputs(
  executionId: string,
  nodeIds: readonly string[]
): Promise<Map<string, CompletedStepOutput>> {
  const result = new Map<string, CompletedStepOutput>();
  if (nodeIds.length === 0) {
    return result;
  }

  const trackerSteps = getSuccessfulSteps(executionId);

  const fillFromTracker = (): void => {
    for (const nodeId of nodeIds) {
      if (!result.has(nodeId) && trackerSteps?.has(nodeId)) {
        result.set(nodeId, {
          output: trackerSteps.get(nodeId),
          source: "tracker",
        });
      }
    }
  };

  // Seeded before the query so tracker entries keep the precedence they had
  // when they were what decided the query's node list.
  fillFromTracker();

  if (!DB_FALLBACK_ENABLED) {
    return result;
  }

  const dbNodeIds = [...nodeIds];
  const startMs = Date.now();
  try {
    const rows = await fetchCompletedStepOutputsBatchStep(
      executionId,
      dbNodeIds
    );

    getMetricsCollector().recordLatency(
      "workflow.executor.tracker_db_fallback.duration_ms",
      Date.now() - startMs
    );

    for (const row of rows) {
      if (!result.has(row.nodeId)) {
        result.set(row.nodeId, {
          output: row.outputRaw,
          source: "db",
        });
      }
    }

    const hitCount = rows.length;
    const missCount = dbNodeIds.length - hitCount;
    if (hitCount > 0) {
      getMetricsCollector().incrementCounter(
        "workflow.executor.tracker_db_fallback.total",
        { source: "convergence", outcome: "hit" },
        hitCount
      );
    }
    if (missCount > 0) {
      getMetricsCollector().incrementCounter(
        "workflow.executor.tracker_db_fallback.total",
        { source: "convergence", outcome: "miss" },
        missCount
      );
    }
  } catch (err: unknown) {
    const outcome = isStatementTimeout(err) ? "timeout" : "error";
    getMetricsCollector().incrementCounter(
      "workflow.executor.tracker_db_fallback.total",
      { source: "convergence", outcome }
    );
    logSystemError(
      ErrorCategory.WORKFLOW_ENGINE,
      "[getCompletedStepOutputs] Batch DB fallback query failed; returning partial tracker results",
      err instanceof Error ? err : new Error(String(err)),
      {
        execution_id: executionId,
        predecessor_count: String(nodeIds.length),
        db_error_class: err instanceof Error ? err.constructor.name : "unknown",
      }
    );
  }

  return result;
}
