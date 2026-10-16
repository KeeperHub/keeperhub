"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { switchAwayFrom } from "@/components/organization/switch-away";
import { ApiError, api } from "@/lib/api-client";
import { authClient, useSession } from "@/lib/auth-client";
import {
  currentActiveOrgId,
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
  const afterGone = useCallback(
    async (done: "Left" | "Deleted", wasActive: boolean): Promise<void> => {
      router.replace("/settings");
      if (organizationId) {
        await switchAwayFrom({
          removed: { id: organizationId, name: organizationName },
          wasActive,
          organizations,
          done,
          switchOrganization,
          // From /settings, whether or not the replace above has landed yet.
          // Already on its way to /settings, which needs no organization, so
          // there is no goHome.
          firstFrom: "/settings",
        });
      }
      await refetch();
      router.refresh();
    },
    [
      organizations,
      organizationId,
      organizationName,
      switchOrganization,
      refetch,
      router,
    ]
  );

  const leave = useCallback(
    async (newOwnerMemberId?: string): Promise<void> => {
      if (!organizationId) {
        return;
      }
      setWorking(true);
      // As it is before leaving, which clears the active org (and has the
      // auth client load it again): the settings page's org is made the
      // active one, but that can still be on its way, or have failed.
      const wasActive = currentActiveOrgId() === organizationId;
      try {
        await api.organization.leave(organizationId, { newOwnerMemberId });
        await afterGone("Left", wasActive);
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
    [organizationId, afterGone]
  );

  const remove = useCallback(async (): Promise<void> => {
    if (!organizationId) {
      return;
    }
    setWorking(true);
    // As it is before deleting, which clears the active org and has the
    // auth client load it again, maybe before this reads it.
    const wasActive = currentActiveOrgId() === organizationId;
    try {
      const { error } = await authClient.organization.delete({
        organizationId,
      });
      if (error) {
        toast.error(error.message || "Could not delete the organization");
        return;
      }
      await afterGone("Deleted", wasActive);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not delete the organization"
      );
    } finally {
      setWorking(false);
    }
  }, [organizationId, afterGone]);

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
