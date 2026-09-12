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
 * 2. markBroadcast() records {executionId, broadcastAt} into a per-execution
 *    registry (KH_BROADCAST_MARKER_DIR, one file per execution id) and
 *    increments the registered `keeperhub_executor_broadcasts_total` counter.
 *    Per-execution file names exist because the executor runs up to
 *    `maxMessages` (10) in-process executions concurrently
 *    (Promise.allSettled in index.ts): with one fixed filename a later
 *    broadcast could overwrite an earlier one before its run reads it back,
 *    silently losing the sample. The counter ships to the executor with the
 *    other counter deltas, so the broadcast stage stays observable even where
 *    the per-run files cannot be read back (multi-write runs, read-only fs).
 * 3. After executeWorkflow() returns, the runner takes its own execution's
 *    marker (read-and-discard for exactly its execution id) and includes the
 *    stage in its structured completion log; the observation collector ships
 *    the interval to the executor. Taking by explicit execution id is what
 *    keeps concurrent in-process runs from stealing each other's marker.
 *
 * Marker files are removed on three paths, so no single failure mode can
 * accumulate them: the runner's or the in-process success take
 * (read-and-discard), the in-process failure catch (best-effort discard, so
 * a run that broadcasts and then throws leaves nothing behind), and a sweep
 * of the whole registry at executor startup (sweepBroadcastMarkers, called
 * from the executor's listen() before any run can start - covers a process
 * killed mid-run, where no in-process handler ever returns). Best-effort by
 * design: every failure mode degrades to a missing optional stage mark, and
 * a missed cleanup costs one tiny file until the next startup sweep. Never
 * throws into the write path - observability must not be able to fail a
 * transaction.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getWorkflowErrorContext } from "@/lib/workflow/executor/error-context";

const MARKER_DIR = process.env.KH_BROADCAST_MARKER_DIR || "/tmp/kh-broadcast-markers";

/** Stage record written by the write path and consumed by the runner. */
export type BroadcastMarker = {
  executionId: string;
  broadcastAt: number;
};

export function getBroadcastMarkerPath(executionId: string): string {
  return join(MARKER_DIR, `${executionId}.json`);
}

/**
 * Path hardening (issue #2289 review): the execution id drives both a file
 * path and the rmSync in takeBroadcastMarker, so it is validated before it
 * reaches the filesystem. Allowlist rather than blocklist: the platform's
 * ids are nanoid over [0-9a-z] (lib/utils/id.ts generateId) or UUIDs, so
 * [A-Za-z0-9_-] with a 128-char cap accepts every id the platform issues
 * while rejecting path separators, `..` and control characters outright.
 * Hardening rather than a live hole - ids are DB-generated and SQS messages
 * are HMAC-signed - but the value became load-bearing for a delete, so it
 * is checked like one.
 */
const SAFE_EXECUTION_ID = /^[A-Za-z0-9_-]{1,128}$/;

function isSafeExecutionId(executionId: string): boolean {
  return SAFE_EXECUTION_ID.test(executionId);
}

/**
 * Best-effort execution id for the broadcast marker: reads the async-local
 * workflow error context the engine enters at run start, which carries
 * execution_id across every async leg of the run (including plugin steps).
 * Callers that know their execution id (the runner, the in-process path,
 * tests) pass it explicitly; outside a registered context (scripts, tests)
 * this returns undefined and markBroadcast only bumps the counters. Pure
 * module (no Node builtins), so importing it from lib/web3 write paths adds
 * nothing the engine has not already loaded.
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
  bumpRegisteredCounter();
  // An unsafe id still counts (the broadcast did happen) but writes no file:
  // the sidecar is an optimization, the counters are the guarantee.
  if (!executionId || !isSafeExecutionId(executionId)) {
    return;
  }
  try {
    mkdirSync(MARKER_DIR, { recursive: true });
    writeFileSync(
      getBroadcastMarkerPath(executionId),
      JSON.stringify({
        executionId,
        broadcastAt: Date.now(),
      } satisfies BroadcastMarker),
      "utf-8"
    );
  } catch {
    // Sidecar unavailable (read-only fs, sandbox): the registered broadcast
    // counter still records that a broadcast happened this run.
  }
}

/** Process-local count of broadcasts this pod has performed (diagnostic). */
export function getBroadcastCount(): number {
  return broadcastCount;
}

/**
 * Non-destructive read of the marker for one execution. Concurrent
 * in-process runs can each peek at their own file without touching another
 * run's sample. Returns undefined when no broadcast was marked for this
 * execution (or the file is unreadable/corrupt - treated the same way).
 */
