import "server-only";

import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import {
  type TradeStockTokenCoreInput,
  tradeStockTokenCore,
  type TradeStockTokenResult,
} from "./trade-stock-token-core";

export type TradeStockTokenInput = StepInput &
  Omit<TradeStockTokenCoreInput, "_context">;

/**
 * Trade Stock Token
 *
 * Swaps USDG into a tokenised equity or back out, through the Universal Router
 * on Uniswap v4.
 *
 * Takes an explicit pool key. This chain carries hundreds of pools per stock
 * token at fee tiers reaching 95%, all reachable and none distinguished
 * on-chain, so any pool a heuristic could pick is a pool a griefer could aim
 * at. The caller names the pool and the minimum they will accept, and the
 * router enforces the minimum twice.
 */
export async function tradeStockTokenStep(
  input: TradeStockTokenInput
): Promise<TradeStockTokenResult> {
  "use step";

  return runPluginStep(
    { pluginName: "robinhood", actionName: "trade-stock-token" },
    input,
    (received: TradeStockTokenInput) => tradeStockTokenCore(received)
  );
}

// Never retried. A swap that timed out may still land, and a second attempt
// would be a second trade at a price nobody asked for.
tradeStockTokenStep.maxRetries = 0;

export const _integrationType = "robinhood";
