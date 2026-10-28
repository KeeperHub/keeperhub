import { EMAIL_LOGO_URL, escapeHtml } from "@/lib/email";

/**
 * What each failure notification says, for every channel. Kept apart from the
 * delivery code so the wording can be read and tested in one place.
 */

export type AlertWorkflow = {
  id: string;
  name: string;
  triggerLabel: string;
};

export type AlertIncident = {
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
  /** PagerDuty summary (1024 characters max). */
  summary: string;
};

export type MessageInput =
  | {
      kind: "alert" | "reminder";
      orgName: string;
      workflow: AlertWorkflow;
      incident: AlertIncident;
      appUrl: string;
      backupReason?: string;
    }
  | {
      kind: "grouped";
      orgName: string;
      workflows: (AlertWorkflow & { failureCount: number })[];
      appUrl: string;
      backupReason?: string;
    }
  | {
      kind: "recovery";
      orgName: string;
      workflow: AlertWorkflow;
      incident: AlertIncident;
      appUrl: string;
    }
  | {
      kind: "channel_paused";
      orgName: string;
      channelLabel: string;
      reason: string;
      appUrl: string;
      organizationId: string;
    }
  | {
      kind: "launch_notice";
      orgName: string;
      threshold: number;
      failingNow: (AlertWorkflow & { failureCount: number })[];
      appUrl: string;
      organizationId: string;
    }
  | { kind: "test"; orgName: string; channelLabel: string };

const MAX_ERROR_CHARS = 300;

