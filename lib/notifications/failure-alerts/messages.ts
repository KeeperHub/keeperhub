import { emailButton, emailLayout, escapeHtml } from "@/lib/email";
import {
  MAX_SUMMARY_CHARS,
  truncateRunes,
} from "@/plugins/pagerduty/event-payload";

/**
 * What each failure notification says, for every channel. Kept apart from the
 * delivery code so the wording can be read and tested in one place.
 */

export type AlertWorkflow = {
  id: string;
  name: string;
  triggerLabel: string;
};

type AlertIncident = {
  failureCount: number;
  firstFailedAt: Date;
  lastError: string | null;
  openedBy: "count" | "time";
};

export type RenderedMessage = {
  subject: string;
  text: string;
  html: string;
  /** Plain text for Slack, Discord and Telegram. */
  chat: string;
  /** PagerDuty summary. */
  summary: string;
};

type OrgFields = { orgName: string; organizationId: string; appUrl: string };

export type MessageInput =
  | (OrgFields & {
      kind: "alert" | "reminder";
      workflow: AlertWorkflow;
      incident: AlertIncident;
      backupReason?: string;
    })
  | (OrgFields & {
      kind: "grouped";
      workflows: (AlertWorkflow & { failureCount: number })[];
      backupReason?: string;
    })
  | (OrgFields & {
      kind: "recovery";
      workflow: AlertWorkflow;
      incident: AlertIncident;
    })
  | (OrgFields & {
      kind: "channel_paused";
      channelLabel: string;
      reason: string;
    })
  | (OrgFields & {
      kind: "launch_notice";
      threshold: number;
      failingNow: (AlertWorkflow & { failureCount: number })[];
    })
  | { kind: "test"; orgName: string; channelLabel: string };

const MAX_ERROR_CHARS = 300;
const WHITESPACE = /\s+/g;
const TRAILING_DOTS = /\.+$/;

function shortError(error: string | null): string {
  if (!error) {
    return "No error message was recorded.";
  }
  return truncateRunes(error.replace(WHITESPACE, " ").trim(), MAX_ERROR_CHARS);
}

const RPC_TROUBLE =
  /\b(429|rate.?limit|too many requests|timed? ?out|timeout|ETIMEDOUT|ECONNRESET|503|502)\b/i;
const GAS_TROUBLE =
  /insufficient funds|out of gas|gas required exceeds|intrinsic gas/i;

/** A first guess at the cause, for the errors that keep coming up. */
function errorHint(error: string | null): string | null {
  if (!error) {
    return null;
  }
  if (GAS_TROUBLE.test(error)) {
    return "This looks like the wallet running out of gas: check its balance.";
  }
  if (RPC_TROUBLE.test(error)) {
    return "This looks like an RPC provider problem (rate limit or timeout), which often clears on its own.";
  }
  return null;
}

