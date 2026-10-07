import "server-only";

import {
  type Abi,
  type Address,
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  formatUnits,
  getAddress,
  type Hex,
  isAddress,
  isAddressEqual,
  parseAbiItem,
  parseUnits,
  toEventSelector,
} from "viem";
import {
  checkGasCredits,
  getFreshGasTokenPriceUsd,
} from "@/lib/billing/gas-credits";
import erc20AbiJson from "@/lib/contracts/abis/erc20.json";
import { getChainTokens } from "@/lib/contracts/tokens";
import { db } from "@/lib/db";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import {
  type GasTopUpChainId,
  isGasTopUpChain,
} from "@/lib/execute/gas-top-up-chains";
import {
  checkStablecoinTransferAmount,
  loadStablecoin,
} from "@/lib/execute/stablecoin-cap";
import {
  gasTopUpDailyLimit,
  stablecoinDailyLimitDenial,
} from "@/lib/execute/value-ledger";
import { ErrorCategory, logSystemWarn } from "@/lib/logging";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import { resolveSignerForNode } from "@/lib/safe/signer-resolver";
import { sleep } from "@/lib/sleep";
import { getErrorMessage } from "@/lib/utils";
import { buildChainTransactionUrl } from "@/lib/web3/chain-adapter/explorer";
import { isTestnetChain } from "@/lib/web3/chainlink-feeds";
import { applySlippageFloor } from "@/lib/web3/slippage";
import { createSponsoredClient } from "@/lib/web3/sponsored-client";
import { resolveSponsoredSendError } from "@/lib/web3/sponsored-send-error";
import { executeSponsoredContractTransaction } from "@/lib/web3/sponsored-transaction-manager";
import { shouldTrySponsorship } from "@/lib/web3/sponsorship-eligibility";
import {
  isSponsoredTxPendingError,
  isSponsoredTxRevertError,
} from "@/lib/web3/turnkey-revert";
import quoterAbiJson from "@/protocols/abis/uniswap-quoter.json";
import swapRouterAbiJson from "@/protocols/abis/uniswap-swap-router.json";
import wethAbiJson from "@/protocols/abis/weth.json";
import uniswapV3 from "@/protocols/uniswap-v3";
import wrapped from "@/protocols/wrapped";

const erc20Abi = erc20AbiJson as Abi;
const quoterAbi = quoterAbiJson as Abi;
const swapRouterAbi = swapRouterAbiJson as Abi;
const wethAbi = wethAbiJson as Abi;
// SwapRouter02's exactInputSingle has no deadline of its own; its
// MulticallExtended entry point reverts once block.timestamp passes it.
const swapRouterMulticallAbi = [
  parseAbiItem(
    "function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)"
  ),
] as const;

/**
 * The USDC/WETH pool each chain swaps through. 0.05% is the deepest USDC/WETH
 * pool on Ethereum, Base and Arbitrum; Sepolia uses the 0.3% tier. The quote
 * is taken against the same tier the swap uses, so a thin or missing pool
 * shows up as a failed or small quote (and a refusal) rather than a bad fill.
 */
const POOL_FEE: Readonly<Record<GasTopUpChainId, number>> = {
  1: 500,
  8453: 500,
  42161: 500,
  11155111: 3000,
};

/**
 * A swap still in the mempool this long after its pre-swap quote reverts, so it
 * cannot fill long after the price that set its floor. A revert spends no USDC.
 */
const GAS_TOP_UP_DEADLINE_SECONDS = 180;
/**
 * How much worse than the chain's Chainlink ETH/USD price a quote may be. The
 * quotes and the floor come from the pool the swap fills against, so the
 * oracle is the only price an adversary moving that pool cannot also move.
 * One-sided: a quote better than the oracle never refuses.
 */
const GAS_TOP_UP_ORACLE_TOLERANCE_BPS = 200;
const WETH_DECIMALS = 18;
const LOG_PREFIX = "[Gas Top-up]";
const ACTION_NAME = "gas-top-up";

const ORACLE_PRICE_DECIMALS = 8;

/**
 * The least WETH (wei) `amountIn` USDC may buy at the oracle's ETH/USD price
 * less the tolerance, valuing USDC at 1 USD. In bigint after scaling the price
 * to the oracle's own 8 decimals.
 */
export function minimumOracleWethOut(
  amountIn: bigint,
  usdcDecimals: number,
  ethPriceUsd: number,
  toleranceBps: number = GAS_TOP_UP_ORACLE_TOLERANCE_BPS
): bigint {
  const price = BigInt(Math.round(ethPriceUsd * 10 ** ORACLE_PRICE_DECIMALS));
  const expectedWei =
    (amountIn *
      BigInt(10) ** BigInt(WETH_DECIMALS - usdcDecimals) *
      BigInt(10) ** BigInt(ORACLE_PRICE_DECIMALS)) /
    price;
  return applySlippageFloor(expectedWei, toleranceBps);
}

