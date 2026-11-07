// API response shapes, kept here so the browser can import them (builders are server-only).

import { PAYG_BLOCK_MESSAGES } from "@/lib/billing/payg/errors";
import type {
  FailureAlertChannelKind,
  FailureAlertChannelRole,
  FailureAlertMessageKind,
  FailureIncidentTrigger,
} from "@/lib/db/schema-failure-alerts";
import {
  NOT_EXECUTABLE_CODE,
  type NotExecutableReason,
  refusalCannotRun,
} from "@/lib/workflow/not-executable";
import { PAUSE_KIND_LABEL, pauseEffect } from "./pause-copy";
import { SKIP_REASON } from "./stored-reasons";

export type ChannelView = {
  id: string;
  kind: FailureAlertChannelKind;
  integrationId: string;
  connectionName: string | null;
  destination: string;
  role: FailureAlertChannelRole;
  stoppedAt: string | null;
  stoppedReason: string | null;
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
  /** Workflows with their own settings, so pauses and overrides are visible to the team. */
  customWorkflows: {
    id: string;
    name: string;
    pausedUntil: string | null;
    pauseUntilSuccess: boolean;
    threshold: number | null;
    /** Null follows the org; 0 means off for this workflow. */
    timeLimitMinutes: number | null;
    customRecipients: boolean;
    customChannels: boolean;
    disableWorkflow: boolean;
    /** Its own methods that stopped working or lost their connection. */
    brokenMethods: number;
  }[];
  /** Last alert of any kind delivered to anyone, for "it works" proof. */
  lastAlertDeliveredAt: string | null;
  /** Send back on save; a stale one is refused with 409. */
  version: number;
  /** Org-wide pause: no alerts until `until`. */
  pause: {
    until: string;
    reason: string | null;
    by: string | null;
    /** The pauser's sign-in email or wallet address; never a step-up inbox. */
    byAccount: string | null;
  } | null;
  /** Every workflow whose alerts are paused right now, failing ones first. */
  alertsPausedWorkflows: {
    id: string;
    name: string;
    pausedUntil: string | null;
    untilItWorks: boolean;
    by: string | null;
    /** Sign-in email or wallet address of whoever paused; never a step-up inbox. */
    byAccount: string | null;
    reason: string | null;
    failing: boolean;
    /** Failed runs since the pause began. */
    failedRuns: number;
  }[];
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
  /** Which channel a stopped-method notice is about, a pause's reason, or why a backup was sent. */
  note: string | null;
  /** Who caused it: a person for a pause, resume or test, else KeeperHub. */
  by: string;
  /** The account that person signed in with: an email or a wallet address. */
  byAccount: string | null;
  workflows: { id: string; name: string }[];
  /** A pause's end, shown in the viewer's time; itWorks for "until it works again". */
  pauseUntil: { at: string | null; itWorks: boolean } | null;
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
    | "remindDaily"
    | "notifyRecovery"
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
    pausedUntil: string | null;
    pauseUntilSuccess: boolean;
    pauseReason: string | null;
    /** Who paused: their name, or "An owner" / "An admin". */
    pausedBy: string | null;
    /** Their sign-in email or wallet address; never a step-up inbox. */
    pausedByAccount: string | null;
    /** Turn the workflow off when its alert goes out. Workflow-only. */
    disableWorkflow: boolean;
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
      workflowDisabledAt: string | null;
      /** When someone last turned it back on after that. */
      workflowReenabledAt: string | null;
      /** Not running because its runs are refused before they start. */
      refused: boolean;
      /** The refusal's reason as shown; null when not refused or none was recorded. */
      refusedReason: string | null;
      /** A "refused" incident's newest refusal. */
      lastRefusedAt: string | null;
    } | null;
  };
  members: MemberView[];
  connections: ConnectionView[];
  /** The viewer's unshared connections, greyed out to explain why they are missing. */
  unsharedConnections: ConnectionView[];
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
export function orgPauseEffect(disablingWorkflows: number | undefined): string {
  const effect = `${pauseEffect("org")} until then.`;
  if (disablingWorkflows === 0) {
    return effect;
  }
  let which =
    "any set to turn off at their limit still turn off; you are told about those";
  if (disablingWorkflows === 1) {
    which =
      "the 1 set to turn off at its limit still turns off; you are told about it";
  } else if (disablingWorkflows !== undefined) {
    which = `the ${disablingWorkflows} set to turn off at their limit still turn off; you are told about those`;
  }
  return `${effect} ${which.charAt(0).toUpperCase()}${which.slice(1)} when the pause ends.`;
}

