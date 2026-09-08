"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client";
import { roleLabel } from "@/lib/organization/role-label";
import { useSettingsContext } from "../settings-context";
import { cacheRead, cacheWrite } from "./settings-cache";

export type OrgMember = {
  id: string;
  userId: string;
  role: string;
  createdAt: Date;
  user: { name: string; email: string; image?: string };
};

export type SentInvitation = {
  id: string;
  email: string;
  role: string;
  status: string;
  expiresAt?: Date | string;
  createdAt?: Date | string;
};

export type OrgMembersState = {
  members: OrgMember[];
  invitations: SentInvitation[];
  loading: boolean;
  invitationsLoading: boolean;
  /** Member id whose role change is in flight. */
  updatingId: string | null;
  refetch: () => Promise<void>;
  cancelInvitation: (invitationId: string) => Promise<void>;
  resendInvitation: (invitation: SentInvitation) => Promise<void>;
  changeRole: (member: OrgMember, role: string) => Promise<void>;
  removeMember: (member: OrgMember) => Promise<void>;
};

async function fetchMembers(organizationId: string): Promise<OrgMember[]> {
  const result = await authClient.organization.listMembers({
    query: { organizationId },
  });
  const data = result.data as { members?: OrgMember[] } | OrgMember[] | null;
  const list = Array.isArray(data) ? data : (data?.members ?? []);
  return list.filter(Boolean);
}

async function fetchInvitations(
  organizationId: string
): Promise<SentInvitation[]> {
  const result = await authClient.organization.listInvitations({
    query: { organizationId },
  });
  const list = Array.isArray(result.data) ? result.data : [];
  return (list as SentInvitation[]).filter((inv) => inv.status === "pending");
}

export function useOrgMembers(): OrgMembersState {
  const { organizationId, isAdmin, revision } = useSettingsContext();
  const membersKey = organizationId ? `members:${organizationId}` : null;
  const invitesKey = organizationId ? `invites:${organizationId}` : null;
  const [members, setMembers] = useState<OrgMember[]>(
    () => cacheRead<OrgMember[]>(membersKey) ?? []
  );
  const [invitations, setInvitations] = useState<SentInvitation[]>(
    () => cacheRead<SentInvitation[]>(invitesKey) ?? []
  );
  const [loading, setLoading] = useState(
    () => cacheRead(membersKey) === undefined
  );
  const [invitationsLoading, setInvitationsLoading] = useState(
    () => cacheRead(invitesKey) === undefined
  );
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const refetch = useCallback(async (): Promise<void> => {
    if (!organizationId) {
      setLoading(false);
      setInvitationsLoading(false);
      return;
    }
    try {
      const nextMembers = await fetchMembers(organizationId);
      setMembers(nextMembers);
      cacheWrite(membersKey, nextMembers);
    } catch {
      setMembers([]);
    } finally {
      setLoading(false);
    }

    if (!isAdmin) {
      setInvitations([]);
      setInvitationsLoading(false);
      return;
    }
    try {
      const nextInvites = await fetchInvitations(organizationId);
      setInvitations(nextInvites);
      cacheWrite(invitesKey, nextInvites);
    } catch {
      setInvitations([]);
    } finally {
      setInvitationsLoading(false);
    }
  }, [organizationId, isAdmin, membersKey, invitesKey]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is a reload trigger, not a value this reads
  useEffect(() => {
    refetch().catch(() => undefined);
  }, [refetch, revision]);

  const cancelInvitation = useCallback(
    async (invitationId: string): Promise<void> => {
      try {
        const { error } = await authClient.organization.cancelInvitation({
          invitationId,
        });
        if (error) {
          toast.error(error.message || "Could not cancel the invitation");
        } else {
          toast.success("Invitation cancelled");
        }
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to cancel invitation"
        );
      } finally {
        await refetch();
      }
    },
    [refetch]
  );

  const changeRole = useCallback(
    async (member: OrgMember, role: string): Promise<void> => {
      setUpdatingId(member.id);
      const who = member.user.name || member.user.email;
      try {
        // better-auth reports failures on the result rather than throwing, so
        // a bare try/catch would let a rejected change pass silently.
        const { error } = await authClient.organization.updateMemberRole({
          memberId: member.id,
          role,
        });
        if (error) {
          toast.error(error.message || `Could not change the role for ${who}`);
        } else {
          toast.success(`${who} is now ${roleLabel(role) ?? role}`);
        }
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to update role"
        );
      } finally {
        setUpdatingId(null);
        await refetch();
      }
    },
    [refetch]
  );

  const removeMember = useCallback(
    async (member: OrgMember): Promise<void> => {
      const who = member.user.name || member.user.email;
      try {
        const { error } = await authClient.organization.removeMember({
          memberIdOrEmail: member.user.email,
        });
        if (error) {
          toast.error(error.message || `Could not remove ${who}`);
        } else {
          toast.success(`Removed ${who}`);
        }
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to remove member"
        );
      } finally {
        await refetch();
      }
    },
    [refetch]
  );

  // There is no API to re-send an existing invitation, and none to change its
  // role once issued, so a resend is a cancel plus a fresh invite to the same
  // address and role. The old link stops working.
  const resendInvitation = useCallback(
    async (invitation: SentInvitation): Promise<void> => {
      if (!organizationId) {
        return;
      }
      try {
        await authClient.organization.cancelInvitation({
          invitationId: invitation.id,
        });
        const { error } = await authClient.organization.inviteMember({
          email: invitation.email,
          organizationId,
          role: invitation.role as "member" | "admin" | "owner",
        });
        if (error) {
          toast.error(error.message || "Could not resend the invitation");
        } else {
          toast.success(`Invitation resent to ${invitation.email}`);
        }
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Could not resend"
        );
      } finally {
        await refetch();
      }
    },
    [organizationId, refetch]
  );

  return {
    cancelInvitation,
    resendInvitation,
    changeRole,
    removeMember,
    updatingId,
    invitations,
    invitationsLoading,
    loading,
    members,
    refetch,
  };
}
