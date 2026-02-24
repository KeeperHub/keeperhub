import { defineProtocol } from "@/keeperhub/lib/protocol-registry";

export default defineProtocol({
  name: "Ajna",
  slug: "ajna",
  description:
    "Ajna permissionless lending protocol -- liquidation and vault keeper operations on Base",
  website: "https://www.ajna.finance",
  icon: "/protocols/ajna.png",

  contracts: {
    poolInfoUtils: {
      label: "Ajna Pool Info Utils",
      addresses: {
        // Base
        "8453": "0x97fa9b0909C238D170C1ab3B5c728A3a45BBEcBa",
      },
    },
    pool1: {
      label: "cbBTC/usBTCd Pool",
      addresses: {
        // Base
        "8453": "0x46Acc253133b3Ec0953fe4445B5Ba8E6CFe10500",
      },
    },
    pool2: {
      label: "usBTCd/webmx Pool",
      addresses: {
        // Base
        "8453": "0x7e86Fd9eEceC773dE51625533fC9edF5f44719d9",
      },
    },
    vault1: {
      label: "cbBTC/usBTCd ERC-4626 Vault",
      addresses: {
        // Base
        "8453": "0xFE8f1651a781f98dd349EA87DFF8F2814a1B0eB5",
      },
    },
    vault2: {
      label: "usBTCd/webmx ERC-4626 Vault",
      addresses: {
        // Base
        "8453": "0xeA9F4105Be9A9Bd49a810b7D044f4e12e1958Db6",
      },
    },
    vaultAuth1: {
      label: "cbBTC/usBTCd Vault Config",
      addresses: {
        // Base
        "8453": "0xC1F8F3E59c65D3E7d378711E8FdF007e9e03e804",
      },
    },
    vaultAuth2: {
      label: "usBTCd/webmx Vault Config",
      addresses: {
        // Base
        "8453": "0x6caEe7adE308EF5f9879018b008308dE4c08F451",
      },
    },
    buffer1: {
      label: "cbBTC/usBTCd Buffer",
      addresses: {
        // Base
        "8453": "0x79eD528FbA19717c3d8DE682c6C06f7af749FbdC",
      },
    },
    buffer2: {
      label: "usBTCd/webmx Buffer",
      addresses: {
        // Base
        "8453": "0xef093900fdD98F128Bd80761C74A94ab1687A020",
      },
    },
  },

  actions: [
    // Pool Info Utils
    {
      slug: "get-auction-status",
      label: "Get Auction Status",
      description: "Get current auction status for a borrower in an Ajna pool",
      type: "read",
      contract: "poolInfoUtils",
      function: "auctionStatus",
      inputs: [
        { name: "ajnaPool_", type: "address", label: "Pool Address" },
        { name: "borrower_", type: "address", label: "Borrower Address" },
      ],
      outputs: [
        { name: "kickTime_", type: "uint256", label: "Kick Timestamp" },
        {
          name: "collateral_",
          type: "uint256",
          label: "Collateral (WAD)",
          decimals: 18,
        },
        {
          name: "debtToCover_",
          type: "uint256",
          label: "Debt to Cover (WAD)",
          decimals: 18,
        },
        { name: "isCollateralized_", type: "bool", label: "Is Collateralized" },
        {
          name: "price_",
          type: "uint256",
          label: "Current Price (WAD)",
          decimals: 18,
        },
        {
          name: "neutralPrice_",
          type: "uint256",
          label: "Neutral Price (WAD)",
          decimals: 18,
        },
        {
          name: "referencePrice_",
          type: "uint256",
          label: "Reference Price (WAD)",
          decimals: 18,
        },
        {
          name: "debtToCollateral_",
          type: "uint256",
          label: "Debt to Collateral (WAD)",
          decimals: 18,
        },
        {
          name: "bondFactor_",
          type: "uint256",
          label: "Bond Factor (WAD)",
          decimals: 18,
        },
      ],
    },
    {
      slug: "get-hpb-index",
      label: "Get HPB Index",
      description: "Get the highest price bucket index of an Ajna pool",
      type: "read",
      contract: "poolInfoUtils",
      function: "hpbIndex",
      inputs: [{ name: "ajnaPool_", type: "address", label: "Pool Address" }],
      outputs: [{ name: "index", type: "uint256", label: "HPB Index" }],
    },
    {
      slug: "get-pool-lup",
      label: "Get Pool LUP",
      description: "Get the Lowest Utilized Price of an Ajna pool",
      type: "read",
      contract: "poolInfoUtils",
      function: "lup",
      inputs: [{ name: "ajnaPool_", type: "address", label: "Pool Address" }],
      outputs: [
        { name: "lup", type: "uint256", label: "LUP (WAD)", decimals: 18 },
      ],
    },
    {
      slug: "get-pool-htp",
      label: "Get Pool HTP",
      description: "Get the Highest Threshold Price of an Ajna pool",
      type: "read",
      contract: "poolInfoUtils",
      function: "htp",
      inputs: [{ name: "ajnaPool_", type: "address", label: "Pool Address" }],
      outputs: [
        { name: "htp", type: "uint256", label: "HTP (WAD)", decimals: 18 },
      ],
    },
    {
      slug: "get-borrower-info",
      label: "Get Borrower Info",
      description:
        "Get borrower loan information including debt, collateral, and threshold price",
      type: "read",
      contract: "poolInfoUtils",
      function: "borrowerInfo",
      inputs: [
        { name: "ajnaPool_", type: "address", label: "Pool Address" },
        { name: "borrower_", type: "address", label: "Borrower Address" },
      ],
      outputs: [
        {
          name: "debt",
          type: "uint256",
          label: "Borrower Debt (WAD)",
          decimals: 18,
        },
        {
          name: "collateral",
          type: "uint256",
          label: "Borrower Collateral (WAD)",
          decimals: 18,
        },
        {
          name: "t0Np",
          type: "uint256",
          label: "T0 Neutral Price (WAD)",
          decimals: 18,
        },
        {
          name: "thresholdPrice",
          type: "uint256",
          label: "Threshold Price (WAD)",
          decimals: 18,
        },
      ],
    },
    {
      slug: "price-to-index",
      label: "Price to Bucket Index",
      description: "Convert a price to its corresponding Ajna bucket index",
      type: "read",
      contract: "poolInfoUtils",
      function: "priceToIndex",
      inputs: [{ name: "price", type: "uint256", label: "Price (WAD)" }],
      outputs: [{ name: "index", type: "uint256", label: "Bucket Index" }],
    },
    {
      slug: "index-to-price",
      label: "Bucket Index to Price",
      description: "Convert a bucket index to its corresponding price",
      type: "read",
      contract: "poolInfoUtils",
      function: "indexToPrice",
      inputs: [{ name: "index_", type: "uint256", label: "Bucket Index" }],
      outputs: [
        { name: "price", type: "uint256", label: "Price (WAD)", decimals: 18 },
      ],
    },
    {
      slug: "get-deposit-index",
      label: "Get Deposit Index",
      description:
        "Get the bucket index containing a given amount of deposit for an Ajna pool",
      type: "read",
      contract: "poolInfoUtils",
      function: "depositIndex",
      inputs: [
        { name: "ajnaPool_", type: "address", label: "Pool Address" },
        { name: "debt_", type: "uint256", label: "Debt Amount (WAD)" },
      ],
      outputs: [
        { name: "index", type: "uint256", label: "Deposit Bucket Index" },
      ],
    },

    // Pool 1 (cbBTC/usBTCd)
    {
      slug: "pool1-kicker-info",
      label: "Pool 1 Kicker Info",
      description: "Get kicker bond information in the cbBTC/usBTCd pool",
      type: "read",
      contract: "pool1",
      function: "kickerInfo",
      inputs: [{ name: "kicker_", type: "address", label: "Kicker Address" }],
      outputs: [
        {
          name: "claimable",
          type: "uint256",
          label: "Claimable Bond (WAD)",
          decimals: 18,
        },
        {
          name: "locked",
          type: "uint256",
          label: "Locked Bond (WAD)",
          decimals: 18,
        },
      ],
    },
    {
      slug: "pool1-auction-info",
      label: "Pool 1 Auction Info",
      description:
        "Get auction details for a borrower in the cbBTC/usBTCd pool",
      type: "read",
      contract: "pool1",
      function: "auctionInfo",
      inputs: [
        { name: "borrower_", type: "address", label: "Borrower Address" },
      ],
      outputs: [
        { name: "kicker", type: "address", label: "Kicker Address" },
        {
          name: "bondFactor",
          type: "uint256",
          label: "Bond Factor (WAD)",
          decimals: 18,
        },
        {
          name: "bondSize",
          type: "uint256",
          label: "Bond Size (WAD)",
          decimals: 18,
        },
        { name: "kickTime", type: "uint256", label: "Kick Timestamp" },
        {
          name: "referencePrice",
          type: "uint256",
          label: "Reference Price (WAD)",
          decimals: 18,
        },
        {
          name: "neutralPrice",
          type: "uint256",
          label: "Neutral Price (WAD)",
          decimals: 18,
        },
        {
          name: "debtToCollateral",
          type: "uint256",
          label: "Debt to Collateral (WAD)",
          decimals: 18,
        },
        { name: "head", type: "address", label: "Head Address" },
        { name: "next", type: "address", label: "Next Address" },
        { name: "prev", type: "address", label: "Prev Address" },
      ],
    },
    {
      slug: "pool1-bucket-info",
      label: "Pool 1 Bucket Info",
      description:
        "Get bucket information at a given index in the cbBTC/usBTCd pool",
      type: "read",
      contract: "pool1",
      function: "bucketInfo",
      inputs: [{ name: "index_", type: "uint256", label: "Bucket Index" }],
      outputs: [
        {
          name: "price",
          type: "uint256",
          label: "Bucket Price (WAD)",
          decimals: 18,
        },
        {
          name: "quoteTokens",
          type: "uint256",
          label: "Quote Tokens (WAD)",
          decimals: 18,
        },
        {
          name: "collateral",
          type: "uint256",
          label: "Collateral (WAD)",
          decimals: 18,
        },
        {
          name: "bucketLP",
          type: "uint256",
          label: "LP Amount (WAD)",
          decimals: 18,
        },
        {
          name: "scale",
          type: "uint256",
          label: "Bucket Scale (WAD)",
          decimals: 18,
        },
      ],
    },
    {
      slug: "pool1-inflator-info",
      label: "Pool 1 Inflator Info",
      description:
        "Get pool inflator and last update timestamp for cbBTC/usBTCd pool",
      type: "read",
      contract: "pool1",
      function: "inflatorInfo",
      inputs: [],
      outputs: [
        {
          name: "inflator",
          type: "uint256",
          label: "Pool Inflator (WAD)",
          decimals: 18,
        },
        { name: "lastUpdate", type: "uint256", label: "Last Update Timestamp" },
      ],
    },
    {
      slug: "pool1-kick",
      label: "Pool 1 Kick",
      description:
        "Kick an undercollateralized borrower to start a liquidation auction in the cbBTC/usBTCd pool",
      type: "write",
      contract: "pool1",
      function: "kick",
      inputs: [
        { name: "borrower_", type: "address", label: "Borrower Address" },
        { name: "limitIndex_", type: "uint256", label: "Limit Bucket Index" },
      ],
    },
    {
      slug: "pool1-bucket-take",
      label: "Pool 1 Bucket Take",
      description:
        "Take from a liquidation auction using bucket liquidity in the cbBTC/usBTCd pool",
      type: "write",
      contract: "pool1",
      function: "bucketTake",
      inputs: [
        {
          name: "borrowerAddress_",
          type: "address",
          label: "Borrower Address",
        },
        { name: "depositTake_", type: "bool", label: "Use Deposit Take" },
        { name: "index_", type: "uint256", label: "Bucket Index" },
      ],
    },
    {
      slug: "pool1-settle",
      label: "Pool 1 Settle",
      description:
        "Settle a completed liquidation auction in the cbBTC/usBTCd pool",
      type: "write",
      contract: "pool1",
      function: "settle",
      inputs: [
        {
          name: "borrowerAddress_",
          type: "address",
          label: "Borrower Address",
        },
        { name: "maxDepth_", type: "uint256", label: "Max Bucket Depth" },
      ],
    },
    {
      slug: "pool1-withdraw-bonds",
      label: "Pool 1 Withdraw Bonds",
      description: "Withdraw claimable kicker bonds from the cbBTC/usBTCd pool",
      type: "write",
      contract: "pool1",
      function: "withdrawBonds",
      inputs: [
        { name: "recipient_", type: "address", label: "Recipient Address" },
        { name: "maxAmount_", type: "uint256", label: "Max Amount (WAD)" },
      ],
    },
    {
      slug: "pool1-update-interest",
      label: "Pool 1 Update Interest",
      description: "Update interest rate for the cbBTC/usBTCd pool",
      type: "write",
      contract: "pool1",
      function: "updateInterest",
      inputs: [],
    },

    // Pool 2 (usBTCd/webmx)
    {
      slug: "pool2-kicker-info",
      label: "Pool 2 Kicker Info",
      description: "Get kicker bond information in the usBTCd/webmx pool",
      type: "read",
      contract: "pool2",
      function: "kickerInfo",
      inputs: [{ name: "kicker_", type: "address", label: "Kicker Address" }],
      outputs: [
        {
          name: "claimable",
          type: "uint256",
          label: "Claimable Bond (WAD)",
          decimals: 18,
        },
        {
          name: "locked",
          type: "uint256",
          label: "Locked Bond (WAD)",
          decimals: 18,
        },
      ],
    },
    {
      slug: "pool2-auction-info",
      label: "Pool 2 Auction Info",
      description:
        "Get auction details for a borrower in the usBTCd/webmx pool",
      type: "read",
      contract: "pool2",
      function: "auctionInfo",
      inputs: [
        { name: "borrower_", type: "address", label: "Borrower Address" },
      ],
      outputs: [
        { name: "kicker", type: "address", label: "Kicker Address" },
        {
          name: "bondFactor",
          type: "uint256",
          label: "Bond Factor (WAD)",
          decimals: 18,
        },
        {
          name: "bondSize",
          type: "uint256",
          label: "Bond Size (WAD)",
          decimals: 18,
        },
        { name: "kickTime", type: "uint256", label: "Kick Timestamp" },
        {
          name: "referencePrice",
          type: "uint256",
          label: "Reference Price (WAD)",
          decimals: 18,
        },
        {
          name: "neutralPrice",
          type: "uint256",
          label: "Neutral Price (WAD)",
          decimals: 18,
        },
        {
          name: "debtToCollateral",
          type: "uint256",
          label: "Debt to Collateral (WAD)",
          decimals: 18,
        },
        { name: "head", type: "address", label: "Head Address" },
        { name: "next", type: "address", label: "Next Address" },
        { name: "prev", type: "address", label: "Prev Address" },
      ],
    },
    {
      slug: "pool2-bucket-info",
      label: "Pool 2 Bucket Info",
      description:
        "Get bucket information at a given index in the usBTCd/webmx pool",
      type: "read",
      contract: "pool2",
      function: "bucketInfo",
      inputs: [{ name: "index_", type: "uint256", label: "Bucket Index" }],
      outputs: [
        {
          name: "price",
          type: "uint256",
          label: "Bucket Price (WAD)",
          decimals: 18,
        },
        {
          name: "quoteTokens",
          type: "uint256",
          label: "Quote Tokens (WAD)",
          decimals: 18,
        },
        {
          name: "collateral",
          type: "uint256",
          label: "Collateral (WAD)",
          decimals: 18,
        },
        {
          name: "bucketLP",
          type: "uint256",
          label: "LP Amount (WAD)",
          decimals: 18,
        },
        {
          name: "scale",
          type: "uint256",
          label: "Bucket Scale (WAD)",
          decimals: 18,
        },
      ],
    },
    {
      slug: "pool2-inflator-info",
      label: "Pool 2 Inflator Info",
      description:
        "Get pool inflator and last update timestamp for usBTCd/webmx pool",
      type: "read",
      contract: "pool2",
      function: "inflatorInfo",
      inputs: [],
      outputs: [
        {
          name: "inflator",
          type: "uint256",
          label: "Pool Inflator (WAD)",
          decimals: 18,
        },
        { name: "lastUpdate", type: "uint256", label: "Last Update Timestamp" },
      ],
    },
    {
      slug: "pool2-kick",
      label: "Pool 2 Kick",
      description:
        "Kick an undercollateralized borrower to start a liquidation auction in the usBTCd/webmx pool",
      type: "write",
      contract: "pool2",
      function: "kick",
      inputs: [
        { name: "borrower_", type: "address", label: "Borrower Address" },
        { name: "limitIndex_", type: "uint256", label: "Limit Bucket Index" },
      ],
    },
    {
      slug: "pool2-bucket-take",
      label: "Pool 2 Bucket Take",
      description:
        "Take from a liquidation auction using bucket liquidity in the usBTCd/webmx pool",
      type: "write",
      contract: "pool2",
      function: "bucketTake",
      inputs: [
        {
          name: "borrowerAddress_",
          type: "address",
          label: "Borrower Address",
        },
        { name: "depositTake_", type: "bool", label: "Use Deposit Take" },
        { name: "index_", type: "uint256", label: "Bucket Index" },
      ],
    },
    {
      slug: "pool2-settle",
      label: "Pool 2 Settle",
      description:
        "Settle a completed liquidation auction in the usBTCd/webmx pool",
      type: "write",
      contract: "pool2",
      function: "settle",
      inputs: [
        {
          name: "borrowerAddress_",
          type: "address",
          label: "Borrower Address",
        },
        { name: "maxDepth_", type: "uint256", label: "Max Bucket Depth" },
      ],
    },
    {
      slug: "pool2-withdraw-bonds",
      label: "Pool 2 Withdraw Bonds",
      description: "Withdraw claimable kicker bonds from the usBTCd/webmx pool",
      type: "write",
      contract: "pool2",
      function: "withdrawBonds",
      inputs: [
        { name: "recipient_", type: "address", label: "Recipient Address" },
        { name: "maxAmount_", type: "uint256", label: "Max Amount (WAD)" },
      ],
    },
    {
      slug: "pool2-update-interest",
      label: "Pool 2 Update Interest",
      description: "Update interest rate for the usBTCd/webmx pool",
      type: "write",
      contract: "pool2",
      function: "updateInterest",
      inputs: [],
    },

    // Vault 1 (cbBTC/usBTCd)
    {
      slug: "vault1-is-paused",
      label: "Vault 1 Is Paused",
      description: "Check if the cbBTC/usBTCd vault is paused",
      type: "read",
      contract: "vault1",
      function: "paused",
      inputs: [],
      outputs: [{ name: "isPaused", type: "bool", label: "Is Vault Paused" }],
    },
    {
      slug: "vault1-get-buckets",
      label: "Vault 1 Get Buckets",
      description: "Get all active bucket indices in the cbBTC/usBTCd vault",
      type: "read",
      contract: "vault1",
      function: "getBuckets",
      inputs: [],
      outputs: [
        { name: "buckets", type: "uint256[]", label: "Active Bucket Indices" },
      ],
    },
    {
      slug: "vault1-total-assets",
      label: "Vault 1 Total Assets",
      description: "Get total assets managed by the cbBTC/usBTCd vault",
      type: "read",
      contract: "vault1",
      function: "totalAssets",
      inputs: [],
      outputs: [
        {
          name: "assets",
          type: "uint256",
          label: "Total Assets (WAD)",
          decimals: 18,
        },
      ],
    },
    {
      slug: "vault1-lp-to-value",
      label: "Vault 1 LP to Value",
      description:
        "Convert LP amount to quote token value for a bucket in the cbBTC/usBTCd vault",
      type: "read",
      contract: "vault1",
      function: "lpToValue",
      inputs: [{ name: "bucket", type: "uint256", label: "Bucket Index" }],
      outputs: [
        { name: "value", type: "uint256", label: "Value (WAD)", decimals: 18 },
      ],
    },
    {
      slug: "vault1-drain",
      label: "Vault 1 Drain Bucket",
      description:
        "Drain all liquidity from a bucket in the cbBTC/usBTCd vault",
      type: "write",
      contract: "vault1",
      function: "drain",
      inputs: [{ name: "bucket", type: "uint256", label: "Bucket Index" }],
    },
    {
      slug: "vault1-move",
      label: "Vault 1 Move Liquidity",
      description: "Move liquidity between buckets in the cbBTC/usBTCd vault",
      type: "write",
      contract: "vault1",
      function: "move",
      inputs: [
        { name: "fromIndex_", type: "uint256", label: "Source Bucket Index" },
        {
          name: "toIndex_",
          type: "uint256",
          label: "Destination Bucket Index",
        },
        { name: "amt_", type: "uint256", label: "Amount (WAD)" },
      ],
    },
    {
      slug: "vault1-move-from-buffer",
      label: "Vault 1 Move From Buffer",
      description:
        "Move liquidity from the buffer to a pool bucket in the cbBTC/usBTCd vault",
      type: "write",
      contract: "vault1",
      function: "moveFromBuffer",
      inputs: [
        {
          name: "toIndex_",
          type: "uint256",
          label: "Destination Bucket Index",
        },
        { name: "amt_", type: "uint256", label: "Amount (WAD)" },
      ],
    },
    {
      slug: "vault1-move-to-buffer",
      label: "Vault 1 Move To Buffer",
      description:
        "Move liquidity from a pool bucket to the buffer in the cbBTC/usBTCd vault",
      type: "write",
      contract: "vault1",
      function: "moveToBuffer",
      inputs: [
        { name: "fromIndex_", type: "uint256", label: "Source Bucket Index" },
        { name: "amt_", type: "uint256", label: "Amount (WAD)" },
      ],
    },

    // Vault 2 (usBTCd/webmx)
    {
      slug: "vault2-is-paused",
      label: "Vault 2 Is Paused",
      description: "Check if the usBTCd/webmx vault is paused",
      type: "read",
      contract: "vault2",
      function: "paused",
      inputs: [],
      outputs: [{ name: "isPaused", type: "bool", label: "Is Vault Paused" }],
    },
    {
      slug: "vault2-get-buckets",
      label: "Vault 2 Get Buckets",
      description: "Get all active bucket indices in the usBTCd/webmx vault",
      type: "read",
      contract: "vault2",
      function: "getBuckets",
      inputs: [],
      outputs: [
        { name: "buckets", type: "uint256[]", label: "Active Bucket Indices" },
      ],
    },
    {
      slug: "vault2-total-assets",
      label: "Vault 2 Total Assets",
      description: "Get total assets managed by the usBTCd/webmx vault",
      type: "read",
      contract: "vault2",
      function: "totalAssets",
      inputs: [],
      outputs: [
        {
          name: "assets",
          type: "uint256",
          label: "Total Assets (WAD)",
          decimals: 18,
        },
      ],
    },
    {
      slug: "vault2-lp-to-value",
      label: "Vault 2 LP to Value",
      description:
        "Convert LP amount to quote token value for a bucket in the usBTCd/webmx vault",
      type: "read",
      contract: "vault2",
      function: "lpToValue",
      inputs: [{ name: "bucket", type: "uint256", label: "Bucket Index" }],
      outputs: [
        { name: "value", type: "uint256", label: "Value (WAD)", decimals: 18 },
      ],
    },
    {
      slug: "vault2-drain",
      label: "Vault 2 Drain Bucket",
      description:
        "Drain all liquidity from a bucket in the usBTCd/webmx vault",
      type: "write",
      contract: "vault2",
      function: "drain",
      inputs: [{ name: "bucket", type: "uint256", label: "Bucket Index" }],
    },
    {
      slug: "vault2-move",
      label: "Vault 2 Move Liquidity",
      description: "Move liquidity between buckets in the usBTCd/webmx vault",
      type: "write",
      contract: "vault2",
      function: "move",
      inputs: [
        { name: "fromIndex_", type: "uint256", label: "Source Bucket Index" },
        {
          name: "toIndex_",
          type: "uint256",
          label: "Destination Bucket Index",
        },
        { name: "amt_", type: "uint256", label: "Amount (WAD)" },
      ],
    },
    {
      slug: "vault2-move-from-buffer",
      label: "Vault 2 Move From Buffer",
      description:
        "Move liquidity from the buffer to a pool bucket in the usBTCd/webmx vault",
      type: "write",
      contract: "vault2",
      function: "moveFromBuffer",
      inputs: [
        {
          name: "toIndex_",
          type: "uint256",
          label: "Destination Bucket Index",
        },
        { name: "amt_", type: "uint256", label: "Amount (WAD)" },
      ],
    },
    {
      slug: "vault2-move-to-buffer",
      label: "Vault 2 Move To Buffer",
      description:
        "Move liquidity from a pool bucket to the buffer in the usBTCd/webmx vault",
      type: "write",
      contract: "vault2",
      function: "moveToBuffer",
      inputs: [
        { name: "fromIndex_", type: "uint256", label: "Source Bucket Index" },
        { name: "amt_", type: "uint256", label: "Amount (WAD)" },
      ],
    },

    // Vault 1 Config (vaultAuth1)
    {
      slug: "vault1-buffer-ratio",
      label: "Vault 1 Buffer Ratio",
      description: "Get the target buffer ratio for the cbBTC/usBTCd vault",
      type: "read",
      contract: "vaultAuth1",
      function: "bufferRatio",
      inputs: [],
      outputs: [
        {
          name: "ratio",
          type: "uint256",
          label: "Buffer Ratio (WAD)",
          decimals: 18,
        },
      ],
    },
    {
      slug: "vault1-min-bucket-index",
      label: "Vault 1 Min Bucket Index",
      description:
        "Get the minimum allowed bucket index for the cbBTC/usBTCd vault",
      type: "read",
      contract: "vaultAuth1",
      function: "minBucketIndex",
      inputs: [],
      outputs: [{ name: "index", type: "uint256", label: "Min Bucket Index" }],
    },

    // Vault 2 Config (vaultAuth2)
    {
      slug: "vault2-buffer-ratio",
      label: "Vault 2 Buffer Ratio",
      description: "Get the target buffer ratio for the usBTCd/webmx vault",
      type: "read",
      contract: "vaultAuth2",
      function: "bufferRatio",
      inputs: [],
      outputs: [
        {
          name: "ratio",
          type: "uint256",
          label: "Buffer Ratio (WAD)",
          decimals: 18,
        },
      ],
    },
    {
      slug: "vault2-min-bucket-index",
      label: "Vault 2 Min Bucket Index",
      description:
        "Get the minimum allowed bucket index for the usBTCd/webmx vault",
      type: "read",
      contract: "vaultAuth2",
      function: "minBucketIndex",
      inputs: [],
      outputs: [{ name: "index", type: "uint256", label: "Min Bucket Index" }],
    },

    // Buffer Reads
    {
      slug: "vault1-buffer-total",
      label: "Vault 1 Buffer Total",
      description:
        "Get total liquidity held in the cbBTC/usBTCd buffer contract",
      type: "read",
      contract: "buffer1",
      function: "total",
      inputs: [],
      outputs: [
        {
          name: "bufferTotal",
          type: "uint256",
          label: "Buffer Total (WAD)",
          decimals: 18,
        },
      ],
    },
    {
      slug: "vault2-buffer-total",
      label: "Vault 2 Buffer Total",
      description:
        "Get total liquidity held in the usBTCd/webmx buffer contract",
      type: "read",
      contract: "buffer2",
      function: "total",
      inputs: [],
      outputs: [
        {
          name: "bufferTotal",
          type: "uint256",
          label: "Buffer Total (WAD)",
          decimals: 18,
        },
      ],
    },
  ],
});
