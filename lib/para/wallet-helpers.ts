import "server-only";
import { ParaEthersSigner } from "@getpara/ethers-v6-integration";
import { Environment, Para as ParaServer } from "@getpara/server-sdk";
import { TurnkeySigner } from "@turnkey/ethers";
import { eq } from "drizzle-orm";
import type { ethers } from "ethers";
import { toChecksumAddress } from "@/lib/address-utils";
import { db } from "@/lib/db";
import { type OrganizationWallet, organizationWallets } from "@/lib/db/schema";
import { decryptUserShare, encryptUserShare } from "@/lib/encryption";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getRpcProviderFromUrls } from "@/lib/rpc/provider-factory";
import { getTurnkeySignerConfig } from "@/lib/turnkey/turnkey-client";

/**
 * Get organization's wallet from database
 * @throws Error if wallet not found
 */
export async function getOrganizationWallet(
  organizationId: string
): Promise<OrganizationWallet> {
  const wallet = await db
    .select()
    .from(organizationWallets)
    .where(eq(organizationWallets.organizationId, organizationId))
    .limit(1);

  if (wallet.length === 0) {
    throw new Error("No wallet found for organization");
  }

  return wallet[0];
}

/**
 * @deprecated Use getOrganizationWallet instead
 */
export async function getUserWallet(userId: string) {
  const wallet = await db
    .select()
    .from(organizationWallets)
    .where(eq(organizationWallets.userId, userId))
    .limit(1);

  if (wallet.length === 0) {
    throw new Error("No wallet found for user");
  }

  return wallet[0];
}

/**
 * Initialize an ethers-compatible signer for the organization's wallet.
 * Dispatches to the correct provider (Para MPC or Turnkey secure enclave).
 */
export async function initializeWalletSigner(
  organizationId: string,
  rpcUrl: string
): Promise<ethers.Signer> {
  const wallet = await getOrganizationWallet(organizationId);
  const rpcManager = await getRpcProviderFromUrls(rpcUrl);
  const provider = rpcManager.getProvider();

  if (wallet.provider === "turnkey") {
    return initializeTurnkeySigner(wallet, provider);
  }

  return initializeParaMpcSigner(wallet, provider);
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

async function initializeParaMpcSigner(
  wallet: {
    organizationId: string | null;
    userShare: string | null;
    paraSession: string | null;
  },
  provider: ethers.Provider
): Promise<ethers.Signer> {
  const PARA_API_KEY = process.env.PARA_API_KEY;
  const PARA_ENV = process.env.PARA_ENVIRONMENT ?? "beta";

  if (!PARA_API_KEY) {
    logSystemError(
      ErrorCategory.INFRASTRUCTURE,
      "[Para] PARA_API_KEY not configured",
      new Error("PARA_API_KEY environment variable is not configured"),
      { component: "para-service", service: "para" }
    );
    throw new Error("PARA_API_KEY not configured");
  }

  const paraClient = new ParaServer(
    PARA_ENV === "prod" ? Environment.PROD : Environment.BETA,
    PARA_API_KEY
  );

  if (wallet.paraSession) {
    // Post-claim: import session for signing (session includes auth + signers)
    const decryptedSession = decryptUserShare(wallet.paraSession);
    await paraClient.importSession(decryptedSession);

    const isActive: boolean = await paraClient.keepSessionAlive();
    if (!isActive) {
      throw new Error(
        "Para session expired. User must re-export from wallet settings."
      );
    }

    // Re-export the session blob after keepSessionAlive extends the server-side TTL.
    // The old blob is stale -- waitAndExportSession produces a new one with refreshed state.
    const refreshedBlob: string = await paraClient.waitAndExportSession();
    const encryptedRefreshed = encryptUserShare(refreshedBlob);

    const orgId = wallet.organizationId;

    if (orgId) {
      await db
        .update(organizationWallets)
        .set({ paraSession: encryptedRefreshed })
        .where(eq(organizationWallets.organizationId, orgId));
    }
  } else if (wallet.userShare) {
    // Pre-claim: use stored userShare
    const decryptedShare = decryptUserShare(wallet.userShare);
    await paraClient.setUserShare(decryptedShare);
  } else {
    throw new Error("Para wallet missing both session and user share");
  }

  const signer = new ParaEthersSigner(
    // biome-ignore lint/suspicious/noExplicitAny: Para server-sdk type incompatibility with core-sdk ParaCore
    paraClient as any,
    provider
  );

  return signer;
}

/**
 * Get organization's wallet address
 */
export async function getOrganizationWalletAddress(
  organizationId: string
): Promise<string> {
  const wallet = await getOrganizationWallet(organizationId);
  return wallet.walletAddress;
}

/**
 * Check if organization has a wallet
 */
export async function organizationHasWallet(
  organizationId: string
): Promise<boolean> {
  const wallet = await db
    .select()
    .from(organizationWallets)
    .where(eq(organizationWallets.organizationId, organizationId))
    .limit(1);

  return wallet.length > 0;
}

/**
 * @deprecated Use getOrganizationWalletAddress instead
 */
export async function getUserWalletAddress(userId: string): Promise<string> {
  const wallet = await getUserWallet(userId);
  return wallet.walletAddress;
}

/**
 * @deprecated Use organizationHasWallet instead
 */
export async function userHasWallet(userId: string): Promise<boolean> {
  const wallet = await db
    .select()
    .from(organizationWallets)
    .where(eq(organizationWallets.userId, userId))
    .limit(1);

  return wallet.length > 0;
}
