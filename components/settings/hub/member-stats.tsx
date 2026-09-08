"use client";

import type { OrgMember } from "./hooks/use-org-members";
import { StatTile } from "./section";

export function MemberStats({
  members,
  pendingCount,
  loading = false,
}: {
  members: OrgMember[];
  pendingCount: number;
  loading?: boolean;
}): React.ReactElement {
  const owners = members.filter((m) => m.role === "owner").length;
  const admins = members.filter((m) => m.role === "admin").length;

  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <StatTile
        hint={`${owners} owner${owners === 1 ? "" : "s"}, ${admins} admin${admins === 1 ? "" : "s"}`}
        label="Seats in use"
        loading={loading}
        value={String(members.length)}
      />
      <StatTile
        hint={pendingCount > 0 ? "Awaiting acceptance" : "None waiting"}
        label="Pending invitations"
        loading={loading}
        tone={pendingCount > 0 ? "warning" : "neutral"}
        value={String(pendingCount)}
      />
      <StatTile
        hint="Can manage members and wallets"
        label="Admins and owners"
        loading={loading}
        value={String(owners + admins)}
      />
    </div>
  );
}
