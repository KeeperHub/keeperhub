import "server-only";

import { ErrorCategory, logUserError } from "@/lib/logging";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
import { getErrorMessage } from "@/lib/utils";
import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import {
  type ChainlinkFeed,
  fetchQuote,
  type FeedReading,
  loadChainlinkFeeds,
  readChainlinkFeed,
  readOnChainState,
  resolveStockToken,
  ROBINHOOD_CHAIN_ID,
} from "./stock-token-core";

export type GetStockPriceInput = StepInput & {
  network: string;
  symbol: string;
};

type GetStockPriceResult =
  | {
      success: true;
      symbol: string;
      name: string;
      tokenAddress: string;
      /** Underlying equity bid/ask from the issuer. Not multiplier adjusted. */
      bid: string;
      ask: string;
      currency: string;
      quoteGeneratedAt: string;
      quoteAgeSeconds: number | null;
      /**
       * Chainlink's token price, with the multiplier already applied, when a
       * feed exists. Null for most tickers: 35 of 194 are covered.
       */
      feedPrice: string | null;
      feedUpdatedAt: string | null;
      feedAgeSeconds: number | null;
      feedBeyondHeartbeat: boolean | null;
      /** The token's own scaling factor, for converting between the two. */
      uiMultiplier: string;
      isTradingHalt: boolean;
      oraclePaused: boolean;
      tokenPaused: boolean;
      paused: boolean;
    }
  | { success: false; error: string };

async function stepHandler(
  input: GetStockPriceInput
): Promise<GetStockPriceResult> {
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

  const resolved = await resolveStockToken(input.symbol);
  if (!resolved.ok) {
    return { success: false, error: resolved.error };
  }
  const { token } = resolved;

  try {
    const rpcManager = await getRpcProvider({ chainId });
    // Corroboration only, and absent for most tickers, so a directory outage
    // must not fail a price the issuer answered perfectly well.
    let feed: ChainlinkFeed | undefined;
    try {
      feed = (await loadChainlinkFeeds()).get(token.symbol);
    } catch {
      feed = undefined;
    }

    const [quote, onChain, reading] = await Promise.all([
      fetchQuote(token.symbol),
      rpcManager.executeWithFailover((provider) =>
        readOnChainState(provider, token.address)
      ),
      feed
        ? rpcManager.executeWithFailover(
            (provider): Promise<FeedReading | null> =>
              readChainlinkFeed(provider, feed)
          )
        : Promise.resolve(null),
    ]);

    return {
      success: true,
      symbol: token.symbol,
      name: token.name,
      tokenAddress: token.address,
      bid: quote.bid,
      ask: quote.ask,
      currency: quote.currency,
      quoteGeneratedAt: quote.generatedAt,
      quoteAgeSeconds: quote.quoteAgeSeconds,
      feedPrice: reading?.price ?? null,
      feedUpdatedAt: reading?.updatedAt ?? null,
      feedAgeSeconds: reading?.ageSeconds ?? null,
      feedBeyondHeartbeat: reading?.beyondHeartbeat ?? null,
      uiMultiplier: onChain.uiMultiplier,
      isTradingHalt: quote.isTradingHalt,
      oraclePaused: onChain.oraclePaused,
      tokenPaused: onChain.tokenPaused,
      paused: onChain.paused,
    };
  } catch (error) {
    logUserError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[Get Stock Price] Failed to read price",
      error,
      { plugin_name: "robinhood", action_name: "get-stock-price" }
    );
    return { success: false, error: getErrorMessage(error) };
  }
}

/**
 * Get Stock Token Price
 *
 * Returns both price conventions side by side rather than reconciling them.
 * The bid/ask is the underlying equity from the issuer; the feed price is the
 * token, with its multiplier applied. They are not interchangeable, and the
 * relationship between them could not be verified against the live chain, so
 * each is labelled with its source and age and the caller chooses.
 */
export async function getStockPriceStep(
  input: GetStockPriceInput
): Promise<GetStockPriceResult> {
  "use step";

  return runPluginStep(
    { pluginName: "robinhood", actionName: "get-stock-price" },
    input,
    stepHandler
  );
}

getStockPriceStep.maxRetries = 0;

export const _integrationType = "robinhood";
