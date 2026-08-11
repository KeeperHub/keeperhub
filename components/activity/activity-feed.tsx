"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiKeysOverlay } from "@/components/overlays/api-keys-overlay";
import { IntegrationsOverlay } from "@/components/overlays/integrations-overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { Skeleton } from "@/components/ui/skeleton";
import { groupByDate } from "@/lib/activity/time-groups";
import { api, type SecurityAuditEvent } from "@/lib/api-client";
import { authClient } from "@/lib/auth-client";
import { usePaginatedResource } from "@/lib/hooks/use-paginated-resource";
import type { PageMeta } from "@/lib/pagination";
import { ActivityRow } from "./activity-row";
import { Pager } from "./pager";

type FeedParams = {
  resourceType?: string;
  resourceTypes?: string[];
  resourceId?: string;
  resourceIds?: string[];
  projectIds?: string[];
  tagIds?: string[];
  workflowIds?: string[];
  action?: string;
  actorUserId?: string;
  actorUserIds?: string[];
  from?: string;
  to?: string;
  search?: string;
  limit?: number;
};

// Synthesized baseline entries stand in for a resource's creation when no
// audit event was ever recorded (it pre-dates auditing). A creation is the
// OLDEST event for its resource, so it belongs on the last/oldest page -- never
// page 1, where appending it would overflow the page size and show the
// "creation" out of order. On the last page we drop any fallback whose resource
// already has a real ".created" event there, then merge the rest in date order.
function mergeFallback(
  events: SecurityAuditEvent[],
  fallback: SecurityAuditEvent[] | undefined,
  meta: PageMeta | null
): SecurityAuditEvent[] {
  if (!fallback?.length) {
    return events;
  }
  const onLastPage = !meta || meta.page >= meta.totalPages;
  if (!onLastPage) {
    return events;
  }
  const covered = new Set(
    events
      .filter((e) => e.action.endsWith(".created") && e.resourceId)
      .map((e) => e.resourceId)
  );
  const extra = fallback.filter(
    (f) => !(f.resourceId && covered.has(f.resourceId))
  );
  if (extra.length === 0) {
    return events;
  }
  return [...events, ...extra].sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : -1
  );
}

// Stable keys for the placeholder rows so the skeleton list doesn't key on
// the array index.
const SKELETON_KEYS = ["a", "b", "c", "d", "e", "f"] as const;

function SkeletonRow(): React.ReactElement {
  return (
    <li className="flex items-start gap-3 py-3">
      <Skeleton className="size-7 shrink-0 rounded-full" />
      <div className="flex-1 space-y-2 py-0.5">
        <Skeleton className="h-3.5 w-2/5" />
        <Skeleton className="h-3 w-3/5" />
        <Skeleton className="h-3 w-1/4" />
      </div>
    </li>
  );
}

