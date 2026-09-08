import "server-only";
import { and, eq } from "drizzle-orm";
import type { Address } from "viem";
import { db } from "@/lib/db";
import { organizationWallets } from "@/lib/db/schema-extensions";
import { isSponsorshipSupported } from "@/lib/web3/turnkey-sponsorship-config";

/**
 * Sponsorship preflight: resolves the organization's active wallet and
 * returns the Turnkey identifiers needed by the sponsored transaction
 * manager.
 *
 * Returns null when sponsorship cannot be set up so callers fall back
 * to direct signing. Reasons for null:
 *   - chain is not in the Turnkey Gas Station allowlist
 *   - the org has no active wallet
 *   - the wallet row is missing its Turnkey sub-organization id
 *
 * This file intentionally does NOT call Turnkey itself -- it only assembles
 * the parameters the manager will pass to ethSendTransaction. Keeping the
 * preflight DB read separate from the API call lets the manager stay
 * agnostic of how the wallet was provisioned.
 */
export type SponsoredClientResult = {
  subOrgId: string;
  walletAddress: Address;
  chainId: number;
};

export async function createSponsoredClient(
  organizationId: string,
  chainId: number
): Promise<SponsoredClientResult | null> {
  if (!isSponsorshipSupported(chainId)) {
    return null;
  }

  const rows = await db
    .select({
      walletAddress: organizationWallets.walletAddress,
      turnkeySubOrgId: organizationWallets.turnkeySubOrgId,
    })
    .from(organizationWallets)
    .where(
      and(
        eq(organizationWallets.organizationId, organizationId),
        eq(organizationWallets.isActive, true)
      )
    )
    .limit(1);

  const wallet = rows[0];
  if (!wallet) {
    return null;
  }

  if (wallet.turnkeySubOrgId === null) {
    return null;
  }

  return {
    subOrgId: wallet.turnkeySubOrgId,
    walletAddress: wallet.walletAddress as Address,
    chainId,
  };
}
