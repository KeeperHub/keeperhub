export type LeadingDebounce = {
  call: () => void;
  cancel: () => void;
};

/**
 * Runs `task` at once on the first call, then at most once per window.
 *
 * The stream emits a run event per run, and each one triggered a full refresh
 * that aborts the refresh before it. An organization that starts runs faster
 * than a refresh completes therefore cancelled every refresh but the last while
 * still paying for the queries behind all of them.
 *
 * Leading edge keeps an idle dashboard instant, which is what a viewer watching
 * for one run expects. Only a burst is grouped, and the refresh reads the whole
 * window rather than a delta, so grouping loses no run.
 */
export function createLeadingDebounce(
  task: () => Promise<void>,
  windowMs: number,
  now: () => number = Date.now
): LeadingDebounce {
  let lastRunAt = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const run = (): void => {
    lastRunAt = now();
    task().catch(() => {
      /* the caller surfaces its own errors */
    });
  };

  const call = (): void => {
    const elapsed = now() - lastRunAt;
    if (elapsed >= windowMs) {
      cancel();
      run();
      return;
    }
    // A trailing run is already booked, so this event joins it.
    if (timer) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      run();
    }, windowMs - elapsed);
  };

  return { call, cancel };
}