/**
 * A refusal message when the quote is materially worse than the oracle price,
 * or when no fresh oracle price can be read (fail closed); null when it passes.
 * Testnets have no feed and no value at stake, so they skip the check.
 */
async function oracleCheck(
  plan: GasTopUpPlan,
  rpcUrl: string,
  quotedOut: bigint
): Promise<string | null> {
  if (isTestnetChain(plan.chainId)) {
    return null;
  }
  let ethPriceUsd: number;
  try {
    ethPriceUsd = await getFreshGasTokenPriceUsd(rpcUrl, plan.chainId);
  } catch (error) {
    return `No fresh Chainlink ETH/USD price (${getErrorMessage(error)}); refusing to swap without an independent price check`;
  }
  const minimum = minimumOracleWethOut(
    plan.amountIn,
    plan.usdc.decimals,
    ethPriceUsd
  );
  if (quotedOut >= minimum) {
    return null;
  }
  const impliedUsdPerEth =
    Number(plan.amountUsdc) / Number(formatUnits(quotedOut, WETH_DECIMALS));
  return `Quote implies ${impliedUsdPerEth.toFixed(2)} USD per ETH, more than ${GAS_TOP_UP_ORACLE_TOLERANCE_BPS / 100}% worse than the Chainlink price of ${ethPriceUsd.toFixed(2)}; refusing to swap`;
}

type GasTopUpContracts = {
  router: Address;
  quoter: Address;
  weth: Address;
  fee: number;
};

/**
 * Router, quoter and WETH come from the protocol registry definitions rather
 * than local literals, so this route can never swap through an address the
 * protocol integrations (and the stablecoin-cap spender allowlist) do not
 * already know.
 */
export function resolveGasTopUpContracts(
  chainId: GasTopUpChainId
): GasTopUpContracts | null {
  const key = String(chainId);
  const router = uniswapV3.contracts.swapRouter?.addresses[key];
  const quoter = uniswapV3.contracts.quoter?.addresses[key];
  const weth = wrapped.contracts.weth?.addresses[key];
  if (!(router && quoter && weth)) {
    return null;
  }
  if (!(isAddress(router) && isAddress(quoter) && isAddress(weth))) {
    return null;
  }
  return {
    router: getAddress(router),
    quoter: getAddress(quoter),
    weth: getAddress(weth),
    fee: POOL_FEE[chainId],
  };
}

type UsdcToken = { address: Address; decimals: number };

/**
 * The address is pinned to canonical USDC from the static token list, never
 * matched by symbol, so a second row labelled USDC cannot redirect the swap to
 * another token. The `supported_tokens` row is found with the stablecoin cap's
 * own lookup: it must exist (the cap meters it) and supplies the decimals.
 */
async function resolveUsdc(chainId: number): Promise<UsdcToken | null> {
  const canonical = getChainTokens(chainId).find(
    (token) => token.symbol === "USDC"
  );
  if (!canonical) {
    return null;
  }
  const token = await loadStablecoin(chainId, canonical.address);
  return token
    ? { address: getAddress(canonical.address), decimals: token.decimals }
    : null;
}

export type GasTopUpPlan = {
  organizationId: string;
  chainId: GasTopUpChainId;
  wallet: Address;
  usdc: UsdcToken;
  contracts: GasTopUpContracts;
  amountUsdc: string;
  amountIn: bigint;
  /** What the daily cap is charged, in micro-USD, derived from `amountIn`. */
  amountMicroUsd: bigint;
};

const MICRO_USD_DECIMALS = 6;

/** USDC counted at 1 USD. Rounded up so the cap never under-counts. */
function toMicroUsd(amountIn: bigint, decimals: number): bigint {
  if (decimals <= MICRO_USD_DECIMALS) {
    return amountIn * BigInt(10) ** BigInt(MICRO_USD_DECIMALS - decimals);
  }
  const scale = BigInt(10) ** BigInt(decimals - MICRO_USD_DECIMALS);
  return (amountIn + scale - BigInt(1)) / scale;
}

export type GasTopUpRefusalCode =
  | "UNSUPPORTED_CHAIN"
  | "USDC_NOT_CONFIGURED"
  | "INVALID_AMOUNT"
  | "STABLECOIN_CAP_EXCEEDED"
  | "DAILY_LIMIT_EXCEEDED"
  | "SPONSORSHIP_UNAVAILABLE";

