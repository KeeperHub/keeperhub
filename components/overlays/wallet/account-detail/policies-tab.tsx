"use client";

import { RolePermissionsCard } from "@/components/safe/role-permissions-card";
import { getSafeAppUrl } from "@/components/safe/chain-prefixes";

type PoliciesTabProps = {
  safeId: string;
  chainId: number;
  safeAddress: string;
  isAdmin: boolean;
  isOwner: boolean;
};

/**
 * Wraps the role permissions card in the per-account detail overlay.
 * Pure pass-through today -- kept as its own file so the detail overlay's
 * tab strip stays a thin switch and the policies UI can grow without
 * dragging the overlay shell with it.
 */
export function PoliciesTab({
  safeId,
  chainId,
  safeAddress,
  isAdmin,
  isOwner,
}: PoliciesTabProps): React.ReactElement {
  const safeUrl = getSafeAppUrl(chainId, safeAddress);
  return (
    <RolePermissionsCard
      bare
      chainId={chainId}
      isAdmin={isAdmin}
      isOwner={isOwner}
      safeAddress={safeAddress}
      safeId={safeId}
      safeUrl={safeUrl}
    />
  );
}
