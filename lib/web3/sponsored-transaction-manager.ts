import "server-only";
import type { Hex } from "viem";
import { BaseError, createPublicClient, encodeFunctionData, http } from "viem";
import {
  checkGasCredits,
  getGasTokenPriceUsd,
  recordGasUsage,
} from "@/lib/billing/gas-credits";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getMetricsCollector } from "@/lib/metrics";
import { MetricNames } from "@/lib/metrics/types";
import {
  isBlockedHost,
  isBlockedIp,
  stripIpv6Brackets,
} from "@/lib/safe-fetch";
import { isTestnetChain } from "@/lib/web3/chainlink-feeds";
import { createSponsoredClient } from "@/lib/web3/sponsored-client";
import { isGasSponsorshipEnabled } from "@/lib/web3/sponsorship-feature-flag";
import { SponsoredTxRevertError } from "@/lib/web3/turnkey-revert";
import { submitTurnkeySponsoredTransaction } from "@/lib/web3/turnkey-sponsored-tx";
import { isSponsorshipSupported } from "@/lib/web3/turnkey-sponsorship-config";

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
 * A sponsored write against a loopback or private-range RPC can never land,
 * since Turnkey's Gas Station broadcasts from its own infrastructure, not
 * from the caller's network. Skipping here (rather than attempting
 * sponsorship and falling back after failure) also avoids a no-fallback
 * hang: a sponsored activity Turnkey accepts but can never confirm raises
 * without returning null.
 */
function isSponsorshipBlockedRpc(rpcUrl: string): boolean {
  let hostname: string;
  try {
    hostname = stripIpv6Brackets(new URL(rpcUrl).hostname);
  } catch {
    return false;
  }
  return isBlockedHost(hostname).blocked || isBlockedIp(hostname).blocked;
}

/**
 * Attempt to execute a transaction via Turnkey Gas Station sponsorship.
 *
 * Returns the result if sponsorship succeeds, or null if sponsorship is
 * unavailable (unsupported chain, non-Turnkey wallet, credits exhausted,
 * Turnkey rejected the activity). Callers should fall back to direct
 * signing when null is returned.
 */
export async function executeSponsoredTransaction(
  params: SponsoredTxParams
): Promise<SponsoredTransactionResult> {
  if (!isGasSponsorshipEnabled()) {
    return null;
  }

  if (isSponsorshipBlockedRpc(params.rpcUrl)) {
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
    params.chainId
  );

  if (client === null) {
    return null;
  }

  const submitResult = await submitTurnkeySponsoredTransaction({
    subOrgId: client.subOrgId,
    walletAddress: client.walletAddress,
    chainId: params.chainId,
    to: params.to,
    value: params.value,
    data: params.data,
  });

  if (submitResult === null) {
    return null;
  }

  return await finalizeSponsoredTx(
    submitResult.txHash,
    submitResult.sendTransactionStatusId,
    params.rpcUrl,
    params.organizationId,
    params.chainId,
    params.executionId
  );
}

/**
 * Attempt to execute a contract call via Turnkey Gas Station sponsorship.
 *
 * Same semantics as executeSponsoredTransaction -- returns null on failure
 * so callers can fall back to direct signing.
 */
export async function executeSponsoredContractTransaction(
  params: SponsoredContractTxParams
): Promise<SponsoredTransactionResult> {
  if (!isGasSponsorshipEnabled()) {
    return null;
  }

  if (isSponsorshipBlockedRpc(params.rpcUrl)) {
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
    params.chainId
  );

  if (client === null) {
    return null;
  }

  const callData = encodeFunctionData({
    abi: params.abi,
    functionName: params.functionName,
    args: params.args,
  });

  const submitResult = await submitTurnkeySponsoredTransaction({
    subOrgId: client.subOrgId,
    walletAddress: client.walletAddress,
    chainId: params.chainId,
    to: params.to,
    value: params.value,
    data: callData,
  });

  if (submitResult === null) {
    return null;
  }

  return await finalizeSponsoredTx(
    submitResult.txHash,
    submitResult.sendTransactionStatusId,
    params.rpcUrl,
    params.organizationId,
    params.chainId,
    params.executionId
  );
}

// viem renders an Error(string) revert as
// "Execution reverted with reason: <reason>." -- pull <reason> back out.
const VIEM_REVERT_REASON_RE = /reverted with reason:\s*(.+?)\.?\s*$/i;

/**
 * Recover the revert reason of an already-mined, reverted sponsored tx.
 *
 * This is a read-only `eth_call` replay against the block the tx landed in --
 * it never broadcasts a second transaction, so it does NOT double-send. Returns
 * undefined when the reason cannot be decoded (custom error without an ABI, or
 * state drift so the replay no longer reverts); callers fall back to a generic
 * message.
 */
async function decodeSponsoredRevertReason(
  publicClient: ReturnType<typeof createPublicClient>,
  txHash: Hex,
  blockNumber: bigint
): Promise<string | undefined> {
  let tx: Awaited<ReturnType<typeof publicClient.getTransaction>>;
  try {
    tx = await publicClient.getTransaction({ hash: txHash });
  } catch {
    return;
  }
  if (!tx.to) {
    return;
  }
  try {
    await publicClient.call({
      account: tx.from,
      to: tx.to,
      data: tx.input,
      value: tx.value,
      blockNumber,
    });
    return;
  } catch (replayError) {
    if (replayError instanceof BaseError) {
      return VIEM_REVERT_REASON_RE.exec(replayError.shortMessage)?.[1]?.trim();
    }
    return;
  }
}

/**
 * Wait for receipt, record gas usage, and build the result.
 *
 * Turnkey pays the gas, so the org's wallet is never charged for the
 * underlying tx -- but the on-chain receipt still reports gasUsed and
 * effectiveGasPrice, which is what we meter against the org's gas-credit
 * balance. Billing is skipped on testnets.
 */
async function finalizeSponsoredTx(
  txHash: Hex,
  sendTransactionStatusId: string,
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
    // The sponsored tx is on-chain and reverted. Read-only replay to recover
    // the reason (Turnkey's early hash meant we never saw its FAILED status),
    // then raise the typed revert error -- not a generic Error -- so the caller
    // reports it as the node result instead of falling back and duplicating.
    const reason = await decodeSponsoredRevertReason(
      publicClient,
      txHash,
      receipt.blockNumber
    );
    throw new SponsoredTxRevertError({
      message: reason ?? "reason unavailable",
      txHash,
      sendTransactionStatusId,
      revertChain: [],
    });
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
    : await getGasTokenPriceUsd(rpcUrl, chainId);

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
