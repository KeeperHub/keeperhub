/**
 * KEEP-395 (Bug 2): Drain-loop tracker for pending workflow tasks.
 *
 * Under "use workflow" durability, the SDK can checkpoint and resume
 * `executeWorkflow` partway through. The recursive `executeReadyDownstream`
 * call chain runs in the workflow layer (NOT inside a "use step"), so when
 * the SDK truncates the call-stack-await chain at a checkpoint resume the
 * scheduling of a downstream node is sometimes lost -- finalisation occurs
 * before that downstream node has even been queued.
 *
 * Wrap every `Promise.allSettled(...)` whose elements call `executeNode`
 * with `trackPending` so the executor holds a strong reference to every
 * in-flight branch. After the trigger settle, drain until the set is empty.
 * This catches any orphaned promise that was scheduled but not awaited via
 * the call-stack chain.
 *
 * Behavioural-equivalent: when no checkpoint resume happens, every awaited
 * `Promise.allSettled` resolves naturally and the drain loop sees an empty
 * set immediately. The new behaviour only kicks in when an orphaned promise
 * exists -- previously they were silently dropped, now they are awaited.
 *
 * KEEP-395 (Bug 2 hardening): drain is bounded by a timeout so a hung step
 * (no AbortSignal in most plugin implementations) cannot stall the workflow
 * indefinitely. Default 5 minutes, override via `KH_EXECUTOR_DRAIN_TIMEOUT_MS`.
 * When the timeout fires, drain returns and the caller is informed via the
 * `onTimeout` callback (if supplied) so it can log the leak with workflow
 * context. The leaked promises are NOT cancelled (no AbortController plumbing
 * here) -- they continue running in the background and the platform-level
 * workflow timeout will eventually clean them up.
 *
 * The timeout MUST stay below the runner pod's activeDeadlineSeconds. At or
 * past it the pod is SIGKILLed before `onTimeout` runs, so the leak is never
 * logged, no terminal status is written, and the execution row is orphaned
 * "running" until the reaper closes it. The k8s-job dispatcher derives the env
 * var from the deadline for exactly this reason (see config.ts).
 */

const DEFAULT_DRAIN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function readDrainTimeoutMs(): number {
  const raw = process.env.KH_EXECUTOR_DRAIN_TIMEOUT_MS;
  if (!raw) {
    return DEFAULT_DRAIN_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return DEFAULT_DRAIN_TIMEOUT_MS;
  }
  return parsed;
}

export type DrainOptions = {
  /** Override the timeout in ms. Defaults to env or 5 minutes. */
  timeoutMs?: number;
  /**
   * Called once if the drain hits its timeout with promises still pending.
   * `pendingCount` is the snapshot size at the moment the timeout fired.
   */
  onTimeout?: (pendingCount: number) => void;
};

export type PendingTracker = {
  /**
   * Wrap a promise so it is held in the pending set until it settles.
   * Returns the same promise (settled or rejected) so callers can `await`
   * it normally.
   */
  track<T>(p: Promise<T>): Promise<T>;
  /**
   * Drain the pending set: await every currently-tracked promise. New
   * promises added by the awaited promises are also drained. Returns once
   * the set is empty OR the timeout fires (whichever first).
   */
  drain(opts?: DrainOptions): Promise<void>;
  /** Current count of in-flight promises (used in tests / diagnostics). */
  size(): number;
};

export function createPendingTracker(): PendingTracker {
  const pending = new Set<Promise<unknown>>();

  function track<T>(p: Promise<T>): Promise<T> {
    pending.add(p);
    // `.finally` returns a NEW promise that rejects with the same reason if
    // `p` rejects. Attach a noop `.catch` so an internal rejection here is
    // never reported as unhandled. Callers that care about rejection should
    // await the original promise (returned below) where their own handlers
    // apply.
    p.finally(() => {
      pending.delete(p);
    }).catch(() => undefined);
    return p;
  }

  async function drainLoop(): Promise<void> {
    // New promises may be added while we await existing ones (e.g. an
    // awaited branch schedules another downstream node). Loop until the
    // set is fully drained.
    while (pending.size > 0) {
      const snapshot = [...pending];
      await Promise.allSettled(snapshot);
    }
  }

  async function drain(opts?: DrainOptions): Promise<void> {
    if (pending.size === 0) {
      return;
    }

    const timeoutMs = opts?.timeoutMs ?? readDrainTimeoutMs();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timeoutHandle = setTimeout(() => resolve("timeout"), timeoutMs);
      // Don't keep the event loop alive for this watchdog.
      timeoutHandle.unref?.();
    });

    const result = await Promise.race([
      drainLoop().then(() => "drained" as const),
      timeoutPromise,
    ]);

    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }

    if (result === "timeout") {
      opts?.onTimeout?.(pending.size);
    }
  }

  function size(): number {
    return pending.size;
  }

  return { track, drain, size };
}
