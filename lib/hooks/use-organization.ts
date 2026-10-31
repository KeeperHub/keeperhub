"use client";

import { useSetAtom } from "jotai";
import { useRouter } from "next/navigation";
import { useCallback, useEffect } from "react";
import { invalidateFeatureSnapshot } from "@/hooks/use-features";
import { api } from "@/lib/api-client";
import { analyticsProjectIdAtom } from "@/lib/atoms/analytics";
import { authClient } from "@/lib/auth-client";
import { useOrganizationsData } from "@/lib/hooks/use-org-data";
import { registerOrganizationRefetch } from "@/lib/refetch-organizations";
import { refetchSidebar } from "@/lib/refetch-sidebar";
import { latestVisibleWorkflow } from "@/lib/workflow/latest-workflow";
import { resetWorkflowStateForOrgSwitchAtom } from "@/lib/workflow/store";

type ActiveOrgState = {
  data: { id: string } | null;
  isPending: boolean;
  isRefetching: boolean;
};

// How often a switch asks for the active org again when its refresh did not
// show the new one (a blip: a timeout, too many requests), and how long it
// waits before each.
const SHOW_RETRY_DELAYS_MS = [500, 1500];

// The auth client starts its own refresh of the active org a few
// milliseconds after an organization request answers (setActive among
// them); a switch waits this long for it before asking for one itself.
const OWN_REFRESH_GRACE_MS = 100;
// One wait for a refresh lasts no longer than this (a refresh that hangs).
const SHOW_WAIT_LIMIT_MS = 2500;
// And a switch waits for its org to show no longer than this in all.
const SHOW_TOTAL_LIMIT_MS = 8000;

/**
 * Resolves once the auth client's active org is `orgId` (true), or once a
 * refresh has answered without it, or `limitMs` has passed (false). The
 * first wait gives the auth client `askAfterMs` to start its own refresh
 * before asking for one, so a switch does not load the active org twice; a
 * retry (`ask`) sends its own request at once, so one that hangs is not
 * waited on again.
 */
function whenActiveOrgShows(
  orgId: string,
  refetch: () => Promise<unknown>,
  {
    askAfterMs,
    ask,
    limitMs,
  }: { askAfterMs: number; ask: boolean; limitMs: number }
): Promise<boolean> {
  const atom = authClient.$store.atoms.activeOrganization;
  return new Promise((resolve) => {
    let started = false;
    let settled = false;
    let unlisten: () => void = () => undefined;
    let limit: ReturnType<typeof setTimeout> | undefined;
    const finish = (shown: boolean): void => {
      if (!settled) {
        settled = true;
        unlisten();
        clearTimeout(limit);
        resolve(shown);
      }
    };
    const check = (state: ActiveOrgState): void => {
      if (state.isPending || state.isRefetching) {
        started = true;
      } else if (state.data?.id === orgId) {
        finish(true);
      } else if (started) {
        finish(false);
      }
    };
    unlisten = atom.listen(check);
    check(atom.get());
    // A retry's own request, or, for the first wait, one where none is
    // under way by then (or the auth client's has been and gone).
    setTimeout(() => {
      if (!settled && (ask || !started)) {
        started = true;
        refetch();
      }
    }, askAfterMs);
    limit = setTimeout(() => finish(false), limitMs);
  });
}

/** The active org's id as the auth client holds it now, not as last rendered. */
export function currentActiveOrgId(): string | undefined {
  return authClient.$store.atoms.activeOrganization.get().data?.id;
}

// The auth server's answers that the active org is gone: not found (400:
// deleted; 404 taken the same way) or not a member (403: removed from it).
// Every other failure (no answer, a timeout, too many requests, the
// server's own error) may pass, and there may still be an org.
const GONE_STATUSES: ReadonlySet<number> = new Set([400, 403, 404]);

// Whether the active org's request failed in a way a retry can mend: not
// knowing it is not having none. An org that is gone is as none active.
function couldNotLoad(error: { status?: number } | null | undefined): boolean {
  if (!error) {
    return false;
  }
  return !GONE_STATUSES.has(error.status ?? 0);
}

/** Whether the active org's last request failed in a way a retry can mend. */
export function activeOrgLoadFailed(): boolean {
  return couldNotLoad(authClient.$store.atoms.activeOrganization.get().error);
}

