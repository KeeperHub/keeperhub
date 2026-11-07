import { MAX_PAUSE_DAYS } from "./constants";

// One wording for pausing alerts, org-wide or for one workflow, on every surface.

type PauseScope = "org" | "workflow";

export const PAUSE_ALERTS = "Pause alerts";
export const RESUME_ALERTS = "Resume alerts";
export const RESUMING_ALERTS = "Resuming...";
export const PAUSE_SUBMIT = "Pause and notify";
export const CHANGE_PAUSE = "Change or extend the pause";
export const PAUSE_FOR = "Pause alerts for";
export const PAUSE_UNTIL = "Pause until";
export const PAUSED = "Paused";
export const PAUSE_MAX = `A pause lasts at most ${MAX_PAUSE_DAYS} days.`;
export const RESUMED_TOAST =
  "Alerts resumed. Everyone who was told of the pause is told it ended.";
export const PAUSED_TOAST =
  "Alerts paused. Everyone who gets this workflow's alerts was told.";

/** Headlines of the pause notices, also the history labels. */
export const PAUSE_HEADLINE = {
  paused: "Alerts paused",
  changed: "Pause changed",
  resumed: "Alerts resumed",
  ended: "Pause ended",
} as const;

/** What a pause does, without the closing period. */
export function pauseEffect(scope: PauseScope): string {
  return scope === "org"
    ? "Workflows keep running, but if one fails, no alert goes out"
    : "This workflow keeps running, but if it fails, no alert goes out";
}

/** "Alerts are paused for the whole organization", or "for this workflow". */
export function pausedFor(scope: PauseScope): string {
  return `Alerts are paused for ${scope === "org" ? "the whole organization" : "this workflow"}`;
}

/** "Paused by Dana (dana@x.com)", or "Paused" when nobody is named. */
export function pausedBy(who: string | null): string {
  return who ? `${PAUSED} by ${who}` : PAUSED;
}
