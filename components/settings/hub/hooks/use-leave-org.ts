"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { ApiError, api } from "@/lib/api-client";
import { authClient, useSession } from "@/lib/auth-client";
import {
  useOrganization,
  useOrganizations,
} from "@/lib/hooks/use-organization";
import type { OrgMember } from "./use-org-members";

export type LeaveOrgState = {
  /** Accepted members other than you, the only people ownership can go to. */
  otherMembers: OrgMember[];
  /** You own it and nobody else does. */
  isOnlyOwner: boolean;
  /**
   * A sole owner with nobody to hand the organization to cannot leave: doing
   * so would strand it. Deleting is the way out.
   */
  canLeave: boolean;
  /** Leaving needs a new owner named first. */
  needsSuccessor: boolean;
  working: boolean;
  leave: (newOwnerMemberId?: string) => Promise<void>;
  remove: () => Promise<void>;
};

/**
 * Leaving and deleting an organization, with the rule that ties them: exactly
 * one owner is required, so the last one either passes it on or takes the
 * organization with them.
 */
export function useLeaveOrg(
  organizationId: string | null,
  organizationName: string,
  isOwner: boolean,
  members: OrgMember[]
): LeaveOrgState {
  const router = useRouter();
  const { data: session } = useSession();
  const { organizations, refetch } = useOrganizations();
  const { switchOrganization } = useOrganization();
  const [working, setWorking] = useState(false);

  const otherMembers = members.filter((m) => m.userId !== session?.user?.id);
  const ownerCount = members.filter((m) => m.role === "owner").length;
  const isOnlyOwner = isOwner && ownerCount === 1;
  const canLeave = !isOnlyOwner || otherMembers.length > 0;
  const needsSuccessor = isOnlyOwner && otherMembers.length > 0;

  // Whatever removed this organization, it is no longer somewhere to be.
  // Leaving the page comes first: the settings provider reconciles the active
  // organization from the URL, so lingering here would switch straight back
  // onto the one that was just removed. Replace rather than push, so back does
  // not return to a page whose organization is gone.
  const afterGone = useCallback(async (): Promise<void> => {
    router.replace("/settings");
    const next = organizations.find((o) => o.id !== organizationId);
    if (next) {
      await switchOrganization(next.id);
    }
    await refetch();
    router.refresh();
  }, [organizations, organizationId, switchOrganization, refetch, router]);

  const leave = useCallback(
    async (newOwnerMemberId?: string): Promise<void> => {
      if (!organizationId) {
        return;
      }
      setWorking(true);
      try {
        await api.organization.leave(organizationId, { newOwnerMemberId });
        toast.success(`Left ${organizationName}`);
        await afterGone();
      } catch (error) {
        toast.error(
          error instanceof ApiError
            ? error.message
            : "Could not leave the organization"
        );
      } finally {
        setWorking(false);
      }
    },
    [organizationId, organizationName, afterGone]
  );

  const remove = useCallback(async (): Promise<void> => {
    if (!organizationId) {
      return;
    }
    setWorking(true);
    try {
      const { error } = await authClient.organization.delete({
        organizationId,
      });
      if (error) {
        toast.error(error.message || "Could not delete the organization");
        return;
      }
      toast.success(`Deleted ${organizationName}`);
      await afterGone();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not delete the organization"
      );
    } finally {
      setWorking(false);
    }
  }, [organizationId, organizationName, afterGone]);

  return {
    canLeave,
    isOnlyOwner,
    leave,
    needsSuccessor,
    otherMembers,
    remove,
    working,
  };
}
