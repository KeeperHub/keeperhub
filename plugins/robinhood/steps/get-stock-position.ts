import "server-only";

import { ethers } from "ethers";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
import { getErrorMessage } from "@/lib/utils";
import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import {
  fetchQuote,
  readPosition,
  resolveStockToken,
  ROBINHOOD_CHAIN_ID,
} from "./stock-token-core";

export type GetStockPositionInput = StepInput & {
  network: string;
  symbol: string;
  address: string;
};

type GetStockPositionResult =
  | {
      success: true;
      symbol: string;
      tokenAddress: string;
      address: string;
      /**
       * Share count, which is what Robinhood shows the holder and what the
       * position is worth. This is the number to act on.
       */
      shares: string;
      /**
       * Unscaled on-chain balance. This is what `transfer` moves and what a
       * block explorer displays, and it differs from `shares` by the
       * multiplier whenever a corporate action has been applied.
       */
      rawBalance: string;
      uiMultiplier: string;
      /** shares * bid, in the quote currency. Null if no quote was available. */
      valueAtBid: string | null;
      currency: string | null;
      quoteAgeSeconds: number | null;
    }
  | { success: false; error: string };

async function stepHandler(
  input: GetStockPositionInput
): Promise<GetStockPositionResult> {
  let chainId: number;
  try {
    chainId = getChainIdFromNetwork(input.network);
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }

  if (chainId !== ROBINHOOD_CHAIN_ID) {
    return {
      success: false,
      error: "Stock tokens exist only on Robinhood Chain (4663).",
    };
  }

  if (!ethers.isAddress(input.address)) {
    return { success: false, error: `Invalid address: ${input.address}` };
  }

  const resolved = await resolveStockToken(input.symbol);
  if (!resolved.ok) {
    return { success: false, error: resolved.error };
  }
  const { token } = resolved;

  try {
    const rpcManager = await getRpcProvider({ chainId });
    const position = await rpcManager.executeWithFailover((provider) =>
      readPosition(provider, token, input.address)
    );

    // A missing quote should not fail a balance read: the position is a fact
    // about the chain, the valuation is a convenience.
    let valueAtBid: string | null = null;
    let currency: string | null = null;
    let quoteAgeSeconds: number | null = null;
    try {
      const quote = await fetchQuote(token.symbol);
      // Fixed point, not float. `shares` carries up to 18 decimals and a double
      // loses the tail of a large position, in a monetary figure a workflow may
      // branch on. Both sides are scaled to integers before multiplying.
      const CENTS = BigInt(100);
      const bidCents = ethers.parseUnits(quote.bid || "0", 2);
      const sharesUnits = ethers.parseUnits(position.ui, token.decimals);
      if (bidCents > BigInt(0)) {
        const scale = BigInt(10) ** BigInt(token.decimals);
        const cents = (bidCents * sharesUnits) / scale;
        valueAtBid = `${cents / CENTS}.${String(cents % CENTS).padStart(2, "0")}`;
        currency = quote.currency;
        quoteAgeSeconds = quote.quoteAgeSeconds;
      }
    } catch {
      // Reported as nulls below rather than failing the step.
    }

    return {
      success: true,
      symbol: token.symbol,
      tokenAddress: token.address,
      address: input.address,
      shares: position.ui,
      rawBalance: position.raw,
      uiMultiplier: position.uiMultiplier,
      valueAtBid,
      currency,
      quoteAgeSeconds,
    };
  } catch (error) {
    logUserError(
      ErrorCategory.NETWORK_RPC,
      "[Get Stock Position] Failed to read position",
      error,
      { plugin_name: "robinhood", action_name: "get-stock-position" }
    );
    return { success: false, error: getErrorMessage(error) };
  }
}

/**
 * Get Stock Token Position
 *
 * Reports the share count and the raw on-chain balance side by side. Reading
 * `balanceOf` alone understates a position by the multiplier on any token that
 * has been through a corporate action, silently and with no error.
 */
export async function getStockPositionStep(
  input: GetStockPositionInput
): Promise<GetStockPositionResult> {
  "use step";

  return runPluginStep(
    { pluginName: "robinhood", actionName: "get-stock-position" },
    input,
    stepHandler
  );
}

getStockPositionStep.maxRetries = 0;

export const _integrationType = "robinhood";