export type GasTopUpPreparation =
  | { ok: true; plan: GasTopUpPlan }
  | { ok: false; code: GasTopUpRefusalCode; error: string; field?: string };

/**
 * Everything that can refuse a top-up before an execution is reserved: the
 * chain, the amount against the per-call stablecoin cap, and whether every
 * transaction can go through Turnkey sponsorship. Nothing here signs or sends.
 *
 * Sponsorship is required, not preferred. The wallet this is for typically
 * holds no native balance, so a direct-signing fallback would fail at
 * broadcast anyway, and a partially self-paid sequence is worse than none.
 */
export async function prepareGasTopUp(params: {
  organizationId: string;
  chainId: number;
  amountUsdc: string;
}): Promise<GasTopUpPreparation> {
  const { organizationId, chainId, amountUsdc } = params;

  if (!isGasTopUpChain(chainId)) {
    return {
      ok: false,
      code: "UNSUPPORTED_CHAIN",
      error: `Gas top-up is not available on chain ${chainId}`,
      field: "chainId",
    };
  }

  const contracts = resolveGasTopUpContracts(chainId);
  if (!contracts) {
    return {
      ok: false,
      code: "UNSUPPORTED_CHAIN",
      error: `Uniswap V3 or WETH is not registered on chain ${chainId}`,
      field: "chainId",
    };
  }

  const usdc = await resolveUsdc(chainId);
  if (!usdc) {
    return {
      ok: false,
      code: "USDC_NOT_CONFIGURED",
      error: `Canonical USDC is not a supported stablecoin on chain ${chainId}`,
      field: "chainId",
    };
  }

  let amountIn: bigint;
  try {
    amountIn = parseUnits(amountUsdc, usdc.decimals);
  } catch {
    return {
      ok: false,
      code: "INVALID_AMOUNT",
      error: `Invalid USDC amount: ${amountUsdc}`,
      field: "amountUsdc",
    };
  }
  if (amountIn <= BigInt(0)) {
    return {
      ok: false,
      code: "INVALID_AMOUNT",
      error: "amountUsdc must be greater than 0",
      field: "amountUsdc",
    };
  }

  // The swap itself is not a call the stablecoin cap meters, and the approve
  // to SwapRouter02 is exempt as a known protocol spender, so the bound is
  // applied here, as a transfer of the full amount, before anything is sent.
  const cap = await checkStablecoinTransferAmount({
    organizationId,
    chainId,
    tokenAddress: usdc.address,
    amount: amountUsdc,
    context: ACTION_NAME,
  });
  if (cap.kind === "denied") {
    return {
      ok: false,
      code: "STABLECOIN_CAP_EXCEEDED",
      error: cap.error,
      field: "amountUsdc",
    };
  }

  // Unlocked, so a concurrent request can race it: this only spares an org
  // whose day is already spent the signer, credit and Turnkey work below. The
  // reservation repeats the check under the cap row lock, and that one decides.
  const amountMicroUsd = toMicroUsd(amountIn, usdc.decimals);
  const dailyDenial = await stablecoinDailyLimitDenial(
    db,
    organizationId,
    gasTopUpDailyLimit(amountMicroUsd)
  );
  if (dailyDenial) {
    return {
      ok: false,
      code: "DAILY_LIMIT_EXCEEDED",
      error: dailyDenial,
      field: "amountUsdc",
    };
  }

  // web3Connection "eoa" pins the sender to the org's Turnkey EOA regardless
  // of any Safe the org runs on this chain: the native balance is for the
  // wallet that pays gas, and that is the EOA.
  const signerMode = await resolveSignerForNode({
    organizationId,
    chainId,
    web3Connection: "eoa",
  });
  if (!shouldTrySponsorship({ chainId, signerMode, sponsorGas: true })) {
    return {
      ok: false,
      code: "SPONSORSHIP_UNAVAILABLE",
      error: `Gas sponsorship is not available on chain ${chainId}; gas top-up only runs sponsored`,
    };
  }

  const credits = await checkGasCredits(organizationId);
  if (!credits.allowed) {
    return {
      ok: false,
      code: "SPONSORSHIP_UNAVAILABLE",
      error: `Gas sponsorship credits are exhausted: ${credits.reason}`,
    };
  }

  const client = await createSponsoredClient(organizationId, chainId);
  if (!client) {
    return {
      ok: false,
      code: "SPONSORSHIP_UNAVAILABLE",
      error:
        "The organization has no active Turnkey wallet eligible for gas sponsorship",
    };
  }

  return {
    ok: true,
    plan: {
      organizationId,
      chainId,
      // The sponsored send always signs from this wallet, so it is also the
      // swap recipient. There is deliberately no caller-supplied recipient.
      wallet: getAddress(client.walletAddress),
      usdc,
      contracts,
      amountUsdc,
      amountIn,
      amountMicroUsd,
    },
  };
}

