import type { FailureIncidentTrigger } from "@/lib/db/schema-failure-alerts";
import { emailButton, emailLayout, escapeHtml } from "@/lib/email";
import {
  type ChatPart,
  type ChatText,
  formatChat,
} from "@/lib/notifications/chat-text";
import { redactSecretUrls } from "@/lib/rpc/scrub-rpc-urls";
import { MAX_SUMMARY_CHARS } from "@/plugins/pagerduty/event-payload";
import { isOutOfFunds } from "./streak";
import { EMAILS_KEPT_FOR_NEW_FAILURES, orgPauseEffect } from "./view-types";

// Message wording for every channel, apart from delivery so it is tested in one place.

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
  /** Chat text as the preview shows it. */
  chat: string;
  /** Chat text with outside text marked, fullest first; senders send the first that fits. */
  chatVariants: ChatText[];
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
      /** Reminder number, and the most there will be. */
      reminderNumber?: number;
      maxReminders?: number;
    })
  | (OrgFields & {
      kind: "grouped";
      workflows: (AlertWorkflow & {
        failureCount: number;
        workflowPaused?: boolean;
        lastError?: string | null;
        openedBy?: FailureIncidentTrigger;
      })[];
      backupReason?: string;
    })
  | (OrgFields & {
      kind: "recovery";
      workflow: AlertWorkflow;
      incident: AlertIncident;
      testNote?: string;
      /** A late schedule ran again, but that run failed. */
      ranButFailed?: boolean;
    })
  | (OrgFields & {
      kind: "channel_paused";
      channelLabel: string;
      /** slack, discord, telegram or pagerduty; unknown on older notices. */
      channelKind?: string;
      reason: string;
    })
  | (OrgFields & {
      kind: "alerts_paused";
      until: Date;
      reason: string | null;
      by: string | null;
      /** Workflows set to turn off at their limit; unknown when undefined. */
      pausingWorkflows?: number;
    })
  | (OrgFields & { kind: "alerts_resumed"; by: string | null })
  | (OrgFields & {
      kind: "cap_warning";
      used: number;
      limit: number;
      /** A Slack, Discord, Telegram or PagerDuty method works; unknown when undefined. */
      chatWorks?: boolean;
    })
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

const EMAIL_LIKE = /@/;

/** How a pause notice names who did it: their name, never an email; else their role. */
export function pauseActorName(
  member: { name: string | null; role: string } | undefined
): string | null {
  const name = member?.name?.trim();
  if (name && !EMAIL_LIKE.test(name)) {
    return name;
  }
  if (!member) {
    return null;
  }
  return member.role === "owner" ? "An owner" : "An admin";
}

export function appBaseUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? "https://app.keeperhub.com";
}

const MAX_ERROR_CHARS = 300;
const WHITESPACE = /\s+/g;
const TRAILING_DOTS = /\.+$/;
const ELLIPSIS = "…";

// Chat webhook URLs carry their secret in the path; the rest go through redactSecretUrls.
const CHAT_WEBHOOK_URL =
  /\bhttps?:\/\/(?:hooks\.slack\.com|(?:[\w-]+\.)?discord(?:app)?\.com\/api\/webhooks|api\.telegram\.org)[^\s)'"<>]*/gi;
