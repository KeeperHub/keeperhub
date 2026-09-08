import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import type { OrganizationWallet } from "@/lib/db/schema";
import { organizationWallets } from "@/lib/db/schema";
import { isSolanaWalletProvisioningEnabled } from "@/lib/turnkey/solana-provisioning-flag";
import {
  fetchOrCreateSolanaWalletAddress,
  getTurnkeyApiClient,
} from "@/lib/turnkey/turnkey-operations";

/**
 * Ensures an organization wallet row has a persisted Solana address.
 * Idempotent: reuses an existing Turnkey Solana account when the DB row is stale.
 */
export async function ensureOrganizationSolanaAddress(
  wallet: OrganizationWallet
): Promise<string> {
  if (wallet.solanaAddress) {
    return wallet.solanaAddress;
  }

  if (!isSolanaWalletProvisioningEnabled()) {
    throw new Error(
      "[Solana] Organization wallet has no provisioned Solana address. " +
        "Solana wallet provisioning is disabled (SOLANA_WALLET_PROVISIONING_ENABLED). " +
        "Enable the flag and retry, or ask an operator to run scripts/backfill-solana-address.ts."
    );
  }

  const subOrgId = wallet.turnkeySubOrgId;
  const walletId = wallet.turnkeyWalletId;
  if (!(subOrgId && walletId)) {
    throw new Error(
      "[Solana] Turnkey wallet missing sub-organization or wallet ID"
    );
  }

  const client = getTurnkeyApiClient();
  const solanaAddress = await fetchOrCreateSolanaWalletAddress(
    client,
    subOrgId,
    walletId
  );

  await db
    .update(organizationWallets)
    .set({ solanaAddress })
    .where(eq(organizationWallets.id, wallet.id));

  return solanaAddress;
}
