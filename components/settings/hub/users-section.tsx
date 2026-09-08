"use client";

import { UserPlus } from "lucide-react";
import { useState } from "react";
import { InviteMemberForm } from "@/components/organization/invite-modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { truncateAddress } from "@/lib/address-utils";
import { isWalletEmail } from "@/lib/auth/wallet-constants";
import { useSession } from "@/lib/auth-client";
import { useOrgMembers } from "./hooks/use-org-members";
import { InvitationsCard } from "./invitations-card";
import { MemberStats } from "./member-stats";
import { MembersTable } from "./members/members-table";
import { invitationTiming } from "./relative-time";
import { EmptyState, SectionHeader, SettingsCard } from "./section";
import { useSettingsContext } from "./settings-context";

/** Most privileged first; anything unrecognised sorts last. */
function roleRank(role: string): number {
  if (role === "owner") {
    return 0;
  }
  if (role === "admin") {
    return 1;
  }
  return role === "member" ? 2 : 3;
}

export function UsersSection(): React.ReactElement {
  const { isAdmin } = useSettingsContext();
  const { data: session } = useSession();
  const members = useOrgMembers();
  const [query, setQuery] = useState("");
  const [inviting, setInviting] = useState(false);

  const currentMemberId =
    members.members.find((m) => m.userId === session?.user?.id)?.id ?? null;

  const needle = query.trim().toLowerCase();
  const filtered = members.members
    .filter(
      (m) =>
        !needle ||
        (m.user.name ?? "").toLowerCase().includes(needle) ||
        (m.user.email ?? "").toLowerCase().includes(needle)
    )
    .slice()
    .sort(
      (a, b) =>
        roleRank(a.role) - roleRank(b.role) ||
        (a.user.name ?? a.user.email).localeCompare(b.user.name ?? b.user.email)
    );

  return (
    <>
      <SectionHeader
        description="Everyone in this organization, and everyone invited to it."
        title="Users"
      />

      <MemberStats
        loading={members.loading}
        members={members.members}
        pendingCount={members.invitations.length}
      />

      <SettingsCard
        action={
          <Input
            className="h-8 w-44"
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search members"
            value={query}
          />
        }
        bodyClassName="p-2"
        title="Members"
      >
        {!members.loading && filtered.length === 0 && (
          <EmptyState>No members match that search.</EmptyState>
        )}
        {(members.loading || filtered.length > 0) && (
          <MembersTable
            canManage={isAdmin}
            currentMemberId={currentMemberId}
            loading={members.loading}
            members={filtered}
            onRemove={members.removeMember}
            onRoleChange={members.changeRole}
            updatingId={members.updatingId}
          />
        )}
      </SettingsCard>

      {isAdmin && (
        <InvitationsCard
          action={
            <Button onClick={() => setInviting((v) => !v)} size="sm">
              <UserPlus className="size-3.5" />
              Invite
            </Button>
          }
          before={
            inviting && (
              <div className="mb-3 rounded-lg border p-4">
                <InviteMemberForm
                  compact
                  onDone={() => setInviting(false)}
                  onInvited={() => {
                    members.refetch().catch(() => undefined);
                  }}
                />
              </div>
            )
          }
          description="People invited to this organization who have not joined yet. Resending issues a new link and invalidates the old one."
          emptyLabel="No invitations are outstanding."
          loading={members.invitationsLoading}
          onCancel={(id) => {
            members.cancelInvitation(id).catch(() => undefined);
          }}
          onResend={(id) => {
            const invitation = members.invitations.find((i) => i.id === id);
            if (invitation) {
              members.resendInvitation(invitation).catch(() => undefined);
            }
          }}
          rows={members.invitations.map((inv) => ({
            badge: inv.role,
            // Wallet invitees carry a synthetic address rather than a mailbox,
            // and are never emailed, so show the wallet they sign in with.
            label: isWalletEmail(inv.email)
              ? truncateAddress(inv.email.split("@")[0])
              : inv.email,
            expired: inv.expiresAt
              ? new Date(inv.expiresAt) < new Date()
              : false,
            id: inv.id,
            meta: invitationTiming(inv.createdAt, inv.expiresAt),
          }))}
          title="Invitations sent"
        />
      )}
    </>
  );
}