const BEARER_TOKEN = /\bBearer\s+[\w.~+/=-]+/gi;
const TELEGRAM_BOT_TOKEN = /\b\d{6,}:[\w-]{30,}/g;
const SECRET_PAIR =
  /\b(api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key|secret|password)(["']?\s*[=:]\s*["']?)[^\s"'&,;]+/gi;

/** Error text with keys, tokens and secret-bearing URLs masked, for anything we send. */
export function redactErrorSecrets(text: string): string {
  return redactSecretUrls(text.replace(CHAT_WEBHOOK_URL, "[REDACTED-URL]"))
    .replace(BEARER_TOKEN, "Bearer [REDACTED]")
    .replace(TELEGRAM_BOT_TOKEN, "[REDACTED]")
    .replace(SECRET_PAIR, "$1$2[REDACTED]");
}

/** At most `max` characters, ending in "…" when shortened. */
function clip(text: string, max: number): string {
  const runes = [...text];
  return runes.length <= max
    ? text
    : `${runes.slice(0, max - 1).join("")}${ELLIPSIS}`;
}

/** Error text as sent: one line, secrets masked, shortened. */
function errorExcerpt(error: string, max: number): string {
  return clip(redactErrorSecrets(error.replace(WHITESPACE, " ").trim()), max);
}

function shortError(error: string | null): string {
  if (!error) {
    return "No error message was recorded.";
  }
  return errorExcerpt(error, MAX_ERROR_CHARS);
}

const RPC_TROUBLE =
  /\b(429|rate.?limit|too many requests|timed? ?out|timeout|ETIMEDOUT|ECONNRESET|503|502)\b/i;
const GAS_LIMIT_TROUBLE = /out of gas|gas required exceeds|intrinsic gas/i;

/** A first guess at the cause, for the errors that keep coming up. */
function errorHint(error: string | null): string | null {
  if (!error) {
    return null;
  }
  if (isOutOfFunds(error)) {
    return "This looks like the wallet running out of funds: check its balance.";
  }
  if (GAS_LIMIT_TROUBLE.test(error)) {
    return "The transaction ran out of its gas limit, which often means it reverted.";
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

function walletsUrl(appUrl: string, organizationId: string): string {
  return `${appUrl}/settings/${encodeURIComponent(organizationId)}/wallets`;
}

/** Where an alert's links go; the samples have no workflow, so they open the Alerts page. */
function workflowLinks(
  input: OrgFields,
  workflowId: string
): { open: string; runs: string } {
  if (!workflowId) {
    const alerts = settingsUrl(input.appUrl, input.organizationId);
    return { open: alerts, runs: alerts };
  }
  return {
    open: workflowUrl(input.appUrl, workflowId),
    runs: runsUrl(input.appUrl, workflowId),
  };
}

function summaryOf(text: string): string {
  return clip(`[KeeperHub] ${text}`, MAX_SUMMARY_CHARS);
}

/** Outside text (names, reasons): escaped for each chat provider. */
function user(text: string): ChatPart {
  return { user: text };
}

function plain(parts: ChatText): string {
  return formatChat(parts, "plain");
}

function orgTag(orgName: string): ChatPart[] {
  return ["[", user(orgName), "] "];
}

/** Lines joined by newlines; null lines are left out. */
function joinLines(lines: (ChatText | string | null)[]): ChatPart[] {
  const out: ChatPart[] = [];
  for (const line of lines) {
    if (line === null) {
      continue;
    }
    if (out.length > 0) {
      out.push("\n");
    }
    out.push(...(typeof line === "string" ? [line] : line));
  }
  return out;
}

function chatOf(
  variants: ChatText[]
): Pick<RenderedMessage, "chat" | "chatVariants"> {
  return { chat: plain(variants[0] ?? []), chatVariants: variants };
}

function failingHeadline(
  workflow: AlertWorkflow,
  incident: AlertIncident,
  still: boolean,
  now: Date
): ChatPart[] {
  const name = user(workflow.name);
  if (incident.openedBy === "missed") {
    return [
      name,
      still ? " still has not run" : " did not run when it was due",
    ];
  }
  if (incident.openedBy === "funding" && !still) {
    return ["Wallet out of funds: ", name, " cannot pay for its transaction"];
  }
  const runs = `${plural(incident.failureCount, "failed run", "failed runs")} in a row`;
  if (incident.openedBy === "time" && !still) {
    return [
      name,
      ` has been failing for ${formatDuration(now.getTime() - incident.firstFailedAt.getTime())} (${runs})`,
    ];
  }
  return still
    ? [name, `: ${runs}`]
    : [
        name,
        ` failed ${plural(incident.failureCount, "time", "times")} in a row`,
      ];
}

function pausedHeadline(
  workflow: AlertWorkflow,
  failures: number,
  again: boolean,
  funding: boolean
): ChatPart[] {
  const cause = funding ? "Wallet out of funds: " : "";
  if (again) {
    return [
      cause,
      user(workflow.name),
      ` was paused again: ${plural(failures, "more failed run", "more failed runs")} after it was turned back on`,
    ];
  }
  return [
    cause,
    user(workflow.name),
    ` was paused after ${plural(failures, "failed run", "failed runs")} in a row`,
  ];
}

const PAUSED_NEXT_STEP =
  "KeeperHub turned it off because this workflow is set to pause at its failure limit. It will not run until someone turns it back on: fix the cause, then press Turn back on in the workflow's Alerts panel.";

type Banner = { html: string; text: string; chat: ChatPart[] };

const NO_BANNER: Banner = { html: "", text: "", chat: [] };

function joinBanners(...banners: Banner[]): Banner {
  return {
    html: banners.map((b) => b.html).join(""),
    text: banners.map((b) => b.text).join(""),
    chat: banners.flatMap((b) => b.chat),
  };
}

function testBanner(note: string | undefined): Banner {
  if (!note) {
    return NO_BANNER;
  }
  return {
    html: `<div style="background: #eff6ff; border: 1px solid #93c5fd; border-radius: 8px; padding: 14px 16px; margin-bottom: 20px; color: #1e3a8a;">${escapeHtml(note)}</div>`,
    text: `${note}\n\n`,
    // The note names the channel, which people type.
    chat: [user(note), "\n"],
  };
}

function backupBanner(reason: string | undefined): Banner {
  if (!reason) {
    return NO_BANNER;
  }
  return {
    html: `<div style="background: #fffbeb; border: 1px solid #fcd34d; border-radius: 8px; padding: 14px 16px; margin-bottom: 20px; color: #92400e;"><strong>Backup alert:</strong> ${escapeHtml(reason)}.</div>`,
    text: `BACKUP ALERT: ${reason}.\n\n`,
    chat: ["Backup alert: ", user(reason), ".\n"],
  };
}

function footer(input: OrgFields): { text: string; html: string } {
  const link = settingsUrl(input.appUrl, input.organizationId);
  const why = `You get this because you receive ${input.orgName} alerts.`;
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
    case "cap_warning":
      return renderCapWarning(input);
    default:
      return renderTest(input);
  }
}

const MISSED_DETAIL =
  "Its scheduled run did not start. This is usually a KeeperHub scheduling problem, not your workflow, and it is reported to our team.";
const FUNDING_NEXT_STEP =
  "Add funds to the wallet that pays for it; the next run picks them up. The error above shows what it had and what it needed.";
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
  const headlineParts = input.paused
    ? pausedHeadline(
        workflow,
        input.pausedFailures ?? incident.failureCount,
        input.paused === "again",
        incident.openedBy === "funding"
      )
    : failingHeadline(workflow, incident, reminder, now);
  const headline = plain(headlineParts);
  const banners = joinBanners(
    testBanner(input.testNote),
    backupBanner(input.backupReason)
  );
  // A funds alert already says what to do; the hint would repeat it.
  const hint =
    missed || incident.openedBy === "funding"
      ? null
      : errorHint(incident.lastError);
  const { open, runs } = workflowLinks(input, workflow.id);
  const funds =
    incident.openedBy === "funding"
      ? walletsUrl(appUrl, input.organizationId)
      : null;
  const foot = footer(input);
  let nextStep = FAILING_NEXT_STEP;
  if (input.paused) {
    nextStep = PAUSED_NEXT_STEP;
  } else if (missed) {
    nextStep = MISSED_NEXT_STEP;
  } else if (incident.openedBy === "funding") {
    nextStep = FUNDING_NEXT_STEP;
  }
  let label = "Action needed";
  if (missed && !input.paused) {
    label = "Check";
  } else if (reminder && !input.paused) {
    label = input.reminderNumber
      ? `Still failing (reminder ${input.reminderNumber} of ${input.maxReminders ?? 7})`
      : "Still failing";
  }
  const last =
    reminder &&
    !input.paused &&
    input.reminderNumber !== undefined &&
    input.reminderNumber >= (input.maxReminders ?? 7);
  const accent = missed && !input.paused ? "#b45309" : "#b91c1c";
  const tint = missed && !input.paused ? "#fffbeb" : "#fef2f2";
  const since = missed
    ? `Due at ${formatUtc(incident.firstFailedAt)}, ${formatDuration(now.getTime() - incident.firstFailedAt.getTime())} ago.`
    : `Failing since ${formatUtc(incident.firstFailedAt)}.`;
  const history = missed ? null : historyLine(incident);
  const detail = missed
    ? MISSED_DETAIL
    : `Last error: ${shortError(incident.lastError)}`;

  // The same lines, in the same order, for email text, chat and the HTML.
  const lastLine = last
    ? "This is the last reminder. It stays under Failing now on the Alerts page until it works or someone pauses it."
    : null;
  const lines = [since, history, detail, hint, nextStep, lastLine].filter(
    (line): line is string => Boolean(line)
  );
  let links = [`Open the failing workflow: ${open}`, `Failed runs: ${runs}`];
  if (missed) {
    links = [`Open the workflow: ${open}`];
  } else if (funds) {
    links = [`Add funds: ${funds}`, ...links];
  }
  let buttons = `${emailButton(open, "Open the failing workflow", "danger")}${emailButton(runs, "View failed runs")}`;
  if (missed) {
    buttons = emailButton(open, "Open the workflow", "primary");
  } else if (funds) {
    buttons = `${emailButton(funds, "Add funds", "danger")}${emailButton(open, "Open the failing workflow")}`;
  }

  const text = `${banners.text}${label}: ${headline}.

${lines.join("\n")}

${links.join("\n")}

${workflow.triggerLabel} trigger, ${orgName}.
${foot.text}`;

  const html = emailLayout(
    `<span style="display:inline-block; background:${accent}; color:#fff; font-size:12px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase; padding:3px 8px; border-radius:4px; margin-bottom:8px;">${label}</span><br>${escapeHtml(headline)}`,
    `${banners.html}
    <div style="border-left: 4px solid ${accent}; background: ${tint}; border-radius: 6px; padding: 14px 16px; margin: 0 0 20px; font-size: 14px;">
      <div><strong>${escapeHtml(since)}</strong></div>
      ${history ? `<div>${escapeHtml(history)}</div>` : ""}
      ${
        missed
          ? `<div style="margin-top: 8px;">${escapeHtml(MISSED_DETAIL)}</div>`
          : `<div style="margin-top: 8px;">Last error: <code>${escapeHtml(shortError(incident.lastError))}</code></div>`
      }
      ${hint ? `<div style="margin-top: 8px;">${escapeHtml(hint)}</div>` : ""}
      ${lastLine ? `<div style="margin-top: 8px;"><strong>${escapeHtml(lastLine)}</strong></div>` : ""}
    </div>
    <p>${buttons}</p>
    <p style="color: #555; font-size: 13px;">${escapeHtml(nextStep)}</p>
    <p style="color: #555; font-size: 13px;">${escapeHtml(workflow.triggerLabel)} trigger, ${escapeHtml(orgName)}.</p>`,
    foot.html
  );

  return {
    subject: `${input.testNote ? "[Test] " : ""}${input.backupReason ? "[Backup] " : ""}[${orgName}] ${label}: ${headline}`,
    text,
    html,
    ...chatOf(
      alertChatVariants({
        top: [
          ...orgTag(orgName),
          ...banners.chat,
          `${label}: `,
          ...headlineParts,
          ".",
        ],
        lastError: missed ? null : incident.lastError,
        middle: [since, history, hint, nextStep, lastLine],
        detail: missed ? MISSED_DETAIL : null,
        links,
      })
    ),
    summary: summaryOf(`${orgName}: ${headline}`),
  };
}

/** Fullest first, then without the error text, then headline and links only. */
function alertChatVariants(parts: {
  top: ChatPart[];
  lastError: string | null;
  middle: (string | null)[];
  detail: string | null;
  links: string[];
}): ChatText[] {
  const [since, history, ...rest] = parts.middle;
  const withDetail = (detail: ChatText | string | null): ChatText =>
    joinLines([parts.top, since, history, detail, ...rest, ...parts.links]);
  let detail: ChatText | string | null = parts.detail;
  if (detail === null) {
    detail = parts.lastError
      ? ["Last error: ", { code: shortError(parts.lastError) }]
      : `Last error: ${shortError(null)}`;
  }
  return [
    withDetail(detail),
    withDetail(parts.detail ?? "Last error: see the failed runs."),
    joinLines([parts.top, ...parts.links]),
  ];
}

type GroupedWorkflow = Extract<
  MessageInput,
  { kind: "grouped" }
>["workflows"][number];

/** A grouped alert lists this many workflows, then "And N more". */
const GROUPED_LIST_MAX = 10;
const GROUPED_ERROR_CHARS = 120;

function outOfFunds(w: GroupedWorkflow): boolean {
  return w.openedBy === "funding" || isOutOfFunds(w.lastError ?? null);
}

function groupedRank(w: GroupedWorkflow): number {
  if (w.workflowPaused) {
    return 0;
  }
  return outOfFunds(w) ? 1 : 2;
}

/** Turned off first, then out of funds, then most failures, so a short list keeps them. */
function sortGrouped(workflows: GroupedWorkflow[]): GroupedWorkflow[] {
  return [...workflows].sort(
    (a, b) => groupedRank(a) - groupedRank(b) || b.failureCount - a.failureCount
  );
}

function renderGrouped(
  input: Extract<MessageInput, { kind: "grouped" }>
): RenderedMessage {
  const { orgName, appUrl } = input;
  const workflows = sortGrouped(input.workflows);
  const turnedOff = workflows.filter((w) => w.workflowPaused).length;
  const headline = `${plural(workflows.length, "workflow", "workflows")} started failing${turnedOff > 0 ? `, ${turnedOff} turned off` : ""}`;
  const errorText = (w: { lastError?: string | null }): string | null =>
    w.lastError ? errorExcerpt(w.lastError, GROUPED_ERROR_CHARS) : null;
  const errorOf = (w: { lastError?: string | null }): string => {
    const error = errorText(w);
    return error ? `: ${error}` : "";
  };
  const cause = `This often means a shared cause, such as an RPC provider or a wallet out of gas.${turnedOff > 0 ? " Workflows KeeperHub turned off stay off until someone turns them back on." : ""}`;
  const backup = backupBanner(input.backupReason);
  const foot = footer(input);
  const pausedNote = (w: { workflowPaused?: boolean }): string =>
    w.workflowPaused ? ", turned off" : "";
  const fundsPrefix = (w: GroupedWorkflow): string =>
    outOfFunds(w) ? "Wallet out of funds: " : "";
  const shown = workflows.slice(0, GROUPED_LIST_MAX);
  const more = workflows.length - shown.length;
  const moreLine = more > 0 ? `And ${more} more.` : null;
  const funds = workflows.some(outOfFunds)
    ? walletsUrl(appUrl, input.organizationId)
    : null;
  const lines = shown.map(
    (w) =>
      `- ${fundsPrefix(w)}${w.name}: ${plural(w.failureCount, "failed run", "failed runs")} in a row${pausedNote(w)}${errorOf(w)} (${runsUrl(appUrl, w.id)})`
  );
  if (moreLine) {
    lines.push(moreLine);
  }
  const fundsLine = funds ? `Add funds: ${funds}\n` : "";
  const seeAll = `See all failing workflows: ${settingsUrl(appUrl, input.organizationId)}`;
  const chatLine = (w: GroupedWorkflow, withError: boolean): ChatPart[] => {
    const error = withError ? errorText(w) : null;
    return [
      `- ${fundsPrefix(w)}`,
      user(w.name),
      `: ${plural(w.failureCount, "failed run", "failed runs")} in a row${pausedNote(w)}`,
      ...(error ? [": ", { code: error }] : []),
      ` (${runsUrl(appUrl, w.id)})`,
    ];
  };
  const chatList = (count: number, withError: boolean): ChatText => {
    const rest = workflows.length - count;
    return joinLines([
      [
        ...orgTag(orgName),
        ...backup.chat,
        `Action needed: ${headline}. ${cause}`,
      ],
      ...workflows.slice(0, count).map((w) => chatLine(w, withError)),
      rest > 0 ? `And ${rest} more.` : null,
      funds ? `Add funds: ${funds}` : null,
      seeAll,
    ]);
  };
  // Drop the error text first, then list fewer workflows.
  const chatVariants = [chatList(shown.length, true)];
  for (let count = shown.length; count >= 1; count -= 1) {
    chatVariants.push(chatList(count, false));
  }
  const text = `${backup.text}${headline} in ${orgName}. ${cause}

${lines.join("\n")}

${fundsLine}${seeAll}

${foot.text}`;
  const html = emailLayout(
    `<span style="display:inline-block; background:#b91c1c; color:#fff; font-size:12px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase; padding:3px 8px; border-radius:4px; margin-bottom:8px;">Action needed</span><br>${escapeHtml(headline)}`,
    `${backup.html}
    <p>${escapeHtml(cause)}</p>
    <ul style="padding-left: 20px;">${shown
      .map(
        (w) =>
          `<li>${outOfFunds(w) ? "<strong>Wallet out of funds:</strong> " : ""}<a href="${escapeHtml(runsUrl(appUrl, w.id))}">${escapeHtml(w.name)}</a>: ${plural(w.failureCount, "failed run", "failed runs")} in a row${pausedNote(w)}${w.lastError ? `<br><code style="font-size:12px;">${escapeHtml(errorText(w) ?? "")}</code>` : ""}</li>`
      )
      .join("")}</ul>
    ${moreLine ? `<p>${moreLine}</p>` : ""}
    <p>${emailButton(settingsUrl(appUrl, input.organizationId), "See all failing workflows", "danger")}${funds ? emailButton(funds, "Add funds") : ""}</p>`,
    foot.html
  );
  return {
    subject: `${input.backupReason ? "[Backup] " : ""}[${orgName}] Action needed: ${headline}`,
    text,
    html,
    ...chatOf(chatVariants),
    summary: summaryOf(`${orgName}: ${headline}`),
  };
}

function renderRecovery(
  input: Extract<MessageInput, { kind: "recovery" }>,
  now: Date
): RenderedMessage {
  const { workflow, incident, orgName } = input;
  const span = formatDuration(now.getTime() - incident.firstFailedAt.getTime());
  let tail = " is running again";
  let detail = `It succeeded after ${plural(incident.failureCount, "failed run", "failed runs")} (${span}).`;
  if (incident.openedBy === "missed") {
    tail = input.ranButFailed
      ? " ran, but the run failed"
      : " is running again";
    detail = input.ranButFailed
      ? `It started ${span} after it was due. You will be told if it keeps failing.`
      : `It started again ${span} after it was due.`;
  }
  const headlineParts = [user(workflow.name), tail];
  const headline = plain(headlineParts);
  const prefix = input.ranButFailed ? "Started again" : "Resolved";
  const link = workflowLinks(input, workflow.id).runs;
  const foot = footer(input);
  const test = testBanner(input.testNote);
  return {
    subject: `${input.testNote ? "[Test] " : ""}[${orgName}] ${prefix}: ${headline}`,
    text: `${test.text}${headline}. ${detail}\n\nView runs: ${link}\n\n${foot.text}`,
    html: emailLayout(
      escapeHtml(headline),
      `${test.html}<p>${escapeHtml(detail)}</p><p>${emailButton(link, "View runs")}</p>`,
      foot.html
    ),
    ...chatOf([
      [
        ...orgTag(orgName),
        ...test.chat,
        ...headlineParts,
        `. ${detail}\n${link}`,
      ],
    ]),
    summary: summaryOf(`${orgName}: ${headline}`),
  };
}

/** How a paused method comes back: the daily check proves all but Slack (token only). */
function channelResumeText(kind: string | undefined): string {
  if (kind === "slack") {
    return "It is paused until a test from the Alerts page succeeds.";
  }
  if (kind) {
    return "It is paused; it is checked every day and turns back on by itself when it works, or when a test succeeds.";
  }
  return "It is paused until a test succeeds; apart from Slack, it is also checked every day and turns back on by itself when it works.";
}

function renderChannelPaused(
  input: Extract<MessageInput, { kind: "channel_paused" }>
): RenderedMessage {
  const link = settingsUrl(input.appUrl, input.organizationId);
  // The label and the provider's reason are outside text.
  const headlineParts = [
    user(input.channelLabel),
    " stopped working for failure notifications",
  ];
  const detailParts = [
    user(redactErrorSecrets(input.reason).replace(TRAILING_DOTS, "")),
    `. ${channelResumeText(input.channelKind)} Your other notification methods are still used.`,
  ];
  const headline = plain(headlineParts);
  const detail = plain(detailParts);
  const foot = footer(input);
  return {
    subject: `[${input.orgName}] ${headline}`,
    text: `${headline}.\n\n${detail}\n\nFix it: ${link}\n\n${foot.text}`,
    html: emailLayout(
      escapeHtml(headline),
      `<p>${escapeHtml(detail)}</p><p>${emailButton(link, "Fix the channel")}</p>`,
      foot.html
    ),
    ...chatOf([
      [
        ...orgTag(input.orgName),
        ...headlineParts,
        ". ",
        ...detailParts,
        `\n${link}`,
      ],
    ]),
    summary: summaryOf(`${input.orgName}: ${headline}`),
  };
}

const ADD_CHAT = "Add Slack, Discord, Telegram or PagerDuty, or upgrade.";

function capOutDetail(chatWorks: boolean | undefined): string {
  if (chatWorks === false) {
    return `From now until the 1st, nobody is told about new failures. ${ADD_CHAT}`;
  }
  if (chatWorks) {
    return "Until the 1st, new failure alerts go only to your chat and PagerDuty methods, not email. Upgrade for unlimited alert emails.";
  }
  return "Until the 1st, new failure alerts go only to Slack, Discord, Telegram and PagerDuty, not email; without one of those, nobody is told. Add one, or upgrade for unlimited alert emails.";
}

function capLowDetail(input: { limit: number; chatWorks?: boolean }): string {
  const from = input.limit - EMAILS_KEPT_FOR_NEW_FAILURES;
  const kept = `After ${from}, only alerts about new failures go by email; reminders and recovery messages do not.`;
  return input.chatWorks === false
    ? `${kept} Once all ${input.limit} are used, nobody is told until the 1st. ${ADD_CHAT}`
    : `${kept} Chat and PagerDuty are never counted.`;
}

function renderCapWarning(
  input: Extract<MessageInput, { kind: "cap_warning" }>
): RenderedMessage {
  const out = input.used >= input.limit;
  // The org name is already in the [Org] tag and the subject.
  const headlineParts = [
    out
      ? `All ${input.limit} alert emails for this month are used`
      : `${input.used} of the ${input.limit} alert emails for this month are used`,
  ];
  const headline = plain(headlineParts);
  const detail = out ? capOutDetail(input.chatWorks) : capLowDetail(input);
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
    ...chatOf([
      [...orgTag(input.orgName), ...headlineParts, `. ${detail}\n${link}`],
    ]),
    summary: summaryOf(`${input.orgName}: ${headline}`),
  };
}

