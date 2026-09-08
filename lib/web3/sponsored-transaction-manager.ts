import "server-only";
import type { Hex, TransactionReceipt } from "viem";
import {
  BaseError,
  createPublicClient,
  encodeFunctionData,
  http,
  type PublicClient,
} from "viem";
import {
  checkGasCredits,
  getGasTokenPriceUsd,
  recordGasUsage,
} from "@/lib/billing/gas-credits";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getMetricsCollector } from "@/lib/metrics";
import { MetricNames } from "@/lib/metrics/types";
import { resolveRpcConfig } from "@/lib/rpc/config-service";
import {
  isBlockedHost,
  isBlockedIp,
  stripIpv6Brackets,
} from "@/lib/safe-fetch";
import { sleep } from "@/lib/sleep";
import { isTestnetChain } from "@/lib/web3/chainlink-feeds";
import { createSponsoredClient } from "@/lib/web3/sponsored-client";
import { isGasSponsorshipEnabled } from "@/lib/web3/sponsorship-feature-flag";
import {
  isSponsoredTxRevertError,
  SponsoredTxPendingError,
  SponsoredTxRevertError,
} from "@/lib/web3/turnkey-revert";
import { submitTurnkeySponsoredTransaction } from "@/lib/web3/turnkey-sponsored-tx";
import { isSponsorshipSupported } from "@/lib/web3/turnkey-sponsorship-config";

type SponsoredTransactionResult = {
  success: true;
  transactionHash: string;
  /** Fee in wei (units * effectiveGasPrice), matching the direct-signing path. */
  gasUsed: string;
  /** Raw gas unit count from the receipt. */
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
  params: SponsoredTxParams,
  receiptWait?: ReceiptWaitOptions
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

  return await settleSponsoredTx(
    submitResult.txHash,
    submitResult.sendTransactionStatusId,
    params.rpcUrl,
    params.organizationId,
    params.chainId,
    params.executionId,
    receiptWait
  );
}

/**
 * Attempt to execute a contract call via Turnkey Gas Station sponsorship.
 *
 * Same semantics as executeSponsoredTransaction -- returns null on failure
 * so callers can fall back to direct signing.
 */
