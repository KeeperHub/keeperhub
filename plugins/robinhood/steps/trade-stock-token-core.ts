import "server-only";

import { ethers } from "ethers";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
import {
  executeContractCallAsRole,
  executeContractCallAsSafe,
} from "@/lib/safe/execute-as-safe";
import { resolveSignerForNode, SIGNER_MODE } from "@/lib/safe/signer-resolver";
import { getErrorMessage } from "@/lib/utils";
import { getChainAdapter } from "@/lib/web3/chain-adapter";
import { resolveGasLimitOverrides } from "@/lib/web3/gas-defaults";
import {
  preflightGasBalance,
  resolveFundingHolder,
} from "@/lib/web3/gas-preflight";
import { resolveOrganizationContext } from "@/lib/web3/resolve-org-context";
import {
  convertAmountForWrite,
  resolveForWrite,
} from "@/lib/web3/ui-multiplier";
import {
  getOrganizationWalletAddress,
  initializeWalletSigner,
} from "@/lib/web3/wallet-helpers";
import {
  type TransactionContext,
  withNonceSession,
} from "@/lib/web3/transaction-manager";
import {
  readOnChainState,
  resolveStockToken,
  ROBINHOOD_CHAIN_ID,
} from "./stock-token-core";
import {
  encodeExactInSingleSwap,
  UNIVERSAL_ROUTER_ABI,
} from "./v4-swap-encoding";

/**
 * Swap USDG into a Robinhood stock token, or back out of one.
 *
 * Deliberately takes an explicit pool key rather than discovering one. This
 * chain carries hundreds of pools per stock token at fee tiers up to 95%, all
 * reachable, and nothing on-chain distinguishes the real one. Any discovery
 * heuristic this node could apply would be a heuristic a griefer can aim at.
 * The caller names the pool and names the minimum they will accept, and both
 * are enforced on-chain.
 */

export const UNIVERSAL_ROUTER = "0x8876789976decbfcbbbe364623c63652db8c0904";
export const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
export const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const USDG_DECIMALS = 6;

const ERC20_ALLOWANCE_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
] as const;
const PERMIT2_ABI = [
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
] as const;

export type TradeSide = "buy" | "sell";

export type TradeStockTokenCoreInput = {
  network: string;
  symbol: string;
  side: TradeSide;
  /** Buy: USDG to spend. Sell: shares to sell. */
  amountIn: string;
  /** Buy: minimum shares to receive. Sell: minimum USDG to receive. */
  minAmountOut: string;
  poolFee: string;
  poolTickSpacing: string;
  poolHooks?: string;
  deadlineSeconds?: string;
  web3Connection?: string;
  _context?: {
    executionId?: string;
    organizationId?: string;
    workflowId?: string;
  };
};

export type TradeStockTokenResult =
  | {
      success: true;
      transactionHash: string;
      chainId: number;
      symbol: string;
      side: TradeSide;
      amountIn: string;
      minAmountOut: string;
      poolFee: number;
      poolTickSpacing: number;
    }
  | { success: false; error: string };

/** Refusals that are the caller's to fix, phrased so they can fix them. */
function refuse(error: string): TradeStockTokenResult {
  return { success: false, error };
}

/**
 * The Universal Router never touches a wallet directly: it pulls funds through
 * Permit2, which needs two allowances rather than the usual one. Checked before
 * anything is signed so the failure is a sentence rather than a revert.
 */
