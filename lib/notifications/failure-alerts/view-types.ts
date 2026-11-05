// API response shapes, kept here so the browser can import them (builders are server-only).
import type {
  FailureAlertChannelKind,
  FailureAlertChannelRole,
  FailureAlertMessageKind,
  FailureIncidentTrigger,
} from "@/lib/db/schema-failure-alerts";
import { SKIP_REASON } from "./stored-reasons";

export type ChannelView = {
  id: string;
  kind: FailureAlertChannelKind;
  integrationId: string;
  connectionName: string | null;
  destination: string;
  role: FailureAlertChannelRole;
  pausedAt: string | null;
  pausedReason: string | null;
  lastDeliveredAt: string | null;
  lastFailedAt: string | null;
  lastError: string | null;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  /** Last daily silent check. */
  lastHealthCheckAt: string | null;
  /** The connection was deleted or is no longer shared: it cannot send. */
  connectionMissing: boolean;
};

export type MemberView = {
  userId: string;
  role: string;
  email: string | null;
  name: string | null;
  /** False for wallet-only and unverified accounts: mail cannot reach them. */
  reachable: boolean;
};

export type ConnectionView = {
  id: string;
  name: string;
  kind: FailureAlertChannelKind;
};

export type OrgSettingsView = {
  enabled: boolean;
  isDefault: boolean;
  threshold: number;
  timeLimitMinutes: number | null;
  remindDaily: boolean;
  notifyRecovery: boolean;
  /** Explicit list, or the owners when nobody chose. */
  recipientUserIds: string[];
  recipientsAreDefault: boolean;
  members: MemberView[];
  channels: ChannelView[];
  connections: ConnectionView[];
  emailUsage: { used: number; limit: number } | null;
  /** Workflows with their own settings, so mutes and overrides are visible to the team. */
  customWorkflows: {
    id: string;
    name: string;
    mutedUntil: string | null;
    muteUntilSuccess: boolean;
    threshold: number | null;
    customRecipients: boolean;
    customChannels: boolean;
    pauseWorkflow: boolean;
  }[];
  /** Last alert of any kind delivered to anyone, for "it works" proof. */
  lastAlertDeliveredAt: string | null;
  /** Send back on save; a stale one is refused with 409. */
  version: number;
  /** Org-wide pause: no alerts until `until`. */
  pause: { until: string; reason: string | null; by: string | null } | null;
  /** Workflows with an open failure incident right now. */
  failingNow: {
    workflowId: string;
    name: string;
    failureCount: number;
    openedAt: string;
    /** "missed": a scheduled run did not start, dueAt is when it was due; "refused": runs refused before they start. */
    openedBy: FailureIncidentTrigger;
    dueAt: string;
    /** Not running because its runs are refused before they start. */
    refused: boolean;
    /** The refusal's reason as shown; null when not refused or none was recorded. */
    refusedReason: string | null;
  }[];
  /** The viewer's unshared connections, greyed out to explain why they are missing. */
  unsharedConnections: ConnectionView[];
  /** Nobody can be emailed and no chat or PagerDuty channel works. */
  unreachable: boolean;
};

export type HistoryEntry = {
  id: string;
  createdAt: string;
  deliveredAt: string | null;
  kind: string;
  channel: string;
  recipient: string;
  connectionName: string | null;
  isBackup: boolean;
  state: string;
  attempts: number;
  lastStatus: number | null;
  lastError: string | null;
  /** When a queued row is next tried: later than now for a held recovery. */
  nextAttemptAt: string;
  /** Which channel a pause notice is about, or why a backup was sent. */
  note: string | null;
  workflows: { id: string; name: string }[];
};

