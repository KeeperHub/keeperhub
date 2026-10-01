import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { takeBroadcastMarker } from "./lib/broadcast-marker";
import { validateWorkflowIntegrations } from "../lib/db/integrations";
import { getMetricsCollector } from "../lib/metrics";
import { LabelKeys, MetricNames } from "../lib/metrics/types";
import { buildExecutorInput } from "../lib/workflow/executor/build-executor-input";
import { executeWorkflow } from "../lib/workflow/executor/executor.workflow";
import type { WorkflowEdge, WorkflowNode } from "../lib/workflow/store";
import { loadWorkflowForExecution } from "../lib/workflow/load-for-execution";
import type { ApiExecuteTriggerType } from "./api-execute";
// Correlation map (issue #2289): the executor tracks every message's timeline
// under its correlation id before dispatch; this target's entries are freed
// here at run end because no observation will ever arrive to free them.
import { takeLatency } from "./lib/correlation-map";
import { ExecutionLatency } from "./latency";
import type { DbSchema } from "./lib/db-helpers";
import { ErrorCategory, logSystemError } from "../lib/logging";
import {
  applyExecutionResult,
  initializeExecutionProgress,
  updateExecutionStatus,
  updateScheduleStatus,
} from "./lib/db-helpers";

/**
 * Execute a workflow in-process (no K8s Job).
 * Refactored from keeperhub-executor/workflow-runner.ts main() to be callable
 * from the executor without managing its own process lifecycle.
 */
