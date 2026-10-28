"use client";

import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import Link from "next/link";
import { timeAgo } from "@/components/settings/hub/relative-time";
import { Notice, WARNING_TEXT } from "@/components/ui/notice";
import {
  channelLabel,
  type OrgSettingsView,
} from "@/lib/notifications/failure-alerts/view-types";
import { cn } from "@/lib/utils";
import { failedRuns, formatWhen } from "./format";
import { channelWorks } from "./method-drafts";
import { AlertsPausedNotice } from "./pause-alerts";

type StatusState = "paused" | "unreachable" | "failing" | "single" | "quiet";

const ICON_CLASS = "mt-0.5 size-4 shrink-0";

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
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
          <div className="text-muted-foreground text-xs">{children}</div>
        )}
      </div>
    </div>
  );
}

/**
 * "Is it working?" in one card: paused, nobody reachable, failing, a single
 * point of failure or all quiet; the last delivery; the email cap; and the
 * workflows failing now.
 */
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
    channelLabel(c.kind, c.destination, c.connectionName);

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

  const reach = [
    people.length > 0 ? plural(people.length, "person", "people") : "",
    working.length > 0 ? plural(working.length, "method", "methods") : "",
  ].filter(Boolean);
  const reachLine =
    reach.length > 0 ? `${reach.join(" and ")} can be reached.` : "";
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
        />
      )}
      {state === "unreachable" && (
        <Headline
          title="Nobody can be reached: nobody will be told when a workflow fails"
          tone="danger"
        >
          No chosen person has an email KeeperHub can reach, and no other method
          works.{" "}
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
          <Notice tone={capped ? "danger" : "warning"}>
            {capped
              ? `All ${usage.limit} alert emails for this month are used. Until the 1st, alerts go to chat and PagerDuty only, which still work.`
              : `Free plan: ${usage.used} of ${usage.limit} alert emails used this month. After ${usage.limit}, alerts go to chat and PagerDuty only, which still work.`}
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
                    : `${w.openedBy === "funding" ? "Wallet out of funds, " : ""}${failedRuns(w.failureCount)} in a row, alert sent ${timeAgo(w.openedAt)}`}
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