export type WorkflowAlertView = {
  workflowId: string;
  organizationId: string;
  /** False for a workflow that only runs by hand. */
  applies: boolean;
  triggerType: string | null;
  enabled: boolean;
  org: Pick<
    OrgSettingsView,
    | "threshold"
    | "timeLimitMinutes"
    | "recipientUserIds"
    | "channels"
    | "unreachable"
    | "emailUsage"
    | "pause"
  >;
  /** Send back on save; a stale one is refused with 409. */
  version: number;
  override: {
    threshold: number | null;
    timeLimitMinutes: number | null;
    recipientUserIds: string[] | null;
    customChannels: boolean;
    channels: ChannelView[];
    mutedUntil: string | null;
    muteUntilSuccess: boolean;
    muteReason: string | null;
    mutedBy: string | null;
    /** Turn the workflow off when its alert goes out. Workflow-only. */
    pauseWorkflow: boolean;
  };
  effective: {
    threshold: number;
    timeLimitMinutes: number | null;
    emails: string[];
    channels: ChannelView[];
    source: "default" | "org" | "custom";
  };
  status: {
    failures: number;
    firstFailedAt: string | null;
    lastError: string | null;
    incident: {
      openedAt: string;
      failureCount: number;
      /** The rule in force when it opened, which may since have changed. */
      threshold: number;
      lastNotifiedAt: string;
      deliveredTo: string[];
      openedBy: FailureIncidentTrigger;
      /** First failure, or when the missed run was due. */
      since: string;
      /** When this incident last turned the workflow off, if it did. */
      workflowPausedAt: string | null;
      /** When someone last turned it back on after that. */
      workflowResumedAt: string | null;
      /** Not running because its runs are refused before they start. */
      refused: boolean;
      /** The refusal's reason as shown; null when not refused or none was recorded. */
      refusedReason: string | null;
      /** A "refused" incident's newest refusal. */
      lastRefusedAt: string | null;
      /** Told in the alert of another workflow refused for the same reason. */
      reportedWithOthers: boolean;
    } | null;
  };
  members: MemberView[];
  connections: ConnectionView[];
};

/** What a Test button asks for. */
export type TestRequest =
  | {
      channel: "email";
      to: "me" | "recipients";
      recipientUserIds?: string[];
    }
  | {
      channel: FailureAlertChannelKind;
      integrationId: string;
      destination: string;
      /** A saved channel: tests its stored values and ignores the fields above. */
      channelId?: string;
      /** PagerDuty: "change" pages nobody; "page" opens and resolves one. */
      pagerDutyMode?: "change" | "page";
    };

/** What a Test button gets back. */
export type TestResult = {
  delivered: boolean;
  classification: "ok" | "transient" | "permanent";
  status?: number;
  message: string;
  durationMs: number;
  recipients?: string[];
};

export const CHANNEL_LABEL: Record<FailureAlertChannelKind | "email", string> =
  {
    email: "Email",
    slack: "Slack",
    discord: "Discord",
    telegram: "Telegram",
    pagerduty: "PagerDuty",
  };

/** "Slack #ops", "Discord Origin alerts", "PagerDuty PABC123". */
export function channelLabel(
  kind: string,
  destination: string,
  connectionName?: string | null
): string {
  const name = CHANNEL_LABEL[kind as keyof typeof CHANNEL_LABEL] ?? kind;
  const where = kind === "discord" ? connectionName : destination;
  return where ? `${name} ${where}` : name;
}

/** A method as people name it: the connection as title, where it sends as subline. */
export function methodName(
  kind: string,
  destination: string,
  connectionName?: string | null
): { title: string; target: string } {
  const kindLabel = CHANNEL_LABEL[kind as keyof typeof CHANNEL_LABEL] ?? kind;
  const target =
    kind === "discord" ? kindLabel : channelLabel(kind, destination);
  return { title: connectionName || kindLabel, target };
}

/** One-line form: "Keeper bot (Telegram -100123)", "Origin alerts (Discord)". */
export function methodText(
  kind: string,
  destination: string,
  connectionName?: string | null
): string {
  if (!connectionName) {
    return channelLabel(kind, destination, connectionName);
  }
  const { title, target } = methodName(kind, destination, connectionName);
  return `${title} (${target})`;
}

/** Free plan: the last emails of the month go only to alerts about new failures. */
export const EMAILS_KEPT_FOR_NEW_FAILURES = 10;

/** What still happens during an org pause, for the pause email and the Alerts page. */
export function orgPauseEffect(pausingWorkflows: number | undefined): string {
  if (pausingWorkflows === 0) {
    return "Workflows keep running; failures are not reported until then.";
  }
  let which =
    "any set to turn off at their limit still turn off; you are told about those";
  if (pausingWorkflows === 1) {
    which =
      "the 1 set to turn off at its limit still turns off; you are told about it";
  } else if (pausingWorkflows !== undefined) {
    which = `the ${pausingWorkflows} set to turn off at their limit still turn off; you are told about those`;
  }
  return `Failures are not reported until then. Workflows keep running, but ${which} when the pause ends.`;
}

/** What each kind of message is called in the history and analytics lists. */
export const FAILURE_ALERT_KIND_LABEL: Record<FailureAlertMessageKind, string> =
  {
    alert: "Alert",
    reminder: "Still failing",
    recovery: "Recovered",
    channel_paused: "Method paused",
    launch_notice: "Alerts turned on",
    alerts_paused: "Alerts paused",
    alerts_resumed: "Alerts back on",
    cap_warning: "Email limit warning",
  };

