"use client";

import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import Link from "next/link";
import { timeAgo } from "@/components/settings/hub/relative-time";
import { Button } from "@/components/ui/button";
import { Notice, WARNING_TEXT } from "@/components/ui/notice";
import {
  EMAILS_KEPT_FOR_NEW_FAILURES,
  isNotRunning,
  methodText,
  type OrgSettingsView,
} from "@/lib/notifications/failure-alerts/view-types";
import { cn } from "@/lib/utils";
import { failedRuns, formatWhen, joinList, notRunningText } from "./format";
import { memberLabel } from "./member-label";
import { channelWorks } from "./method-drafts";

const ICON_CLASS = "mt-0.5 size-4 shrink-0";

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

const MAX_NAMED = 3;

/** "a, b and c", or "a, b and 2 more" when some are left out. */
function withMore(parts: string[], more: number): string {
  return more > 0 ? `${parts.join(", ")} and ${more} more` : joinList(parts);
}

/** "a@x, b@y (email), Origin alerts (Discord) and 2 more". */
function namesLine(emails: string[], methods: string[]): string {
  const shownEmails = emails.slice(0, MAX_NAMED);
  const shownMethods = methods.slice(0, MAX_NAMED - shownEmails.length);
  const parts = [
    ...(shownEmails.length > 0 ? [`${shownEmails.join(", ")} (email)`] : []),
    ...shownMethods,
  ];
  return withMore(
    parts,
    emails.length + methods.length - shownEmails.length - shownMethods.length
  );
}

/**
 * Why email reaches nobody (the cap, nobody chosen, or who lacks an email),
 * and who can add one in Account security.
 */
