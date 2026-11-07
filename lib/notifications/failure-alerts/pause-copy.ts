import { MAX_PAUSE_DAYS } from "./constants";

// One wording for pausing alerts, org-wide or for one workflow, on every surface.
// A workflow pause stops its alerts, never the workflow: say "its alerts".

type PauseScope = "org" | "workflow";

export const PAUSE_ALERTS = "Pause alerts";
export const RESUME_ALERTS = "Resume alerts";
export const RESUMING_ALERTS = "Resuming...";
export const PAUSE_SUBMIT = "Pause and notify";
export const CHANGE_PAUSE = "Change or extend the pause";
export const PAUSE_FOR = "Pause alerts for";
export const PAUSE_UNTIL = "Pause until";
export const PAUSED = "Paused";
export const ALERTS_PAUSED = "Alerts paused";
export const ORG_ALERTS_PAUSED = "Alerts are paused for the whole organization";
export const ORG_ALERTS_RESUMED = "Alerts resumed for the whole organization";
export const PAUSE_MAX = `A pause lasts at most ${MAX_PAUSE_DAYS} days.`;
export const RESUMED_TOAST =
  "Alerts resumed. Everyone who was told of the pause is told it ended.";
export const PAUSED_TOAST =
  "Alerts paused. Everyone who gets this workflow's alerts, and every owner, was told.";
export const PAUSE_CHANGED_TOAST =
  "Pause changed. Everyone who gets this workflow's alerts, and every owner, was told.";

/** Headlines of a workflow's pause notices; its name follows. */
export const PAUSE_HEADLINE = {
  paused: ALERTS_PAUSED,
  changed: "Alerts pause changed",
  resumed: "Alerts resumed",
  ended: "Alerts pause ended",
} as const;

/** History labels: each scope its own, so the What filter tells them apart. */
export const PAUSE_KIND_LABEL = {
  orgPaused: "All alerts paused",
  orgResumed: "All alerts resumed",
  workflowPaused: "Workflow alerts paused",
  workflowResumed: "Workflow alerts resumed",
  workflowEnded: "Workflow alerts pause ended",
} as const;

/** What a pause does, without the closing period. */
export function pauseEffect(scope: PauseScope): string {
  return scope === "org"
    ? "Workflows keep running, but if one fails, no alert goes out"
    : "This workflow keeps running, but if it fails, no alert goes out";
}

/** "Paused by Dana" on the org card; "Alerts paused by Dana" beside a workflow. */
export function pausedBy(who: string | null, scope: PauseScope): string {
  const label = scope === "org" ? PAUSED : ALERTS_PAUSED;
  return who ? `${label} by ${who}` : label;
}
