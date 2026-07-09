import "server-only";
import { TurnkeySigner } from "@turnkey/ethers";
import { and, eq } from "drizzle-orm";
import type { ethers } from "ethers";
import { toChecksumAddress } from "@/lib/address-utils";
import { db } from "@/lib/db";
import { type OrganizationWallet, organizationWallets } from "@/lib/db/schema";
import { getRpcProviderFromUrls } from "@/lib/rpc/provider-factory";
import { getTurnkeySignerConfig } from "@/lib/turnkey/turnkey-client";
import { TurnkeySolanaSigner } from "@/lib/agentic-wallet/solana-turnkey-signer";
import type { SolanaTransactionSigner } from "@/lib/web3/chain-adapter/types";

/**
 * Get organization's active wallet from database.
 */
export async function getOrganizationWallet(
  organizationId: string
): Promise<OrganizationWallet> {
  const wallet = await db
    .select()
    .from(organizationWallets)
    .where(
      and(
        eq(organizationWallets.organizationId, organizationId),
        eq(organizationWallets.isActive, true)
      )
    )
    .limit(1);

  if (wallet.length === 0) {
    throw new Error("No wallet found for organization");
  }

  return wallet[0];
}

export async function initializeWalletSigner(
  organizationId: string,
  rpcUrl: string,
  chainId: number
): Promise<ethers.Signer> {
  const wallet = await getOrganizationWallet(organizationId);
  const rpcManager = await getRpcProviderFromUrls(rpcUrl, undefined, chainId);
  const provider = rpcManager.getProvider();

  return initializeTurnkeySigner(wallet, provider);
}

function initializeTurnkeySigner(
  wallet: { turnkeySubOrgId: string | null; walletAddress: string },
  provider: ethers.Provider
): ethers.Signer {
  if (!wallet.turnkeySubOrgId) {
    throw new Error("Turnkey wallet missing sub-organization ID");
  }

  const config = getTurnkeySignerConfig(
    wallet.turnkeySubOrgId,
    toChecksumAddress(wallet.walletAddress)
  );

  const signer = new TurnkeySigner({
    client: config.client,
    organizationId: config.organizationId,
    signWith: config.signWith,
  });

  return signer.connect(provider);
}

export async function getOrganizationWalletAddress(
  organizationId: string
): Promise<string> {
  const wallet = await getOrganizationWallet(organizationId);
  return wallet.walletAddress;
}

export async function organizationHasWallet(
  organizationId: string
): Promise<boolean> {
  const wallet = await db
    .select()
    .from(organizationWallets)
    .where(
      and(
        eq(organizationWallets.organizationId, organizationId),
        eq(organizationWallets.isActive, true)
      )
    )
    .limit(1);

  return wallet.length > 0;
}

export async function initializeSolanaWalletSigner(
  organizationId: string
): Promise<SolanaTransactionSigner> {
  const wallet = await getOrganizationWallet(organizationId);

  if (!wallet.turnkeySubOrgId) {
    throw new Error("[Solana] Turnkey wallet missing sub-organization ID");
  }
  if (!wallet.solanaAddress) {
    throw new Error(
      "[Solana] Organization wallet has no provisioned Solana address. " +
      "The wallet was created before Solana support was added. " +
      "Contact support to add a Solana account to this wallet."
    );
  }

  return new TurnkeySolanaSigner(wallet.turnkeySubOrgId, wallet.solanaAddress);
}
