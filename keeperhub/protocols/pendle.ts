import { defineProtocol } from "@/keeperhub/lib/protocol-registry";

export default defineProtocol({
  name: "Pendle Finance",
  slug: "pendle",
  description:
    "Pendle Finance -- yield tokenization protocol for trading fixed and variable yield on DeFi assets",
  website: "https://pendle.finance",
  icon: "/protocols/pendle.png",

  contracts: {
    router: {
      label: "PendleRouter",
      // Proxy -- ABI auto-resolved via abi-cache
      addresses: {
        // Ethereum Mainnet
        "1": "0x888888888889758F76e7103c6CbF23ABbF58F946",
        // Base
        "8453": "0x888888888889758F76e7103c6CbF23ABbF58F946",
        // Arbitrum One
        "42161": "0x888888888889758F76e7103c6CbF23ABbF58F946",
        // Optimism
        "10": "0x888888888889758F76e7103c6CbF23ABbF58F946",
      },
    },
    vePendle: {
      label: "vePENDLE",
      addresses: {
        // Ethereum Mainnet
        "1": "0x4f30A9D41B80ecC5B94306AB4364951AE3170210",
      },
    },
    market: {
      label: "Pendle Market",
      userSpecifiedAddress: true,
      // Reference addresses for chain-availability metadata.
      // Runtime address comes from user input via the contractAddress config field.
      addresses: {
        // Ethereum Mainnet
        "1": "0x888888888889758F76e7103c6CbF23ABbF58F946",
        // Base
        "8453": "0x888888888889758F76e7103c6CbF23ABbF58F946",
        // Arbitrum One
        "42161": "0x888888888889758F76e7103c6CbF23ABbF58F946",
        // Optimism
        "10": "0x888888888889758F76e7103c6CbF23ABbF58F946",
      },
    },
    pt: {
      label: "Principal Token (PT)",
      userSpecifiedAddress: true,
      // Reference addresses for chain-availability metadata.
      // Runtime address comes from user input via the contractAddress config field.
      addresses: {
        // Ethereum Mainnet
        "1": "0x888888888889758F76e7103c6CbF23ABbF58F946",
        // Base
        "8453": "0x888888888889758F76e7103c6CbF23ABbF58F946",
        // Arbitrum One
        "42161": "0x888888888889758F76e7103c6CbF23ABbF58F946",
        // Optimism
        "10": "0x888888888889758F76e7103c6CbF23ABbF58F946",
      },
    },
    yt: {
      label: "Yield Token (YT)",
      userSpecifiedAddress: true,
      // Reference addresses for chain-availability metadata.
      // Runtime address comes from user input via the contractAddress config field.
      addresses: {
        // Ethereum Mainnet
        "1": "0x888888888889758F76e7103c6CbF23ABbF58F946",
        // Base
        "8453": "0x888888888889758F76e7103c6CbF23ABbF58F946",
        // Arbitrum One
        "42161": "0x888888888889758F76e7103c6CbF23ABbF58F946",
        // Optimism
        "10": "0x888888888889758F76e7103c6CbF23ABbF58F946",
      },
    },
    sy: {
      label: "Standardized Yield (SY)",
      userSpecifiedAddress: true,
      // Reference addresses for chain-availability metadata.
      // Runtime address comes from user input via the contractAddress config field.
      addresses: {
        // Ethereum Mainnet
        "1": "0x888888888889758F76e7103c6CbF23ABbF58F946",
        // Base
        "8453": "0x888888888889758F76e7103c6CbF23ABbF58F946",
        // Arbitrum One
        "42161": "0x888888888889758F76e7103c6CbF23ABbF58F946",
        // Optimism
        "10": "0x888888888889758F76e7103c6CbF23ABbF58F946",
      },
    },
  },

  events: [
    // Market Events

    {
      slug: "market-swap",
      label: "Market Swap",
      description:
        "Fires when a swap occurs in a Pendle market (PT/SY exchange)",
      eventName: "Swap",
      contract: "market",
      inputs: [
        { name: "caller", type: "address", indexed: true },
        { name: "receiver", type: "address", indexed: true },
        { name: "netPtOut", type: "int256", indexed: false },
        { name: "netSyOut", type: "int256", indexed: false },
        { name: "netSyFee", type: "uint256", indexed: false },
        { name: "netSyToReserve", type: "uint256", indexed: false },
      ],
    },
    {
      slug: "market-mint",
      label: "Market LP Minted",
      description:
        "Fires when liquidity is added to a Pendle market (LP tokens minted)",
      eventName: "Mint",
      contract: "market",
      inputs: [
        { name: "receiver", type: "address", indexed: true },
        { name: "netLpMinted", type: "uint256", indexed: false },
        { name: "netSyUsed", type: "uint256", indexed: false },
        { name: "netPtUsed", type: "uint256", indexed: false },
      ],
    },
    {
      slug: "market-burn",
      label: "Market LP Burned",
      description:
        "Fires when liquidity is removed from a Pendle market (LP tokens burned)",
      eventName: "Burn",
      contract: "market",
      inputs: [
        { name: "receiverSy", type: "address", indexed: true },
        { name: "receiverPt", type: "address", indexed: true },
        { name: "netLpBurned", type: "uint256", indexed: false },
        { name: "netSyOut", type: "uint256", indexed: false },
        { name: "netPtOut", type: "uint256", indexed: false },
      ],
    },
    {
      slug: "update-implied-rate",
      label: "Implied Rate Updated",
      description:
        "Fires when the implied yield rate changes in a Pendle market",
      eventName: "UpdateImpliedRate",
      contract: "market",
      inputs: [
        { name: "timestamp", type: "uint256", indexed: true },
        { name: "lnLastImpliedRate", type: "uint256", indexed: false },
      ],
    },

    // Yield Token Events

    {
      slug: "yt-mint",
      label: "PT/YT Minted",
      description:
        "Fires when SY is split into PT and YT via the Yield Token contract",
      eventName: "Mint",
      contract: "yt",
      inputs: [
        { name: "caller", type: "address", indexed: true },
        { name: "receiverPT", type: "address", indexed: true },
        { name: "receiverYT", type: "address", indexed: true },
        { name: "amountSyToMint", type: "uint256", indexed: false },
        { name: "amountPYOut", type: "uint256", indexed: false },
      ],
    },
    {
      slug: "yt-burn",
      label: "PT/YT Redeemed",
      description:
        "Fires when PT and YT are merged back into SY via the Yield Token contract",
      eventName: "Burn",
      contract: "yt",
      inputs: [
        { name: "caller", type: "address", indexed: true },
        { name: "receiver", type: "address", indexed: true },
        { name: "amountPYToRedeem", type: "uint256", indexed: false },
        { name: "amountSyOut", type: "uint256", indexed: false },
      ],
    },
    {
      slug: "redeem-rewards",
      label: "Rewards Redeemed",
      description:
        "Fires when a user claims accrued rewards from a Yield Token position",
      eventName: "RedeemRewards",
      contract: "yt",
      inputs: [{ name: "user", type: "address", indexed: true }],
    },
    {
      slug: "redeem-interest",
      label: "Interest Redeemed",
      description:
        "Fires when a user claims accrued interest from a Yield Token position",
      eventName: "RedeemInterest",
      contract: "yt",
      inputs: [
        { name: "user", type: "address", indexed: true },
        { name: "interestOut", type: "uint256", indexed: false },
      ],
    },
  ],

  actions: [
    // vePENDLE

    {
      slug: "get-ve-pendle-balance",
      label: "Get vePENDLE Balance",
      description: "Check the vePENDLE voting power balance of an address",
      type: "read",
      contract: "vePendle",
      function: "balanceOf",
      inputs: [{ name: "user", type: "address", label: "Wallet Address" }],
      outputs: [
        {
          name: "balance",
          type: "uint128",
          label: "vePENDLE Balance",
          decimals: 18,
        },
      ],
    },
    {
      slug: "get-ve-pendle-total-supply",
      label: "Get vePENDLE Total Supply",
      description: "Get the stored total vePENDLE supply across all lockers",
      type: "read",
      contract: "vePendle",
      function: "totalSupplyStored",
      inputs: [],
      outputs: [
        {
          name: "totalSupply",
          type: "uint128",
          label: "Total vePENDLE Supply",
          decimals: 18,
        },
      ],
    },
    {
      slug: "get-ve-pendle-position",
      label: "Get vePENDLE Lock Position",
      description:
        "Get the lock position data for an address (amount and expiry)",
      type: "read",
      contract: "vePendle",
      function: "positionData",
      inputs: [{ name: "user", type: "address", label: "Wallet Address" }],
      outputs: [
        {
          name: "amount",
          type: "uint128",
          label: "Locked PENDLE Amount",
          decimals: 18,
        },
        { name: "expiry", type: "uint128", label: "Lock Expiry Timestamp" },
      ],
    },

    // Market

    {
      slug: "get-market-expiry",
      label: "Get Market Expiry",
      description: "Get the expiry timestamp of a Pendle market",
      type: "read",
      contract: "market",
      function: "expiry",
      inputs: [],
      outputs: [
        {
          name: "expiry",
          type: "uint256",
          label: "Expiry Timestamp",
        },
      ],
    },
    {
      slug: "is-market-expired",
      label: "Is Market Expired",
      description: "Check whether a Pendle market has passed its expiry date",
      type: "read",
      contract: "market",
      function: "isExpired",
      inputs: [],
      outputs: [
        {
          name: "expired",
          type: "bool",
          label: "Is Expired",
        },
      ],
    },
    {
      slug: "get-lp-balance",
      label: "Get LP Balance",
      description: "Check the LP token balance for a Pendle market position",
      type: "read",
      contract: "market",
      function: "balanceOf",
      inputs: [{ name: "account", type: "address", label: "Wallet Address" }],
      outputs: [
        {
          name: "balance",
          type: "uint256",
          label: "LP Token Balance",
          decimals: 18,
        },
      ],
    },
    {
      slug: "get-active-lp-balance",
      label: "Get Active LP Balance",
      description:
        "Check the active (non-expired) LP balance earning rewards in a Pendle market",
      type: "read",
      contract: "market",
      function: "activeBalance",
      inputs: [{ name: "user", type: "address", label: "Wallet Address" }],
      outputs: [
        {
          name: "balance",
          type: "uint256",
          label: "Active LP Balance",
          decimals: 18,
        },
      ],
    },

    // Principal Token

    {
      slug: "get-pt-balance",
      label: "Get PT Balance",
      description: "Check the Principal Token balance of an address",
      type: "read",
      contract: "pt",
      function: "balanceOf",
      inputs: [{ name: "account", type: "address", label: "Wallet Address" }],
      outputs: [
        {
          name: "balance",
          type: "uint256",
          label: "PT Balance",
          decimals: 18,
        },
      ],
    },
    {
      slug: "is-pt-expired",
      label: "Is PT Expired",
      description:
        "Check whether a Principal Token has passed its maturity date",
      type: "read",
      contract: "pt",
      function: "isExpired",
      inputs: [],
      outputs: [
        {
          name: "expired",
          type: "bool",
          label: "Is Expired",
        },
      ],
    },

    // Yield Token

    {
      slug: "get-yt-balance",
      label: "Get YT Balance",
      description: "Check the Yield Token balance of an address",
      type: "read",
      contract: "yt",
      function: "balanceOf",
      inputs: [{ name: "account", type: "address", label: "Wallet Address" }],
      outputs: [
        {
          name: "balance",
          type: "uint256",
          label: "YT Balance",
          decimals: 18,
        },
      ],
    },

    // Standardized Yield

    {
      slug: "get-sy-balance",
      label: "Get SY Balance",
      description: "Check the Standardized Yield token balance of an address",
      type: "read",
      contract: "sy",
      function: "balanceOf",
      inputs: [{ name: "account", type: "address", label: "Wallet Address" }],
      outputs: [
        {
          name: "balance",
          type: "uint256",
          label: "SY Balance",
          decimals: 18,
        },
      ],
    },
    {
      slug: "get-sy-exchange-rate",
      label: "Get SY Exchange Rate",
      description:
        "Get the current exchange rate between SY and its underlying asset",
      type: "read",
      contract: "sy",
      function: "exchangeRate",
      inputs: [],
      outputs: [
        {
          name: "exchangeRate",
          type: "uint256",
          label: "Exchange Rate",
          decimals: 18,
        },
      ],
    },

    // Router (Write)

    {
      slug: "mint-py-from-sy",
      label: "Mint PT and YT from SY",
      description:
        "Split Standardized Yield tokens into Principal Tokens and Yield Tokens",
      type: "write",
      contract: "router",
      function: "mintPyFromSy",
      inputs: [
        { name: "receiver", type: "address", label: "Receiver Address" },
        { name: "YT", type: "address", label: "YT Token Address" },
        { name: "netSyIn", type: "uint256", label: "SY Amount (wei)" },
        { name: "minPyOut", type: "uint256", label: "Minimum PT/YT Out (wei)" },
      ],
    },
    {
      slug: "redeem-py-to-sy",
      label: "Redeem PT and YT to SY",
      description:
        "Merge Principal Tokens and Yield Tokens back into Standardized Yield tokens",
      type: "write",
      contract: "router",
      function: "redeemPyToSy",
      inputs: [
        { name: "receiver", type: "address", label: "Receiver Address" },
        { name: "YT", type: "address", label: "YT Token Address" },
        { name: "netPyIn", type: "uint256", label: "PT/YT Amount (wei)" },
        { name: "minSyOut", type: "uint256", label: "Minimum SY Out (wei)" },
      ],
    },
  ],
});
