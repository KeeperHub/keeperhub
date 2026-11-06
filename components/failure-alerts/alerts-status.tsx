"use client";

import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { timeAgo } from "@/components/settings/hub/relative-time";
import { Button } from "@/components/ui/button";
import { WARNING_SURFACE, WARNING_TEXT } from "@/components/ui/notice";
import {
  EMAILS_KEPT_FOR_NEW_FAILURES,
  isNotRunning,
  methodText,
  type OrgSettingsView,
} from "@/lib/notifications/failure-alerts/view-types";
import { cn } from "@/lib/utils";
import { unmuteWorkflow } from "./api";
import { TextWithEmails } from "./email-text";
import {
  failedRuns,
  formatWhen,
  joinList,
  notRunningText,
  TOUCH_TARGET,
} from "./format";
import { memberLabel, muteSentence } from "./member-label";
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

/** The healthy line: problems are listed in the issue sections instead. */
function HealthyLine({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex items-start gap-2">
      <CheckCircle2
        aria-hidden="true"
        className={cn(ICON_CLASS, "text-keeperhub-green-dark")}
      />
      <div className="min-w-0 space-y-0.5">
        <p className="font-medium text-sm">All healthy</p>
        <div className="break-words text-muted-foreground text-xs">
          {children}
        </div>
      </div>
    </div>
  );
}

const TRAILING_DOT = /\.$/;

/** "Telegram X is paused: <why>." or "Slack #ops stopped working: <why>.", then what still works. */
function brokenDetail(
  broken: { label: string; paused: boolean; why: string | null }[],
  stillWorking: string[]
): string {
  const each = broken
    .map((b) => {
      const state = b.paused ? "is paused" : "stopped working";
      return b.why
        ? `${b.label} ${state}: ${b.why.replace(TRAILING_DOT, "")}`
        : `${b.label} ${state}`;
    })
    .join(". ");
  if (stillWorking.length === 0) {
    return `${each}.`;
  }
  const verb = stillWorking.length === 1 ? "still gets" : "still get";
  return `${each}. ${stillWorking.join(" and ")} ${verb} alerts.`;
}

/** The Status card is neutral when on and yellow when paused; health never colours it. */
export function statusCardClass(data: OrgSettingsView): string {
  const paused =
    data.pause && new Date(data.pause.until).getTime() > Date.now();
  return paused ? WARNING_SURFACE : "";
}

type AttentionRow = {
  id: string;
  name: string;
  href: string;
  detail: React.ReactNode;
  tone: "danger" | "warning";
  /** A link under the detail, e.g. where to unmute. */
  action?: string;
};

type Issue = {
  id: string;
  tone: "danger" | "warning";
  title: React.ReactNode;
  detail: React.ReactNode;
  action?: React.ReactNode;
  testId?: string;
};

