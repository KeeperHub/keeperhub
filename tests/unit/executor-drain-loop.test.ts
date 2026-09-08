/**
 * KEEP-395 (Bug 2): single-edge chain through chained node not fully awaited.
 *
 * Tests the `createPendingTracker` drain-loop helper used by the workflow
 * executor. Under "use workflow" SDK durability, the call-stack-await chain
 * inside `executeReadyDownstream` recursion can be truncated by checkpoint
 * resume, leaving an orphaned promise that nothing is awaiting. The pending
 * tracker holds a strong reference to every wrapped promise and lets the
 * executor drain them all before finalisation.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createPendingTracker } from "@/lib/workflow/executor/pending-tasks";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createPendingTracker (KEEP-395 Bug 2)", () => {
  it("track returns the original promise", async () => {
    const tracker = createPendingTracker();
    const p = Promise.resolve(42);
    const wrapped = tracker.track(p);
    expect(wrapped).toBe(p);
    expect(await wrapped).toBe(42);
  });

  it("size reflects in-flight promises and decrements on settle", async () => {
    const tracker = createPendingTracker();
    const d1 = deferred<number>();
    const d2 = deferred<number>();

    tracker.track(d1.promise);
    tracker.track(d2.promise);
    expect(tracker.size()).toBe(2);

    d1.resolve(1);
    // Allow the .finally microtask to run.
    await Promise.resolve();
    await Promise.resolve();
    expect(tracker.size()).toBe(1);

    d2.resolve(2);
    await Promise.resolve();
    await Promise.resolve();
    expect(tracker.size()).toBe(0);
  });

  it("drain resolves immediately when the set is empty", async () => {
    const tracker = createPendingTracker();
    await expect(tracker.drain()).resolves.toBeUndefined();
  });

  it("drain awaits a single in-flight promise", async () => {
    const tracker = createPendingTracker();
    const d = deferred<string>();
    tracker.track(d.promise);

    let drained = false;
    const drainPromise = tracker.drain().then(() => {
      drained = true;
    });

    // Drain has not resolved yet (promise still pending).
    await Promise.resolve();
    expect(drained).toBe(false);

    d.resolve("done");
    await drainPromise;
    expect(drained).toBe(true);
    expect(tracker.size()).toBe(0);
  });

  it("drain awaits NEW promises added while existing ones are settling (recursive scheduling)", async () => {
    // This is the core Bug 2 scenario: when an awaited branch schedules a
    // downstream node mid-drain (executeReadyDownstream recursion), the
    // newly-added promise must also be awaited before drain returns.
    const tracker = createPendingTracker();

    const dA = deferred<string>();
    const dB = deferred<string>();

    tracker.track(dA.promise);
    // When A settles it will (synchronously, in its .then) schedule B.
    dA.promise
      .then(() => {
        tracker.track(dB.promise);
      })
      .catch(() => undefined);

    let drained = false;
    const drainPromise = tracker.drain().then(() => {
      drained = true;
    });

    await Promise.resolve();
    expect(drained).toBe(false);
    expect(tracker.size()).toBe(1);

    dA.resolve("a-done");
    // After A settles, drain should re-iterate and find B is now pending.
    await Promise.resolve();
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(tracker.size()).toBe(1);

    dB.resolve("b-done");
    await drainPromise;
    expect(drained).toBe(true);
    expect(tracker.size()).toBe(0);
  });

  it("drain handles a rejected promise without throwing (allSettled semantics)", async () => {
    const tracker = createPendingTracker();
    const d = deferred<number>();
    // The caller's branch is responsible for handling its own rejection
    // (the executor uses Promise.allSettled at every call site). track()
    // must NOT cause an unhandled-rejection in its internal `.finally`.
    d.promise.catch(() => undefined);
    tracker.track(d.promise);

    const drainPromise = tracker.drain();
    d.reject(new Error("kaboom"));

    await expect(drainPromise).resolves.toBeUndefined();
    expect(tracker.size()).toBe(0);
  });

  it("drain returns and invokes onTimeout when timeout fires before pending settles", async () => {
    // KEEP-395 Bug 2 hardening (R2 BLOCKER 1): drain must be bounded so a
    // hung step (most plugin steps lack AbortSignal) cannot stall the
    // workflow indefinitely. Timeout fires -> drain resolves -> onTimeout
    // is called once with the remaining pending count.
    const tracker = createPendingTracker();
    const d1 = deferred<number>();
    const d2 = deferred<number>();
    // Suppress unhandled-rejection noise on never-resolved promises.
    d1.promise.catch(() => undefined);
    d2.promise.catch(() => undefined);
    tracker.track(d1.promise);
    tracker.track(d2.promise);

    const onTimeout = vi.fn();
    const start = Date.now();
    await tracker.drain({ timeoutMs: 25, onTimeout });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(20);
    expect(elapsed).toBeLessThan(500); // generous CI margin
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledWith(2);
    // The two never-settled promises remain in the set; tracker is leaked
    // but that's the documented behaviour (no AbortController plumbing).
    expect(tracker.size()).toBe(2);

    // Cleanup: settle them so vitest doesn't report leaks.
    d1.resolve(1);
    d2.resolve(2);
    await Promise.resolve();
    await Promise.resolve();
  });

  it("drain does NOT invoke onTimeout when pending settles before timeout", async () => {
    const tracker = createPendingTracker();
    const d = deferred<string>();
    tracker.track(d.promise);

    const onTimeout = vi.fn();
    const drainPromise = tracker.drain({ timeoutMs: 5000, onTimeout });
    d.resolve("done");
    await drainPromise;

    expect(onTimeout).not.toHaveBeenCalled();
    expect(tracker.size()).toBe(0);
  });

  it("drain returns immediately (no timer) when pending is already empty", async () => {
    const tracker = createPendingTracker();
    const onTimeout = vi.fn();
    // Zero timeout would normally fire instantly; the empty-set short-circuit
    // must skip the timer entirely so onTimeout is never called.
    await tracker.drain({ timeoutMs: 0, onTimeout });
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("simulates the executor pattern: trigger settle + recursive downstream + drain", async () => {
    // Fake a workflow shape: trigger -> A -> B. Trigger settle awaits
    // executeNode(trigger), which schedules A inside its promise chain. A
    // schedules B. The outermost trigger settle resolves before A finishes
    // (simulating SDK truncation). Without drain, B would be lost.
    const tracker = createPendingTracker();

    const aResolver = deferred<void>();
    const bResolver = deferred<void>();
    const completed: string[] = [];

    const executeNode = (id: string): Promise<void> => {
      if (id === "trigger") {
        // Schedule A but RETURN BEFORE A settles -- simulates SDK truncation
        // where the trigger's await chain is cut off.
        const aPromise = (async () => {
          await aResolver.promise;
          completed.push("A");
          // A schedules B
          const bPromise = (async () => {
            await bResolver.promise;
            completed.push("B");
          })();
          tracker.track(bPromise);
        })();
        tracker.track(aPromise);
        completed.push("trigger");
        return Promise.resolve();
      }
      return Promise.resolve();
    };

    const triggerSettled = await tracker.track(
      Promise.allSettled([executeNode("trigger")])
    );
    expect(triggerSettled).toHaveLength(1);
    expect(completed).toEqual(["trigger"]);

    // Without drain: A and B never run before finalisation. With drain:
    // both must complete before drain returns.
    const drainPromise = tracker.drain();

    aResolver.resolve();
    await Promise.resolve();
    bResolver.resolve();

    await drainPromise;
    expect(completed).toEqual(["trigger", "A", "B"]);
    expect(tracker.size()).toBe(0);
  });

  it("simulates parallel For Each iterations: drain rescues truncated body recursion", async () => {
    // For Each parallel iteration drop: when a For Each runs in parallel
    // mode, multiple iteration body chains are in flight at once.
    // After each body's first step (e.g. decode-network), the SDK can
    // truncate the await chain before the iteration's recurseInto schedules
    // the next step (e.g. HTTP Request). Without pendingTasks.track around
    // each iteration body, those orphaned downstream steps are silently
    // dropped and the workflow finalises with status "success" missing the
    // dropped body work.
    //
    // Faithful shape:
    //   ForEach (parallel, 4 items)
    //     -> body: stepA (decode-network) -> stepB (HTTP Request)
    //
    // The simulator models all 4 iterations as truncated -- their stepA
    // completes synchronously and their stepB is scheduled but the
    // iteration body returns before stepB settles. Wrapping each
    // iteration body in tracker.track means the orphaned stepB promises
    // remain reachable via the tracker, and the workflow-end drain forces
    // them to complete before finalisation.
    const tracker = createPendingTracker();

    const completed: string[] = [];
    const stepBResolvers = [
      deferred<void>(),
      deferred<void>(),
      deferred<void>(),
      deferred<void>(),
    ];

    const runIteration = (index: number): Promise<void> => {
      // stepA always resolves synchronously (analog of decode-network).
      completed.push(`stepA-${index}`);
      // stepB is the recurseInto target. The iteration schedules it but
      // does NOT await it inside the body -- this models the SDK
      // checkpoint-resume severing the await chain. Without a strong
      // reference held by the tracker, the stepB promise is orphaned.
      const stepB: Promise<void> = (async () => {
        await stepBResolvers[index].promise;
        completed.push(`stepB-${index}`);
      })();
      tracker.track(stepB);
      return Promise.resolve();
    };

    // Mirror the executor: each iteration body promise is itself wrapped
    // in tracker.track (the production fix in handleForEachExecution).
    const settled = await Promise.allSettled(
      [0, 1, 2, 3].map((i) => tracker.track(runIteration(i)))
    );
    expect(settled).toHaveLength(4);
    // All iteration bodies returned; only stepA has run for each.
    expect(completed).toEqual(["stepA-0", "stepA-1", "stepA-2", "stepA-3"]);

    // Workflow-end drain: tracker holds strong refs to the orphaned stepB
    // promises. Without it, the workflow would finalise with stepB
    // unscheduled for every iteration.
    const drainPromise = tracker.drain();

    // Resolve the orphaned stepB promises -- in production these are
    // backed by real "use step" calls that complete asynchronously.
    for (const r of stepBResolvers) {
      r.resolve();
    }

    await drainPromise;

    // All four iterations completed both steps via the drain.
    expect(completed).toContain("stepB-0");
    expect(completed).toContain("stepB-1");
    expect(completed).toContain("stepB-2");
    expect(completed).toContain("stepB-3");
    expect(tracker.size()).toBe(0);
  });
});
