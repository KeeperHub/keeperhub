import { channelLabel } from "@/lib/notifications/failure-alerts/view-types";

/** "1 failed run" / "5 failed runs", worded the same everywhere in the feature. */
export function failedRuns(count: number): string {
  return `${count} failed run${count === 1 ? "" : "s"}`;
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
function joinList(items: string[]): string {
  if (items.length <= 1) {
    return items.join("");
  }
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

const MAX_TARGET = 24;

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
  const subject =
    input.scope === "org"
      ? "If a workflow that runs on its own fails"
      : "If this workflow fails";
  const count = `${input.threshold} time${input.threshold === 1 ? "" : "s"} in a row${
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
    truncateMiddle(channelLabel(c.kind, c.destination, c.connectionName));
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

  let sentence = `${subject} ${count}, KeeperHub tells ${who}${backupPart}.`;
  if (input.pauseWorkflow) {
    sentence += " Then KeeperHub turns this workflow off.";
  }
  if (input.scope === "org") {
    sentence +=
      " Scheduled runs that do not start are reported too. Runs you start by hand never count.";
  }
  return sentence;
}