/** What each kind of message is called in the history and analytics lists. */
export const FAILURE_ALERT_KIND_LABEL: Record<FailureAlertMessageKind, string> =
  {
    alert: "New failure",
    reminder: "Still failing",
    recovery: "Recovered",
    channel_stopped: "Method stopped working",
    launch_notice: "Alerts turned on",
    alerts_paused: PAUSE_KIND_LABEL.orgPaused,
    alerts_resumed: PAUSE_KIND_LABEL.orgResumed,
    cap_warning: "Email limit warning",
    test: "Test",
    workflow_alerts_paused: PAUSE_KIND_LABEL.workflowPaused,
    workflow_alerts_resumed: PAUSE_KIND_LABEL.workflowResumed,
    workflow_alerts_pause_ended: PAUSE_KIND_LABEL.workflowEnded,
    recipients_removed: "Removed from alerts",
  };

/** Kinds a person causes, so the By column names them. */
export const PERSON_KINDS: readonly string[] = [
  "alerts_paused",
  "alerts_resumed",
  "test",
  "workflow_alerts_paused",
  "workflow_alerts_resumed",
  "recipients_removed",
];

/** Who caused a message: the person who paused, resumed or tested; KeeperHub for everything automatic. */
export function historyBy(
  context: Record<string, unknown> | null,
  kind: string
): string {
  const person =
    PERSON_KINDS.includes(kind) && typeof context?.by === "string" && context.by
      ? context.by
      : null;
  return person ?? "KeeperHub";
}

/** A pause notice's end, for the page to show in the viewer's own time. */
export function pauseUntilOf(
  context: Record<string, unknown> | null,
  kind?: string
): HistoryEntry["pauseUntil"] {
  if (kind !== "workflow_alerts_paused") {
    return null;
  }
  const at =
    typeof context?.until === "string" && context.until ? context.until : null;
  const itWorks = context?.untilItWorks === true;
  return at || itWorks ? { at, itWorks } : null;
}

/** "Reason: …", or "No reason given" where a person was expected to say why. */
function reasonNote(context: Record<string, unknown> | null): string {
  return typeof context?.reason === "string" && context.reason.trim()
    ? `Reason: ${context.reason.trim()}`
    : "No reason given";
}

/** The note for a pause notice or a removal; undefined for every other kind. */
function pauseHistoryNote(
  context: Record<string, unknown> | null,
  kind?: string
): string | null | undefined {
  if (kind === "workflow_alerts_paused") {
    return reasonNote(context);
  }
  if (kind === "workflow_alerts_resumed") {
    return null;
  }
  if (kind === "workflow_alerts_pause_ended") {
    const failed =
      typeof context?.failedRuns === "number" ? context.failedRuns : 0;
    const ending =
      context?.ended === "worked"
        ? "Ended because it works again"
        : "Pause ran out";
    const failures =
      failed === 0
        ? "no failures while its alerts were paused"
        : `${failed} failure${failed === 1 ? "" : "s"} while its alerts were paused`;
    const reason =
      typeof context?.reason === "string" && context.reason
        ? `Reason: ${context.reason}`
        : null;
    return [ending, failures, reason].filter(Boolean).join(" · ");
  }
  if (kind === "recipients_removed") {
    return Array.isArray(context?.removed)
      ? `Removed: ${(context.removed as unknown[]).map(String).join(", ")}`
      : null;
  }
  return undefined;
}

