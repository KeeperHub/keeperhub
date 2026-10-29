"use client";

import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import Link from "next/link";
import { timeAgo } from "@/components/settings/hub/relative-time";
import { Notice, WARNING_TEXT } from "@/components/ui/notice";
import {
  EMAILS_KEPT_FOR_NEW_FAILURES,
  methodText,
  type OrgSettingsView,
} from "@/lib/notifications/failure-alerts/view-types";
import { cn } from "@/lib/utils";
import { failedRuns, formatWhen } from "./format";
import { memberLabel } from "./member-label";
import { channelWorks } from "./method-drafts";
import { AlertsPausedNotice } from "./pause-alerts";

type StatusState = "paused" | "unreachable" | "failing" | "single" | "quiet";

const ICON_CLASS = "mt-0.5 size-4 shrink-0";

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

const MAX_NAMED = 3;

/** "a@x, b@y (email), Origin alerts (Discord) and 2 more". */
function namesLine(emails: string[], methods: string[]): string {
  const shownEmails = emails.slice(0, MAX_NAMED);
  const shownMethods = methods.slice(0, MAX_NAMED - shownEmails.length);
  const parts = [
    ...(shownEmails.length > 0 ? [`${shownEmails.join(", ")} (email)`] : []),
    ...shownMethods,
  ];
  const more =
    emails.length + methods.length - shownEmails.length - shownMethods.length;
  return more > 0 ? `${parts.join(", ")} and ${more} more` : parts.join(", ");
}

/** " (own rule: 3)" for a workflow with its own limit. */
function ownRule(threshold: number | null | undefined): string {
  return typeof threshold === "number" ? ` (own rule: ${threshold})` : "";
}

const ADD_CHAT = "Add Slack, Discord, Telegram or PagerDuty, or upgrade.";

/** The Free plan email line: who still hears once the emails run out. */
function capText(
  usage: { used: number; limit: number },
  chatWorks: boolean
): string {
  if (usage.used >= usage.limit) {
    const used = `All ${usage.limit} alert emails for this month are used.`;
    return chatWorks
      ? `${used} Until the 1st, alerts go only to your chat and PagerDuty methods.`
      : `${used} From now until the 1st, nobody is told about new failures. ${ADD_CHAT}`;
  }
  const head = `Free plan: ${usage.used} of ${usage.limit} alert emails used this month. After ${usage.limit - EMAILS_KEPT_FOR_NEW_FAILURES}, only alerts about new failures go by email.`;
  return chatWorks
    ? `${head} Chat and PagerDuty are not counted.`
    : `${head} Once all ${usage.limit} are used, nobody is told until the 1st. ${ADD_CHAT}`;
}

function Headline({
  tone,
  title,
  children,
}: {
  tone: "ok" | "warning" | "danger";
  title: string;
  children?: React.ReactNode;
}): React.ReactElement {
  let Icon = CheckCircle2;
  let iconClass = "text-keeperhub-green-dark";
  if (tone === "warning") {
    Icon = AlertTriangle;
    iconClass = WARNING_TEXT;
  } else if (tone === "danger") {
    Icon = XCircle;
    iconClass = "text-destructive";
  }
  return (
    <div className="flex items-start gap-2">
      <Icon aria-hidden="true" className={cn(ICON_CLASS, iconClass)} />
      <div className="min-w-0 space-y-0.5">
        <p
          className={cn(
            "font-medium text-sm",
            tone === "danger" && "text-destructive"
          )}
        >
          {title}
        </p>
        {children && (
          <div className="break-words text-muted-foreground text-xs">
            {children}
          </div>
        )}
      </div>
    </div>
  );
}

