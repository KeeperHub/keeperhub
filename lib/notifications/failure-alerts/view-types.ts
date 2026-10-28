/**
 * The shapes the failure-notification API returns, importable from the
 * browser. The server modules that build them carry "server-only".
 */
import type {
  FailureAlertChannelKind,
  FailureAlertChannelRole,
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
      lastNotifiedAt: string;
      deliveredTo: string[];
    } | null;
  };
  members: MemberView[];
  connections: ConnectionView[];
};
