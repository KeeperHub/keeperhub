import type { FailureIncidentTrigger } from "@/lib/db/schema-failure-alerts";
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
  openedBy: FailureIncidentTrigger;
  /** Successful runs in the 30 days before it started failing. */
  before?: { successes: number; lastSuccessAt: Date | null };
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
      /** KeeperHub turned the workflow off: first time, or again after a resume. */
      paused?: "first" | "again";
      /** Failed runs that led to this pause, when not the incident's count. */
      pausedFailures?: number;
      testNote?: string;
    })
  | (OrgFields & {
      kind: "grouped";
      workflows: (AlertWorkflow & {
        failureCount: number;
        workflowPaused?: boolean;
      })[];
      backupReason?: string;
    })
  | (OrgFields & {
      kind: "recovery";
      workflow: AlertWorkflow;
      incident: AlertIncident;
      testNote?: string;
    })
  | (OrgFields & {
      kind: "channel_paused";
      channelLabel: string;
      reason: string;
    })
  | (OrgFields & {
      kind: "alerts_paused";
      until: Date;
      reason: string | null;
      by: string | null;
    })
  | (OrgFields & { kind: "alerts_resumed"; by: string | null })
  | (OrgFields & {
      kind: "launch_notice";
      threshold: number;
      failingNow: (AlertWorkflow & { failureCount: number })[];
    })
  | (OrgFields & {
      kind: "test";
      channelLabel: string;
      sample?: SampleKind;
    });

/** Example messages for the preview and the Test buttons. */
export type SampleKind = "alert" | "missed" | "paused" | "recovery";

export function appBaseUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? "https://app.keeperhub.com";
}

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
  return `${appUrl}/settings/${encodeURIComponent(organizationId)}/alerts`;
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
  if (incident.openedBy === "missed") {
    return `${workflow.name} ${still ? "still has" : "has"} not run: it was due at ${formatUtc(incident.firstFailedAt)}`;
  }
  const runs = `${plural(incident.failureCount, "failed run", "failed runs")} in a row`;
  if (incident.openedBy === "time" && !still) {
    return `${workflow.name} has been failing for ${formatDuration(now.getTime() - incident.firstFailedAt.getTime())} (${runs})`;
  }
  return still
    ? `${workflow.name} is still failing: ${plural(incident.failureCount, "failed run", "failed runs")}`
    : `${workflow.name} failed ${plural(incident.failureCount, "time", "times")} in a row`;
}

function pausedHeadline(
  workflow: AlertWorkflow,
  failures: number,
  again: boolean
): string {
  if (again) {
    return `${workflow.name} was paused again: ${plural(failures, "more failed run", "more failed runs")} after it was turned back on`;
  }
  return `${workflow.name} was paused after ${plural(failures, "failed run", "failed runs")} in a row`;
}

const PAUSED_NEXT_STEP =
  "KeeperHub turned it off because this workflow is set to pause at its failure limit. It will not run until someone turns it back on: fix the cause, then use the Enable switch in the workflow editor.";

function joinBanners(
  ...banners: { html: string; text: string; chat: string }[]
): { html: string; text: string; chat: string } {
  return {
    html: banners.map((b) => b.html).join(""),
    text: banners.map((b) => b.text).join(""),
    chat: banners.map((b) => b.chat).join(""),
  };
}

function testBanner(note: string | undefined): {
  html: string;
  text: string;
  chat: string;
} {
  if (!note) {
    return { html: "", text: "", chat: "" };
  }
  return {
    html: `<div style="background: #eff6ff; border: 1px solid #93c5fd; border-radius: 8px; padding: 14px 16px; margin-bottom: 20px; color: #1e3a8a;">${escapeHtml(note)}</div>`,
    text: `${note}\n\n`,
    chat: `${note}\n`,
  };
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
    case "alerts_paused":
    case "alerts_resumed":
      return renderOrgPause(input);
    default:
      return renderTest(input);
  }
}

const MISSED_DETAIL =
  "Its schedule was due and no run started. This is usually a KeeperHub scheduling problem, not your workflow; our team is alerted too.";
const FAILING_NEXT_STEP =
  "It keeps running and failing until someone fixes, mutes or pauses it.";
const MISSED_NEXT_STEP =
  "You can run it by hand from the editor; you will be told when it runs on its own again.";

/** "Before this: 214 successful runs in 30 days, the last at 12:15 UTC." */
function historyLine(incident: AlertIncident): string | null {
  const before = incident.before;
  if (!before) {
    return null;
  }
  if (before.successes === 0) {
    return "It has not succeeded in the 30 days before this.";
  }
  const last = before.lastSuccessAt
    ? `, the last at ${formatUtc(before.lastSuccessAt)}`
    : "";
  return `Before this: ${plural(before.successes, "successful run", "successful runs")} in 30 days${last}.`;
}