export async function executeInProcess(params: {
  workflowId: string;
  executionId: string;
  input: Record<string, unknown>;
  triggerType: ApiExecuteTriggerType;
  scheduleId?: string;
  db: PostgresJsDatabase<DbSchema>;
  /** Latency correlation (issue #2289): the id minted at SQS receive. */
  correlationId?: string;
  /**
   * Latency observation anchors (issue #2289): the executor's own stage
   * stamps, so this process records one timeline rather than starting a
   * second, unrelated one. Same shape the k8s-job branch passes.
   */
  latencyEpochs?: { receivedAt?: number; observedAt?: number };
}): Promise<void> {
  const { workflowId, executionId, input, triggerType, scheduleId, db } =
    params;
  const { receivedAt, observedAt } = params.latencyEpochs ?? {};
  const latency = new ExecutionLatency(params.correlationId);
  // The timeline belongs to the executor's instance: it stamps `observed`
  // when the event-tracker's message is received and `received` at SQS
  // receive, both before this hand-off (index.ts:895-898), and it passes the
  // epochs down because this process is the one that sees started/completed.
  // Without them stageMs("received", "started") and
  // stageMs("observed", "broadcast") are permanently undefined here, which
  // left the in-process queue leg measured nowhere (index.ts skips the
  // dispatch histogram for this target) and left the headline observed ->
  // broadcast histogram with no in-process series at all. Unlike the k8s-job
  // branch there is no cross-process hand-off to preserve, so the epochs are
  // re-marked rather than re-derived. A caller that starts the run itself
  // rather than receiving it has no earlier anchor, so the hand-off is the
  // receive stamp in that case.
  if (observedAt !== undefined) {
    latency.mark("observed", observedAt);
  }
  latency.mark("received", receivedAt ?? Date.now());
  const startTime = Date.now();

  console.log(
    `[Executor:InProcess] Starting workflow execution correlationId=${latency.correlationId}`
  );
  console.log(`[Executor:InProcess] Workflow ID: ${workflowId}`);
  console.log(`[Executor:InProcess] Execution ID: ${executionId}`);

  try {
    await updateExecutionStatus(db, executionId, "running");

    // Defensive re-check: the dispatcher already gated lifecycle state, but the
    // workflow could have been disabled, soft-deleted, deactivated, or its
    // owning org deactivated between dispatch and execution. Cancel rather than
    // run. The org owns the workflow, so org deactivation is the owner gate.
    //
    // Manual runs are the exception: the editor "Run" button must work on
    // not-yet-enabled drafts, so manual triggers pass requireEnabled: false to
    // match the interactive execute route. That only bypasses the "disabled"
    // reason - deleted/deactivated/org-deactivated still block - so it stays
    // safe. Automated triggers (schedule/event/block/webhook) keep the guard.
    const loaded = await loadWorkflowForExecution(workflowId, {
      requireEnabled: triggerType !== "manual",
    });
    if (loaded.status === "not_found") {
      throw new Error(`Workflow not found: ${workflowId}`);
    }
    if (loaded.status === "not_executable") {
      console.log(
        `[Executor:InProcess] Workflow not executable (${loaded.reason}), skipping: ${workflowId}`
      );
      await updateExecutionStatus(db, executionId, "cancelled");
      return;
    }

    const { workflow, organizationName } = loaded;
    const nodes = workflow.nodes as WorkflowNode[];
    const edges = workflow.edges as WorkflowEdge[];
    const validation = await validateWorkflowIntegrations(
      nodes,
      workflow.organizationId
    );

    if (!validation.valid) {
      throw new Error(
        `Workflow contains invalid integration references: ${validation.invalidIds?.join(", ")}`
      );
    }

    await initializeExecutionProgress(db, executionId, nodes, edges);

    console.log("[Executor:InProcess] Executing workflow...");
    // Intentional direct call (not start() from workflow/api): the executor and
    // K8s runner are standalone processes with no DevKit run-processor, so they
    // run the workflow synchronously to completion here. The DevKit editor hint
    // to "use start()" only applies inside the Next runtime. Tradeoff: there is
    // no checkpoint/resume, so a crash mid-run leaves the row "running" until a
    // sweeper closes it - tracked separately from this dedup work.
    //
    // Latency instrumentation (issue #2289): "started" is marked immediately
    // before the engine runs; "completed" after the terminal status lands.
    latency.mark("started");
    const result = await executeWorkflow(
      buildExecutorInput(workflow, {
        triggerInput: input,
        executionId,
        organizationName,
      })
    );

    latency.mark("completed");
    const duration = Date.now() - startTime;
    // Wrapped so instrumentation cannot fail a run that succeeded. This call
    // sits inside the try and before applyExecutionResult, so a throw here
    // would reach the catch and write status "error" for a run that completed -
    // and updateScheduleStatus has no terminal-state filter, so a scheduled run
    // would be recorded as failed with runCount never incremented. Observability
    // must not be able to fail a transaction, so it must not be able to fail a
    // successful workflow either.
    try {
      recordInProcessLatency({
        latency,
        workflowId,
        executionId,
        triggerType,
      });
    } catch (latencyError) {
      // logSystemError, not console.error: this catch is a swallow path now,
      // so the failure must reach the error metric and Sentry, not just stdout.
      logSystemError(
        ErrorCategory.WORKFLOW_ENGINE,
        "[Executor:InProcess] Latency instrumentation failed (run unaffected):",
        latencyError
      );
    }
    console.log(
      `[Executor:InProcess] Completed in ${duration}ms correlationId=${latency.correlationId}`
    );

    // executeWorkflow is the authoritative writer of the terminal status (with
    // reconciliation and richer fields). applyExecutionResult is a guarded
    // backstop: the WHERE clause in updateExecutionStatus makes its writes a
    // no-op once the engine's own write landed, and only closes the row if
    // that write was lost - so a finished run is never left stuck "running".
    const { errorMessage } = await applyExecutionResult(db, executionId, result, {
      scheduleId,
    });
    if (errorMessage) {
      console.error("[Executor:InProcess] Workflow execution failed:", errorMessage);
    } else {
      console.log("[Executor:InProcess] Execution completed successfully");
    }
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    // Latency instrumentation (issue #2289): discard this run's broadcast
    // marker if the write path left one and the run then failed - the success
    // path's takeBroadcastMarker never fires on this route, so without this a
    // failed in-process run leaks its per-execution marker file into a
    // weeks-long pod's emptyDir. Deliberately cleanup only: no latency stage
    // is recorded on the failure path, so the histograms keep counting only
    // runs that reached a terminal state. The executor's startup
    // sweepBroadcastMarkers covers the remaining failure mode, a process
    // killed before this catch can run.
    try {
      takeBroadcastMarker(executionId);
    } catch {
      // Never let marker cleanup mask the run's own error.
    }

    // "completed" is not marked on failure: the histogram must only count runs
    // that reached a terminal state, so a crash/failure is visible as a
    // missing series rather than a fast fake latency.
    console.error(
      `[Executor:InProcess] Fatal error after ${duration}ms correlationId=${latency.correlationId}:`,
      errorMessage
    );

    try {
      await updateExecutionStatus(db, executionId, "error", {
        error: errorMessage,
      });

      if (scheduleId) {
        await updateScheduleStatus(db, scheduleId, "error", errorMessage);
      }
    } catch (updateError) {
      console.error(
        "[Executor:InProcess] Failed to update execution status:",
        updateError
      );
    }
  } finally {
    // Correlation map (issue #2289): the timeline was tracked under this
    // correlation id at SQS receive, but no runner will ever ingest an
    // observation for an in-process run, so waiting for one held the slot
    // for the map's whole turnover window (the leak the review flagged:
    // only k8s-job entries were ever freed). Freeing in a finally covers
    // every exit - success, throw, and the cancelled early return alike.
    if (params.correlationId !== undefined) {
      try {
        takeLatency(params.correlationId);
      } catch {
        // Never let map cleanup mask the run's own outcome.
      }
    }
  }
}

