import "server-only";
import { eq } from "drizzle-orm";
import { createSmartAccountClient } from "permissionless";
import { to7702SimpleSmartAccount } from "permissionless/accounts";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import type { Address, LocalAccount, PublicClient } from "viem";
import { createPublicClient, defineChain, http } from "viem";
import { entryPoint08Address } from "viem/account-abstraction";
import { db } from "@/lib/db";
import { chains } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { createParaViemAccount } from "@/lib/para/viem-account-adapter";
import { recordDelegationIfNeeded } from "@/lib/web3/eip7702-delegation";
import {
  getPimlicoUrl,
  isSponsorshipSupported,
} from "@/lib/web3/pimlico-config";

const LOG_PREFIX = "[Sponsorship]";

type SponsoredClientResult = {
  // biome-ignore lint/suspicious/noExplicitAny: SmartAccountClient generic signature is deeply nested across permissionless.js types
  smartAccountClient: any;
  smartAccount: { isDeployed: () => Promise<boolean> };
  account: LocalAccount;
  publicClient: PublicClient;
  walletAddress: Address;
  chainId: number;
};

/**
 * Creates a sponsored smart account client for an organization.
 *
 * This:
 * 1. Creates a viem account backed by Para MPC signing
 * 2. Creates a Pimlico-sponsored smart account client with EIP-7702 support
 *
 * Returns the smart account client plus the account/publicClient needed for
 * callers to manually sign EIP-7702 authorization on first transaction.
 *
 * Returns null if sponsorship cannot be set up (unsupported chain, etc).
 * Callers should fall back to direct signing.
 */
export async function createSponsoredClient(
  organizationId: string,
  chainId: number,
  rpcUrl: string
): Promise<SponsoredClientResult | null> {
  if (!isSponsorshipSupported(chainId)) {
    return null;
  }

  try {
    const { account, walletRecord } =
      await createParaViemAccount(organizationId);
    const walletAddress = walletRecord.walletAddress as Address;
    const chainRecord = await db.query.chains.findFirst({
      where: eq(chains.chainId, chainId),
    });

    const chainName = chainRecord?.name ?? `Chain ${chainId}`;
    const chainSymbol = chainRecord?.symbol ?? "ETH";

    const chain = defineChain({
      id: chainId,
      name: chainName,
      nativeCurrency: { name: chainSymbol, symbol: chainSymbol, decimals: 18 },
      rpcUrls: {
        default: { http: [rpcUrl] },
      },
    });

    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl),
    });

    const pimlicoUrl = getPimlicoUrl(chainId);

    const pimlicoClient = createPimlicoClient({
      chain,
      transport: http(pimlicoUrl),
      entryPoint: {
        address: entryPoint08Address,
        version: "0.8",
      },
    });

    const smartAccount = await to7702SimpleSmartAccount({
      client: publicClient,
      owner: account,
    });

    const gasPrices = await pimlicoClient.getUserOperationGasPrice();

    const smartAccountClient = createSmartAccountClient({
      chain,
      account: smartAccount,
      client: publicClient,
      bundlerTransport: http(pimlicoUrl),
      paymaster: pimlicoClient,
      userOperation: {
        estimateFeesPerGas: async () => gasPrices.fast,
      },
    });

    // Record delegation in DB if first time (non-blocking)
    recordDelegationIfNeeded(
      organizationId,
      chainId,
      rpcUrl,
      walletAddress
    ).catch((error: unknown) => {
      logSystemError(
        ErrorCategory.TRANSACTION,
        `${LOG_PREFIX} Failed to record delegation`,
        error
      );
    });

    return {
      smartAccountClient,
      smartAccount,
      account,
      publicClient,
      walletAddress,
      chainId,
    };
  } catch (error) {
    logSystemError(
      ErrorCategory.TRANSACTION,
      `${LOG_PREFIX} Failed to create sponsored client`,
      error
    );
    return null;
  }
}
