/**
 * Which runs count toward a failing streak, as pure functions so the rules can
 * be tested as a table.
 *
 * - error counts.
 * - success ends the streak.
 * - Everything else is stepped over: it neither counts nor resets. That covers
 *   runs refused before they started (skipped), cancelled runs, runs not
 *   finished yet (pending, running, phantom, unconfirmed until the reconciler
 *   settles them) and platform errors (system_error), which are ours to fix
 *   and page our own on-call instead of every owner at once.
 * - A run someone started by hand never counts either way: they saw the
 *   result, and a test press on a broken workflow must not hide the streak.
 */

export type StreakRun = {
  id: string;
  status: string;
  triggerSource: string | null;
  credentialType: string | null;
  startedAt: Date;
  completedAt: Date | null;
  error: string | null;
};

/**
 * Whether a run started on its own, rather than by a person pressing Run.
 *
 * `trigger_source` is "manual" both for the Run button and for an API call
 * that sent no trigger header, and an API call is automation. The credential
 * type tells them apart: only a browser session is a person.
 */
export function isAutomatedRun(
  run: Pick<StreakRun, "triggerSource" | "credentialType">
): boolean {
  if (run.triggerSource !== "manual") {
    return true;
  }
  return Boolean(run.credentialType && run.credentialType !== "session");
}

export type StreakSummary = {
  /** Consecutive automated failures, newest first, since the last success. */
  failures: number;
  firstFailedAt: Date | null;
  lastFailedAt: Date | null;
  lastFailedRunId: string | null;
  lastError: string | null;
  /** The newest automated success, when it is newer than every failure. */
  latestSuccessRunId: string | null;
  /**
   * True when the window held only failures, so the streak may be longer than
   * counted. Enough to decide "at or over the threshold".
   */
  truncated: boolean;
};

/**
 * Walk runs newest first and summarise the current streak.
 *
 * `countingSince` drops runs that finished before the organization started
 * counting, so switching the feature on never alerts on old history.
 */
export function summarizeStreak(
  runsNewestFirst: readonly StreakRun[],
  countingSince: Date | null,
  windowSize: number
): StreakSummary {
  const summary: StreakSummary = {
    failures: 0,
    firstFailedAt: null,
    lastFailedAt: null,
    lastFailedRunId: null,
    lastError: null,
    latestSuccessRunId: null,
    truncated: false,
  };

  let ended = false;
  for (const run of runsNewestFirst) {
    const finishedAt = run.completedAt ?? run.startedAt;
    if (countingSince && finishedAt < countingSince) {
      ended = true;
      break;
    }
    if (!isAutomatedRun(run)) {
      continue;
    }
    if (run.status === "success") {
      if (summary.failures === 0) {
        summary.latestSuccessRunId = run.id;
      }
      ended = true;
      break;
    }
    if (run.status !== "error") {
      continue;
    }
    summary.failures += 1;
    if (summary.lastFailedAt === null) {
      summary.lastFailedAt = finishedAt;
      summary.lastFailedRunId = run.id;
      summary.lastError = run.error;
    }
    summary.firstFailedAt = run.startedAt;
  }

  summary.truncated =
    !ended && runsNewestFirst.length >= windowSize && summary.failures > 0;
  return summary;
}

export type StreakDecision =
  | { kind: "none" }
  | { kind: "open"; by: "count" | "time" }
  | { kind: "resolve" }
  | { kind: "recheck"; at: Date };

/**
 * What the evaluator should do with a workflow, given its streak and whether
 * an incident is already open.
 */
export function decide(params: {
  summary: StreakSummary;
  threshold: number;
  timeLimitMinutes: number | null;
  hasOpenIncident: boolean;
  now: Date;
}): StreakDecision {
  const { summary, threshold, timeLimitMinutes, hasOpenIncident, now } = params;

  if (summary.failures === 0) {
    return hasOpenIncident && summary.latestSuccessRunId
      ? { kind: "resolve" }
      : { kind: "none" };
  }
  if (hasOpenIncident) {
    return { kind: "none" };
  }
  if (summary.failures >= threshold) {
    return { kind: "open", by: "count" };
  }
  if (timeLimitMinutes && summary.firstFailedAt) {
    const dueAt = new Date(
      summary.firstFailedAt.getTime() + timeLimitMinutes * 60 * 1000
    );
    return dueAt <= now
      ? { kind: "open", by: "time" }
      : { kind: "recheck", at: dueAt };
  }
  return { kind: "none" };
}