/** One subsection of Needs attention: title with count, a line on what it covers, then its issues. */
function IssueSection({
  title,
  description,
  issues,
  testId,
}: {
  title: string;
  description: string;
  issues: Issue[];
  testId: string;
}): React.ReactElement {
  return (
    <section className="space-y-2" data-testid={`${testId}-section`}>
      <div className="space-y-0.5">
        <h3 className="font-medium text-sm">
          {title} ({issues.length})
        </h3>
        <p className="text-muted-foreground text-xs">{description}</p>
      </div>
      <ul className="divide-y rounded-md border" data-testid={testId}>
        {issues.map((issue) => {
          const Icon = issue.tone === "danger" ? XCircle : AlertTriangle;
          const toneClass =
            issue.tone === "danger" ? "text-destructive" : WARNING_TEXT;
          return (
            <li
              className="flex items-start gap-2 px-3 py-2"
              data-testid={issue.testId}
              data-tone={issue.tone}
              key={issue.id}
            >
              <Icon aria-hidden="true" className={cn(ICON_CLASS, toneClass)} />
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="break-words font-medium text-sm">{issue.title}</p>
                <div className={cn("break-words text-xs", toneClass)}>
                  {issue.detail}
                </div>
                {issue.action}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Unmute straight from Overview; everyone who was told of the mute is told it ended. */
function UnmuteButton({
  workflowId,
  onDone,
}: {
  workflowId: string;
  onDone?: () => void;
}): React.ReactElement {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      className={`h-auto px-0 text-xs underline underline-offset-4 ${TOUCH_TARGET}`}
      data-testid="failure-alerts-overview-unmute"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const error = await unmuteWorkflow(workflowId);
        setBusy(false);
        if (error) {
          toast.error(error);
          return;
        }
        toast.success(
          "Alerts back on. Everyone who was told of the mute is told it ended."
        );
        onDone?.();
      }}
      type="button"
      variant="link"
    >
      {busy ? "Unmuting..." : "Unmute"}
    </Button>
  );
}

/**
 * "Does anything need attention?": who cannot be reached, broken methods, the
 * email limit, and every workflow that is failing or has a broken own method.
 */
export function AlertsHealth({
  data,
  canManage,
  viewerUserId,
  onGoToSetup,
  onChanged,
}: {
  data: OrgSettingsView;
  canManage: boolean;
  viewerUserId?: string | null;
  /** Opens the Setup tab, where methods are fixed. */
  onGoToSetup?: () => void;
  /** Reloads the page's data after an action here (Unmute). */
  onChanged?: () => void;
}): React.ReactElement {
  const fixButton = (label: string): React.ReactNode =>
    canManage && onGoToSetup ? (
      <Button
        className={`mt-1 h-auto px-0 text-xs underline underline-offset-4 ${TOUCH_TARGET}`}
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

  const noEmail = noEmailLine(data, capped, people.length, viewerUserId);
  const onlyRoute = emailWorks
    ? "Email"
    : (working[0] && label(working[0])) || "";

  // Every active mute shows, so silencing a workflow is never quiet.
  const muted = data.mutedWorkflows ?? [];
  const mutedIds = new Set(muted.map((w) => w.id));
  const muteRow = (w: (typeof muted)[number]): AttentionRow => {
    const muteLine = muteSentence({
      by: w.by,
      account: w.byAccount,
      untilItWorks: w.untilItWorks,
      mutedUntil: w.mutedUntil,
      reason: w.reason,
    });
    // The mute line already says "Muted ..."; only failing adds a state.
    let state = "";
    if (w.failing) {
      state =
        w.failedRuns > 0
          ? `Still failing: ${failedRuns(w.failedRuns)} since it was muted.`
          : "Still failing.";
    }
    return {
      id: w.id,
      name: w.name,
      href: `/workflows/${w.id}`,
      // Muted means someone already knows: yellow, as in the workflow panel.
      tone: "warning",
      // Only the state is coloured, so the rows stay easy to scan.
      detail: (
        <>
          {state && <span>{state} </span>}
          <span className="text-muted-foreground">
            <TextWithEmails text={`${muteLine}.`} />
          </span>
        </>
      ),
      action: "Open its Alerts",
    };
  };
  // Failing while muted first, then failing, then other mutes and broken own methods.
  const rows: AttentionRow[] = [
    ...muted.filter((w) => w.failing).map(muteRow),
    ...data.failingNow
      .filter((w) => !mutedIds.has(w.workflowId))
      .map((w) => ({
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
    ...muted.filter((w) => !w.failing).map(muteRow),
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
  const setupIssues: Issue[] = [];
  if (unreachable) {
    setupIssues.push({
      id: "unreachable",
      tone: "danger",
      title: "Nobody can be reached",
      detail: (
        <>
          Nobody will be told when a workflow fails. {noEmail.text}{" "}
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
            : "Ask an owner or admin to fix it."}
        </>
      ),
      action: fixButton("Fix in Setup"),
    });
  }
  if (!unreachable && broken.length > 0) {
    setupIssues.push({
      id: "broken",
      tone: "warning",
      title: `${plural(broken.length, "method needs", "methods need")} attention`,
      detail: brokenDetail(
        broken.map((c) => ({
          label: label(c),
          paused: Boolean(c.pausedAt),
          why: c.pausedAt ? (c.pausedReason ?? c.lastError) : c.lastError,
        })),
        [...(emailWorks ? ["Email"] : []), ...working.map(label)]
      ),
      action: fixButton("Fix in Setup"),
    });
  }
  if (single) {
    setupIssues.push({
      id: "single",
      tone: "warning",
      title: `Only one working method: ${onlyRoute}`,
      detail: `If ${onlyRoute} stops working, nobody is told. Add a backup method, or an additional email recipient in Setup.`,
      action: fixButton("Fix in Setup"),
    });
  }
  if (usage && usage.used >= usage.limit * 0.8) {
    setupIssues.push({
      id: "email-cap",
      tone: capped && working.length === 0 ? "danger" : "warning",
      title: capped ? "Alert emails used up" : "Alert emails running low",
      detail: capText(usage, working.length > 0),
      testId: "failure-alerts-email-cap",
    });
  }

  const workflowIssues: Issue[] = rows.map((row) => ({
    id: `${row.tone}:${row.id}`,
    tone: row.tone,
    title: (
      <Link
        className={`break-words underline underline-offset-4 ${TOUCH_TARGET}`}
        href={row.href}
      >
        {row.name}
      </Link>
    ),
    detail: row.detail,
    action: row.action ? (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {mutedIds.has(row.id) && canManage && (
          <UnmuteButton onDone={onChanged} workflowId={row.id} />
        )}
        <Link
          className={`text-xs underline underline-offset-4 ${TOUCH_TARGET}`}
          href={row.href}
        >
          {row.action}
        </Link>
      </div>
    ) : undefined,
    testId: mutedIds.has(row.id) ? "failure-alerts-muted-workflow" : undefined,
  }));

  const workflowSection = workflowIssues.length > 0 && (
    <IssueSection
      description="Workflows that are failing or not running, muted, or whose own methods stopped working."
      issues={workflowIssues}
      testId="failure-alerts-failing"
      title="Workflows that need attention"
    />
  );
  const workflowsFirst = workflowIssues.some((i) => i.tone === "danger");

  let healthState = "healthy";
  if (unreachable) {
    healthState = "unreachable";
  } else if (setupIssues.length + workflowIssues.length > 0) {
    healthState = "attention";
  }

  return (
    <div
      className="space-y-5"
      data-state={healthState}
      data-testid="failure-alerts-health"
    >
      {/* A failing workflow is the most urgent thing on the page, so it goes first. */}
      {workflowsFirst && workflowSection}
      {setupIssues.length > 0 && (
        <IssueSection
          description="Problems with who gets alerts and how they are sent."
          issues={setupIssues}
          testId="failure-alerts-setup-issues"
          title="Setup that needs attention"
        />
      )}
      {!workflowsFirst && workflowSection}
      {setupIssues.length === 0 && workflowIssues.length === 0 && (
        <HealthyLine>
          No workflow is failing and every method works.
          {data.lastAlertDeliveredAt
            ? null
            : " No alert sent yet: use Test on a method in Setup to see one arrive."}
        </HealthyLine>
      )}
    </div>
  );
}
