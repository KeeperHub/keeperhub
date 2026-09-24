/**
 * Runs `tick` repeatedly with `intervalMs` of idle time between the end of one
 * run and the start of the next. Unlike setInterval, a tick that outlasts the
 * interval delays the next one instead of overlapping it, so a slow endpoint
 * never has several identical requests in flight from a single poller.
 *
 * `tick` should handle its own failures; the chain continues either way.
 */
export function startSerialPoll(
  tick: () => Promise<void>,
  intervalMs: number
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function schedule(): void {
    if (!stopped) {
      timer = setTimeout(run, intervalMs);
    }
  }

  async function run(): Promise<void> {
    if (stopped) {
      return;
    }
    try {
      await tick();
    } finally {
      schedule();
    }
  }

  schedule();

  return (): void => {
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
    }
  };
}