/** "Is it working?": state, who is reached, the email cap, and what is failing now. */
export function AlertsStatus({
  data,
  canManage,
  onResume,
}: {
  data: OrgSettingsView;
  canManage: boolean;
  onResume: () => Promise<string | null>;
}): React.ReactElement {
  const pause =
    data.pause && new Date(data.pause.until).getTime() > Date.now()
      ? data.pause
      : null;
  const people = data.members.filter(
    (m) => m.reachable && data.recipientUserIds.includes(m.userId)
  );
  const usage = data.emailUsage;
  const capped = Boolean(usage && usage.used >= usage.limit);
  const emailWorks = people.length > 0 && !capped;
  const working = data.channels.filter(channelWorks);
  const broken = data.channels.filter((c) => !channelWorks(c));
  const routes = (emailWorks ? 1 : 0) + working.length;
  const label = (c: (typeof data.channels)[number]): string =>
    methodText(c.kind, c.destination, c.connectionName);
  const ownThreshold = new Map(
    data.customWorkflows.map((w) => [w.id, w.threshold])
  );

  let state: StatusState = "quiet";
  if (pause) {
    state = "paused";
  } else if (data.unreachable || routes === 0) {
    state = "unreachable";
  } else if (data.failingNow.length > 0) {
    state = "failing";
  } else if (routes === 1) {
    state = "single";
  }

  const emailNames = emailWorks ? people.map(memberLabel) : [];
  const always = working.filter((c) => c.role === "always").map(label);
  const backups = working.filter((c) => c.role === "backup").map(label);
  // Backups take the alert first when nothing else is set.
  const primary =
    emailNames.length + always.length > 0 ? always : [...always, ...backups];
  const reachParts = [
    emailNames.length + primary.length > 0
      ? `Reached: ${namesLine(emailNames, primary)}.`
      : "",
    primary === always && backups.length > 0
      ? `Backup: ${namesLine([], backups)}.`
      : "",
  ].filter(Boolean);
  const reachLine = reachParts.join(" ");
  const onlyRoute = emailWorks
    ? "Email"
    : (working[0] && label(working[0])) || "";

  return (
    <div
      className="space-y-4"
      data-state={state}
      data-testid="failure-alerts-status"
    >
      {state === "paused" && pause && (
        <AlertsPausedNotice
          canManage={canManage}
          onResume={onResume}
          pause={pause}
          pausingWorkflows={
            data.customWorkflows.filter((w) => w.pauseWorkflow).length
          }
        />
      )}
      {state === "unreachable" && (
        <Headline
          title="Nobody can be reached: nobody will be told when a workflow fails"
          tone="danger"
        >
          {capped && people.length > 0
            ? "This month's alert emails are used up, and no other method works."
            : "No chosen person has an email KeeperHub can reach, and no other method works."}{" "}
          {canManage ? (
            <>
              Add a method below, or add an email in{" "}
              <Link className="underline" href="/settings/security">
                Account security
              </Link>
              .
            </>
          ) : (
            "Ask an owner or admin to fix it."
          )}
        </Headline>
      )}
      {state === "failing" && (
        <Headline
          title={`${plural(data.failingNow.length, "workflow", "workflows")} failing`}
          tone="danger"
        >
          {reachLine}
        </Headline>
      )}
      {state === "single" && (
        <Headline title={`Only one method: ${onlyRoute}`} tone="warning">
          Only {onlyRoute} can reach anyone. If it stops working, nobody is
          told. Add a backup method, or an email.
        </Headline>
      )}
      {state === "quiet" && (
        <Headline title="All quiet" tone="ok">
          Nothing is failing. {reachLine}
        </Headline>
      )}

      {state !== "unreachable" && broken.length > 0 && (
        <p className="text-xs">
          <span className={cn("font-medium", WARNING_TEXT)}>
            {plural(broken.length, "method needs", "methods need")} attention:
          </span>{" "}
          {broken.map(label).join(", ")}.
          {routes > 0 ? " Everyone else is still reached." : ""}
        </p>
      )}

      <p className="text-muted-foreground text-xs">
        {data.lastAlertDeliveredAt
          ? `Last alert delivered ${timeAgo(data.lastAlertDeliveredAt)}.`
          : "No alert sent yet: nothing has failed. Use Test on a method to see one arrive."}
      </p>

      {usage && usage.used >= usage.limit * 0.8 && (
        <div data-testid="failure-alerts-email-cap">
          <Notice tone={capped && working.length === 0 ? "danger" : "warning"}>
            {capText(usage, working.length > 0)}
          </Notice>
        </div>
      )}

      {data.failingNow.length > 0 && (
        <div className="space-y-2">
          <h3 className="font-medium text-xs">
            Failing now ({data.failingNow.length})
          </h3>
          <ul
            className="divide-y rounded-md border"
            data-testid="failure-alerts-failing"
          >
            {data.failingNow.map((w) => (
              <li
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 px-3 py-2 text-sm"
                key={w.workflowId}
              >
                <Link
                  className="min-w-0 break-words font-medium underline underline-offset-4"
                  href={`/workflows/${w.workflowId}?tab=runs`}
                >
                  {w.name}
                </Link>
                <span className="text-destructive text-xs">
                  {w.openedBy === "missed"
                    ? `Did not run at ${formatWhen(w.dueAt)}`
                    : `${w.openedBy === "funding" ? "Wallet out of funds, " : ""}${failedRuns(w.failureCount)} in a row${ownRule(ownThreshold.get(w.workflowId))}, alert sent ${timeAgo(w.openedAt)}`}
                  {pause
                    ? `. Alerts held until ${formatWhen(pause.until)}`
                    : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