export function peekBroadcastMarker(
  executionId: string
): BroadcastMarker | undefined {
  if (!isSafeExecutionId(executionId)) {
    return undefined;
  }
  try {
    const path = getBroadcastMarkerPath(executionId);
    if (!existsSync(path)) {
      return undefined;
    }
    const marker = parseMarker(readFileSync(path, "utf-8"));
    // Reader-level id check: a marker is only valid for the execution whose
    // name the file carries. parseMarker validates shape without knowing the
    // requested id; this closes the content-vs-filename gap here so no
    // consumer can ever receive a mismatched marker.
    if (marker && marker.executionId !== executionId) {
      return undefined;
    }
    return marker;
  } catch {
    return undefined;
  }
}

/**
 * Read-and-discard the marker for one execution: the caller has consumed the
 * stage record, so its per-execution file is removed. Passing the execution
 * id explicitly (rather than consuming a shared file) is what makes this safe
 * under concurrent in-process executions - run B's marker can never be taken
 * by run A, because A only ever removes its own file.
 */
export function takeBroadcastMarker(
  executionId: string
): BroadcastMarker | undefined {
  if (!isSafeExecutionId(executionId)) {
    return undefined;
  }
  try {
    const path = getBroadcastMarkerPath(executionId);
    if (!existsSync(path)) {
      return undefined;
    }
    const raw = readFileSync(path, "utf-8");
    rmSync(path, { force: true });
    const marker = parseMarker(raw);
    // Same reader-level id check as peekBroadcastMarker. A mismatched file is
    // still consumed (removed above): a misfiled marker is garbage either
    // way, and leaving it behind would defeat the cleanup paths.
    if (marker && marker.executionId !== executionId) {
      return undefined;
    }
    return marker;
  } catch {
    return undefined;
  }
}

/**
 * Delete every marker file in the registry and return how many were removed.
 * Called from the executor's listen() at process startup, before the SQS
 * consumer can start any in-process run: at that point every file present is
 * a leftover from a previous process that died between broadcast and take
 * (the one failure mode neither the success take nor the failure catch
 * covers). Runner pods mount their own emptyDir, so a sweep in the executor
 * pod cannot touch markers belonging to a live dispatch. Best-effort: a
 * missing or unreadable directory sweeps nothing and returns 0.
 */
export function sweepBroadcastMarkers(): number {
  try {
    const entries = readdirSync(MARKER_DIR);
    let removed = 0;
    for (const entry of entries) {
      try {
        rmSync(join(MARKER_DIR, entry), { force: true, recursive: true });
        removed++;
      } catch {
        // Unlinkable entry (permissions, concurrent removal): leave it. The
        // sweep runs again on the next startup and the file is inert until
        // then.
      }
    }
    return removed;
  } catch {
    // No registry directory yet (fresh pod): nothing to sweep, not an error.
    return 0;
  }
}

function parseMarker(raw: string): BroadcastMarker | undefined {
  try {
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

// The registered counter (keeperhub_executor_broadcasts_total) lives in
// lib/metrics/collectors/prometheus, which is server-only and drags the whole
// metrics stack with it; importing it eagerly would weight every lib/web3
// write path for a metric it rarely reads. Resolve it lazily on first
// broadcast instead: the executor and the runner pods both load the module
// anyway (delta collection imports it), so the promise settles almost
// immediately in production. Marks landing before resolution are buffered and
// flushed on arrival, so no sample is lost either way. Where the collector
// never becomes available (tests without the server-only shim) this stays a
// no-op - observability must not be able to fail a transaction.
let broadcastCount = 0;
let broadcastCounter: import("prom-client").Counter<string> | undefined;
let broadcastCounterRequested = false;
let broadcastCounterBuffer = 0;
// The in-flight resolution of the lazy counter import, captured so tests can
// await it deterministically (waitForBroadcastCounterForTests) instead of
// assuming a dynamic ESM import settles within a fixed number of ticks.
let broadcastCounterReady: Promise<void> | undefined;

function bumpRegisteredCounter(): void {
  if (broadcastCounter) {
    broadcastCounter.inc();
    return;
  }
  broadcastCounterBuffer++;
  if (!broadcastCounterRequested) {
    broadcastCounterRequested = true;
    broadcastCounterReady = import("../../lib/metrics/collectors/prometheus")
      .then(({ executorBroadcastsTotal }) => {
        broadcastCounter = executorBroadcastsTotal;
        if (broadcastCounterBuffer > 0) {
          broadcastCounter.inc(broadcastCounterBuffer);
          broadcastCounterBuffer = 0;
        }
      })
      .catch(() => {
        // Collector unavailable in this process (tests, bundles without the
        // metrics stack): keep counting locally via getBroadcastCount().
        broadcastCounterBuffer = 0;
      });
  }
}

/**
 * Test seam: resolves once a requested counter import has settled (counter
 * registered, or resolution failed and the buffer was dropped). Resolves
 * immediately when no import was ever requested. Without this, a test
 * asserting on the registered counter would have to assume a dynamic ESM
 * import settles within one macrotask tick - which holds only by accident of
 * module-load order, not by guarantee.
 */
export async function waitForBroadcastCounterForTests(): Promise<void> {
  if (broadcastCounterReady) {
    await broadcastCounterReady;
  }
}