export function ActivityFeed({
  params,
  fallback,
  embedded = false,
  fillHeight = false,
  syncPageToUrl = false,
  urlPageSizeDefault,
}: {
  params?: FeedParams;
  fallback?: SecurityAuditEvent[];
  /**
   * When the feed lives inside an already-scrolling container (e.g. the
   * Settings overlay), set this to skip the feed's own fixed-height scroll box
   * and avoid a nested second scrollbar; the parent owns scrolling.
   */
  embedded?: boolean;
  /**
   * Full-page mode: the feed grows to fill its flex parent and the pager is
   * pinned to the bottom of that space (the list scrolls between header and
   * pager). The parent must be a flex column with a bounded height.
   */
  fillHeight?: boolean;
  /**
   * Reflect the current page and page size in the URL (`?page=N&size=M`) and
   * seed them from it, so the feed is deep-linkable and survives refresh/back.
   * Page size is seeded by the caller (via params.limit); this only writes it
   * back. Only makes sense for a route-backed feed, not an overlay.
   */
  syncPageToUrl?: boolean;
  /**
   * The page size considered "default" when syncing to the URL: at this size
   * the `size` param is omitted to keep the URL clean. Defaults to the limit
   * being absent (always write when a limit is set).
   */
  urlPageSizeDefault?: number;
}): React.ReactElement {
  const resourceType = params?.resourceType;
  const resourceTypes = params?.resourceTypes;
  const resourceId = params?.resourceId;
  const resourceIds = params?.resourceIds;
  const projectIds = params?.projectIds;
  const tagIds = params?.tagIds;
  const workflowIds = params?.workflowIds;
  const action = params?.action;
  const actorUserId = params?.actorUserId;
  const actorUserIds = params?.actorUserIds;
  const from = params?.from;
  const to = params?.to;
  const search = params?.search;
  const limit = params?.limit;

  // Open the event's resource: workflows leave for their editor's History tab
  // (deep-linked to the exact version when known); integrations and API keys
  // open their management modal on top of the feed.
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // Scope the feed to the active org: switching orgs must reset to page 1 and
  // refetch. router.refresh() (fired by the org switcher) re-renders server
  // components but keeps this client state, so without the org in the reset key
  // the feed would keep showing the previous org's events.
  const { data: activeOrg } = authClient.useActiveOrganization();
  const activeOrgId = activeOrg?.id ?? null;
  const initialPage = syncPageToUrl
    ? Math.max(1, Number.parseInt(searchParams.get("page") ?? "", 10) || 1)
    : 1;
  const { closeAll, push } = useOverlay();
  const openResource = useCallback(
    (event: SecurityAuditEvent) => {
      if (!event.resourceId) {
        return;
      }
      if (event.resourceType === "workflow") {
        closeAll();
        const versionQuery =
          event.version === null ? "" : `&version=${event.version}`;
        router.push(
          `/workflows/${event.resourceId}?tab=history${versionQuery}`
        );
        return;
      }
      if (event.resourceType === "integration") {
        push(IntegrationsOverlay, { highlightId: event.resourceId });
        return;
      }
      if (
        event.resourceType === "api_key" ||
        event.resourceType === "org_api_key"
      ) {
        const highlightType: "api_key" | "org_api_key" = event.resourceType;
        push(ApiKeysOverlay, {
          highlightId: event.resourceId,
          highlightType,
        });
      }
    },
    [router, closeAll, push]
  );

  const {
    items: events,
    meta,
    page,
    setPage,
    loading,
    error,
    reload,
  } = usePaginatedResource<SecurityAuditEvent>(
    (page) =>
      api.security.getAudit({
        resourceType,
        resourceTypes,
        resourceId,
        resourceIds,
        projectIds,
        tagIds,
        workflowIds,
        action,
        actorUserId,
        actorUserIds,
        from,
        to,
        search,
        page,
        limit,
      }),
    // `limit` (page size) is intentionally NOT part of the reset key: changing
    // the page size keeps the current page (it just refetches via the effect
    // below). Only the actual filters -- and the active org -- reset the feed
    // back to page 1.
    JSON.stringify({
      orgId: activeOrgId,
      resourceType,
      resourceTypes,
      resourceId,
      resourceIds,
      projectIds,
      tagIds,
      workflowIds,
      action,
      actorUserId,
      actorUserIds,
      from,
      to,
      search,
    }),
    { initialPage }
  );

  // Page size lives outside the reset key, so refetch the current page when it
  // changes (skip the first render -- the initial fetch already covers it).
  const didMountLimitRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: limit is the change trigger, not read in the body
  useEffect(() => {
    if (didMountLimitRef.current) {
      reload();
    } else {
      didMountLimitRef.current = true;
    }
  }, [limit, reload]);

  // Reflect the active page + size in the URL when asked (route-backed feed
  // only), dropping each param at its default (page 1 / default size) so the
  // URL stays clean. This is the single writer for both params, so size and
  // page changes never race each other. Reading searchParams here only to
  // preserve sibling params; it is intentionally not a dep -- our own replace
  // would otherwise loop.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see note above
  useEffect(() => {
    if (!syncPageToUrl) {
      return;
    }
    const next = new URLSearchParams(searchParams.toString());
    if (page > 1) {
      next.set("page", String(page));
    } else {
      next.delete("page");
    }
    if (limit && limit !== urlPageSizeDefault) {
      next.set("size", String(limit));
    } else {
      next.delete("size");
    }
    if (search) {
      next.set("q", search);
    } else {
      next.delete("q");
    }
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [
    syncPageToUrl,
    page,
    limit,
    search,
    urlPageSizeDefault,
    pathname,
    router,
  ]);

  // Capture the settled content height so the skeleton can hold it on the next
  // load. Without this the embedded feed (no fixed box) collapses to the
  // skeleton's natural height and back, jumping the modal on every filter/page
  // change. Per-resource overlays use the fixed box below instead.
  const listRef = useRef<HTMLDivElement>(null);
  const [reservedHeight, setReservedHeight] = useState<number>();
  useEffect(() => {
    if (embedded && !fillHeight && !loading && listRef.current) {
      setReservedHeight(listRef.current.offsetHeight);
    }
  }, [embedded, fillHeight, loading]);

  // Three layout modes:
  // - fillHeight (full page): the list grows to fill the flex parent and scrolls
  //   internally, so the Pager stays pinned at the bottom of the viewport.
  // - embedded (already-scrolling overlay): no box, the parent owns scrolling.
  // - default (per-resource overlay): a fixed-height box so the modal never
  //   resizes; content taller than the box scrolls inside it.
  let scrollClass: string;
  if (fillHeight) {
    scrollClass = "thin-scrollbar min-h-0 flex-1 overflow-y-auto";
  } else if (embedded) {
    scrollClass = "";
  } else {
    scrollClass = `thin-scrollbar overflow-y-auto ${limit ? "h-[32rem]" : ""}`;
  }

  // In fillHeight mode the feed is a flex column so the list (flex-1) pushes the
  // Pager to the bottom; other modes keep the natural block flow.
  const rootClass = fillHeight ? "flex min-h-0 flex-1 flex-col" : undefined;
  const pagerClass = fillHeight ? "border-border/60 border-t pt-3" : "pt-2";

  // Skeletons show on every load in both modes. In the fixed box the swap is
  // absorbed; when embedded, the skeleton holds the last content height
  // (reservedHeight) so the modal doesn't jump.
  if (loading) {
    return (
      <div className={rootClass}>
        <div
          className={scrollClass}
          style={
            embedded && !fillHeight ? { minHeight: reservedHeight } : undefined
          }
        >
          <ul>
            {SKELETON_KEYS.slice(
              0,
              Math.min(limit ?? 3, SKELETON_KEYS.length)
            ).map((key) => (
              <SkeletonRow key={key} />
            ))}
          </ul>
        </div>
        {meta && (
          <div className={pagerClass}>
            <Pager meta={meta} onPage={setPage} unit="events" />
          </div>
        )}
      </div>
    );
  }

  if (error) {
    return (
      <div className={scrollClass}>
        <p className="py-4 text-muted-foreground text-sm">
          Failed to load activity.
        </p>
      </div>
    );
  }

  const merged = mergeFallback(events, fallback, meta);

  if (merged.length === 0) {
    return (
      <div className={scrollClass}>
        <p className="py-4 text-muted-foreground text-sm">
          No activity recorded yet.
        </p>
      </div>
    );
  }

  const groups = groupByDate(merged, (e) => e.createdAt);

  return (
    <div className={rootClass}>
      <div className={scrollClass} ref={listRef}>
        {groups.map((group) => (
          <div key={group.label}>
            <p className="sticky top-0 z-10 mb-2 border-border/60 border-b bg-background pt-6 pb-2 font-medium text-muted-foreground text-xs uppercase tracking-wide first:pt-0">
              {group.label}
            </p>
            <ul>
              {group.items.map((event) => (
                <ActivityRow
                  event={event}
                  key={event.id}
                  // A single-resource feed (e.g. a per-resource overlay) is
                  // already that resource's history, so its rows don't drill in.
                  onOpen={resourceId ? undefined : openResource}
                />
              ))}
            </ul>
          </div>
        ))}
      </div>
      {meta && (
        <div className={pagerClass}>
          <Pager meta={meta} onPage={setPage} unit="events" />
        </div>
      )}
    </div>
  );
}
