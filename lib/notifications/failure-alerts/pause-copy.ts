import { MAX_PAUSE_DAYS } from "./constants";

// One wording for pausing alerts, org-wide or for one workflow, on every surface.
// A workflow pause stops its alerts, never the workflow: say "its alerts".

type PauseScope = "org" | "workflow";

const TRAILING_DOTS = /\.+$/;

/** What a workflow pause save did, as the server reports it. */
export type PauseChange = "paused" | "changed" | "resumed" | null;

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
export const ORG_PAUSE_SCOPE =
  "Pauses alerts for every workflow in this organization.";
const RESUMED_TOAST =
  "This workflow's alerts resumed. Everyone who gets its alerts, and every owner, was told.";
const PAUSED_TOAST =
  "Alerts paused. Everyone who gets this workflow's alerts, and every owner, was told.";
const PAUSE_UNCHANGED_TOAST =
  "Saved. The pause did not change, so nobody was told.";
const ALREADY_RESUMED_TOAST = "This workflow's alerts were already back on.";
const PAUSE_CHANGED_TOAST =
  "Pause changed. Everyone who gets this workflow's alerts, and every owner, was told.";

/** Headlines of a workflow's pause notices; its name follows. */
export const PAUSE_HEADLINE = {
  paused: ALERTS_PAUSED,
  changed: "Alerts pause changed",
  resumed: "Alerts resumed",
  ended: "Alerts pause ended",
} as const;

/** Short org-wide pause line, for the banner on small screens and the history. */
export const ORG_PAUSED_SHORT = "All alerts paused";

/** History labels: each scope its own, so the What filter tells them apart. */
export const PAUSE_KIND_LABEL = {
  orgPaused: ORG_PAUSED_SHORT,
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

/** The toast for a pause or resume, from what the server says changed. */
export function pauseToast(
  change: PauseChange | undefined,
  action: "pause" | "resume"
): string {
  if (change === "paused") {
    return PAUSED_TOAST;
  }
  if (change === "changed") {
    return PAUSE_CHANGED_TOAST;
  }
  if (change === "resumed") {
    return RESUMED_TOAST;
  }
  // Ended or resumed elsewhere first: the cycle or that resume tells people.
  return action === "resume" ? ALREADY_RESUMED_TOAST : PAUSE_UNCHANGED_TOAST;
}

/** ". Reason: X", ending the sentence before it; empty when there is no reason. */
export function reasonSentence(reason: string | null | undefined): string {
  const text = reason?.trim().replace(TRAILING_DOTS, "");
  return text ? `. Reason: ${text}` : "";
}

/** "Paused by Dana" on the org card; "Alerts paused by Dana" beside a workflow. */
export function pausedBy(who: string | null, scope: PauseScope): string {
  const label = scope === "org" ? PAUSED : ALERTS_PAUSED;
  return who ? `${label} by ${who}` : label;
}
