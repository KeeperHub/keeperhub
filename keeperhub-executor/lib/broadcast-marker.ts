/**
 * Broadcast-stage marker for the executor latency instrumentation (issue #2289).
 *
 * The stage timestamp lives inside lib/web3 write paths, but the latency
 * timeline is owned by this satellite's long-lived process. A web3 write
 * executes inside a separate pod (or a separate engine call) with no handle on
 * the `ExecutionLatency` instance, so the timestamp is handed over through a
 * side channel and the executor applies it to the right run:
 *
 * 1. The write path calls markBroadcast() at the exact broadcast point.
 * 2. markBroadcast() writes {executionId, broadcastAt} to
 *    KH_BROADCAST_MARKER (an absolute /tmp path) - it is a fixed filename, so
 *    only one web3 write can be in flight per pod by construction (one
 *    execution per Job pod, and in-process executions hold the event loop).
 *    It also bumps a process-local broadcast counter, shipped to the executor
 *    with the other counter deltas, so the broadcast stage is observable even
 *    when the sidecar file cannot be read back (multi-write in-process runs).
 * 3. After executeWorkflow() returns, the runner reads and clears the sidecar
 *    via takeBroadcastMarker() and includes it in its structured completion
 *    log. The executor matches on executionId and marks "broadcast" before
 *    deriving the observed -> broadcast distribution.
 *
 * Best-effort by design: every failure mode degrades to a missing optional
 * stage mark (and a stale sidecar from a crashed pod is simply overwritten by
 * the next run). Never throws into the write path - observability must not be
 * able to fail a transaction.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { getWorkflowErrorContext } from "@/lib/workflow/executor/error-context";

const MARKER_PATH = process.env.KH_BROADCAST_MARKER || "/tmp/kh-broadcast-marker.json";

let broadcastCount = 0;

/** Stage record written by the write path and consumed by the runner. */
export type BroadcastMarker = {
  executionId: string;
  broadcastAt: number;
};

export function getBroadcastMarkerPath(): string {
  return MARKER_PATH;
}

/**
 * Best-effort execution id for the broadcast marker: reads the async-local
 * workflow error context the engine enters at run start, which carries
 * execution_id across every async leg of the run (including plugin steps).
 * Undefined outside a run (scripts, tests) - markBroadcast then only bumps
 * the process-local counter. Pure module (no Node builtins), so importing it
 * from lib/web3 write paths adds nothing the engine has not already loaded.
 */
export function currentExecutionId(): string | undefined {
  return getWorkflowErrorContext()?.execution_id;
}

/**
 * Record the moment a transaction was handed to the chain. Called at the
 * broadcast points inside lib/web3 write paths; the owning execution id is
 * resolved from the async-local workflow context the engine enters at run
 * start. Errors are swallowed: a failed marker write must never fail the
 * transaction it observes.
 */
export function markBroadcast(
  executionId: string | undefined = currentExecutionId()
): void {
  broadcastCount++;
  if (!executionId) {
    return;
  }
  try {
    writeFileSync(
      MARKER_PATH,
      JSON.stringify({
        executionId,
        broadcastAt: Date.now(),
      } satisfies BroadcastMarker),
      "utf-8"
    );
  } catch {
    // Sidecar unavailable (read-only fs, sandbox): the shipped broadcast
    // counter still records that a broadcast happened this run.
  }
}

/** Process-local count of broadcasts this pod has performed. */
export function getBroadcastCount(): number {
  return broadcastCount;
}

/**
 * Read-and-clear the sidecar. Returns undefined when no broadcast was marked
 * this run (or the file is unreadable/corrupt - treated the same way).
 */
export function takeBroadcastMarker(): BroadcastMarker | undefined {
  try {
    if (!existsSync(MARKER_PATH)) {
      return undefined;
    }
    const raw = readFileSync(MARKER_PATH, "utf-8");
    rmSync(MARKER_PATH, { force: true });
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as BroadcastMarker).executionId === "string" &&
      typeof (parsed as BroadcastMarker).broadcastAt === "number"
    ) {
      return parsed as BroadcastMarker;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
