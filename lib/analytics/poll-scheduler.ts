export type PollScheduler = {
  start: () => void;
  stop: () => void;
};

/**
 * Runs `task` repeatedly, rearming only once the previous run settles.
 *
 * setInterval fired on the wall clock instead, and every analytics pass aborts
 * the one before it, so a pass slower than the interval could never deliver:
 * the client threw the answer away while the queries behind it kept running to
 * their statement timeout. Twelve passes could be in flight against one viewer.
 * Rearming on settle keeps that at one, and a pass that is slower than the
 * interval simply polls less often.
 */
export function createPollScheduler(
  task: () => Promise<void>,
  intervalMs: number
): PollScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = true;

  const stop = (): void => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const tick = (): void => {
    timer = null;
    task()
      .catch(() => {
        /* the caller surfaces its own errors */
      })
      .finally(() => {
        if (!stopped) {
          timer = setTimeout(tick, intervalMs);
        }
      });
  };

  const start = (): void => {
    stop();
    stopped = false;
    timer = setTimeout(tick, intervalMs);
  };

  return { start, stop };
}