/** Which channel a pause notice is about, why a backup was sent, or a workflow turned off. */
export function historyNote(
  context: Record<string, unknown> | null
): string | null {
  if (typeof context?.channelLabel === "string") {
    return context.channelLabel;
  }
  const notes: string[] = [];
  if (context?.pausedAgain === true) {
    notes.push("Turned the workflow off again after it was turned back on");
  } else if (context?.workflowPaused === true) {
    notes.push("Turned the workflow off");
  }
  if (typeof context?.backupReason === "string") {
    notes.push(`Sent because ${context.backupReason}`);
  }
  return notes.length > 0 ? notes.join(". ") : null;
}

/** One example message as each channel shows it. */
export type MessagePreview = {
  sample: "alert" | "missed" | "paused" | "recovery";
  subject: string;
  html: string;
  /** Slack, Discord and Telegram. */
  chat: string;
  pagerDutySummary: string;
};

/** A not-running incident opened while its runs were refused before they start; lastError holds the reason. */
export function isRefusedIncident(incident: {
  openedBy: string;
  lastFailedExecutionId: string | null;
}): boolean {
  return (
    incident.openedBy === "refused" ||
    (incident.openedBy === "missed" && incident.lastFailedExecutionId !== null)
  );
}

/** Not running, rather than failing: a schedule that did not start, or runs refused before they start. */
export function isNotRunning(
  openedBy: FailureIncidentTrigger | undefined
): boolean {
  return openedBy === "missed" || openedBy === "refused";
}

/** "its scheduled runs are being refused before they start"; an event workflow has no schedule. */
export function refusedLead(
  openedBy: FailureIncidentTrigger | undefined
): string {
  return `its ${openedBy === "refused" ? "" : "scheduled "}runs are being refused before they start`;
}

const SKIPPED_PREFIX = /^Execution skipped:\s*/i;
/** The executor's "workflow is not executable (<code>)" codes, in plain words. */
const NOT_EXECUTABLE_WORDS: Record<string, string> = {
  deleted: "the workflow is deleted",
  deactivated: "the workflow is deactivated",
  org_deactivated: "the organization is deactivated",
  halted: "the organization's circuit breaker is engaged",
  disabled: "the workflow is turned off",
  anonymous_owner: "the owner has no account",
};
const NOT_EXECUTABLE_CODE = /not executable \((\w+)\)/;

/** A stored refusal as shown: no "Execution skipped:" prefix, executor codes in plain words. */
export function shownRefusal(reason: string): string {
  return reason
    .replace(SKIPPED_PREFIX, "")
    .replace(
      NOT_EXECUTABLE_CODE,
      (_match, code: string) =>
        `not executable (${NOT_EXECUTABLE_WORDS[code] ?? code})`
    );
}

/** What a plan or billing refusal asks for: a paid feature, a run limit, or billing. */
export type PlanRefusal = "feature" | "limit" | "billing";

const PAID_FEATURE = /require a paid plan/i;
const RUN_LIMIT = /execution limit|run limit/i;

export function planRefusalOf(reason: string | null): PlanRefusal {
  if (reason && PAID_FEATURE.test(reason)) {
    return "feature";
  }
  return reason && RUN_LIMIT.test(reason) ? "limit" : "billing";
}

/** Deactivated by our team: it does not come back on its own. */
export function refusalStaysOff(reason: string | null): boolean {
  const code = reason?.match(NOT_EXECUTABLE_CODE)?.[1];
  return code === "deactivated" || code === "org_deactivated";
}

/** A refused incident's reason as shown, or null (not refused, or none recorded). */
export function refusedReasonOf(incident: {
  openedBy: string;
  lastFailedExecutionId: string | null;
  lastError: string | null;
}): string | null {
  return isRefusedIncident(incident) && incident.lastError
    ? shownRefusal(incident.lastError)
    : null;
}

/** True for a row the outbox dropped as too old, rather than withdrew. */
export function wasDropped(state: string, lastError: string | null): boolean {
  return state === "skipped" && lastError === SKIP_REASON.stale;
}

/** One word per delivery state, the same in history, analytics and emails. */
export const DELIVERY_STATE_LABEL: Record<string, string> = {
  pending: "Queued",
  sending: "Sending",
  retrying: "Retrying",
  delivered: "Delivered",
  failed: "Not delivered",
  capped: "Over the monthly email limit",
  skipped: "Withdrawn",
};