/**
 * Latency instrumentation (issue #2289): emit the receive->completed histogram
 * for an in-process run that reached a terminal state, split by trigger,
 * target and stage so slow producers vs slow runners are visible
 * independently. The structured stage log line is emitted here
 * (received/started/completed with per-stage durations) for the same run.
 *
 * The broadcast stage is read back from the sidecar marker the write path
 * dropped at the broadcast point (same process, engine already returned): the
 * observed -> broadcast histogram - the interval issue #2289 exists for - is
 * recorded here when both endpoints are known.
 */
function recordInProcessLatency(params: {
  latency: ExecutionLatency;
  workflowId: string;
  executionId: string;
  triggerType: ApiExecuteTriggerType;
}): void {
  const { latency, workflowId, executionId, triggerType } = params;
  // The write path marked its broadcast into the per-execution sidecar; take
  // it (read-and-discard for exactly this execution id) now that the run has
  // returned and the marker can only belong to this execution.
  const marker = takeBroadcastMarker(executionId);
  if (marker && marker.executionId === executionId) {
    latency.mark("broadcast", marker.broadcastAt);
  }
  const queueToStartMs = latency.stageMs("received", "started");
  if (queueToStartMs !== undefined) {
    getMetricsCollector().recordLatency(
      MetricNames.EXECUTOR_DISPATCH_LATENCY,
      queueToStartMs,
      {
        [LabelKeys.TRIGGER_TYPE]: triggerType,
        [LabelKeys.DISPATCH_TARGET]: "in-process",
        [LabelKeys.STAGE]: "started",
      }
    );
  }
  // receive -> terminal, the interval METRICS_REFERENCE.md documents for this
  // metric, rather than this process's own lifetime: the executor's receive
  // stamp is the anchor (threaded in as latencyEpochs), so the in-process
  // series means the same thing as the k8s-job series that
  // observation-applier.ts records from KH_RECEIVED_AT. Measuring from the
  // hand-off instead would silently exclude the executor-side pre-dispatch
  // work and put a second interval in the same histogram.
  const totalMs = latency.totalMs();
  if (totalMs !== undefined) {
    getMetricsCollector().recordLatency(
      MetricNames.EXECUTOR_EXECUTION_LATENCY,
      totalMs,
      {
        [LabelKeys.TRIGGER_TYPE]: triggerType,
        [LabelKeys.DISPATCH_TARGET]: "in-process",
        [LabelKeys.STAGE]: "completed",
      }
    );
  }
  // Guard on the *raw* delta before recording. stageMs() clamps to 0, and
  // `observed` is stamped in the tracker pod while `broadcast` is stamped in
  // this one, so a tracker clock running ahead yields a negative delta that
  // clamping would turn into a real-looking 0 ms sample. latency-observations
  // drops a negative interval for the k8s-job series, so clamping here would
  // make the two series in one histogram disagree on `_count` for the same skew.
  const obsToBroadcast = latency.rawStageMs("observed", "broadcast");
  if (obsToBroadcast !== undefined && obsToBroadcast >= 0) {
    getMetricsCollector().recordLatency(
      MetricNames.EXECUTOR_BROADCAST_LATENCY,
      obsToBroadcast,
      {
        [LabelKeys.TRIGGER_TYPE]: triggerType,
        [LabelKeys.DISPATCH_TARGET]: "in-process",
      }
    );
  }
  latency.emitLog({ workflowId, executionId, triggerType, dispatchTarget: "in-process" });
}