export function useOrganization() {
  const {
    data: activeOrg,
    isPending,
    error,
    refetch,
  } = authClient.useActiveOrganization();
  const router = useRouter();
  const setAnalyticsProjectId = useSetAtom(analyticsProjectIdAtom);
  // Through the hook, not getDefaultStore: the app mounts its own jotai store
  // in app/layout.tsx, and a write to the default one lands where nothing is
  // reading, which is why this reset never ran.
  const resetWorkflowStateForOrgSwitch = useSetAtom(
    resetWorkflowStateForOrgSwitchAtom
  );

  // Register this hook's refetch callback so it can be triggered externally
  useEffect(
    () =>
      registerOrganizationRefetch(() => {
        console.log("[useOrganization] Refetching active organization...");
        refetch();
      }),
    [refetch]
  );

  // Resolves to whether the switch took: the auth client reports a failure
  // instead of throwing. A failed switch changes nothing here.
  // `fromPath`: the page to switch from, for a caller already leaving the
  // one shown.
  const switchOrganization = useCallback(
    async (orgId: string, fromPath?: string): Promise<boolean> => {
      const { error: switchError } = await authClient.organization.setActive({
        organizationId: orgId,
      });
      if (switchError) {
        return false;
      }
      // Resolves once the new org is the one shown (or its wait is over),
      // so callers (and the switchers waiting on them) never act on a page
      // with no org active. A refresh that did not show it (a blip, or one
      // that hangs) is asked for again, a little later, with a request of
      // its own, all within SHOW_TOTAL_LIMIT_MS. The server has switched
      // either way, and every request now runs as the new org, so the
      // switch is made; whether the page shows it, the caller reads from
      // the auth client (the switch runner says when it does not).
      const deadline = Date.now() + SHOW_TOTAL_LIMIT_MS;
      const waitFor = (askAfterMs: number, ask: boolean): Promise<boolean> =>
        whenActiveOrgShows(orgId, refetch, {
          askAfterMs,
          ask,
          limitMs: Math.min(
            SHOW_WAIT_LIMIT_MS,
            Math.max(0, deadline - Date.now())
          ),
        });
      // First the refresh the auth client starts itself after setActive.
      let shown = await waitFor(OWN_REFRESH_GRACE_MS, false);
      for (const delay of SHOW_RETRY_DELAYS_MS) {
        if (shown || deadline - Date.now() <= delay) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
        shown = await waitFor(0, true);
      }
      const open = (href: string, replace: boolean): void => {
        if (replace) {
          router.replace(href);
        } else {
          router.push(href);
        }
      };
      // Otherwise the page as it is now: a retry can come after the page has
      // changed.
      const pathname = fromPath ?? window.location.pathname;
      const reload = (): void => {
        router.refresh();
      };
      // Reset workflow state only after the switch took (safe in hook context).
      resetWorkflowStateForOrgSwitch();
      setAnalyticsProjectId(null);
      invalidateFeatureSnapshot();
      refetchSidebar({ orgChanged: true });

      // Org-scoped settings carry the organization in the path, so switching has
      // to rewrite it. Otherwise the route would keep pointing at the previous
      // org and immediately switch back to it.
      if (pathname.startsWith("/settings/")) {
        const parts = pathname.split("/");
        if (parts.length > 3) {
          parts[2] = orgId;
          open(parts.join("/"), false);
        } else {
          reload();
        }
        return true;
      }

      // Stay on non-workflow pages (e.g. /analytics, /hub, /billing) after switching orgs
      const isWorkflowPage = pathname.startsWith("/workflows/");
      if (!isWorkflowPage) {
        reload();
        return true;
      }

      try {
        // The new org's last-edited workflow the lists show (not the
        // internal __current__ one, nor a deleted one).
        const mostRecent = latestVisibleWorkflow(await api.workflow.getAll());
        open(mostRecent ? `/workflows/${mostRecent.id}` : "/", true);
      } catch (fetchError) {
        console.error(
          "Failed to fetch workflows after org switch:",
          fetchError
        );
        open("/", true);
      }
      return true;
    },
    [refetch, router, resetWorkflowStateForOrgSwitch, setAnalyticsProjectId]
  );

  return {
    organization: activeOrg,
    isLoading: isPending,
    error,
    // The active org could not be loaded, though there may be one.
    loadFailed: couldNotLoad(error),
    switchOrganization,
    refetch, // Keep exposing refetch for direct use
  };
}

export type { OrganizationWithRole } from "@/lib/atoms/organization";

/**
 * The organizations the user belongs to. One shared request no matter how many
 * components ask; see `lib/atoms/organization.ts`.
 */
export function useOrganizations() {
  const {
    data: organizations,
    isLoading,
    hasError,
    refetch,
    reload,
  } = useOrganizationsData();
  return { organizations, isLoading, hasError, refetch, reload };
}

export function useActiveMember() {
  // Use useActiveOrganization to get member info from the organization context
  const { data: activeOrg, isPending } = authClient.useActiveOrganization();

  // Get the session to find current user's membership
  const { data: session } = authClient.useSession();

  // Find the current user's member record in the active organization
  const member = activeOrg?.members?.find(
    (m: { userId: string }) => m.userId === session?.user?.id
  );

  return {
    member: member || null,
    isLoading: isPending,
    role: member?.role as "owner" | "admin" | "member" | undefined,
    isOwner: member?.role === "owner",
    isAdmin: member?.role === "admin" || member?.role === "owner",
  };
}

export function usePermissions() {
  const checkPermission = async (resource: string, actions: string[]) => {
    try {
      const result = await authClient.organization.hasPermission({
        permissions: { [resource]: actions },
      });
      // Handle both data.success and direct success property
      const typedResult = result as {
        data?: { success?: boolean };
        success?: boolean;
      } | null;
      return typedResult?.data?.success || typedResult?.success;
    } catch (error) {
      console.error("Permission check failed:", error);
      return false;
    }
  };

  const checkLocalPermission = (
    role: "owner" | "admin" | "member",
    resource: string,
    actions: string[]
  ) =>
    authClient.organization.checkRolePermission({
      role,
      permissions: { [resource]: actions },
    });

  return {
    checkPermission,
    checkLocalPermission,
  };
}
