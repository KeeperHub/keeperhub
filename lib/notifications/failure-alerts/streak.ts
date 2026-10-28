import { isFundingShortfall } from "@/lib/errors/funding-shortfall";

/**
 * Failing-streak rules:
 * - error counts; success ends the streak.
 * - Every other status is stepped over (system_error pages our on-call, not owners).
 * - Unfinished runs are stepped over until the reconciler settles them.
 * - Runs started by hand never count: the person saw the result.
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

/** "manual" also covers API calls; only a browser session is a person. */
export function isAutomatedRun(
  run: Pick<StreakRun, "triggerSource" | "credentialType">
): boolean {
  if (run.triggerSource !== "manual") {
    return true;
  }
  return Boolean(run.credentialType && run.credentialType !== "session");
}

type StreakSummary = {
  /** Consecutive automated failures, newest first, since the last success. */
  failures: number;
  firstFailedAt: Date | null;
  lastFailedAt: Date | null;
  lastFailedRunId: string | null;
  lastError: string | null;
  /** The newest automated success, when it is newer than every failure. */
  latestSuccessRunId: string | null;
  /** The window held only failures, so the streak may be longer than counted. */
  truncated: boolean;
  /** Newest failures in a row that were the wallet unable to pay. */
  outOfFunds: number;
};

/** Our pre-send balance check, e.g. "Insufficient ETH balance. Have: 0.0004, Need: 0.0006". */
const PREFLIGHT_SHORTFALL = /Insufficient \S+ balance\. Have:/;

/** The chain or our pre-send check refused it: the wallet holds less than this run needs. */
export function isOutOfFunds(error: string | null): boolean {
  return Boolean(
    error && (isFundingShortfall(error) || PREFLIGHT_SHORTFALL.test(error))
  );
}

/** Two shortfalls in a row alert at once: waiting for more only burns runs. */
export const OUT_OF_FUNDS_THRESHOLD = 2;

/** Summarise the current streak; `countingSince` keeps old history from alerting. */
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
    outOfFunds: 0,
  };
  let fundingRun = true;

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
    fundingRun = fundingRun && isOutOfFunds(run.error);
    if (fundingRun) {
      summary.outOfFunds += 1;
    }
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

type StreakDecision =
  | { kind: "none" }
  | { kind: "open"; by: "count" | "time" | "funding" }
  | { kind: "resolve" }
  | { kind: "recheck"; at: Date };

/** What the evaluator should do, given the streak and any open incident. */
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
  if (summary.outOfFunds >= OUT_OF_FUNDS_THRESHOLD) {
    return { kind: "open", by: "funding" };
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