export type GasTopUpStepName = "approve" | "swap" | "unwrap";

export type GasTopUpStep = {
  name: GasTopUpStepName;
  status: "confirmed" | "failed" | "skipped";
  transactionHash?: string;
  transactionLink?: string;
  error?: string;
};

export type GasTopUpFailure = {
  step: GasTopUpStepName | "preflight";
  error: string;
  transactionHash?: string;
  transactionLink?: string;
  broadcastAttempted: boolean;
  errorClass?: ExecutionErrorType;
};

export type GasTopUpResult = {
  success: boolean;
  chainId: GasTopUpChainId;
  wallet: Address;
  steps: GasTopUpStep[];
  usdcSpent?: string;
  quotedWethOut?: string;
  amountOutMinimum?: string;
  wethReceived?: string;
  ethReceived?: string;
  sponsored: true;
  /** True once any step reached Turnkey's broadcast path. */
  broadcastAttempted: boolean;
  /** True once the swap confirmed: the USDC is spent, whatever happens next. */
  swapLanded: boolean;
  /**
   * True when the swap was broadcast but is unconfirmed: the USDC may or may
   * not be spent. The daily cap keys on this, since the reconciler settles the
   * row's status later but never rewrites its output.
   */
  swapPending?: boolean;
  /**
   * Set only when the approve confirmed and the swap then did not happen:
   * true once approve(router, 0) confirmed, false when that cleanup was
   * attempted but did not confirm, so the exact-amount approval may remain.
   */
  approvalRevoked?: boolean;
  revokeTransactionHash?: string;
  revokeTransactionLink?: string;
  /** Sum of the confirmed steps' fees, in wei. */
  gasUsedWei: string;
  finalTransactionHash?: string;
  finalTransactionLink?: string;
  /** Set when the run completed but part of the output may remain as WETH. */
  warning?: string;
  error?: string;
  failure?: GasTopUpFailure;
};

type SendOutcome =
  | {
      kind: "confirmed";
      transactionHash: string;
      transactionLink?: string;
      gasUsedWei: bigint;
    }
  | {
      kind: "failed";
      error: string;
      transactionHash?: string;
      transactionLink?: string;
      broadcastAttempted: boolean;
      /** Broadcast but unconfirmed: it may still land. */
      pending?: boolean;
      errorClass?: ExecutionErrorType;
    };

// The explorer link is cosmetic. sendSponsored builds it after a confirmed
// send, inside the try that maps a throw to "failed before broadcast", so a
// failed config lookup must never propagate and mislabel a landed transaction.
async function transactionLinkFor(
  chainId: number,
  hash: string
): Promise<string | undefined> {
  try {
    return (await buildChainTransactionUrl(chainId, hash)) || undefined;
  } catch (error) {
    logSystemWarn(
      ErrorCategory.DATABASE,
      `${LOG_PREFIX} Could not build the explorer link`,
      error,
      { chain_id: String(chainId), transaction_hash: hash }
    );
    return;
  }
}

/**
 * One sponsored send, never retried and never re-signed directly.
 *
 * `null` from the sponsored manager means Turnkey declined before anything
 * was broadcast (flag off, credits gone, activity rejected). A write step
 * would fall back to direct signing there; this route fails closed instead.
 */
