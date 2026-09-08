/**
 * Poll `fetchFn` until it returns a non-null value or `timeoutMs` elapses.
 *
 * Fetches immediately, then sleeps `intervalMs` between attempts. `now` and
 * `sleep` are injectable so the loop is deterministic under test.
 *
 * Used by the executor's spurious-max-retries recovery: when the framework
 * re-fires a step after a lost completion event and throws "exceeded max
 * retries", the step body's recorded success can land a few hundred ms LATER
 * than the throw. A one-shot read races that late write; this bounded poll
 * waits for it before the catch handler gives up and nullifies the node.
 *
 * Dependency-free (no server-only / DB / metrics) so it imports cleanly into
 * both the workflow bundle and unit tests, and avoids an import cycle with
 * get-completed-step-output.ts.
 */
export async function pollForCompletedOutput<T>(
  fetchFn: () => Promise<T | null>,
  options: {
    timeoutMs: number;
    intervalMs: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  }
): Promise<T | null> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = now() + options.timeoutMs;

  for (;;) {
    const result = await fetchFn();
    if (result !== null) {
      return result;
    }
    if (now() >= deadline) {
      return null;
    }
    await sleep(options.intervalMs);
  }
}
