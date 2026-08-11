"use client";

import { getDefaultStore, useSetAtom } from "jotai";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { invalidateFeatureSnapshot } from "@/hooks/use-features";
import { api } from "@/lib/api-client";
import { analyticsProjectIdAtom } from "@/lib/atoms/analytics";
import { authClient } from "@/lib/auth-client";
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
    getDefaultStore().set(resetWorkflowStateForOrgSwitchAtom);
    setAnalyticsProjectId(null);
    invalidateFeatureSnapshot();
    refetchSidebar();

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

export type OrganizationWithRole = {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  createdAt: string;
  metadata: string | null;
  role: string;
};

export function useOrganizations() {
  const [organizations, setOrganizations] = useState<OrganizationWithRole[]>(
    []
  );
  const [isLoading, setIsLoading] = useState(true);

  const refetch = useCallback(async () => {
    try {
      const response = await fetch("/api/organizations");
      if (response.ok) {
        const data = (await response.json()) as OrganizationWithRole[];
        setOrganizations(data);
      }
    } catch (error) {
      console.error("Failed to fetch organizations:", error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  // Register this hook's refetch callback so it can be triggered externally
  useEffect(
    () =>
      registerOrganizationRefetch(() => {
        refetch();
      }),
    [refetch]
  );

  return {
    organizations,
    isLoading,
    refetch,
  };
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