/** Which channel a stopped-method notice is about, why a backup was sent, or a workflow turned off. */
export function historyNote(
  context: Record<string, unknown> | null,
  kind?: string
): string | null {
  // Who is in historyBy; a pause notice adds its reason here.
  if (kind === "alerts_paused") {
    return reasonNote(context);
  }
  if (kind === "alerts_resumed") {
    return typeof context?.by === "string" ? null : "The pause ran out";
  }
  const pauseNote = pauseHistoryNote(context, kind);
  if (pauseNote !== undefined) {
    return pauseNote;
  }
  if (typeof context?.channelLabel === "string") {
    return context.channelLabel;
  }
  const notes: string[] = [];
  if (context?.disabledAgain === true) {
    notes.push("Turned the workflow off again after it was turned back on");
  } else if (context?.workflowDisabled === true) {
    notes.push("Turned the workflow off");
  }
  if (typeof context?.backupReason === "string") {
    notes.push(`Sent because ${context.backupReason}`);
  }
  return notes.length > 0 ? notes.join(". ") : null;
}

/** One example message as each channel shows it. */
export type MessagePreview = {
  sample: "alert" | "missed" | "disabled" | "recovery";
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
const NOT_EXECUTABLE_WORDS: Record<NotExecutableReason, string> = {
  deleted: "the workflow is deleted",
  deactivated: "the workflow is deactivated",
  org_deactivated: "the organization is deactivated",
  halted: "the organization's circuit breaker is engaged",
  disabled: "the workflow is turned off",
  anonymous_owner: "the owner has no account",
};

/** A stored refusal as shown: no "Execution skipped:" prefix, executor codes in plain words. */
export function shownRefusal(reason: string): string {
  return reason
    .replace(SKIPPED_PREFIX, "")
    .replace(
      NOT_EXECUTABLE_CODE,
      (_match, code: string) =>
        `not executable (${NOT_EXECUTABLE_WORDS[code as NotExecutableReason]})`
    );
}

/** What a plan or billing refusal asks for: a paid feature, a run limit, pay-as-you-go funds or limits, or billing. */
export type PlanRefusal = "feature" | "limit" | "payg" | "billing";

const PAID_FEATURE = /require a paid plan/i;
const RUN_LIMIT = /execution limit|run limit/i;
const PAYG = /pay-as-you-go/i;
const PAYG_MESSAGES = Object.values(PAYG_BLOCK_MESSAGES);

export function planRefusalOf(reason: string | null): PlanRefusal {
  if (!reason) {
    return "billing";
  }
  if (PAID_FEATURE.test(reason)) {
    return "feature";
  }
  if (RUN_LIMIT.test(reason)) {
    return "limit";
  }
  const payg =
    PAYG.test(reason) || PAYG_MESSAGES.some((text) => reason.includes(text));
  return payg ? "payg" : "billing";
}

export type RefusalFixLink = { page: "plans" | "billing"; label: string };

/** The settings page that fixes a refusal kind: Billing for pay-as-you-go, else Plans. */
export function planFixLink(kind: PlanRefusal | undefined): RefusalFixLink {
  return kind === "payg"
    ? { page: "billing", label: "Open Billing" }
    : { page: "plans", label: "Open Plans" };
}

/** Where alerts, the panel and the runs list send a refusal's fix: null when the workflow cannot run. */
export function refusalFixLink(reason: string | null): RefusalFixLink | null {
  return refusalCannotRun(reason) ? null : planFixLink(planRefusalOf(reason));
}

/** The fix page's path for an organization. */
export function refusalFixHref(
  organizationId: string,
  link: RefusalFixLink
): string {
  return `/settings/${encodeURIComponent(organizationId)}/${link.page}`;
}

/** The org's circuit breaker stopped it (lib/execute/org-circuit-breaker.ts). */
export function refusalHalted(reason: string | null): boolean {
  return reason?.match(NOT_EXECUTABLE_CODE)?.[1] === "halted";
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
