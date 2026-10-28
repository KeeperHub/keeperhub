// API response shapes, kept here so the browser can import them (builders are server-only).
import type {
  FailureAlertChannelKind,
  FailureAlertChannelRole,
  FailureAlertMessageKind,
} from "@/lib/db/schema-failure-alerts";

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
    /** "missed": a scheduled run did not start; dueAt is when it was due. */
    openedBy: "count" | "time" | "missed" | "funding";
    dueAt: string;
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
      openedBy: "count" | "time" | "missed" | "funding";
      /** First failure, or when the missed run was due. */
      since: string;
      /** When this incident last turned the workflow off, if it did. */
      workflowPausedAt: string | null;
      /** When someone last turned it back on after that. */
      workflowResumedAt: string | null;
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

/** Which channel a pause notice is about, why a backup was sent, or a workflow pause. */
export function historyNote(
  context: Record<string, unknown> | null
): string | null {
  if (typeof context?.channelLabel === "string") {
    return context.channelLabel;
  }
  const notes: string[] = [];
  if (context?.pausedAgain === true) {
    notes.push("Paused the workflow again after it was turned back on");
  } else if (context?.workflowPaused === true) {
    notes.push("Paused the workflow");
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
