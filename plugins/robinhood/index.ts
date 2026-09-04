import { registerIntegration } from "@/plugins/registry-core";
import type { IntegrationPlugin } from "@/plugins/registry";
import { RobinhoodIcon } from "./icon";

/**
 * Robinhood Chain stock tokens.
 *
 * These actions exist because the assets are tokenised equities
 * rather than tokens, and the generic web3 actions cannot express that: a
 * balance rescales without a transfer, a price has two conventions that are not
 * interchangeable, and the market behind the asset closes while the chain does
 * not.
 *
 * The registry lists deployments on 4663 only, so every network picker here is
 * pinned to it. The testnet has no stock tokens.
 */
const ROBINHOOD_CHAIN_IDS = ["4663"];

const networkField = {
  key: "network",
  label: "Network",
  type: "chain-select" as const,
  chainTypeFilter: "evm" as const,
  allowedChainIds: ROBINHOOD_CHAIN_IDS,
  placeholder: "Robinhood Chain",
  required: true,
};

const symbolField = {
  key: "symbol",
  label: "Ticker",
  type: "template-input" as const,
  placeholder: "AAPL or {{NodeName.symbol}}",
  example: "AAPL",
  // No helpText: it exists only on IntegrationPlugin.formFields, not on an
  // action config field, and nothing renders it. The guidance it carried is in
  // each action's description instead, where it does reach the user.
  required: true,
};

