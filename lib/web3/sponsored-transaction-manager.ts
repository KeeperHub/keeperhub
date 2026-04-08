import "server-only";
import type { Address, Hex } from "viem";
import { createPublicClient, encodeFunctionData, http } from "viem";
import { isBillingEnabled } from "@/lib/billing/feature-flag";
import {
  checkGasCredits,
  getEthPriceUsd,
  recordGasUsage,
} from "@/lib/billing/gas-credits";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getMetricsCollector } from "@/lib/metrics";
import { MetricNames } from "@/lib/metrics/types";
import { isTestnetChain } from "@/lib/web3/chainlink-feeds";
import { isSponsorshipSupported } from "@/lib/web3/pimlico-config";
import { createSponsoredClient } from "@/lib/web3/sponsored-client";

type SponsoredTransactionResult = {
  success: true;
  transactionHash: string;
  gasUsed: string;
  gasUsedUnits: string;
  effectiveGasPrice: string;
  sponsored: true;
} | null;

type SponsoredTxParams = {
  organizationId: string;
  executionId: string;
  chainId: number;
  rpcUrl: string;
  walletAddress: string;
  to: string;
  value?: bigint;
  data?: Hex;
};

type SponsoredContractTxParams = {
  organizationId: string;
  executionId: string;
  chainId: number;
  rpcUrl: string;
  walletAddress: string;
  to: string;
  // biome-ignore lint/suspicious/noExplicitAny: ABI types from viem are deeply nested generics
  abi: any;
  functionName: string;
  args: unknown[];
  value?: bigint;
};

/**
 * Attempt to execute a transaction via gas sponsorship (ERC-4337 + Pimlico).
 *
 * Returns the result if sponsorship succeeds, or null if sponsorship is
 * unavailable (unsupported chain, no credits, client creation failed).
 * Callers should fall back to direct signing when null is returned.
 */
export async function executeSponsoredTransaction(
  params: SponsoredTxParams
): Promise<SponsoredTransactionResult> {
  if (!isBillingEnabled()) {
    return null;
  }

  if (!isSponsorshipSupported(params.chainId)) {
    return null;
  }

  const creditCheck = await checkGasCredits(params.organizationId);
  if (!creditCheck.allowed) {
    return null;
  }

  const client = await createSponsoredClient(
    params.organizationId,
    params.chainId,
    params.rpcUrl
  );

  if (client === null) {
    return null;
  }

  try {
    const txHash: Hex = await client.smartAccountClient.sendTransaction({
      to: params.to as Address,
      value: params.value ?? BigInt(0),
      data: params.data ?? ("0x" as Hex),
    });

    return await finalizeSponsoredTx(
      txHash,
      params.rpcUrl,
      params.organizationId,
      params.chainId,
      params.executionId
    );
  } catch (error) {
    logSystemError(
      ErrorCategory.TRANSACTION,
      "[Sponsorship] Sponsored transaction failed, falling back to direct signing",
      error instanceof Error ? error : new Error(String(error)),
      {
        organizationId: params.organizationId,
        chainId: params.chainId.toString(),
      }
    );
    return null;
  }
}

/**
 * Attempt to execute a contract call via gas sponsorship.
 *
 * Same semantics as executeSponsoredTransaction -- returns null on failure
 * so callers can fall back to direct signing.
 */
export async function executeSponsoredContractTransaction(
  params: SponsoredContractTxParams
): Promise<SponsoredTransactionResult> {
  if (!isBillingEnabled()) {
    return null;
  }

  if (!isSponsorshipSupported(params.chainId)) {
    return null;
  }

  const creditCheck = await checkGasCredits(params.organizationId);
  if (!creditCheck.allowed) {
    return null;
  }

  const client = await createSponsoredClient(
    params.organizationId,
    params.chainId,
    params.rpcUrl
  );

  if (client === null) {
    return null;
  }

  try {
    const callData = encodeFunctionData({
      abi: params.abi,
      functionName: params.functionName,
      args: params.args,
    });

    const txHash: Hex = await client.smartAccountClient.sendTransaction({
      to: params.to as Address,
      value: params.value ?? BigInt(0),
      data: callData,
    });

    return await finalizeSponsoredTx(
      txHash,
      params.rpcUrl,
      params.organizationId,
      params.chainId,
      params.executionId
    );
  } catch (error) {
    logSystemError(
      ErrorCategory.TRANSACTION,
      "[Sponsorship] Sponsored contract call failed, falling back to direct signing",
      error instanceof Error ? error : new Error(String(error)),
      {
        organizationId: params.organizationId,
        chainId: params.chainId.toString(),
      }
    );
    return null;
  }
}

/**
 * Wait for receipt, record gas usage, and build the result.
 * Skips billing on testnets (Pimlico doesn't charge for testnet sponsorship).
 */
async function finalizeSponsoredTx(
  txHash: Hex,
  rpcUrl: string,
  organizationId: string,
  chainId: number,
  executionId: string
): Promise<SponsoredTransactionResult> {
  const publicClient = createPublicClient({
    transport: http(rpcUrl),
  });

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
  });

  if (receipt.status !== "success") {
    throw new Error(`Sponsored transaction reverted: ${txHash}`);
  }

  const gasUsed = receipt.gasUsed;
  const effectiveGasPrice = receipt.effectiveGasPrice;

  const metrics = getMetricsCollector();
  const labels = {
    chain_id: chainId.toString(),
    organization_id: organizationId,
  };

  metrics.incrementCounter(MetricNames.SPONSORSHIP_TRANSACTIONS_TOTAL, labels);
  metrics.incrementCounter(
    MetricNames.SPONSORSHIP_GAS_USED_TOTAL,
    labels,
    Number(gasUsed)
  );

  const TESTNET_ETH_PRICE_USD = 0;
  const isTestnet = isTestnetChain(chainId);
  const ethPriceUsd = isTestnet
    ? TESTNET_ETH_PRICE_USD
    : await getEthPriceUsd(rpcUrl, chainId);

  try {
    await recordGasUsage({
      organizationId,
      chainId,
      txHash,
      executionId,
      gasUsed,
      gasPrice: effectiveGasPrice,
      ethPriceUsd,
    });
  } catch (billingError) {
    logSystemError(
      ErrorCategory.TRANSACTION,
      "[Sponsorship] Failed to record gas usage (tx already confirmed on-chain)",
      billingError instanceof Error
        ? billingError
        : new Error(String(billingError)),
      { organizationId, chainId: chainId.toString(), txHash }
    );
  }

  if (!isTestnet) {
    const gasCostWei = gasUsed * effectiveGasPrice;
    const gasCostEth = Number(gasCostWei) / 1e18;
    const gasCostUsd = gasCostEth * ethPriceUsd;

    metrics.incrementCounter(
      MetricNames.SPONSORSHIP_GAS_COST_USD_MICRO_TOTAL,
      labels,
      Math.ceil(gasCostUsd * 1_000_000)
    );
  }

  return {
    success: true,
    transactionHash: txHash,
    gasUsed: gasUsed.toString(),
    gasUsedUnits: gasUsed.toString(),
    effectiveGasPrice: effectiveGasPrice.toString(),
    sponsored: true,
  };
}