async function checkPermit2Allowances(
  runFailover: <T>(op: (p: ethers.ContractRunner) => Promise<T>) => Promise<T>,
  token: string,
  owner: string,
  amount: bigint,
  deadlineSeconds: number
): Promise<string | null> {
  const [toPermit2, permit2ToRouter] = await Promise.all([
    runFailover((p) =>
      new ethers.Contract(token, ERC20_ALLOWANCE_ABI, p).allowance(
        owner,
        PERMIT2
      ) as Promise<bigint>
    ),
    runFailover(
      (p) =>
        new ethers.Contract(PERMIT2, PERMIT2_ABI, p).allowance(
          owner,
          token,
          UNIVERSAL_ROUTER
        ) as Promise<[bigint, bigint, bigint]>
    ),
  ]);

  if (toPermit2 < amount) {
    return `${token} is not approved to Permit2. Approve ${PERMIT2} to spend ${token} from ${owner} first, using the Approve Token action.`;
  }

  const [allowed, expiration] = permit2ToRouter;
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (allowed < amount) {
    return `Permit2 has not authorised the Universal Router to spend ${token}. Call approve(${token}, ${UNIVERSAL_ROUTER}, amount, expiration) on Permit2 at ${PERMIT2}.`;
  }
  // Permit2 rewrites an expiration of 0 to block.timestamp on approve, so a
  // stored 0 means the allowance was never set rather than that it never
  // expires. The deadline margin matters too: an allowance lapsing between now
  // and the deadline reverts on-chain after gas has been spent.
  if (expiration <= now + BigInt(deadlineSeconds)) {
    return `The Permit2 allowance for ${token} to the Universal Router ${
      expiration === BigInt(0) ? "was never set" : "expires too soon"
    }. Re-approve it on Permit2 at ${PERMIT2} with an expiration beyond the trade deadline.`;
  }
  return null;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: a fund-moving path whose refusals are the point; splitting them would hide the gate sequence
export async function tradeStockTokenCore(
  input: TradeStockTokenCoreInput
): Promise<TradeStockTokenResult> {
  let chainId: number;
  try {
    chainId = getChainIdFromNetwork(input.network);
  } catch (error) {
    return refuse(getErrorMessage(error));
  }
  if (chainId !== ROBINHOOD_CHAIN_ID) {
    return refuse("Stock tokens exist only on Robinhood Chain (4663).");
  }

  const resolved = await resolveStockToken(input.symbol);
  if (!resolved.ok) {
    return refuse(resolved.error);
  }
  const token = resolved.token;

  const orgCtx = await resolveOrganizationContext(
    input._context ?? {},
    "[Trade Stock Token]",
    "trade-stock-token"
  );
  if (!orgCtx.success) {
    return refuse(orgCtx.error);
  }
  const { organizationId } = orgCtx;

  const fee = Number(input.poolFee);
  const tickSpacing = Number(input.poolTickSpacing);
  if (!(Number.isInteger(fee) && Number.isInteger(tickSpacing))) {
    return refuse("poolFee and poolTickSpacing must be integers.");
  }

  const deadlineSeconds = Number(input.deadlineSeconds || "300");
  if (!(Number.isInteger(deadlineSeconds) && deadlineSeconds > 0)) {
    // A template-input resolves to any string at runtime. Left unchecked,
    // "5m" throws out of the function as a RangeError rather than returning a
    // refusal, and "-100" silently builds a deadline already in the past.
    return refuse(
      `deadlineSeconds must be a positive whole number of seconds, got: ${input.deadlineSeconds}`
    );
  }

  let rpcManager: Awaited<ReturnType<typeof getRpcProvider>>;
  try {
    rpcManager = await getRpcProvider({ chainId });
  } catch (error) {
    return refuse(getErrorMessage(error));
  }
  const runFailover = <T>(op: (p: ethers.ContractRunner) => Promise<T>) =>
    rpcManager.executeWithFailover(op as (p: ethers.JsonRpcProvider) => Promise<T>);

  // Gate before anything else. Out of hours the feed freezes while the pool
  // keeps quoting, so there is no oracle anchor and nothing arbitraging the
  // price: this is exactly when an automated swap gets filled badly.
  const state = await runFailover((p) => readOnChainState(p, token.address));
  const blocked: string[] = [];
  if (state.paused) {
    blocked.push("token contract paused");
  }
  if (state.tokenPaused) {
    blocked.push("transfers paused");
  }
  if (state.oraclePaused) {
    blocked.push("oracle paused");
  }
  if (state.pendingMultiplier) {
    blocked.push("corporate action pending");
  }
  for (const field of state.unknown) {
    blocked.push(`could not read ${field}`);
  }
  if (blocked.length > 0) {
    return refuse(`Refusing to trade ${token.symbol}: ${blocked.join("; ")}.`);
  }

  // Shares convert to raw units; USDG does not scale. A sell is sized in
  // shares and a buy's minimum is expressed in shares, so both cross the
  // multiplier and both must be converted or the trade is off by it.
  const multiplier = await resolveForWrite(runFailover, chainId, token.address);
  if (!multiplier.ok) {
    return refuse(getErrorMessage(multiplier.error));
  }

  const toShares = (value: string): bigint | string => {
    let parsed: bigint;
    try {
      parsed = ethers.parseUnits(value, token.decimals);
    } catch {
      return `Invalid share amount: ${value}`;
    }
    const converted = convertAmountForWrite(parsed, multiplier.multiplier);
    return converted.ok ? converted.raw : converted.error;
  };

  let amountInRaw: bigint;
  let minOutRaw: bigint;
  if (input.side === "buy") {
    try {
      amountInRaw = ethers.parseUnits(input.amountIn, USDG_DECIMALS);
    } catch {
      return refuse(`Invalid USDG amount: ${input.amountIn}`);
    }
    const out = toShares(input.minAmountOut);
    if (typeof out === "string") {
      return refuse(out);
    }
    minOutRaw = out;
  } else {
    const inRaw = toShares(input.amountIn);
    if (typeof inRaw === "string") {
      return refuse(inRaw);
    }
    amountInRaw = inRaw;
    try {
      minOutRaw = ethers.parseUnits(input.minAmountOut, USDG_DECIMALS);
    } catch {
      return refuse(`Invalid USDG amount: ${input.minAmountOut}`);
    }
  }

  const [c0, c1] =
    BigInt(USDG) < BigInt(token.address)
      ? [USDG, token.address]
      : [token.address, USDG];
  const inputCurrency = input.side === "buy" ? USDG : token.address;

  let encoded: ReturnType<typeof encodeExactInSingleSwap>;
  try {
    encoded = encodeExactInSingleSwap({
      poolKey: {
        currency0: c0,
        currency1: c1,
        fee,
        tickSpacing,
        hooks: input.poolHooks || ethers.ZeroAddress,
      },
      inputCurrency,
      amountIn: amountInRaw,
      minAmountOut: minOutRaw,
    });
  } catch (error) {
    return refuse(getErrorMessage(error));
  }

  let signerMode: Awaited<ReturnType<typeof resolveSignerForNode>>;
  try {
    signerMode = await resolveSignerForNode({
      organizationId,
      chainId,
      web3Connection: input.web3Connection,
    });
  } catch (error) {
    return refuse(`Failed to resolve Web3 Connection: ${getErrorMessage(error)}`);
  }

  const rpcUrl = rpcManager.getProvider()._getConnection().url;
  let signer: Awaited<ReturnType<typeof initializeWalletSigner>>;
  let signerAddress: string;
  try {
    signer = await initializeWalletSigner(organizationId, rpcUrl, chainId);
    signerAddress = await getOrganizationWalletAddress(organizationId);
  } catch (error) {
    return refuse(
      `Failed to initialize organization wallet: ${getErrorMessage(error)}`
    );
  }
  const spender =
    signerMode.kind === SIGNER_MODE.SAFE_ROLE ||
    signerMode.kind === SIGNER_MODE.SAFE
      ? signerMode.safeAddress
      : signerAddress;

  const allowanceProblem = await checkPermit2Allowances(
    runFailover,
    inputCurrency,
    spender,
    amountInRaw,
    deadlineSeconds
  );
  if (allowanceProblem) {
    return refuse(allowanceProblem);
  }

  const deadline =
    BigInt(Math.floor(Date.now() / 1000)) + BigInt(deadlineSeconds);
  const args = [encoded.commands, encoded.inputs, deadline];

  // Before the nonce session, deliberately. A holder that cannot pay would
  // otherwise take the lock, discover it at broadcast, and stall every other
  // execution for the same wallet behind a failover round.
  const gasCheck = await preflightGasBalance({
    chainId,
    rpcManager,
    // Gas is drawn from the Safe in Safe modes and the EOA otherwise, which is
    // a different address from the nonce key above.
    holderAddress: resolveFundingHolder(signerMode, signerAddress),
  });
  if (!gasCheck.affordable) {
    return refuse(gasCheck.message);
  }

  try {
    const adapter = getChainAdapter(chainId);
    const txContext: TransactionContext = {
      organizationId,
      executionId: input._context?.executionId ?? "direct-trade",
      workflowId: input._context?.workflowId,
      chainId,
      rpcUrl,
      rpcManager,
    };

    // Keyed on the EOA, not on `spender`. In Safe mode `spender` is the Safe,
    // but the nonce this session hands out is applied to the outer transaction
    // the EOA signs, so keying on the Safe would read the proxy's transaction
    // count and sign with a nonce that is far too low. It would also take the
    // lock on the wrong key, leaving a concurrent transfer on the same EOA
    // unserialised. `spender` stays the Permit2 owner, where it is correct:
    // in Safe mode the Safe is msgSender() to the router.
    const hash: string = await withNonceSession(
      txContext,
      signerAddress,
      async (session) => {
        const { multiplierOverride, gasLimitOverride } =
          resolveGasLimitOverrides(undefined);
        const workflowId = input._context?.workflowId;
        // The Safe helpers and the EVM adapter take different option shapes.
        const safeOptions = { chainId, workflowId, rpcManager };
        const adapterOptions = {
          gasOverrides: { multiplierOverride, gasLimitOverride },
          workflowId,
          rpcManager,
        };
      if (signerMode.kind === SIGNER_MODE.SAFE_ROLE) {
        const receipt = await executeContractCallAsRole(
          signer,
          {
            safeAddress: signerMode.safeAddress,
            delegateAddress: signerMode.delegateAddress,
            rolesModifierAddress: signerMode.rolesModifierAddress,
            roleKey: signerMode.roleKey,
            contractAddress: UNIVERSAL_ROUTER,
            abi: UNIVERSAL_ROUTER_ABI,
            functionKey: "execute",
            args,
          },
          session,
          safeOptions
        );
        return receipt.hash;
      }
      if (signerMode.kind === SIGNER_MODE.SAFE) {
        const receipt = await executeContractCallAsSafe(
          signer,
          {
            safeAddress: signerMode.safeAddress,
            ownerAddress: signerMode.ownerAddress,
            contractAddress: UNIVERSAL_ROUTER,
            abi: UNIVERSAL_ROUTER_ABI,
            functionKey: "execute",
            args,
          },
          session,
          safeOptions
        );
        return receipt.hash;
      }
      const receipt = await adapter.executeContractCall(
        signer,
        {
          contractAddress: UNIVERSAL_ROUTER,
          abi: UNIVERSAL_ROUTER_ABI,
          functionKey: "execute",
          args,
        },
        session,
        adapterOptions
      );
      return receipt.hash;
      }
    );

    return {
      success: true,
      transactionHash: hash,
      chainId,
      symbol: token.symbol,
      side: input.side,
      amountIn: input.amountIn,
      minAmountOut: input.minAmountOut,
      poolFee: fee,
      poolTickSpacing: tickSpacing,
    };
  } catch (error) {
    logUserError(
      ErrorCategory.TRANSACTION,
      "[Trade Stock Token] Swap failed",
      error,
      { plugin_name: "robinhood", action_name: "trade-stock-token" }
    );
    return refuse(getErrorMessage(error));
  }
}