async function sendSponsored(params: {
  plan: GasTopUpPlan;
  executionId: string;
  rpcUrl: string;
  to: Address;
  abi: Abi;
  functionName: string;
  args: unknown[];
}): Promise<SendOutcome> {
  const { plan } = params;
  try {
    const result = await executeSponsoredContractTransaction({
      organizationId: plan.organizationId,
      executionId: params.executionId,
      chainId: plan.chainId,
      rpcUrl: params.rpcUrl,
      walletAddress: plan.wallet,
      to: params.to,
      abi: params.abi,
      functionName: params.functionName,
      args: params.args,
    });
    if (!result) {
      return {
        kind: "failed",
        error:
          "Gas sponsorship declined the transaction before broadcast; gas top-up does not fall back to self-paid gas",
        broadcastAttempted: false,
      };
    }
    return {
      kind: "confirmed",
      transactionHash: result.transactionHash,
      transactionLink: await transactionLinkFor(
        plan.chainId,
        result.transactionHash
      ),
      gasUsedWei: BigInt(result.gasUsed),
    };
  } catch (error) {
    if (isSponsoredTxRevertError(error) || isSponsoredTxPendingError(error)) {
      const decision = resolveSponsoredSendError(error, {
        logPrefix: LOG_PREFIX,
        actionName: ACTION_NAME,
        chainId: plan.chainId,
      });
      const pending = isSponsoredTxPendingError(error);
      // The error type, not decision.fallback, proves the send reached
      // Turnkey, so a fallback answer here still reports a broadcast.
      const failure = decision.fallback
        ? {
            error: `Sponsored transaction was broadcast: ${getErrorMessage(error)}`,
            transactionHash: error.txHash,
            errorClass: pending ? ExecutionErrorType.SYSTEM : undefined,
          }
        : decision;
      return {
        kind: "failed",
        error: failure.error,
        transactionHash: failure.transactionHash,
        transactionLink: failure.transactionHash
          ? await transactionLinkFor(plan.chainId, failure.transactionHash)
          : undefined,
        broadcastAttempted: true,
        pending,
        errorClass: failure.errorClass,
      };
    }
    return {
      kind: "failed",
      error: `Sponsored send failed before broadcast: ${getErrorMessage(error)}`,
      broadcastAttempted: false,
    };
  }
}

async function readBalance(
  rpcManager: RpcProviderManager,
  token: Address,
  owner: Address
): Promise<bigint> {
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner],
  });
  const raw = await rpcManager.executeWithFailover((provider) =>
    provider.call({ to: token, data })
  );
  return decodeFunctionResult({
    abi: erc20Abi,
    functionName: "balanceOf",
    data: raw as Hex,
  }) as bigint;
}

/**
 * QuoterV2 answers through eth_call (it simulates the swap and returns the
 * amounts), so this reads the pool's price at the moment of the request.
 * Tuple order differs from the router's: amountIn precedes fee here.
 */
async function quoteUsdcToWeth(
  rpcManager: RpcProviderManager,
  plan: GasTopUpPlan
): Promise<bigint> {
  const data = encodeFunctionData({
    abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    args: [
      {
        tokenIn: plan.usdc.address,
        tokenOut: plan.contracts.weth,
        amountIn: plan.amountIn,
        fee: plan.contracts.fee,
        sqrtPriceLimitX96: BigInt(0),
      },
    ],
  });
  const raw = await rpcManager.executeWithFailover((provider) =>
    provider.call({ to: plan.contracts.quoter, data })
  );
  const decoded = decodeFunctionResult({
    abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    data: raw as Hex,
  }) as readonly [bigint, bigint, number, bigint];
  return decoded[0];
}

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)"
);
const TRANSFER_TOPIC = toEventSelector(TRANSFER_EVENT);

type ReceiptLog = {
  address: string;
  topics: readonly string[];
  data: string;
};

/**
 * WETH the swap paid to the wallet, read from its own receipt: the sum of
 * WETH Transfer events to `wallet`. Exact, and unaffected by WETH the wallet
 * held before or received from elsewhere in the meantime.
 */
export function wethReceivedFromLogs(
  logs: readonly ReceiptLog[],
  weth: Address,
  wallet: Address
): bigint {
  let total = BigInt(0);
  for (const log of logs) {
    if (
      !(
        isAddress(log.address) &&
        isAddressEqual(log.address, weth) &&
        log.topics[0]?.toLowerCase() === TRANSFER_TOPIC &&
        log.topics.length === 3
      )
    ) {
      continue;
    }
    const decoded = decodeEventLog({
      abi: [TRANSFER_EVENT],
      data: log.data as Hex,
      topics: log.topics as [Hex, ...Hex[]],
    });
    if (isAddressEqual(decoded.args.to, wallet)) {
      total += decoded.args.value;
    }
  }
  return total;
}

type SwapOutput = { ok: true; amount: bigint } | { ok: false; error: unknown };

// executeWithFailover takes a null receipt as a valid answer, and a
// load-balanced endpoint can answer from a node a block behind the one the
// sponsored manager just read the receipt from. A few short retries ride that
// lag out before the floor fallback leaves WETH behind.
const SWAP_RECEIPT_READ_ATTEMPTS = 5;
const SWAP_RECEIPT_RETRY_MS = 2000;

/** Shrinkable in tests so the retries do not add wall-clock time. */
export type SwapReceiptReadOptions = {
  attempts?: number;
  delayMs?: number;
};

