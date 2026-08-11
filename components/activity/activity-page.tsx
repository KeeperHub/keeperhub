"use client";

import { Download, LogIn, Search } from "lucide-react";
import { useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { ActivityFeed } from "@/components/activity/activity-feed";
import { ActivityMemberPreview } from "@/components/activity/activity-member-preview";
import { AuditFilterBar } from "@/components/activity/audit-filter-bar";
import { useAuthPrompt } from "@/components/auth/provider";
import { ExportAuditOverlay } from "@/components/overlays/export-audit-overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSession } from "@/lib/auth-client";
import {
  DEFAULT_AUDIT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  useAuditActivity,
} from "@/lib/hooks/use-audit-activity";
import { useActiveMember } from "@/lib/hooks/use-organization";

/**
 * In-page sign-in panel for the Activity route. Signed-out users reach the page
 * (the nav item is visible to everyone) and get a sign-in prompt here rather
 * than being bounced home.
 */
function ActivityGuestGate(): ReactNode {
  const { openAuthPrompt } = useAuthPrompt();
  return (
    <div className="pointer-events-auto fixed inset-0 overflow-y-auto bg-sidebar">
      <div className="transition-[margin-left] duration-200 ease-out md:ml-[var(--nav-content-offset,var(--nav-sidebar-width,60px))]">
        <div className="flex min-h-[80vh] flex-col items-center justify-center gap-6 p-6 text-center">
          <div className="flex size-20 items-center justify-center rounded-2xl bg-muted">
            <LogIn className="size-10 text-muted-foreground" />
          </div>
          <div className="space-y-2">
            <h2 className="font-semibold text-xl tracking-tight">
              Sign in to view activity
            </h2>
            <p className="max-w-sm text-muted-foreground text-sm">
              Sign in to see security-sensitive actions across your
              organization.
            </p>
          </div>
          <Button
            onClick={() =>
              openAuthPrompt({
                action: "nav:activity",
                redirectTo: "/activity",
              })
            }
          >
            Sign in
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Full activity feed for owners and admins -- the real, server-backed view.
 * Isolated in its own component so the audit data hook only runs for the roles
 * allowed to read it.
 */
function ActivityAdminView(): ReactNode {
  const { isOwner } = useActiveMember();
  const { push } = useOverlay();
  const searchParams = useSearchParams();
  // Seed page size from the URL so a shared/refreshed ?size=N is honored; an
  // out-of-range value falls back to the default.
  const sizeParam = Number.parseInt(searchParams.get("size") ?? "", 10);
  const initialPageSize = (PAGE_SIZE_OPTIONS as readonly number[]).includes(
    sizeParam
  )
    ? sizeParam
    : DEFAULT_AUDIT_PAGE_SIZE;
  // Seed the search box from ?q so a shared/refreshed search is honored.
  const initialSearch = (searchParams.get("q") ?? "").slice(0, 200);
  const activity = useAuditActivity({ initialPageSize, initialSearch });

  return (
    <div className="pointer-events-auto fixed inset-0 flex flex-col overflow-hidden bg-sidebar">
      <div className="flex min-h-0 flex-1 flex-col transition-[margin-left] duration-200 ease-out md:ml-[var(--nav-content-offset,var(--nav-sidebar-width,60px))]">
        <div className="flex min-h-0 flex-1 flex-col gap-6 p-6 pt-[calc(5rem+var(--app-banner-height,0px))]">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1">
              <h1 className="font-semibold text-2xl tracking-tight">
                Organization activity
              </h1>
              <p className="text-muted-foreground text-sm">
                Recent security-sensitive actions across your organization.
              </p>
            </div>
            <Button
              disabled={!isOwner}
              onClick={() =>
                push(ExportAuditOverlay, {
                  resourceTypes: activity.types,
                })
              }
              size="sm"
              title={
                isOwner ? undefined : "Only organization owners can export"
              }
              variant="outline"
            >
              <Download className="mr-2 size-4" />
              Export CSV
            </Button>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-1 flex-wrap items-center gap-2">
              <div className="relative w-full max-w-xs">
                <Search className="-translate-y-1/2 absolute top-1/2 left-2.5 size-4 text-muted-foreground" />
                <Input
                  className="h-8 pl-8 text-sm"
                  onChange={(e) => activity.setSearchText(e.target.value)}
                  placeholder="Search name, email, workflow, IP..."
                  value={activity.searchText}
                />
              </div>
              <AuditFilterBar activity={activity} />
            </div>
            <Select
              onValueChange={(v) => activity.setPageSize(Number(v))}
              value={String(activity.pageSize)}
            >
              <SelectTrigger className="h-8 w-28 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAGE_SIZE_OPTIONS.map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size} / page
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <ActivityFeed
            fillHeight
            params={activity.feedParams}
            syncPageToUrl
            urlPageSizeDefault={DEFAULT_AUDIT_PAGE_SIZE}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Full-page organization activity feed, reachable at /activity from the left
 * nav (visible to everyone). What's shown depends on the viewer's role in the
 * active org: owners/admins get the real feed, members get a labelled sample,
 * and signed-out users get an in-page sign-in prompt. The read endpoint is
 * gated the same way server-side, so the member/guest views never hold real
 * audit data. Re-evaluates on org switch via useActiveMember.
 */
export function ActivityPage(): ReactNode {
  const { data: session, isPending } = useSession();
  const { isAdmin, isLoading } = useActiveMember();

  if (isPending) {
    return null;
  }

  const signedIn = Boolean(session?.user) && !session?.user?.isAnonymous;
  if (!signedIn) {
    return <ActivityGuestGate />;
  }

  // Wait for the active-org membership to resolve before choosing member vs
  // admin, so a switch doesn't flash the wrong view.
  if (isLoading) {
    return null;
  }

  if (!isAdmin) {
    return <ActivityMemberPreview />;
  }

  return <ActivityAdminView />;
}
