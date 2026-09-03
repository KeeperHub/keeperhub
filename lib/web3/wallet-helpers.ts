import "server-only";
import { TurnkeySigner } from "@turnkey/ethers";
import { and, eq } from "drizzle-orm";
import type { ethers } from "ethers";
import { toChecksumAddress } from "@/lib/address-utils";
import { db } from "@/lib/db";
import { type OrganizationWallet, organizationWallets } from "@/lib/db/schema";
import { guardSigner, guardSolanaSigner } from "@/lib/policy/signing-guard";
import { getRpcProviderFromUrls } from "@/lib/rpc/provider-factory";
import { SUPPORTED_CHAIN_IDS } from "@/lib/rpc/types";
import { ensureOrganizationSolanaAddress } from "@/lib/turnkey/ensure-solana-address";
import { isSolanaWalletProvisioningEnabled } from "@/lib/turnkey/solana-provisioning-flag";
import { TurnkeySolanaSigner } from "@/lib/turnkey/solana-signer";
import { getTurnkeySignerConfig } from "@/lib/turnkey/turnkey-client";
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

/**
 * The organization's signer, wrapped so policy is unavoidable.
 *
 * Guarding here rather than at each route is the point. Not every path to a
 * signature goes through the workflow engine: direct execution, agent calls and
 * one-off runs all reach a signer another way, and a rule that only holds on
 * some paths is not a rule. A route added tomorrow inherits the check without
 * knowing policy exists.
 */
export async function initializeWalletSigner(
  organizationId: string,
  rpcUrl: string,
  chainId: number
): Promise<ethers.Signer> {
  const wallet = await getOrganizationWallet(organizationId);
  const rpcManager = await getRpcProviderFromUrls(rpcUrl, undefined, chainId);
  const provider = rpcManager.getProvider();

  return guardSigner(initializeTurnkeySigner(wallet, provider), {
    organizationId,
    chainId,
  });
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
    // @turnkey/ethers 1.3.39 pins the v8 Turnkey SDK line (@turnkey/sdk-server 8.x,
    // @turnkey/core 2.x) as direct dependencies, so its TConfig["client"] union
    // names v8 client types while this app is on @turnkey/sdk-server 5.x. The two
    // are structurally incompatible (v8's TurnkeyClient carries ~128 methods the v5
    // TurnkeyApiClient lacks), but the signer only ever calls getPrivateKey,
    // signRawPayload and signTransaction, all of which the v5 client implements
    // with the same request/response shapes. Cast until the SDK is moved to v8,
    // which is a major bump and out of scope for a minor-and-patch update.
    client: config.client as unknown as ConstructorParameters<
      typeof TurnkeySigner
    >[0]["client"],
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

function buildSolanaSignerFromWallet(
  wallet: OrganizationWallet
): SolanaTransactionSigner {
  if (!wallet.turnkeySubOrgId) {
    throw new Error("[Solana] Turnkey wallet missing sub-organization ID");
  }
  if (!wallet.solanaAddress) {
    const provisioningHint = isSolanaWalletProvisioningEnabled()
      ? "Solana account provisioning will be attempted on first use."
      : "Solana wallet provisioning is disabled (SOLANA_WALLET_PROVISIONING_ENABLED). " +
        "Enable the flag or ask an operator to run scripts/backfill-solana-address.ts.";
    throw new Error(
      `[Solana] Organization wallet has no provisioned Solana address. ${provisioningHint}`
    );
  }
  return new TurnkeySolanaSigner(wallet.turnkeySubOrgId, wallet.solanaAddress);
}

/**
 * Resolves an organization's Solana signer and its provisioned address in one
 * fetch, with policy already wrapped around the signer. Throws if the wallet is
 * missing or has no Solana account; callers wrap this in their own error shape.
 *
 * The guard lives here rather than in a separate helper because the separate
 * helper is what failed: it existed, it was correct, and nothing called it, so
 * every Solana write took the unguarded signer instead. The EVM and Solana
 * paths share no code below the signer, so each has to be guarded where it is
 * built, and a rule that holds on one chain family and not the other is not a
 * rule.
 */
export async function initializeSolanaWallet(
  organizationId: string,
  chainId: number = SUPPORTED_CHAIN_IDS.SOLANA_MAINNET
): Promise<{ signer: SolanaTransactionSigner; address: string }> {
  let wallet = await getOrganizationWallet(organizationId);
  if (!wallet.solanaAddress && isSolanaWalletProvisioningEnabled()) {
    const solanaAddress = await ensureOrganizationSolanaAddress(wallet);
    wallet = { ...wallet, solanaAddress };
  }
  const signer = buildSolanaSignerFromWallet(wallet);
  return {
    signer: guardSolanaSigner(signer, { organizationId, chainId }),
    address: wallet.solanaAddress as string,
  };
}
