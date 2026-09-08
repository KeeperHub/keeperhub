"use client";

import { useSetAtom } from "jotai";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { invalidateFeatureSnapshot } from "@/hooks/use-features";
import { api } from "@/lib/api-client";
import { analyticsProjectIdAtom } from "@/lib/atoms/analytics";
import { authClient } from "@/lib/auth-client";
import { useOrganizationsData } from "@/lib/hooks/use-org-data";
import { registerOrganizationRefetch } from "@/lib/refetch-organizations";
import { refetchSidebar } from "@/lib/refetch-sidebar";
import { resetWorkflowStateForOrgSwitchAtom } from "@/lib/workflow/store";

export function useOrganization() {
  const {
    data: activeOrg,
    isPending,
    error,
    refetch,
  } = authClient.useActiveOrganization();
  const router = useRouter();
  const pathname = usePathname();
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

  const switchOrganization = async (orgId: string) => {
    await authClient.organization.setActive({ organizationId: orgId });
    // Reset workflow state only after org switch succeeds (safe in hook context)
    resetWorkflowStateForOrgSwitch();
    setAnalyticsProjectId(null);
    invalidateFeatureSnapshot();
    refetchSidebar();

    // Org-scoped settings carry the organization in the path, so switching has
    // to rewrite it. Otherwise the route would keep pointing at the previous
    // org and immediately switch back to it.
    if (pathname.startsWith("/settings/")) {
      const parts = pathname.split("/");
      if (parts.length > 3) {
        parts[2] = orgId;
        router.push(parts.join("/"));
      } else {
        router.refresh();
      }
      return;
    }

    // Stay on non-workflow pages (e.g. /analytics, /hub, /billing) after switching orgs
    const isWorkflowPage = pathname.startsWith("/workflows/");
    if (!isWorkflowPage) {
      router.refresh();
      return;
    }

    try {
      const list = await api.workflow.getAll();
      // Sort by createdAt descending to get the most recent workflow
      const mostRecent = list.sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      )[0];
      if (mostRecent) {
        router.replace(`/workflows/${mostRecent.id}`);
      } else {
        router.replace("/");
      }
    } catch (fetchError) {
      console.error("Failed to fetch workflows after org switch:", fetchError);
      router.replace("/");
    }
  };

  return {
    organization: activeOrg,
    isLoading: isPending,
    error,
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
  const { data: organizations, isLoading, refetch } = useOrganizationsData();
  return { organizations, isLoading, refetch };
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
