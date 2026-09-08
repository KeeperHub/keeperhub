import "server-only";

import { ethers } from "ethers";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
import { getErrorMessage } from "@/lib/utils";
import { resolveOrganizationContext } from "@/lib/web3/resolve-org-context";
import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import {
  buildSwapExactAmountInCall,
  signAndBroadcastTempoTx,
} from "./tempo-tx-core";
import {
  assertTempoChain,
  buildTempoTxLink,
  quoteTempoSwap,
  resolveTempoToken,
} from "./tempo-step-helpers";

const MAX_UINT128 = (BigInt(1) << BigInt(128)) - BigInt(1);
const DEFAULT_SLIPPAGE_BPS = 50; // 0.5%
const BPS_DENOMINATOR = 10_000;

export type DexSwapInput = StepInput & {
  network: string;
  tokenInConfig: string | Record<string, unknown>;
  tokenOutConfig: string | Record<string, unknown>;
  amountIn: string;
  slippageBps?: string | number;
};

export type DexSwapResult =
  | {
      success: true;
      transactionHash: string;
      transactionLink: string;
      from: string;
      tokenIn: string;
      tokenOut: string;
      amountIn: string;
      quotedOut: string;
      minAmountOut: string;
      chainId: number;
    }
  | { success: false; error: string };

function parseSlippageBps(raw: string | number | undefined): number | null {
  if (raw === undefined || raw === "") {
    return DEFAULT_SLIPPAGE_BPS;
  }
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value) || value < 0 || value >= BPS_DENOMINATOR) {
    return null;
  }
  return Math.floor(value);
}

async function stepHandler(input: DexSwapInput): Promise<DexSwapResult> {
  const { network, tokenInConfig, tokenOutConfig, amountIn, _context } = input;

  let chainId: number;
  try {
    chainId = getChainIdFromNetwork(network);
    assertTempoChain(chainId);
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }

  if (!amountIn || amountIn.trim() === "") {
    return { success: false, error: "Amount is required" };
  }
  const slippageBps = parseSlippageBps(input.slippageBps);
  if (slippageBps === null) {
    return {
      success: false,
      error: "Slippage must be between 0 and 9999 basis points",
    };
  }

  if (!(_context?.executionId || _context?.organizationId)) {
    return {
      success: false,
      error: "Execution ID or organization ID is required",
    };
  }
  const orgCtx = await resolveOrganizationContext(
    _context,
    "[Tempo DEX Swap]",
    "dex-swap"
  );
  if (!orgCtx.success) {
    return orgCtx;
  }

  try {
    const rpcManager = await getRpcProvider({
      chainId,
      userId: orgCtx.userId,
    });
    const [tokenIn, tokenOut] = await Promise.all([
      resolveTempoToken(tokenInConfig, chainId, rpcManager),
      resolveTempoToken(tokenOutConfig, chainId, rpcManager),
    ]);
    if (tokenIn.address.toLowerCase() === tokenOut.address.toLowerCase()) {
      return {
        success: false,
        error: "tokenIn and tokenOut must be different tokens",
      };
    }

    const amountInRaw = ethers.parseUnits(amountIn, tokenIn.decimals);
    if (amountInRaw <= BigInt(0)) {
      return { success: false, error: "Amount must be greater than zero" };
    }
    if (amountInRaw > MAX_UINT128) {
      return {
        success: false,
        error: "Amount exceeds the uint128 limit supported by the DEX",
      };
    }

    const quotedOut = await quoteTempoSwap(
      rpcManager,
      tokenIn.address,
      tokenOut.address,
      amountInRaw
    );
    if (quotedOut <= BigInt(0)) {
      return {
        success: false,
        error: `No DEX liquidity for ${tokenIn.symbol} to ${tokenOut.symbol}`,
      };
    }
    const minAmountOut =
      (quotedOut * BigInt(BPS_DENOMINATOR - slippageBps)) /
      BigInt(BPS_DENOMINATOR);

    const call = buildSwapExactAmountInCall(
      tokenIn.address,
      tokenOut.address,
      amountInRaw,
      minAmountOut
    );
    const { hash, from } = await signAndBroadcastTempoTx({
      organizationId: orgCtx.organizationId,
      userId: orgCtx.userId,
      chainId,
      calls: [call],
      feeToken: tokenIn.address,
      executionId: _context?.executionId,
    });

    const transactionLink = await buildTempoTxLink(chainId, hash);
    return {
      success: true,
      transactionHash: hash,
      transactionLink,
      from,
      tokenIn: tokenIn.symbol,
      tokenOut: tokenOut.symbol,
      amountIn,
      quotedOut: ethers.formatUnits(quotedOut, tokenOut.decimals),
      minAmountOut: ethers.formatUnits(minAmountOut, tokenOut.decimals),
      chainId,
    };
  } catch (error) {
    logUserError(
      ErrorCategory.TRANSACTION,
      "[Tempo DEX Swap] dex-swap failed",
      error,
      { plugin_name: "tempo", action_name: "dex-swap" }
    );
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function dexSwapStep(input: DexSwapInput): Promise<DexSwapResult> {
  "use step";

  return runPluginStep(
    { pluginName: "tempo", actionName: "dex-swap" },
    input,
    stepHandler
  );
}

dexSwapStep.maxRetries = 0;

export const _integrationType = "tempo";