function shortError(error: string | null): string {
  if (!error) {
    return "No error message was recorded.";
  }
  const oneLine = error.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_ERROR_CHARS
    ? `${oneLine.slice(0, MAX_ERROR_CHARS)}...`
    : oneLine;
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

export function runsUrl(appUrl: string, workflowId: string): string {
  return `${appUrl}/workflows/${encodeURIComponent(workflowId)}?tab=runs`;
}

export function settingsUrl(appUrl: string, organizationId: string): string {
  return `${appUrl}/settings/${encodeURIComponent(organizationId)}/notifications`;
}

function failingHeadline(
  workflow: AlertWorkflow,
  incident: AlertIncident,
  now: Date
): string {
  const runs = `${incident.failureCount} failed run${incident.failureCount === 1 ? "" : "s"} in a row`;
  if (incident.openedBy === "time") {
    return `${workflow.name} has been failing for ${formatDuration(now.getTime() - incident.firstFailedAt.getTime())} (${runs})`;
  }
  return `${workflow.name} is failing: ${runs}`;
}

function layout(title: string, bodyHtml: string, footerHtml: string): string {
  const logo = EMAIL_LOGO_URL
    ? `<img src="${EMAIL_LOGO_URL}" alt="KeeperHub" style="max-width: 200px; height: auto;" />`
    : "";
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
    ${logo}
  </div>
  <div style="background: #ffffff; padding: 30px; border: 1px solid #e5e5e5; border-top: none; border-radius: 0 0 12px 12px;">
    <h2 style="color: #1a1a2e; margin-top: 0;">${title}</h2>
    ${bodyHtml}
    <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 30px 0;">
    <p style="color: #999; font-size: 12px; margin-bottom: 0;">${footerHtml}</p>
  </div>
</body>
</html>`.trim();
}

function button(href: string, label: string): string {
  return `<a href="${escapeHtml(href)}" style="display:inline-block; background:#1a1a2e; color:#fff; padding:12px 20px; border-radius:8px; text-decoration:none; margin: 0 8px 8px 0;">${escapeHtml(label)}</a>`;
}

function backupBanner(reason: string | undefined): {
  html: string;
  text: string;
} {
  if (!reason) {
    return { html: "", text: "" };
  }
  return {
    html: `<div style="background: #fffbeb; border: 1px solid #fcd34d; border-radius: 8px; padding: 14px 16px; margin-bottom: 20px; color: #92400e;"><strong>Backup alert:</strong> ${escapeHtml(reason)}</div>`,
    text: `BACKUP ALERT: ${reason}\n\n`,
  };
}

const FOOTER_TEXT =
  "You get this because you receive workflow failure notifications for this organization.";

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
  const headline = failingHeadline(workflow, incident, now);
  const reminder = input.kind === "reminder" ? "Still failing: " : "";
  const backup = backupBanner(input.backupReason);
  const subject = `${input.backupReason ? "[Backup] " : ""}[${orgName}] ${reminder}${headline}`;
  const error = shortError(incident.lastError);
  const link = runsUrl(appUrl, workflow.id);

  const text = `${backup.text}${reminder}${headline}.

Organization: ${orgName}
Trigger: ${workflow.triggerLabel}
Failing since: ${formatUtc(incident.firstFailedAt)}
Last error: ${error}

It keeps running on its trigger until someone fixes or pauses it.
View failed runs: ${link}

${FOOTER_TEXT}`;

  const html = layout(
    escapeHtml(`${reminder}${headline}`),
    `${backup.html}
    <p>It keeps running on its trigger until someone fixes or pauses it.</p>
    <div style="background: #f5f5f5; border-radius: 8px; padding: 20px; margin: 20px 0; font-size: 14px;">
      <div><strong>Organization:</strong> ${escapeHtml(orgName)}</div>
      <div><strong>Trigger:</strong> ${escapeHtml(workflow.triggerLabel)}</div>
      <div><strong>Failing since:</strong> ${formatUtc(incident.firstFailedAt)}</div>
      <div><strong>Last error:</strong> <code>${escapeHtml(error)}</code></div>
    </div>
    <p>${button(link, "View failed runs")}</p>`,
    escapeHtml(FOOTER_TEXT)
  );

  const chatPrefix = input.backupReason
    ? `Backup alert (${input.backupReason}). `
    : "";
  return {
    subject,
    text,
    html,
    chat: `${chatPrefix}${reminder}${headline}.\nLast error: ${error}\n${orgName}, ${workflow.triggerLabel}\n${link}`,
    summary: `[KeeperHub] ${headline}`.slice(0, 1024),
  };
}

function renderGrouped(
  input: Extract<MessageInput, { kind: "grouped" }>
): RenderedMessage {
  const { workflows, orgName, appUrl } = input;
  const headline = `${workflows.length} workflows started failing`;
  const backup = backupBanner(input.backupReason);
  const lines = workflows.map(
    (w) =>
      `- ${w.name}: ${w.failureCount} failed run${w.failureCount === 1 ? "" : "s"} in a row (${runsUrl(appUrl, w.id)})`
  );
  const text = `${backup.text}${headline} in ${orgName}. This often means a shared cause, such as an RPC provider or a wallet out of gas.

${lines.join("\n")}

${FOOTER_TEXT}`;
  const html = layout(
    escapeHtml(headline),
    `${backup.html}
    <p>This often means a shared cause, such as an RPC provider or a wallet out of gas.</p>
    <ul style="padding-left: 20px;">${workflows
      .map(
        (w) =>
          `<li><a href="${escapeHtml(runsUrl(appUrl, w.id))}">${escapeHtml(w.name)}</a>: ${w.failureCount} failed run${w.failureCount === 1 ? "" : "s"} in a row</li>`
      )
      .join("")}</ul>`,
    escapeHtml(FOOTER_TEXT)
  );
  const chatPrefix = input.backupReason
    ? `Backup alert (${input.backupReason}). `
    : "";
  return {
    subject: `${input.backupReason ? "[Backup] " : ""}[${orgName}] ${headline}`,
    text,
    html,
    chat: `${chatPrefix}${headline} in ${orgName}:\n${lines.join("\n")}`,
    summary: `[KeeperHub] ${headline} in ${orgName}`.slice(0, 1024),
  };
}

function renderRecovery(
  input: Extract<MessageInput, { kind: "recovery" }>,
  now: Date
): RenderedMessage {
  const { workflow, incident, orgName, appUrl } = input;
  const span = formatDuration(now.getTime() - incident.firstFailedAt.getTime());
  const headline = `${workflow.name} is running again`;
  const detail = `It succeeded after ${incident.failureCount} failed run${incident.failureCount === 1 ? "" : "s"} over ${span}.`;
  const link = runsUrl(appUrl, workflow.id);
  return {
    subject: `[${orgName}] ${headline}`,
    text: `${headline}. ${detail}\n\nView runs: ${link}\n\n${FOOTER_TEXT}`,
    html: layout(
      escapeHtml(headline),
      `<p>${escapeHtml(detail)}</p><p>${button(link, "View runs")}</p>`,
      escapeHtml(FOOTER_TEXT)
    ),
    chat: `${headline}. ${detail}\n${link}`,
    summary: `[KeeperHub] ${headline}`.slice(0, 1024),
  };
}

function renderChannelPaused(
  input: Extract<MessageInput, { kind: "channel_paused" }>
): RenderedMessage {
  const link = settingsUrl(input.appUrl, input.organizationId);
  const headline = `${input.channelLabel} stopped working for failure notifications`;
  const detail = `${input.reason} It is paused until a test succeeds. Your other notification methods are still used.`;
  return {
    subject: `[${input.orgName}] ${headline}`,
    text: `${headline}.\n\n${detail}\n\nFix it: ${link}\n\n${FOOTER_TEXT}`,
    html: layout(
      escapeHtml(headline),
      `<p>${escapeHtml(detail)}</p><p>${button(link, "Fix the channel")}</p>`,
      escapeHtml(FOOTER_TEXT)
    ),
    chat: `${headline}. ${detail}\n${link}`,
    summary: `[KeeperHub] ${headline}`.slice(0, 1024),
  };
}

function renderLaunchNotice(
  input: Extract<MessageInput, { kind: "launch_notice" }>
): RenderedMessage {
  const link = settingsUrl(input.appUrl, input.organizationId);
  const headline = "Workflow failure notifications are on";
  const rule = `KeeperHub now emails you when a workflow that runs on its own (schedule, event, block, webhook) fails ${input.threshold} times in a row. You can change who gets it, add Slack, Discord, Telegram or PagerDuty, and test each one in Settings, Notifications.`;
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
    html: layout(
      headline,
      `<p>${escapeHtml(rule)}</p>${failingHtml}<p>${button(link, "Notification settings")}</p>`,
      "You get this once, as an owner of the organization."
    ),
    chat: `${headline}. ${rule}`,
    summary: `[KeeperHub] ${headline}`,
  };
}

function renderTest(
  input: Extract<MessageInput, { kind: "test" }>
): RenderedMessage {
  const line = `KeeperHub test, no action needed. Failure notifications for ${input.orgName} can reach ${input.channelLabel}.`;
  return {
    subject: `[${input.orgName}] KeeperHub test notification`,
    text: line,
    html: layout(
      "Test notification",
      `<p>${escapeHtml(line)}</p>`,
      "Sent from the Test button in Settings, Notifications."
    ),
    chat: line,
    summary: `[KeeperHub] Test notification for ${input.orgName}`,
  };
}