function renderAlert(
  input: Extract<MessageInput, { kind: "alert" | "reminder" }>,
  now: Date
): RenderedMessage {
  const { workflow, incident, orgName, appUrl } = input;
  const missed = incident.openedBy === "missed";
  const reminder = input.kind === "reminder";
  const headline = input.paused
    ? pausedHeadline(
        workflow,
        input.pausedFailures ?? incident.failureCount,
        input.paused === "again"
      )
    : failingHeadline(workflow, incident, reminder, now);
  const banners = joinBanners(
    testBanner(input.testNote),
    backupBanner(input.backupReason)
  );
  const hint = missed ? null : errorHint(incident.lastError);
  const runs = runsUrl(appUrl, workflow.id);
  const open = workflowUrl(appUrl, workflow.id);
  const foot = footer(input);
  let nextStep = FAILING_NEXT_STEP;
  if (input.paused) {
    nextStep = PAUSED_NEXT_STEP;
  } else if (missed) {
    nextStep = MISSED_NEXT_STEP;
  }
  const label = reminder && !input.paused ? "Still failing" : "Action needed";
  const since = missed
    ? `Due at ${formatUtc(incident.firstFailedAt)}.`
    : `Failing since ${formatUtc(incident.firstFailedAt)}.`;
  const history = missed ? null : historyLine(incident);
  const detail = missed
    ? MISSED_DETAIL
    : `Last error: ${shortError(incident.lastError)}`;

  // The same lines, in the same order, for email text, chat and the HTML.
  const lines = [since, history, detail, hint, nextStep].filter(
    (line): line is string => Boolean(line)
  );
  const links = missed
    ? [`Open the workflow: ${open}`]
    : [`Open the failing workflow: ${open}`, `Failed runs: ${runs}`];

  const text = `${banners.text}${label}: ${headline}.

${lines.join("\n")}

${links.join("\n")}

${workflow.triggerLabel} trigger, ${orgName}.
${foot.text}`;

  const html = emailLayout(
    `<span style="display:inline-block; background:#b91c1c; color:#fff; font-size:12px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase; padding:3px 8px; border-radius:4px; margin-bottom:8px;">${label}</span><br>${escapeHtml(headline)}`,
    `${banners.html}
    <div style="border-left: 4px solid #b91c1c; background: #fef2f2; border-radius: 6px; padding: 14px 16px; margin: 0 0 20px; font-size: 14px;">
      <div><strong>${escapeHtml(since)}</strong></div>
      ${history ? `<div>${escapeHtml(history)}</div>` : ""}
      ${
        missed
          ? `<div style="margin-top: 8px;">${escapeHtml(MISSED_DETAIL)}</div>`
          : `<div style="margin-top: 8px;">Last error: <code>${escapeHtml(shortError(incident.lastError))}</code></div>`
      }
      ${hint ? `<div style="margin-top: 8px;">${escapeHtml(hint)}</div>` : ""}
    </div>
    <p>${emailButton(open, missed ? "Open the workflow" : "Open the failing workflow", "danger")}${missed ? "" : emailButton(runs, "View failed runs")}</p>
    <p style="color: #555; font-size: 13px;">${escapeHtml(nextStep)} ${escapeHtml(workflow.triggerLabel)} trigger, ${escapeHtml(orgName)}.</p>`,
    foot.html
  );

  return {
    subject: `${input.testNote ? "[Test] " : ""}${input.backupReason ? "[Backup] " : ""}[${orgName}] ${label}: ${headline}`,
    text,
    html,
    chat: `[${orgName}] ${banners.chat}${label}: ${headline}.\n${lines.join("\n")}\n${links.join("\n")}`,
    summary: summaryOf(`${orgName}: ${headline}`),
  };
}

