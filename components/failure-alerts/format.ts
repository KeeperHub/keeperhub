import type { FailureIncidentTrigger } from "@/lib/db/schema-failure-alerts";
import {
  DELIVERY_STATE_LABEL,
  type HistoryEntry,
  isNotRunning,
  methodText,
  refusedLead,
  type WorkflowAlertView,
  wasDropped,
} from "@/lib/notifications/failure-alerts/view-types";

/** "1 failed run" / "5 failed runs", worded the same everywhere in the feature. */
export function failedRuns(count: number): string {
  return `${count} failed run${count === 1 ? "" : "s"}`;
}

/** A not-running incident: refused runs (a plan limit, unpaid) say so; else when it was due. */
export function notRunningText(
  dueAt: string,
  refused: boolean,
  openedBy: FailureIncidentTrigger
): string {
  return refused
    ? `Not running: ${refusedLead(openedBy)}`
    : `Did not run at ${formatWhen(dueAt)}`;
}

/** The workflow panel's incident heading. */
export function incidentTitle(
  incident: Pick<
    NonNullable<WorkflowAlertView["status"]["incident"]>,
    "openedBy" | "since" | "failureCount" | "refused"
  >,
  pausedByAlert: boolean
): string {
  if (isNotRunning(incident.openedBy)) {
    return notRunningText(incident.since, incident.refused, incident.openedBy);
  }
  const runs = `${failedRuns(incident.failureCount)} in a row`;
  if (incident.openedBy === "funding") {
    return pausedByAlert
      ? `Turned off: wallet out of funds, ${runs}`
      : `Wallet out of funds: ${runs}`;
  }
  return pausedByAlert ? `Turned off after ${runs}` : `Failing: ${runs}`;
}

/**
 * One absolute date for the history and the mute line: with the viewer's time
 * zone, and the year only when it is not this year.
 */
export function formatWhen(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString(undefined, {
    year:
      date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

/** A coming time in the viewer's zone: "14:05 GMT+2", with the date when not today. */
export function formatSoon(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (date.toDateString() !== now.toDateString()) {
    return formatWhen(iso);
  }
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

export type DeliveryTone = "delivered" | "failed" | "waiting" | "muted";

/** A history row's outcome: a held row says when it goes, a dropped one reads as not delivered. */
export function deliveryStatus(
  entry: Pick<HistoryEntry, "state" | "kind" | "lastError" | "nextAttemptAt">,
  now: Date = new Date()
): { label: string; tone: DeliveryTone } {
  const { state } = entry;
  if (wasDropped(state, entry.lastError)) {
    return { label: DELIVERY_STATE_LABEL.failed, tone: "failed" };
  }
  if (state === "pending" && new Date(entry.nextAttemptAt) > now) {
    const at = formatSoon(entry.nextAttemptAt, now);
    return {
      label:
        entry.kind === "recovery"
          ? `Sends at ${at} if it keeps working`
          : `Scheduled for ${at}`,
      tone: "waiting",
    };
  }
  const label = DELIVERY_STATE_LABEL[state] ?? state;
  if (state === "delivered") {
    return { label, tone: "delivered" };
  }
  if (state === "failed" || state === "capped") {
    return { label, tone: "failed" };
  }
  if (state === "retrying" || state === "pending" || state === "sending") {
    return { label, tone: "waiting" };
  }
  return { label, tone: "muted" };
}

/** Out-of-funds alerts skip the limit; said on the Rules card and in each workflow. */
export const FUNDS_RULE =
  "Wallet out of funds alerts go out after 2 failed runs, whatever the limit.";

/** A date as a datetime-local input holds it, in the viewer's time zone. */
export function toLocalInput(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const TIME_LIMIT_LABEL: Record<number, string> = {
  60: "1 hour",
  360: "6 hours",
  1440: "24 hours",
};

/** "6 hours", for the "or keeps failing for" rule. */
export function timeLimitLabel(minutes: number): string {
  return TIME_LIMIT_LABEL[minutes] ?? `${minutes} minutes`;
}

/** "a", "a and b", "a, b and c". */
export function joinList(items: string[]): string {
  if (items.length <= 1) {
    return items.join("");
  }
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

const MAX_TARGET = 18;

function truncateMiddle(value: string): string {
  if (value.length <= MAX_TARGET) {
    return value;
  }
  const keep = Math.floor((MAX_TARGET - 2) / 2);
  return `${value.slice(0, keep)}..${value.slice(-keep)}`;
}

export type RuleChannel = {
  kind: string;
  destination: string;
  connectionName: string | null;
  role: "always" | "backup";
  pausedAt: string | null;
  connectionMissing?: boolean;
};

/** The rule in force as one sentence, for the Alerts page and a workflow's panel. */
export function describeRule(input: {
  threshold: number;
  timeLimitMinutes: number | null;
  /** Reachable recipients only. */
  emails: string[];
  viewerEmail?: string | null;
  channels: RuleChannel[];
  pauseWorkflow?: boolean;
  scope: "org" | "workflow";
}): string {
  // The org page shows its limits under Rules, so its sentence names no numbers.
  const when =
    input.scope === "org"
      ? "If a workflow that runs on its own keeps failing"
      : `If this workflow fails ${input.threshold} time${input.threshold === 1 ? "" : "s"} in a row${
          input.timeLimitMinutes
            ? ` or keeps failing for ${timeLimitLabel(input.timeLimitMinutes)}`
            : ""
        }`;

  let emailPart: string | null = null;
  if (input.emails.length === 1) {
    const [only] = input.emails;
    emailPart = `${only === input.viewerEmail ? "you" : only} by email`;
  } else if (input.emails.length > 1 && input.emails.length <= 3) {
    emailPart = `${joinList(input.emails)} by email`;
  } else if (input.emails.length > 3) {
    emailPart = `${input.emails.length} people by email`;
  }

  const live = input.channels.filter(
    (c) => !(c.pausedAt || c.connectionMissing)
  );
  const name = (c: RuleChannel): string =>
    methodText(
      c.kind,
      truncateMiddle(c.destination),
      c.connectionName && truncateMiddle(c.connectionName)
    );
  const always = live.filter((c) => c.role === "always").map(name);
  const backups = live.filter((c) => c.role === "backup").map(name);
  const targets = [emailPart, ...always].filter((t): t is string => t !== null);

  let who = "nobody: no method can reach anyone";
  let backupPart = "";
  if (targets.length > 0) {
    who = joinList(targets);
    if (backups.length > 0) {
      backupPart = `, with ${joinList(backups)} as ${backups.length === 1 ? "a backup" : "backups"}`;
    }
  } else if (backups.length > 0) {
    who = joinList(backups);
  }

  let sentence = `${when}, KeeperHub tells ${who}${backupPart}.`;
  if (input.pauseWorkflow) {
    const runs =
      input.threshold === 1
        ? failedRuns(1)
        : `${failedRuns(input.threshold)} in a row`;
    sentence += ` KeeperHub turns this workflow off only after ${runs} or when its wallet runs out of funds.`;
  }
  if (input.scope === "org") {
    sentence +=
      " Scheduled runs that do not start are reported too. Runs you start by hand never count.";
  }
  return sentence;
}