async function readSwapWethReceived(
  rpcManager: RpcProviderManager,
  plan: GasTopUpPlan,
  swapHash: string,
  options: SwapReceiptReadOptions = {}
): Promise<SwapOutput> {
  const attempts = options.attempts ?? SWAP_RECEIPT_READ_ATTEMPTS;
  const delayMs = options.delayMs ?? SWAP_RECEIPT_RETRY_MS;
  let lastError: unknown = new Error("swap receipt not found");

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) {
      await sleep(delayMs);
    }
    try {
      const receipt = await rpcManager.executeWithFailover(
        (provider) => provider.getTransactionReceipt(swapHash),
        "read"
      );
      if (!receipt) {
        lastError = new Error(
          `swap receipt not found after ${attempt} attempt(s)`
        );
        continue;
      }
      // A mined receipt is final, so a missing transfer is not retried.
      const amount = wethReceivedFromLogs(
        receipt.logs,
        plan.contracts.weth,
        plan.wallet
      );
      if (amount === BigInt(0)) {
        return {
          ok: false,
          error: new Error("swap receipt has no WETH transfer to the wallet"),
        };
      }
      return { ok: true, amount };
    } catch (error) {
      lastError = error;
    }
  }
  return { ok: false, error: lastError };
}

function skippedSteps(from: GasTopUpStepName): GasTopUpStep[] {
  const order: GasTopUpStepName[] = ["approve", "swap", "unwrap"];
  return order
    .slice(order.indexOf(from))
    .map((name) => ({ name, status: "skipped" as const }));
}

/** The approve(router, 0) sent after a swap that did not happen. */
type RevokeOutcome = { revoked: true } | { revoked: false; error: string };

function partialMessage(
  step: GasTopUpStepName,
  error: string,
  pending: boolean,
  revoke?: RevokeOutcome
): string {
  if (step === "approve") {
    return pending
      ? `Approve is unconfirmed; no USDC has been swapped. ${error}`
      : `Approve failed; no USDC was spent. ${error}`;
  }
  if (step === "swap") {
    if (pending) {
      return `Approve confirmed; the swap was broadcast but is unconfirmed, so the USDC may or may not have been spent. ${error}`;
    }
    if (revoke?.revoked) {
      return `Approve confirmed but the swap did not complete; no USDC was spent and the approval was set back to zero. ${error}`;
    }
    const cleanup = revoke
      ? ` (setting it back to zero did not complete: ${revoke.error})`
      : "";
    return `Approve confirmed but the swap did not complete; no USDC was spent and an approval for exactly the requested amount remains${cleanup}. ${error}`;
  }
  return `Approve and swap confirmed but the unwrap did not complete; the swapped WETH is left unwrapped in the wallet. ${error}`;
}

/**
 * approve(exact amount) -> re-quote -> multicall(deadline, [exactInputSingle(
 * recipient = wallet, floor and deadline from that re-quote)]) ->
 * WETH.withdraw(received). Three separate sponsored transactions, so the
 * sequence can stop part-way, and the result says exactly where.
 */
