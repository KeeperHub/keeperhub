"use client";

import { useCallback } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { authClient } from "@/lib/auth-client";
import {
  type OrganizationWithRole,
  useOrganizations,
} from "@/lib/hooks/use-organization";
import { useSettingsContext } from "../settings-context";

export type OrganizationListState = {
  organizations: OrganizationWithRole[];
  loading: boolean;
  rename: (organizationId: string, name: string) => Promise<boolean>;
  create: (name: string, slug: string) => Promise<boolean>;
};

export function useOrganizationList(): OrganizationListState {
  const { refreshAll } = useSettingsContext();
  const { organizations, isLoading, refetch } = useOrganizations();

  const rename = useCallback(
    async (organizationId: string, name: string): Promise<boolean> => {
      try {
        await api.organization.updateName(organizationId, { name });
        toast.success("Organization renamed");
        await refetch();
        refreshAll();
        return true;
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to rename"
        );
        return false;
      }
    },
    [refetch, refreshAll]
  );

  const create = useCallback(
    async (name: string, slug: string): Promise<boolean> => {
      try {
        const { data, error } = await authClient.organization.create({
          name,
          slug,
        });
        if (error) {
          toast.error(error.message || "Failed to create organization");
          return false;
        }
        const orgId = (data as { id: string } | null)?.id;
        if (!orgId) {
          return false;
        }
        await authClient.organization.setActive({ organizationId: orgId });
        toast.success(`Organization "${name}" created`);
        await refetch();
        refreshAll();
        return true;
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "An error occurred"
        );
        return false;
      }
    },
    [refetch, refreshAll]
  );

  return {
    create,
    loading: isLoading,
    organizations,
    rename,
  };
}
