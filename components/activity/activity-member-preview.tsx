"use client";

import { Info } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { groupByDate } from "@/lib/activity/time-groups";
import type { SecurityAuditEvent } from "@/lib/api-client";
import { ActivityRow } from "./activity-row";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Synthetic sample rows shown to members, who can't read the real audit log
// (the endpoint 403s them). Names/emails are fictional and IPs are from the
// 203.0.113.0/24 documentation range, so nothing real ever reaches a member's
// browser.
function buildSampleEvents(now: number): SecurityAuditEvent[] {
  return [
    {
      id: "sample-1",
      action: "workflow.updated",
      resourceType: "workflow",
      resourceId: null,
      resourceName: "Treasury rebalance",
      version: 8,
      createdAt: new Date(now - 2 * HOUR_MS).toISOString(),
      diff: [{ kind: "E", path: ["schedule"], lhs: "Daily", rhs: "Hourly" }],
      metadata: { ip: "203.0.113.10", country: "US" },
      actor: {
        id: "sample-a",
        name: "Jordan Lee",
        email: "jordan@example.com",
        role: "admin",
      },
    },
    {
      id: "sample-2",
      action: "integration.created",
      resourceType: "integration",
      resourceId: null,
      resourceName: "Discord",
      version: null,
      createdAt: new Date(now - 6 * HOUR_MS).toISOString(),
      diff: null,
      metadata: { ip: "203.0.113.24", country: "DE" },
      actor: {
        id: "sample-b",
        name: "Sam Rivera",
        email: "sam@example.com",
        role: "owner",
      },
    },
    {
      id: "sample-3",
      action: "member.invited",
      resourceType: "member",
      resourceId: null,
      resourceName: null,
      version: null,
      createdAt: new Date(now - DAY_MS - 3 * HOUR_MS).toISOString(),
      diff: null,
      metadata: { ip: "203.0.113.51", country: "GB" },
      actor: {
        id: "sample-c",
        name: "Avery Stone",
        email: "avery@example.com",
        role: "owner",
      },
    },
    {
      id: "sample-4",
      action: "api_key.revoked",
      resourceType: "api_key",
      resourceId: null,
      resourceName: "CI deploy key",
      version: null,
      createdAt: new Date(now - 2 * DAY_MS).toISOString(),
      diff: null,
      metadata: { ip: "203.0.113.77", country: "US" },
      actor: {
        id: "sample-d",
        name: "Jordan Lee",
        email: "jordan@example.com",
        role: "admin",
      },
    },
  ];
}

/**
 * Members can see that an activity log exists, but not its contents. This shows
 * a labelled sample of the page with a banner pointing to the role that unlocks
 * the real data. It never calls the audit endpoint -- the rows are mock data.
 */
export function ActivityMemberPreview(): ReactNode {
  const groups = useMemo(() => {
    const events = buildSampleEvents(Date.now());
    return groupByDate(events, (e) => e.createdAt);
  }, []);

  return (
    <div className="pointer-events-auto fixed inset-0 flex flex-col overflow-hidden bg-sidebar">
      <div className="flex min-h-0 flex-1 flex-col transition-[margin-left] duration-200 ease-out md:ml-[var(--nav-content-offset,var(--nav-sidebar-width,60px))]">
        <div className="flex min-h-0 flex-1 flex-col gap-6 p-6 pt-[calc(5rem+var(--app-banner-height,0px))]">
          <div className="space-y-1">
            <h1 className="font-semibold text-2xl tracking-tight">
              Organization activity
            </h1>
            <p className="text-muted-foreground text-sm">
              Recent security-sensitive actions across your organization.
            </p>
          </div>

          <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/40 p-4">
            <Info className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
            <div className="space-y-0.5">
              <p className="font-medium text-sm">Sample activity</p>
              <p className="text-muted-foreground text-sm">
                This is example data. The full organization activity log is
                visible to Owners and Admins.
              </p>
            </div>
          </div>

          <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto">
            {groups.map((group) => (
              <div key={group.label}>
                <p className="sticky top-0 z-10 mb-2 border-border/60 border-b bg-background pt-6 pb-2 font-medium text-muted-foreground text-xs uppercase tracking-wide first:pt-0">
                  {group.label}
                </p>
                <ul>
                  {group.items.map((event) => (
                    <ActivityRow event={event} key={event.id} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