const robinhoodPlugin: IntegrationPlugin = {
  type: "robinhood",
  egress: "fixed-host",
  label: "Robinhood",
  description:
    "Read prices, positions and trading status for the tokenised equities on Robinhood Chain, and trade them against USDG, in share terms rather than raw token units",

  icon: RobinhoodIcon,

  requiresCredentials: false,
  singleConnection: false,
  formFields: [],

  actions: [
    {
      slug: "get-stock-price",
      label: "Get Stock Token Price",
      description:
        "Quote a stock token by ticker, resolved through the issuer's asset registry rather than an address you paste: a symbol search on the chain explorer returns many lookalikes, several with more holders than the real token. Returns the issuer bid and ask for the underlying equity alongside the Chainlink token price where a feed exists, each with its own age, rather than reconciling them into one number",
      category: "Robinhood",
      stepFunction: "getStockPriceStep",
      stepImportPath: "get-stock-price",
      configFields: [networkField, symbolField],
      outputFields: [
        { field: "success", description: "Whether the read succeeded" },
        { field: "symbol", description: "The resolved ticker" },
        { field: "name", description: "The asset's display name" },
        { field: "tokenAddress", description: "Token contract on chain 4663" },
        { field: "currency", description: "Currency of bid and ask" },
        {
          field: "quoteGeneratedAt",
          description: "When the issuer produced the quote",
        },
        {
          field: "feedUpdatedAt",
          description: "When Chainlink last updated, null when there is no feed",
        },
        {
          field: "bid",
          description:
            "Issuer bid for the underlying equity. Not multiplier adjusted",
        },
        {
          field: "ask",
          description:
            "Issuer ask for the underlying equity. Not multiplier adjusted",
        },
        {
          field: "quoteAgeSeconds",
          description:
            "Age of the issuer quote. Grows without bound while the market is closed",
        },
        {
          field: "feedPrice",
          description:
            "Chainlink token price, multiplier already applied. Null for the majority of tickers, which have no feed",
        },
        {
          field: "feedAgeSeconds",
          description: "Age of the Chainlink answer, null when there is no feed",
        },
        {
          field: "feedBeyondHeartbeat",
          description:
            "Whether the feed is older than its own published heartbeat, which is the only meaningful staleness test for it",
        },
        {
          field: "uiMultiplier",
          description:
            "The token's scaling factor, which is the difference between the two price conventions",
        },
        { field: "isTradingHalt", description: "Issuer-reported trading halt" },
        { field: "oraclePaused", description: "On-chain oracle pause flag" },
        { field: "tokenPaused", description: "On-chain transfer pause flag" },
        { field: "paused", description: "On-chain global pause flag" },
        { field: "error", description: "Error message when the read failed" },
      ],
    },
    {
      slug: "get-stock-position",
      label: "Get Stock Token Position",
      description:
        "Read a holder's position in share terms and in raw on-chain units side by side. Reading balanceOf alone understates a position by the multiplier on any token that has been through a corporate action",
      category: "Robinhood",
      stepFunction: "getStockPositionStep",
      stepImportPath: "get-stock-position",
      configFields: [
        networkField,
        symbolField,
        {
          key: "address",
          label: "Holder Address",
          type: "template-input" as const,
          placeholder: "0x... or {{NodeName.address}}",
          required: true,
        },
      ],
      outputFields: [
        { field: "success", description: "Whether the read succeeded" },
        { field: "symbol", description: "The resolved ticker" },
        { field: "tokenAddress", description: "Token contract on chain 4663" },
        { field: "address", description: "The holder that was read" },
        {
          field: "quoteAgeSeconds",
          description: "Age of the quote behind valueAtBid, null when absent",
        },
        {
          field: "shares",
          description:
            "Share count. What the holder is shown and what the position is worth. Act on this",
        },
        {
          field: "rawBalance",
          description:
            "Unscaled on-chain balance. What transfer moves and what a block explorer shows",
        },
        {
          field: "uiMultiplier",
          description: "The factor between shares and rawBalance",
        },
        {
          field: "valueAtBid",
          description:
            "shares multiplied by the issuer bid, null when no quote was available",
        },
        { field: "currency", description: "Currency of valueAtBid" },
        { field: "error", description: "Error message when the read failed" },
      ],
    },
    {
      slug: "trade-stock-token",
      label: "Trade Stock Token",
      description:
        "Swap USDG into a tokenised equity or back out, through Uniswap v4. Takes an explicit pool key and a minimum output rather than choosing a route: this chain carries hundreds of pools per stock token at fee tiers reaching 95 percent, none distinguished on-chain, so any pool a heuristic would pick is one a griefer can aim at",
      category: "Robinhood",
      stepFunction: "tradeStockTokenStep",
      stepImportPath: "trade-stock-token",
      configFields: [
        networkField,
        symbolField,
        {
          key: "side",
          label: "Side",
          type: "select" as const,
          options: [
            { label: "Buy (spend USDG)", value: "buy" },
            { label: "Sell (spend shares)", value: "sell" },
          ],
          required: true,
        },
        {
          key: "amountIn",
          label: "Amount In",
          type: "template-input" as const,
          placeholder: "Buy: USDG to spend. Sell: shares to sell",
          required: true,
        },
        {
          key: "minAmountOut",
          label: "Minimum Amount Out",
          type: "template-input" as const,
          placeholder: "Buy: minimum shares. Sell: minimum USDG",
          required: true,
        },
        {
          key: "poolFee",
          label: "Pool Fee",
          type: "template-input" as const,
          placeholder: "3000",
          example: "3000",
          required: true,
        },
        {
          key: "poolTickSpacing",
          label: "Pool Tick Spacing",
          type: "template-input" as const,
          placeholder: "60",
          example: "60",
          required: true,
        },
        {
          key: "poolHooks",
          label: "Pool Hooks",
          type: "template-input" as const,
          placeholder: "0x0000000000000000000000000000000000000000",
          required: false,
        },
        {
          key: "deadlineSeconds",
          label: "Deadline (seconds)",
          type: "template-input" as const,
          placeholder: "300",
          required: false,
        },
      ],
      outputFields: [
        { field: "success", description: "Whether the swap was broadcast" },
        { field: "transactionHash", description: "The swap transaction hash" },
        { field: "chainId", description: "Chain the swap was broadcast on" },
        { field: "symbol", description: "The resolved ticker" },
        { field: "side", description: "buy or sell" },
        { field: "amountIn", description: "Amount spent, as supplied" },
        {
          field: "minAmountOut",
          description: "The floor the router enforced, as supplied",
        },
        { field: "poolFee", description: "Fee tier of the pool traded" },
        {
          field: "poolTickSpacing",
          description: "Tick spacing of the pool traded",
        },
        {
          field: "error",
          description:
            "Why the trade was refused or failed, including the Permit2 allowances to set when they are missing",
        },
      ],
    },
    {
      slug: "stock-market-status",
      label: "Stock Market Status",
      description:
        "Guard for price-reactive workflows. Reports whether acting on this token's price is currently sane, and names every reason it is not: halts, the three pause flags, stale quotes, feeds beyond their heartbeat, and pending corporate actions",
      category: "Robinhood",
      stepFunction: "stockMarketStatusStep",
      stepImportPath: "stock-market-status",
      configFields: [networkField, symbolField],
      outputFields: [
        { field: "success", description: "Whether the read succeeded" },
        {
          field: "tradeable",
          description:
            "True when nothing blocks acting on this token's price. Branch on this",
        },
        {
          field: "blockedBy",
          description:
            "Every reason tradeable is false, so a workflow can branch on cause rather than re-deriving it",
        },
        { field: "isTradingHalt", description: "Issuer-reported trading halt" },
        { field: "paused", description: "On-chain global pause flag" },
        { field: "tokenPaused", description: "On-chain transfer pause flag" },
        { field: "oraclePaused", description: "On-chain oracle pause flag" },
        {
          field: "quoteAgeSeconds",
          description: "Age of the issuer quote, null when it carried no timestamp",
        },
        {
          field: "feedAgeSeconds",
          description: "Age of the Chainlink answer, null when there is no feed",
        },
        {
          field: "feedBeyondHeartbeat",
          description: "Whether the Chainlink feed is past its own heartbeat",
        },
        {
          field: "pendingMultiplier",
          description:
            "Scheduled multiplier when a corporate action is pending, which gives advance warning before a split lands",
        },
        {
          field: "pendingEffectiveAt",
          description: "When a pending corporate action takes effect",
        },
        { field: "error", description: "Error message when the read failed" },
      ],
    },
  ],
};

registerIntegration(robinhoodPlugin);

export default robinhoodPlugin;