function renderOrgPause(
  input: Extract<MessageInput, { kind: "alerts_paused" | "alerts_resumed" }>
): RenderedMessage {
  const paused = input.kind === "alerts_paused";
  const headlineParts = [
    paused
      ? `Alerts are paused until ${formatUtc(input.until)}`
      : "Alerts are back on",
  ];
  const headline = plain(headlineParts);
  let detailParts: ChatPart[];
  if (paused) {
    const who = input.by
      ? [user(input.by), " paused them"]
      : ["They were paused"];
    detailParts = [
      ...who,
      ...(input.reason
        ? [": ", user(input.reason.replace(TRAILING_DOTS, ""))]
        : []),
      `. ${orgPauseEffect(input.pausingWorkflows)}`,
    ];
  } else {
    detailParts = [
      ...(input.by
        ? [user(input.by), " turned them back on"]
        : ["The pause ended"]),
      ". Any workflow still failing is reported now.",
    ];
  }
  const detail = plain(detailParts);
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
    ...chatOf([
      [
        ...orgTag(input.orgName),
        ...headlineParts,
        ". ",
        ...detailParts,
        `\n${link}`,
      ],
    ]),
    summary: summaryOf(`${input.orgName}: ${headline}`),
  };
}

function renderLaunchNotice(
  input: Extract<MessageInput, { kind: "launch_notice" }>
): RenderedMessage {
  const link = settingsUrl(input.appUrl, input.organizationId);
  const headline = "Workflow alerts are on";
  const rule = `KeeperHub now emails you when a workflow that runs on its own (schedule, event, block, webhook, transfer or Pyth price trigger) fails ${input.threshold} times in a row. You can change who gets it, add Slack, Discord, Telegram or PagerDuty, and test each one in Settings, Alerts.`;
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
      `<p>${escapeHtml(rule)}</p>${failingHtml}<p>${emailButton(link, "Alerts settings")}</p>`,
      "You get this once, as an owner of the organization."
    ),
    ...chatOf([[...orgTag(input.orgName), `${headline}. ${rule}\n${link}`]]),
    summary: summaryOf(`${input.orgName}: ${headline}`),
  };
}

// No id: its links open the Alerts page.
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
  // Two shortfalls in a row open a funds alert, so the sample is one, with its Add funds link.
  const incident: AlertIncident = {
    failureCount: 5,
    firstFailedAt: new Date(now.getTime() - 47 * 60 * 1000),
    lastError:
      "insufficient funds for gas * price + value: have 120000000000000 want 340000000000000",
    openedBy: sample === "missed" ? "missed" : "funding",
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
    `Test from Settings, Alerts, sent to ${input.channelLabel}. Nothing is failing: this is how a real alert looks.`
  );
}