export async function executeSponsoredContractTransaction(
  params: SponsoredContractTxParams,
  receiptWait?: ReceiptWaitOptions
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

  return await settleSponsoredTx(
    submitResult.txHash,
    submitResult.sendTransactionStatusId,
    params.rpcUrl,
    params.organizationId,
    params.chainId,
    params.executionId,
    receiptWait
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
  // Concrete PublicClient rather than ReturnType<typeof createPublicClient>:
  // the un-instantiated generic return type was the single most expensive
  // comparison in the whole type-check (measured via tsc --generateTrace).
  publicClient: PublicClient,
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

// The send is already on the network by the time this runs, so the question is
// only how long to keep looking for its receipt. A healthy sponsored write has
// been observed going from submit to readable receipt in seconds, so eight
// minutes is a very wide margin and covers a badly congested mempool.
//
// This plus the Turnkey hash poll exceeds the idempotency processing lock's
// base TTL, which is safe only because the routes wrap the whole call in
// withIdempotencyHeartbeat: the heartbeat re-extends the lock every 2 minutes,
// so the request cannot outlive its own reservation. Do not raise this without
// checking that heartbeat is still in place.
const RECEIPT_WAIT_BUDGET_MS = 8 * 60_000;
// How long to give one endpoint before rotating to the next. Short relative to
// the budget so a single wedged endpoint cannot consume it.
const RECEIPT_WAIT_PER_ENDPOINT_MS = 30_000;
// Pause between full rotations. Endpoints that reject immediately (connection
// refused, instant 429) would otherwise let the loop spin as fast as they can
// say no, hammering every endpoint for the whole budget.
const RECEIPT_WAIT_ROUND_DELAY_MS = 2000;

/** Shrinkable in tests so the wait budget does not add wall-clock time. */
export type ReceiptWaitOptions = {
  budgetMs?: number;
  perEndpointMs?: number;
  roundDelayMs?: number;
};

/**
 * Every endpoint worth asking for the receipt, most-likely first: the URL the
 * caller broadcast against, then the chain's configured primary and fallback.
 * Deduped, since the caller's URL is usually the primary already.
 */
async function receiptRpcUrls(
  rpcUrl: string,
  chainId: number
): Promise<string[]> {
  let config: Awaited<ReturnType<typeof resolveRpcConfig>> = null;
  try {
    config = await resolveRpcConfig(chainId);
  } catch {
    // Config lookup is an optimization; the caller's URL alone still works.
  }
  const candidates = [rpcUrl, config?.primaryRpcUrl, config?.fallbackRpcUrl];
  return [...new Set(candidates.filter((url): url is string => Boolean(url)))];
}

/**
 * Read the receipt for an already-broadcast sponsored transaction, trying
 * every configured endpoint before giving up.
 *
 * A single load-balanced endpoint can answer for a node that has not yet seen
 * the transaction, so one failed read is not evidence the send did not land.
 * When no endpoint can answer, this raises a pending error carrying the hash
 * rather than a bare Error: the distinction is what stops the caller from
 * re-sending, and a bare Error here is indistinguishable from a pre-broadcast
 * failure.
 */
async function waitForSponsoredReceipt(
  txHash: Hex,
  sendTransactionStatusId: string,
  rpcUrl: string,
  chainId: number,
  options: ReceiptWaitOptions = {}
): Promise<TransactionReceipt> {
  const budgetMs = options.budgetMs ?? RECEIPT_WAIT_BUDGET_MS;
  const perEndpointMs = options.perEndpointMs ?? RECEIPT_WAIT_PER_ENDPOINT_MS;
  const roundDelayMs = options.roundDelayMs ?? RECEIPT_WAIT_ROUND_DELAY_MS;

  const urls = await receiptRpcUrls(rpcUrl, chainId);
  const deadline = Date.now() + budgetMs;
  let lastError: unknown;
  let firstRound = true;

  // Rotate through the endpoints until the budget is spent. One endpoint being
  // wedged or lagging says nothing about whether the transaction landed, so a
  // failed read is a reason to ask someone else rather than to conclude.
  while (firstRound || Date.now() < deadline) {
    if (!firstRound) {
      await sleep(Math.min(roundDelayMs, Math.max(0, deadline - Date.now())));
    }
    firstRound = false;

    for (const url of urls) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        break;
      }
      try {
        return await createPublicClient({
          transport: http(url),
        }).waitForTransactionReceipt({
          hash: txHash,
          timeout: Math.min(perEndpointMs, remaining),
        });
      } catch (error) {
        lastError = error;
      }
    }
  }

  logSystemError(
    ErrorCategory.NETWORK_RPC,
    "[Sponsorship] Sponsored transaction broadcast but its receipt could not be read on any endpoint",
    lastError instanceof Error ? lastError : new Error(String(lastError)),
    { chainId: chainId.toString(), txHash, endpoints: String(urls.length) }
  );

  throw new SponsoredTxPendingError({
    message: `Sponsored transaction was broadcast but its receipt could not be read on any RPC endpoint: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
    sendTransactionStatusId,
    txHash,
  });
}

/**
 * Wait for receipt, record gas usage, and build the result.
 *
 * Turnkey pays the gas, so the org's wallet is never charged for the
 * underlying tx -- but the on-chain receipt still reports gasUsed and
 * effectiveGasPrice, which is what we meter against the org's gas-credit
 * balance. Billing is skipped on testnets.
 *
 * Callers treat a throw from here as "do not fall back to direct signing",
 * which only holds if every throw is one of the two typed sponsored errors.
 * `settleSponsoredTx` below enforces that.
 */
async function finalizeSponsoredTx(
  txHash: Hex,
  sendTransactionStatusId: string,
  rpcUrl: string,
  organizationId: string,
  chainId: number,
  executionId: string,
  receiptWait?: ReceiptWaitOptions
): Promise<SponsoredTransactionResult> {
  const publicClient = createPublicClient({
    transport: http(rpcUrl),
  });

  const receipt = await waitForSponsoredReceipt(
    txHash,
    sendTransactionStatusId,
    rpcUrl,
    chainId,
    receiptWait
  );

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
  // `gasUsed` on the receipt is a unit count; the fee is units * price. Callers
  // put this in `output.gasUsed`, which finalize sums into
  // `workflow_executions.gas_used_wei`, so it has to be the fee like the
  // direct-signing path returns.
  const gasCostWei = gasUsed * effectiveGasPrice;

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
    gasUsed: gasCostWei.toString(),
    gasUsedUnits: gasUsed.toString(),
    effectiveGasPrice: effectiveGasPrice.toString(),
    sponsored: true,
  };
}

/**
 * The single exit from the post-broadcast half of the sponsored path.
 *
 * By the time this runs Turnkey has already put a transaction from the user's
 * wallet on the network. Callers read an untyped throw as a pre-broadcast
 * failure and respond by signing and broadcasting again, which is how one
 * authorized action becomes two on-chain transactions. So anything that
 * escapes finalization other than the two typed sponsored errors -- a gas
 * price lookup, a metrics call, a revert-reason decode -- is converted into a
 * pending error carrying the hash, which callers already handle as
 * "terminal, do not re-send".
 */
async function settleSponsoredTx(
  txHash: Hex,
  sendTransactionStatusId: string,
  rpcUrl: string,
  organizationId: string,
  chainId: number,
  executionId: string,
  receiptWait?: ReceiptWaitOptions
): Promise<SponsoredTransactionResult> {
  try {
    return await finalizeSponsoredTx(
      txHash,
      sendTransactionStatusId,
      rpcUrl,
      organizationId,
      chainId,
      executionId,
      receiptWait
    );
  } catch (error) {
    if (
      isSponsoredTxRevertError(error) ||
      error instanceof SponsoredTxPendingError
    ) {
      throw error;
    }

    logSystemError(
      ErrorCategory.TRANSACTION,
      "[Sponsorship] Finalization failed after the sponsored transaction was broadcast",
      error instanceof Error ? error : new Error(String(error)),
      { organizationId, chainId: chainId.toString(), txHash }
    );

    throw new SponsoredTxPendingError({
      message: `Sponsored transaction ${txHash} was broadcast but could not be finalized: ${
        error instanceof Error ? error.message : String(error)
      }`,
      sendTransactionStatusId,
      txHash,
    });
  }
}