export async function executeGasTopUp(params: {
  plan: GasTopUpPlan;
  executionId: string;
  receiptRead?: SwapReceiptReadOptions;
}): Promise<GasTopUpResult> {
  const { plan, executionId } = params;
  const steps: GasTopUpStep[] = [];
  let gasUsedWei = BigInt(0);

  const base = {
    chainId: plan.chainId,
    wallet: plan.wallet,
    sponsored: true as const,
  };

  const refuse = (error: string): GasTopUpResult => ({
    ...base,
    success: false,
    steps: skippedSteps("approve"),
    usdcSpent: "0",
    broadcastAttempted: false,
    swapLanded: false,
    gasUsedWei: "0",
    error,
    failure: { step: "preflight", error, broadcastAttempted: false },
  });

  let rpcManager: RpcProviderManager;
  let rpcUrl: string;
  try {
    rpcManager = await getRpcProvider({ chainId: plan.chainId });
    rpcUrl = await rpcManager.resolveActiveRpcUrl();
  } catch (error) {
    return refuse(`RPC unavailable: ${getErrorMessage(error)}`);
  }

  let usdcBalance: bigint;
  try {
    usdcBalance = await readBalance(rpcManager, plan.usdc.address, plan.wallet);
  } catch (error) {
    return refuse(`Could not read USDC balance: ${getErrorMessage(error)}`);
  }
  if (usdcBalance < plan.amountIn) {
    return refuse(
      `Insufficient USDC: wallet ${plan.wallet} holds ${formatUnits(usdcBalance, plan.usdc.decimals)} USDC, top-up needs ${plan.amountUsdc}`
    );
  }

  // Pre-flight quote: a pool that cannot fill the amount refuses here, before
  // anything is sent. The swap's own floor comes from a second quote below.
  let quotedOut: bigint;
  try {
    quotedOut = await quoteUsdcToWeth(rpcManager, plan);
  } catch (error) {
    return refuse(`Quote failed: ${getErrorMessage(error)}`);
  }
  let amountOutMinimum = applySlippageFloor(quotedOut);
  if (quotedOut <= BigInt(0) || amountOutMinimum <= BigInt(0)) {
    return refuse("Quote returned no WETH for this amount; refusing to swap");
  }
  const preflightOracleRefusal = await oracleCheck(plan, rpcUrl, quotedOut);
  if (preflightOracleRefusal) {
    return refuse(preflightOracleRefusal);
  }

  let quoteFields = {
    quotedWethOut: quotedOut.toString(),
    amountOutMinimum: amountOutMinimum.toString(),
  };

  const stop = (
    step: GasTopUpStepName,
    outcome: Extract<SendOutcome, { kind: "failed" }>,
    extra: Partial<GasTopUpResult> = {},
    revoke?: RevokeOutcome
  ): GasTopUpResult => {
    const pending = outcome.pending === true;
    const error = partialMessage(step, outcome.error, pending, revoke);
    let next: GasTopUpStepName | null = null;
    if (step === "approve") {
      next = "swap";
    } else if (step === "swap") {
      next = "unwrap";
    }
    return {
      ...base,
      ...quoteFields,
      success: false,
      steps: [
        ...steps,
        {
          name: step,
          status: "failed",
          ...(outcome.transactionHash
            ? { transactionHash: outcome.transactionHash }
            : {}),
          ...(outcome.transactionLink
            ? { transactionLink: outcome.transactionLink }
            : {}),
          error: outcome.error,
        },
        ...(next ? skippedSteps(next) : []),
      ],
      // usdcSpent is unknown while a broadcast swap is unconfirmed.
      ...(step === "swap" && pending
        ? { swapPending: true }
        : { usdcSpent: "0" }),
      broadcastAttempted:
        outcome.broadcastAttempted || steps.some((s) => s.transactionHash),
      swapLanded: false,
      gasUsedWei: gasUsedWei.toString(),
      error,
      failure: {
        step,
        error,
        transactionHash: outcome.transactionHash,
        transactionLink: outcome.transactionLink,
        broadcastAttempted: outcome.broadcastAttempted,
        errorClass: outcome.errorClass,
      },
      ...extra,
    };
  };

  const approve = await sendSponsored({
    plan,
    executionId,
    rpcUrl,
    to: plan.usdc.address,
    abi: erc20Abi,
    functionName: "approve",
    args: [plan.contracts.router, plan.amountIn],
  });
  if (approve.kind === "failed") {
    return stop("approve", approve);
  }
  gasUsedWei += approve.gasUsedWei;
  steps.push({
    name: "approve",
    status: "confirmed",
    transactionHash: approve.transactionHash,
    transactionLink: approve.transactionLink,
  });

  // The swap did not happen, so the exact-amount approval would otherwise be
  // left standing. A swap still pending is left alone: it may yet land, and it
  // needs the allowance to. The cleanup is best effort and never changes which
  // step failed, so the row is settled from the swap as before.
  const failSwap = async (
    outcome: Extract<SendOutcome, { kind: "failed" }>
  ): Promise<GasTopUpResult> => {
    if (outcome.pending) {
      return stop("swap", outcome);
    }
    const revoke = await sendSponsored({
      plan,
      executionId,
      rpcUrl,
      to: plan.usdc.address,
      abi: erc20Abi,
      functionName: "approve",
      args: [plan.contracts.router, BigInt(0)],
    });
    const revokeLink = {
      ...(revoke.transactionHash
        ? { revokeTransactionHash: revoke.transactionHash }
        : {}),
      ...(revoke.transactionLink
        ? { revokeTransactionLink: revoke.transactionLink }
        : {}),
    };
    if (revoke.kind === "confirmed") {
      gasUsedWei += revoke.gasUsedWei;
      return stop(
        "swap",
        outcome,
        { approvalRevoked: true, ...revokeLink },
        { revoked: true }
      );
    }
    logSystemWarn(
      ErrorCategory.TRANSACTION,
      `${LOG_PREFIX} Could not set the approval back to zero`,
      new Error(revoke.error),
      {
        chain_id: String(plan.chainId),
        execution_id: executionId,
        swap_error: outcome.error,
      }
    );
    return stop(
      "swap",
      outcome,
      { approvalRevoked: false, ...revokeLink },
      { revoked: false, error: revoke.error }
    );
  };

  // The approve can wait minutes for its receipt, so the floor and the
  // deadline come from a quote taken now rather than the pre-flight one.
  const swapQuoteFailed = (error: string) =>
    failSwap({ kind: "failed", error, broadcastAttempted: false });
  try {
    quotedOut = await quoteUsdcToWeth(rpcManager, plan);
  } catch (error) {
    return await swapQuoteFailed(
      `Re-quote before the swap failed: ${getErrorMessage(error)}`
    );
  }
  amountOutMinimum = applySlippageFloor(quotedOut);
  if (quotedOut <= BigInt(0) || amountOutMinimum <= BigInt(0)) {
    return await swapQuoteFailed(
      "Re-quote before the swap returned no WETH for this amount; refusing to swap"
    );
  }
  const swapOracleRefusal = await oracleCheck(plan, rpcUrl, quotedOut);
  if (swapOracleRefusal) {
    return await swapQuoteFailed(
      `Re-quote before the swap: ${swapOracleRefusal}`
    );
  }
  quoteFields = {
    quotedWethOut: quotedOut.toString(),
    amountOutMinimum: amountOutMinimum.toString(),
  };
  const deadline = BigInt(
    Math.floor(Date.now() / 1000) + GAS_TOP_UP_DEADLINE_SECONDS
  );

  const exactInputSingle = encodeFunctionData({
    abi: swapRouterAbi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: plan.usdc.address,
        tokenOut: plan.contracts.weth,
        fee: plan.contracts.fee,
        recipient: plan.wallet,
        amountIn: plan.amountIn,
        amountOutMinimum,
        sqrtPriceLimitX96: BigInt(0),
      },
    ],
  });
  const swap = await sendSponsored({
    plan,
    executionId,
    rpcUrl,
    to: plan.contracts.router,
    abi: swapRouterMulticallAbi as unknown as Abi,
    functionName: "multicall",
    args: [deadline, [exactInputSingle]],
  });
  if (swap.kind === "failed") {
    return await failSwap(swap);
  }
  gasUsedWei += swap.gasUsedWei;
  steps.push({
    name: "swap",
    status: "confirmed",
    transactionHash: swap.transactionHash,
    transactionLink: swap.transactionLink,
  });

  // The router enforces amountOutMinimum, so at least the floor arrived. The
  // swap's own receipt gives the exact figure. If it cannot be read, the floor
  // is unwrapped and the shortfall is reported and logged, never passed off as
  // the whole output.
  let wethReceived: bigint;
  let warning: string | undefined;
  const swapOutput = await readSwapWethReceived(
    rpcManager,
    plan,
    swap.transactionHash,
    params.receiptRead
  );
  if (swapOutput.ok) {
    wethReceived = swapOutput.amount;
  } else {
    wethReceived = amountOutMinimum;
    warning = `The exact swap output could not be read (${getErrorMessage(swapOutput.error)}), so the guaranteed minimum of ${formatUnits(amountOutMinimum, WETH_DECIMALS)} WETH was unwrapped. Any WETH the swap delivered above that minimum remains in the wallet; unwrap it with the wrapped/unwrap protocol action.`;
    logSystemWarn(
      ErrorCategory.NETWORK_RPC,
      `${LOG_PREFIX} Could not read the swap's WETH output; unwrapping the minimum`,
      swapOutput.error,
      {
        chain_id: String(plan.chainId),
        execution_id: executionId,
        transaction_hash: swap.transactionHash,
      }
    );
  }

  const swapLandedFields: Partial<GasTopUpResult> = {
    usdcSpent: plan.amountUsdc,
    swapLanded: true,
    wethReceived: formatUnits(wethReceived, WETH_DECIMALS),
    broadcastAttempted: true,
    ...(warning ? { warning } : {}),
  };

  const unwrap = await sendSponsored({
    plan,
    executionId,
    rpcUrl,
    to: plan.contracts.weth,
    abi: wethAbi,
    functionName: "withdraw",
    args: [wethReceived],
  });
  if (unwrap.kind === "failed") {
    return stop("unwrap", unwrap, swapLandedFields);
  }
  gasUsedWei += unwrap.gasUsedWei;
  steps.push({
    name: "unwrap",
    status: "confirmed",
    transactionHash: unwrap.transactionHash,
    transactionLink: unwrap.transactionLink,
  });

  return {
    ...base,
    ...quoteFields,
    success: true,
    steps,
    usdcSpent: plan.amountUsdc,
    wethReceived: formatUnits(wethReceived, WETH_DECIMALS),
    ethReceived: formatUnits(wethReceived, WETH_DECIMALS),
    broadcastAttempted: true,
    swapLanded: true,
    gasUsedWei: gasUsedWei.toString(),
    finalTransactionHash: unwrap.transactionHash,
    finalTransactionLink: unwrap.transactionLink,
    ...(warning ? { warning } : {}),
  };
}