function formatUtc(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const days = Math.round(hours / 24);
  return `${days} days`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function runsUrl(appUrl: string, workflowId: string): string {
  return `${appUrl}/workflows/${encodeURIComponent(workflowId)}?tab=runs`;
}

function workflowUrl(appUrl: string, workflowId: string): string {
  return `${appUrl}/workflows/${encodeURIComponent(workflowId)}`;
}

function settingsUrl(appUrl: string, organizationId: string): string {
  return `${appUrl}/settings/${encodeURIComponent(organizationId)}/notifications`;
}

function summaryOf(text: string): string {
  return truncateRunes(`[KeeperHub] ${text}`, MAX_SUMMARY_CHARS);
}

function failingHeadline(
  workflow: AlertWorkflow,
  incident: AlertIncident,
  still: boolean,
  now: Date
): string {
  const runs = `${plural(incident.failureCount, "failed run", "failed runs")} in a row`;
  if (incident.openedBy === "time" && !still) {
    return `${workflow.name} has been failing for ${formatDuration(now.getTime() - incident.firstFailedAt.getTime())} (${runs})`;
  }
  return `${workflow.name} is ${still ? "still " : ""}failing: ${runs}`;
}

function backupBanner(reason: string | undefined): {
  html: string;
  text: string;
  chat: string;
} {
  if (!reason) {
    return { html: "", text: "", chat: "" };
  }
  return {
    html: `<div style="background: #fffbeb; border: 1px solid #fcd34d; border-radius: 8px; padding: 14px 16px; margin-bottom: 20px; color: #92400e;"><strong>Backup alert:</strong> ${escapeHtml(reason)}.</div>`,
    text: `BACKUP ALERT: ${reason}.\n\n`,
    chat: `Backup alert: ${reason}.\n`,
  };
}

function footer(input: OrgFields): { text: string; html: string } {
  const link = settingsUrl(input.appUrl, input.organizationId);
  const why =
    "You get this because you receive workflow failure notifications for this organization.";
  return {
    text: `${why} Change who gets these: ${link}`,
    html: `${escapeHtml(why)} <a href="${escapeHtml(link)}" style="color: #999;">Change who gets these</a>.`,
  };
}

export function renderMessage(
  input: MessageInput,
  now: Date = new Date()
): RenderedMessage {
  switch (input.kind) {
    case "alert":
    case "reminder":
      return renderAlert(input, now);
    case "grouped":
      return renderGrouped(input);
    case "recovery":
      return renderRecovery(input, now);
    case "channel_paused":
      return renderChannelPaused(input);
    case "launch_notice":
      return renderLaunchNotice(input);
    default:
      return renderTest(input);
  }
}

function renderAlert(
  input: Extract<MessageInput, { kind: "alert" | "reminder" }>,
  now: Date
): RenderedMessage {
  const { workflow, incident, orgName, appUrl } = input;
  const headline = failingHeadline(
    workflow,
    incident,
    input.kind === "reminder",
    now
  );
  const backup = backupBanner(input.backupReason);
  const error = shortError(incident.lastError);
  const hint = errorHint(incident.lastError);
  const runs = runsUrl(appUrl, workflow.id);
  const open = workflowUrl(appUrl, workflow.id);
  const foot = footer(input);
  const nextStep =
    "It keeps running on its trigger until someone fixes, mutes or pauses it. Mute and Pause are in the workflow's Properties.";

  const text = `${backup.text}${headline}.

Organization: ${orgName}
Trigger: ${workflow.triggerLabel}
Failing since: ${formatUtc(incident.firstFailedAt)}
Last error: ${error}
${hint ? `${hint}\n` : ""}
${nextStep}
View failed runs: ${runs}
Open the workflow: ${open}

${foot.text}`;

  const html = emailLayout(
    escapeHtml(headline),
    `${backup.html}
    <div style="background: #f5f5f5; border-radius: 8px; padding: 20px; margin: 0 0 20px; font-size: 14px;">
      <div><strong>Organization:</strong> ${escapeHtml(orgName)}</div>
      <div><strong>Trigger:</strong> ${escapeHtml(workflow.triggerLabel)}</div>
      <div><strong>Failing since:</strong> ${formatUtc(incident.firstFailedAt)}</div>
      <div><strong>Last error:</strong> <code>${escapeHtml(error)}</code></div>
      ${hint ? `<div style="margin-top: 8px;">${escapeHtml(hint)}</div>` : ""}
    </div>
    <p>${escapeHtml(nextStep)}</p>
    <p>${emailButton(runs, "View failed runs")}${emailButton(open, "Open the workflow")}</p>`,
    foot.html
  );

  return {
    subject: `${input.backupReason ? "[Backup] " : ""}[${orgName}] ${headline}`,
    text,
    html,
    chat: `[${orgName}] ${backup.chat}${headline}.\nLast error: ${error}${hint ? `\n${hint}` : ""}\nTrigger: ${workflow.triggerLabel}\n${runs}`,
    summary: summaryOf(`${orgName}: ${headline}`),
  };
}

function renderGrouped(
  input: Extract<MessageInput, { kind: "grouped" }>
): RenderedMessage {
  const { workflows, orgName, appUrl } = input;
  const headline = `${workflows.length} workflows started failing`;
  const cause =
    "This often means a shared cause, such as an RPC provider or a wallet out of gas.";
  const backup = backupBanner(input.backupReason);
  const foot = footer(input);
  const lines = workflows.map(
    (w) =>
      `- ${w.name}: ${plural(w.failureCount, "failed run", "failed runs")} in a row (${runsUrl(appUrl, w.id)})`
  );
  const text = `${backup.text}${headline} in ${orgName}. ${cause}

${lines.join("\n")}

${foot.text}`;
  const html = emailLayout(
    escapeHtml(headline),
    `${backup.html}
    <p>${escapeHtml(cause)}</p>
    <ul style="padding-left: 20px;">${workflows
      .map(
        (w) =>
          `<li><a href="${escapeHtml(runsUrl(appUrl, w.id))}">${escapeHtml(w.name)}</a>: ${plural(w.failureCount, "failed run", "failed runs")} in a row</li>`
      )
      .join("")}</ul>
    <p>${emailButton(runsUrl(appUrl, workflows[0]?.id ?? ""), `View ${workflows[0]?.name ?? "the first workflow"}`)}</p>`,
    foot.html
  );
  return {
    subject: `${input.backupReason ? "[Backup] " : ""}[${orgName}] ${headline}`,
    text,
    html,
    chat: `[${orgName}] ${backup.chat}${headline}. ${cause}\n${lines.join("\n")}`,
    summary: summaryOf(`${orgName}: ${headline}`),
  };
}

function renderRecovery(
  input: Extract<MessageInput, { kind: "recovery" }>,
  now: Date
): RenderedMessage {
  const { workflow, incident, orgName, appUrl } = input;
  const span = formatDuration(now.getTime() - incident.firstFailedAt.getTime());
  const headline = `${workflow.name} is running again`;
  const detail = `It succeeded after ${plural(incident.failureCount, "failed run", "failed runs")} over ${span}.`;
  const link = runsUrl(appUrl, workflow.id);
  const foot = footer(input);
  return {
    subject: `[${orgName}] ${headline}`,
    text: `${headline}. ${detail}\n\nView runs: ${link}\n\n${foot.text}`,
    html: emailLayout(
      escapeHtml(headline),
      `<p>${escapeHtml(detail)}</p><p>${emailButton(link, "View runs")}</p>`,
      foot.html
    ),
    chat: `[${orgName}] ${headline}. ${detail}\n${link}`,
    summary: summaryOf(`${orgName}: ${headline}`),
  };
}

function renderChannelPaused(
  input: Extract<MessageInput, { kind: "channel_paused" }>
): RenderedMessage {
  const link = settingsUrl(input.appUrl, input.organizationId);
  const headline = `${input.channelLabel} stopped working for failure notifications`;
  const detail = `${input.reason.replace(TRAILING_DOTS, "")}. It is paused until a test succeeds. Your other notification methods are still used.`;
  const foot = footer(input);
  return {
    subject: `[${input.orgName}] ${headline}`,
    text: `${headline}.\n\n${detail}\n\nFix it: ${link}\n\n${foot.text}`,
    html: emailLayout(
      escapeHtml(headline),
      `<p>${escapeHtml(detail)}</p><p>${emailButton(link, "Fix the channel")}</p>`,
      foot.html
    ),
    chat: `[${input.orgName}] ${headline}. ${detail}\n${link}`,
    summary: summaryOf(`${input.orgName}: ${headline}`),
  };
}

function renderLaunchNotice(
  input: Extract<MessageInput, { kind: "launch_notice" }>
): RenderedMessage {
  const link = settingsUrl(input.appUrl, input.organizationId);
  const headline = "Workflow failure notifications are on";
  const rule = `KeeperHub now emails you when a workflow that runs on its own (schedule, event, block, webhook, transfer or Pyth price trigger) fails ${input.threshold} times in a row. You can change who gets it, add Slack, Discord, Telegram or PagerDuty, and test each one in Settings, Notifications.`;
  const failingText =
    input.failingNow.length > 0
      ? `\n\nThese workflows are failing right now:\n${input.failingNow
          .map(
            (w) =>
              `- ${w.name}: last ${w.failureCount} runs failed (${runsUrl(input.appUrl, w.id)})`
          )
          .join("\n")}`
      : "";
  const failingHtml =
    input.failingNow.length > 0
      ? `<p><strong>These workflows are failing right now:</strong></p><ul style="padding-left: 20px;">${input.failingNow
          .map(
            (w) =>
              `<li><a href="${escapeHtml(runsUrl(input.appUrl, w.id))}">${escapeHtml(w.name)}</a>: last ${w.failureCount} runs failed</li>`
          )
          .join("")}</ul>`
      : "";
  return {
    subject: `[${input.orgName}] ${headline}`,
    text: `${rule}${failingText}\n\nSettings: ${link}`,
    html: emailLayout(
      headline,
      `<p>${escapeHtml(rule)}</p>${failingHtml}<p>${emailButton(link, "Notification settings")}</p>`,
      "You get this once, as an owner of the organization."
    ),
    chat: `[${input.orgName}] ${headline}. ${rule}`,
    summary: summaryOf(`${input.orgName}: ${headline}`),
  };
}

function renderTest(
  input: Extract<MessageInput, { kind: "test" }>
): RenderedMessage {
  const line = `KeeperHub test, no action needed. Failure notifications for ${input.orgName} can reach ${input.channelLabel}.`;
  return {
    subject: `[${input.orgName}] KeeperHub test notification`,
    text: line,
    html: emailLayout(
      "Test notification",
      `<p>${escapeHtml(line)}</p>`,
      "Sent from the Test button in Settings, Notifications."
    ),
    chat: line,
    summary: summaryOf(`Test notification for ${input.orgName}`),
  };
}
