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
  // Every stop and start opens a new generation. A pass that settles after one
  // of those belongs to a chain nobody is waiting for, and a plain boolean let
  // it arm a timer that overwrote the handle the new chain had just stored:
  // both chains then ran forever and only one of them could be stopped.
  let generation = 0;

  const stop = (): void => {
    generation += 1;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const start = (): void => {
    stop();
    const chain = generation;

    const tick = (): void => {
      timer = null;
      task()
        .catch(() => {
          /* the caller surfaces its own errors */
        })
        .finally(() => {
          if (chain === generation) {
            timer = setTimeout(tick, intervalMs);
          }
        });
    };

    timer = setTimeout(tick, intervalMs);
  };

  return { start, stop };
}
