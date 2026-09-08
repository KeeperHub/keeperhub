/**
 * Tracks the executor's in-flight message handlers so shutdown can wait for
 * them. Without a drain, SIGTERM exits mid-processMessage: the claimed row is
 * left pending/running for the reaper, and the SQS message redelivers after the
 * visibility timeout - dropped by the claim CAS when it carries an execution
 * id, run a second time when it does not.
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
