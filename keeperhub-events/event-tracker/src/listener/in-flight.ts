/**
 * Tracks the tracker's in-flight `onLog` handlers so shutdown can wait for
 * them. Without a drain, SIGTERM exits mid-dispatch: the matched event has
 * not reached SQS and has no phantom row behind it, and nothing replays it.
 * `lastProcessedBlock` lives on the in-memory `ChainEntry` and a fresh
 * process resumes at `headBlock - 1`, so a killed handler is a trigger that
 * never fires and never retries.
 *
 * This is a copy of `keeperhub-executor/lib/in-flight.ts`, kept in sync by
 * hand. `@techops/events-tracker` is a standalone package (`rootDir: "."`,
 * `include: ["src/**", "lib/**"]`) and cannot resolve modules from the root
 * context, so the executor's class is not importable here.
 */
export class InFlightTracker {
  private readonly pending = new Set<Promise<unknown>>();

  get size(): number {
    return this.pending.size;
  }

  /** Register a handler promise; it leaves the set once it settles either way. */
  track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    const remove = (): void => {
      this.pending.delete(promise);
    };
    promise.then(remove, remove);
    return promise;
  }

  /**
   * Resolve true once every tracked promise has settled, including any tracked
   * while waiting, or false when timeoutMs elapses first (work is still running
   * and will be cut off by the exit that follows).
   */
  drain(timeoutMs: number): Promise<boolean> {
    if (this.pending.size === 0) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      const settleAll = async (): Promise<void> => {
        while (this.pending.size > 0) {
          await Promise.allSettled([...this.pending]);
        }
        clearTimeout(timer);
        resolve(true);
      };
      settleAll();
    });
  }
}