function renderGrouped(
  input: Extract<MessageInput, { kind: "grouped" }>
): RenderedMessage {
  const { workflows, orgName, appUrl } = input;
  const headline = `${workflows.length} workflows started failing`;
  const anyPaused = workflows.some((w) => w.workflowPaused);
  const cause = `This often means a shared cause, such as an RPC provider or a wallet out of gas.${anyPaused ? " Paused workflows stay off until someone turns them back on." : ""}`;
  const backup = backupBanner(input.backupReason);
  const foot = footer(input);
  const pausedNote = (w: { workflowPaused?: boolean }): string =>
    w.workflowPaused ? ", paused" : "";
  const lines = workflows.map(
    (w) =>
      `- ${w.name}: ${plural(w.failureCount, "failed run", "failed runs")} in a row${pausedNote(w)} (${runsUrl(appUrl, w.id)})`
  );
  const text = `${backup.text}${headline} in ${orgName}. ${cause}

${lines.join("\n")}

See all failing workflows: ${settingsUrl(appUrl, input.organizationId)}

${foot.text}`;
  const html = emailLayout(
    escapeHtml(headline),
    `${backup.html}
    <p>${escapeHtml(cause)}</p>
    <ul style="padding-left: 20px;">${workflows
      .map(
        (w) =>
          `<li><a href="${escapeHtml(runsUrl(appUrl, w.id))}">${escapeHtml(w.name)}</a>: ${plural(w.failureCount, "failed run", "failed runs")} in a row${pausedNote(w)}</li>`
      )
      .join("")}</ul>
    <p>${emailButton(settingsUrl(appUrl, input.organizationId), "See all failing workflows")}</p>`,
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
  const detail =
    incident.openedBy === "missed"
      ? `It started again ${span} after it was due.`
      : `It succeeded after ${plural(incident.failureCount, "failed run", "failed runs")} over ${span}.`;
  const link = runsUrl(appUrl, workflow.id);
  const foot = footer(input);
  const test = testBanner(input.testNote);
  return {
    subject: `${input.testNote ? "[Test] " : ""}[${orgName}] Resolved: ${headline}`,
    text: `${test.text}${headline}. ${detail}\n\nView runs: ${link}\n\n${foot.text}`,
    html: emailLayout(
      escapeHtml(headline),
      `${test.html}<p>${escapeHtml(detail)}</p><p>${emailButton(link, "View runs")}</p>`,
      foot.html
    ),
    chat: `[${orgName}] ${test.chat}${headline}. ${detail}\n${link}`,
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

function renderOrgPause(
  input: Extract<MessageInput, { kind: "alerts_paused" | "alerts_resumed" }>
): RenderedMessage {
  const paused = input.kind === "alerts_paused";
  const headline = paused
    ? `Alerts for ${input.orgName} are paused until ${formatUtc(input.until)}`
    : `Alerts for ${input.orgName} are back on`;
  let detail: string;
  if (paused) {
    const who = input.by ? `${input.by} paused them` : "They were paused";
    detail = `${who}${input.reason ? `: ${input.reason.replace(TRAILING_DOTS, "")}` : ""}. Workflows keep running; failures are not reported until then.`;
  } else {
    detail = `${input.by ? `${input.by} turned them back on` : "The pause ended"}. Any workflow still failing is reported now.`;
  }
  const link = settingsUrl(input.appUrl, input.organizationId);
  const foot = footer(input);
  return {
    subject: `[${input.orgName}] ${headline}`,
    text: `${headline}.\n\n${detail}\n\nAlerts settings: ${link}\n\n${foot.text}`,
    html: emailLayout(
      escapeHtml(headline),
      `<p>${escapeHtml(detail)}</p><p>${emailButton(link, "Alerts settings")}</p>`,
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

const SAMPLE_WORKFLOW: AlertWorkflow = {
  id: "",
  name: "Example keeper",
  triggerLabel: "Schedule",
};

/** A message of the given kind about an example workflow, exactly as it would be sent. */
export function renderSample(
  org: OrgFields,
  sample: SampleKind,
  testNote?: string,
  now: Date = new Date()
): RenderedMessage {
  const incident: AlertIncident = {
    failureCount: 5,
    firstFailedAt: new Date(now.getTime() - 47 * 60 * 1000),
    lastError: "execution reverted: insufficient funds for gas * price + value",
    openedBy: sample === "missed" ? "missed" : "count",
    before: {
      successes: 214,
      lastSuccessAt: new Date(now.getTime() - 52 * 60 * 1000),
    },
  };
  if (sample === "recovery") {
    return renderMessage(
      {
        ...org,
        kind: "recovery",
        workflow: SAMPLE_WORKFLOW,
        incident,
        testNote,
      },
      now
    );
  }
  return renderMessage(
    {
      ...org,
      kind: "alert",
      workflow: SAMPLE_WORKFLOW,
      incident,
      testNote,
      paused: sample === "paused" ? "first" : undefined,
    },
    now
  );
}

/** A real-format example marked as a test, so people see what an alert looks like. */
function renderTest(
  input: Extract<MessageInput, { kind: "test" }>
): RenderedMessage {
  return renderSample(
    input,
    input.sample ?? "alert",
    `Test from Settings, Notifications, sent to ${input.channelLabel}. Nothing is failing: this is how a real alert looks.`
  );
}
