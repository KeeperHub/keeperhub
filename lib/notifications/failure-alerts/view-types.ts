/**
 * The shapes the failure-notification API returns, importable from the
 * browser. The server modules that build them carry "server-only".
 */
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
  customWorkflows: { id: string; name: string }[];
  /** Workflows with an open failure incident right now. */
  failingNow: {
    workflowId: string;
    name: string;
    failureCount: number;
    openedAt: string;
  }[];
  /**
   * The viewer's own connections that are not shared with the org: shown
   * greyed out, so a missing connection is explained rather than invisible.
   */
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
  >;
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
      /** When this incident last turned the workflow off, if it did. */
      workflowPausedAt: string | null;
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
      /**
       * A saved channel. When set, its stored connection and destination are
       * tested and its health is updated; the two fields above are ignored.
       */
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
    reminder: "Reminder",
    recovery: "Running again",
    channel_paused: "Channel stopped working",
    launch_notice: "Notifications turned on",
  };

/** Which channel a pause notice is about, or why a backup was sent. */
export function historyNote(
  context: Record<string, unknown> | null
): string | null {
  if (typeof context?.channelLabel === "string") {
    return context.channelLabel;
  }
  if (typeof context?.backupReason === "string") {
    return `Sent because ${context.backupReason}`;
  }
  return null;
}