function noEmailLine(
  data: OrgSettingsView,
  capped: boolean,
  reachable: number,
  viewerUserId: string | null | undefined
): { text: string; fixer: string | null } {
  if (capped && reachable > 0) {
    return {
      text: "This month's alert emails are used up, and no other method works.",
      fixer: null,
    };
  }
  const unreachable = data.members.filter(
    (m) => data.recipientUserIds.includes(m.userId) && !m.reachable
  );
  if (unreachable.length === 0) {
    return {
      text: "Nobody is chosen for email, and no other method works.",
      fixer: null,
    };
  }
  const self = unreachable.some((m) => m.userId === viewerUserId);
  if (self && unreachable.length === 1) {
    return {
      text: "You have no email KeeperHub can reach, and no other method works.",
      fixer: "You can",
    };
  }
  const names = unreachable.slice(0, MAX_NAMED).map(memberLabel);
  return {
    text: `${withMore(names, unreachable.length - names.length)} ${unreachable.length === 1 ? "has" : "have"} no email KeeperHub can reach, and no other method works.`,
    fixer: self ? "Each of you can" : "They can",
  };
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

/** The Status card is neutral when on and yellow when paused; health never colours it. */
export function statusCardClass(data: OrgSettingsView): string {
  const paused =
    data.pause && new Date(data.pause.until).getTime() > Date.now();
  return paused ? "border-yellow-500/50 bg-yellow-500/5" : "";
}

type AttentionRow = {
  id: string;
  name: string;
  href: string;
  detail: string;
  tone: "danger" | "warning";
};

/**
 * "Does anything need attention?": who cannot be reached, broken methods, the
 * email limit, and every workflow that is failing or has a broken own method.
 */
export function AlertsHealth({
  data,
  canManage,
  viewerUserId,
  onGoToSetup,
  onGoToSent,
}: {
  data: OrgSettingsView;
  canManage: boolean;
  viewerUserId?: string | null;
  /** Opens the Setup tab, where methods are fixed. */
  onGoToSetup?: () => void;
  /** Opens the Sent alerts tab. */
  onGoToSent?: () => void;
}): React.ReactElement {
  const fixButton = (label: string): React.ReactNode =>
    canManage && onGoToSetup ? (
      <Button
        className="mt-1 h-auto px-0 text-xs"
        data-testid="failure-alerts-fix"
        onClick={onGoToSetup}
        type="button"
        variant="link"
      >
        {label}
      </Button>
    ) : null;
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
  const unreachable = data.unreachable || routes === 0;
  const single = !unreachable && routes === 1;

  const emailNames = emailWorks ? people.map(memberLabel) : [];
  const always = working.filter((c) => c.role === "always").map(label);
  const backups = working.filter((c) => c.role === "backup").map(label);
  // Backups take the alert first when nothing else is set.
  const primary =
    emailNames.length + always.length > 0 ? always : [...always, ...backups];
  const reachParts = [
    emailNames.length + primary.length > 0
      ? `Alerts reach ${namesLine(emailNames, primary)}.`
      : "",
    primary === always && backups.length > 0
      ? `Backup: ${namesLine([], backups)}.`
      : "",
  ].filter(Boolean);
  const reachLine = reachParts.join(" ");
  const noEmail = noEmailLine(data, capped, people.length, viewerUserId);
  const onlyRoute = emailWorks
    ? "Email"
    : (working[0] && label(working[0])) || "";

  // Failing first, then workflows whose own methods stopped working.
  const rows: AttentionRow[] = [
    ...data.failingNow.map((w) => ({
      id: w.workflowId,
      name: w.name,
      href: `/workflows/${w.workflowId}?tab=runs`,
      tone: "danger" as const,
      detail: `${
        isNotRunning(w.openedBy)
          ? notRunningText(w.dueAt, w.refused, w.openedBy)
          : `${w.openedBy === "funding" ? "Wallet out of funds, " : ""}${failedRuns(w.failureCount)} in a row${ownRule(ownThreshold.get(w.workflowId))}, alert sent ${timeAgo(w.openedAt)}`
      }${pause ? `. Not reported until ${formatWhen(pause.until)}` : ""}`,
    })),
    ...data.customWorkflows
      .filter((w) => w.brokenMethods > 0)
      .map((w) => ({
        id: w.id,
        name: w.name,
        href: `/workflows/${w.id}`,
        tone: "warning" as const,
        detail:
          w.brokenMethods === 1
            ? "1 of its own methods stopped working"
            : `${w.brokenMethods} of its own methods stopped working`,
      })),
  ];
  const problems =
    unreachable ||
    single ||
    broken.length > 0 ||
    rows.length > 0 ||
    Boolean(usage && usage.used >= usage.limit * 0.8);

  let healthState = "healthy";
  if (unreachable) {
    healthState = "unreachable";
  } else if (rows.length > 0) {
    healthState = "attention";
  }

  return (
    <div
      className="space-y-4"
      data-state={healthState}
      data-testid="failure-alerts-health"
    >
      {unreachable && (
        <Headline
          title="Nobody can be reached: nobody will be told when a workflow fails"
          tone="danger"
        >
          {noEmail.text}{" "}
          {noEmail.fixer && (
            <>
              {noEmail.fixer} add one in{" "}
              <Link className="underline" href="/settings/security">
                Account security
              </Link>
              .{" "}
            </>
          )}
          {canManage
            ? "Add a method, or choose other people for email."
            : "Ask an owner or admin to fix it."}{" "}
          {fixButton("Fix in Setup")}
        </Headline>
      )}
      {!unreachable && broken.length > 0 && (
        <Headline
          title={`${plural(broken.length, "method needs", "methods need")} attention`}
          tone="warning"
        >
          {broken.map(label).join(", ")}. The others are still used.{" "}
          {fixButton("Fix in Setup")}
        </Headline>
      )}
      {single && (
        <Headline title={`Only one method: ${onlyRoute}`} tone="warning">
          If it stops working, nobody is told. Add a backup method, or an email.{" "}
          {fixButton("Add a method")}
        </Headline>
      )}
      {usage && usage.used >= usage.limit * 0.8 && (
        <div data-testid="failure-alerts-email-cap">
          <Notice tone={capped && working.length === 0 ? "danger" : "warning"}>
            {capText(usage, working.length > 0)}
          </Notice>
        </div>
      )}

      {rows.length > 0 && (
        <div className="space-y-2">
          <h3 className="font-medium text-xs">
            Workflows that need attention ({rows.length})
          </h3>
          <ul
            className="divide-y rounded-md border"
            data-testid="failure-alerts-failing"
          >
            {rows.map((row) => {
              const Icon = row.tone === "danger" ? XCircle : AlertTriangle;
              return (
                <li
                  className="flex items-start gap-2 px-3 py-2 text-sm"
                  data-tone={row.tone}
                  key={`${row.tone}:${row.id}`}
                >
                  <Icon
                    aria-hidden="true"
                    className={cn(
                      ICON_CLASS,
                      row.tone === "danger" ? "text-destructive" : WARNING_TEXT
                    )}
                  />
                  <div className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                    <Link
                      className="min-w-0 break-words font-medium underline underline-offset-4"
                      href={row.href}
                    >
                      {row.name}
                    </Link>
                    <span
                      className={cn(
                        "text-xs",
                        row.tone === "danger"
                          ? "text-destructive"
                          : WARNING_TEXT
                      )}
                    >
                      {row.detail}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {!problems && (
        <Headline title="All healthy" tone="ok">
          No workflow is failing and every method works.
        </Headline>
      )}

      <p className="text-muted-foreground text-xs">
        {reachLine ? `${reachLine} ` : ""}
        {data.lastAlertDeliveredAt && onGoToSent && (
          <Button
            className="h-auto px-0 text-muted-foreground text-xs underline"
            data-testid="failure-alerts-last-alert"
            onClick={onGoToSent}
            type="button"
            variant="link"
          >
            Last alert delivered {timeAgo(data.lastAlertDeliveredAt)}
          </Button>
        )}
        {data.lastAlertDeliveredAt && !onGoToSent
          ? `Last alert delivered ${timeAgo(data.lastAlertDeliveredAt)}.`
          : null}
        {data.lastAlertDeliveredAt
          ? null
          : "No alert sent yet. Use Test on a method to see one arrive."}
      </p>
    </div>
  );
}
