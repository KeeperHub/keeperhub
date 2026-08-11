import {
  type AbiFunctionOverride,
  defineAbiProtocol,
} from "@/lib/protocol-registry";
import {
  contract,
  native,
  type ProtocolTestData,
  wallet,
} from "@/lib/test-data/types";

const TEST_DATA: ProtocolTestData = {
  "8453": {
    setup: {
      minNativeHuman: "0.01",
      requiredTokens: [],
      approvals: [],
    },
    actions: {
      "get-hpb-index": { ajnaPool_: contract("pool1") },
      "get-pool-lup": { ajnaPool_: contract("pool1") },
      "get-pool-htp": { ajnaPool_: contract("pool1") },
      "price-to-index": { price: native("1") },
      "index-to-price": { index_: "5000" },
      "get-auction-status": {
        ajnaPool_: contract("pool1"),
        borrower_: wallet(),
      },
      "get-borrower-info": {
        ajnaPool_: contract("pool1"),
        borrower_: wallet(),
      },
      "pool1-inflator-info": {},
      "pool1-bucket-info": { index_: "5000" },
      "pool1-kicker-info": { kicker_: wallet() },
      "pool1-auction-info": { borrower_: wallet() },
      "pool1-kick": { borrower_: wallet() },
      "pool1-bucket-take": { borrowerAddress_: wallet() },
      "pool1-settle": { borrowerAddress_: wallet() },
      "pool1-withdraw-bonds": { recipient_: wallet() },
      "pool1-update-interest": {},
      // depositIndex is a pool-level function (IPoolDerivedState.sol), not
      // a PoolInfoUtils function -- it takes only debt_, no pool address.
      "pool1-deposit-index": { debt_: native("1") },
      "pool2-inflator-info": {},
      "pool2-bucket-info": { index_: "5000" },
      "pool2-kicker-info": { kicker_: wallet() },
      "pool2-auction-info": { borrower_: wallet() },
      "pool2-kick": { borrower_: wallet() },
      "pool2-bucket-take": { borrowerAddress_: wallet() },
      "pool2-settle": { borrowerAddress_: wallet() },
      "pool2-withdraw-bonds": { recipient_: wallet() },
      "pool2-update-interest": {},
      "pool2-deposit-index": { debt_: native("1") },
      "vault1-is-paused": {},
      "vault1-get-buckets": {},
      "vault1-total-assets": {},
      "vault1-lp-to-value": {},
      "vault1-drain": {},
      "vault1-move": {},
      "vault1-move-from-buffer": {},
      "vault1-move-to-buffer": {},
      "vault2-is-paused": {},
      "vault2-get-buckets": {},
      "vault2-total-assets": {},
      "vault2-lp-to-value": {},
      "vault2-drain": {},
      "vault2-move": {},
      "vault2-move-from-buffer": {},
      "vault2-move-to-buffer": {},
      "vault1-buffer-ratio": {},
      "vault1-min-bucket-index": {},
      "vault2-buffer-ratio": {},
      "vault2-min-bucket-index": {},
      "vault1-buffer-total": {},
      "vault2-buffer-total": {},
    },
    skipped: {
      "get-auction-status": "requires an active auction in the pool",
      "get-borrower-info": "requires an active borrower address in the pool",
      "pool1-auction-info": "requires an active auction in the pool",
      "pool1-kick": "requires an undercollateralized borrower position",
      "pool1-bucket-take": "requires an active liquidation auction",
      "pool1-settle": "requires a completed liquidation auction",
      "pool1-withdraw-bonds": "requires prior kicker bond balance",
      "pool1-update-interest":
        "write action with no predictable outcome on mainnet fork",
      "pool2-auction-info": "requires an active auction in the pool",
      "pool2-kick": "requires an undercollateralized borrower position",
      "pool2-bucket-take": "requires an active liquidation auction",
      "pool2-settle": "requires a completed liquidation auction",
      "pool2-withdraw-bonds": "requires prior kicker bond balance",
      "pool2-update-interest":
        "write action with no predictable outcome on mainnet fork",
      "vault1-lp-to-value": "requires an active bucket with LP in the vault",
      "vault1-drain": "write action requiring vault admin role",
      "vault1-move": "write action requiring vault admin role",
      "vault1-move-from-buffer": "write action requiring vault admin role",
      "vault1-move-to-buffer": "write action requiring vault admin role",
      "vault2-lp-to-value": "requires an active bucket with LP in the vault",
      "vault2-drain": "write action requiring vault admin role",
      "vault2-move": "write action requiring vault admin role",
      "vault2-move-from-buffer": "write action requiring vault admin role",
      "vault2-move-to-buffer": "write action requiring vault admin role",
    },
    // Pool invariants on the live Base pools (named outputs). Highest price
    // bucket and lowest utilized price are nonzero on an active pool; the
    // price<->index conversions are pure deterministic math; the inflator is
    // always >= 1e18; the deposit index is nonzero. The two Ajna buffer vaults
    // are live and unpaused. Left unasserted: get-pool-htp (zero with no
    // debt), the per-pool bucket-info price (the bound bucket index can be
    // empty -> zero), kicker/auction/borrower reads (caller bond or an active
    // auction, largely skipped), and vault total-assets/buffer reads (can
    // legitimately be zero).
    expectations: {
      "get-hpb-index": [{ field: "index", nonZero: true }],
      "get-pool-lup": [{ field: "lup", nonZero: true }],
      "price-to-index": [{ field: "index", nonZero: true }],
      "index-to-price": [{ field: "price", nonZero: true }],
      "pool1-inflator-info": [{ field: "inflator", nonZero: true }],
      "pool2-inflator-info": [{ field: "inflator", nonZero: true }],
      "pool1-deposit-index": [{ field: "index", nonZero: true }],
      "pool2-deposit-index": [{ field: "index", nonZero: true }],
      "vault1-is-paused": [{ field: "isPaused", equals: "false" }],
      "vault2-is-paused": [{ field: "isPaused", equals: "false" }],
    },
  },
};

const POOL_INFO_UTILS_ABI = JSON.stringify([
  {
    type: "function",
    name: "auctionStatus",
    stateMutability: "view",
    inputs: [
      { name: "ajnaPool_", type: "address" },
      { name: "borrower_", type: "address" },
    ],
    outputs: [
      { name: "kickTime_", type: "uint256" },
      { name: "collateral_", type: "uint256" },
      { name: "debtToCover_", type: "uint256" },
      { name: "isCollateralized_", type: "bool" },
      { name: "price_", type: "uint256" },
      { name: "neutralPrice_", type: "uint256" },
      { name: "referencePrice_", type: "uint256" },
      { name: "debtToCollateral_", type: "uint256" },
      { name: "bondFactor_", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "hpbIndex",
    stateMutability: "view",
    inputs: [{ name: "ajnaPool_", type: "address" }],
    outputs: [{ name: "index", type: "uint256" }],
  },
  {
    type: "function",
    name: "lup",
    stateMutability: "view",
    inputs: [{ name: "ajnaPool_", type: "address" }],
    outputs: [{ name: "lup", type: "uint256" }],
  },
  {
    type: "function",
    name: "htp",
    stateMutability: "view",
    inputs: [{ name: "ajnaPool_", type: "address" }],
    outputs: [{ name: "htp", type: "uint256" }],
  },
  {
    type: "function",
    name: "borrowerInfo",
    stateMutability: "view",
    inputs: [
      { name: "ajnaPool_", type: "address" },
      { name: "borrower_", type: "address" },
    ],
    outputs: [
      { name: "debt", type: "uint256" },
      { name: "collateral", type: "uint256" },
      { name: "t0Np", type: "uint256" },
      { name: "thresholdPrice", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "priceToIndex",
    stateMutability: "view",
    inputs: [{ name: "price", type: "uint256" }],
    outputs: [{ name: "index", type: "uint256" }],
  },
  {
    type: "function",
    name: "indexToPrice",
    stateMutability: "view",
    inputs: [{ name: "index_", type: "uint256" }],
    outputs: [{ name: "price", type: "uint256" }],
  },
]);

const POOL_ABI = JSON.stringify([
  {
    type: "function",
    name: "kickerInfo",
    stateMutability: "view",
    inputs: [{ name: "kicker_", type: "address" }],
    outputs: [
      { name: "claimable", type: "uint256" },
      { name: "locked", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "auctionInfo",
    stateMutability: "view",
    inputs: [{ name: "borrower_", type: "address" }],
    outputs: [
      { name: "kicker", type: "address" },
      { name: "bondFactor", type: "uint256" },
      { name: "bondSize", type: "uint256" },
      { name: "kickTime", type: "uint256" },
      { name: "referencePrice", type: "uint256" },
      { name: "neutralPrice", type: "uint256" },
      { name: "debtToCollateral", type: "uint256" },
      { name: "head", type: "address" },
      { name: "next", type: "address" },
      { name: "prev", type: "address" },
    ],
  },
  {
    type: "function",
    name: "bucketInfo",
    stateMutability: "view",
    inputs: [{ name: "index_", type: "uint256" }],
    outputs: [
      { name: "price", type: "uint256" },
      { name: "quoteTokens", type: "uint256" },
      { name: "collateral", type: "uint256" },
      { name: "bucketLP", type: "uint256" },
      { name: "scale", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "inflatorInfo",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "inflator", type: "uint256" },
      { name: "lastUpdate", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "kick",
    stateMutability: "nonpayable",
    inputs: [
      { name: "borrower_", type: "address" },
      { name: "limitIndex_", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "bucketTake",
    stateMutability: "nonpayable",
    inputs: [
      { name: "borrowerAddress_", type: "address" },
      { name: "depositTake_", type: "bool" },
      { name: "index_", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "settle",
    stateMutability: "nonpayable",
    inputs: [
      { name: "borrowerAddress_", type: "address" },
      { name: "maxDepth_", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "withdrawBonds",
    stateMutability: "nonpayable",
    inputs: [
      { name: "recipient_", type: "address" },
      { name: "maxAmount_", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "updateInterest",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    // Pool-level function per IPoolDerivedState.sol -- NOT a PoolInfoUtils
    // function. Takes only debt_ (the pool itself is the call target).
    type: "function",
    name: "depositIndex",
    stateMutability: "view",
    inputs: [{ name: "debt_", type: "uint256" }],
    outputs: [{ name: "index", type: "uint256" }],
  },
]);

const VAULT_ABI = JSON.stringify([
  {
    type: "function",
    name: "paused",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "isPaused", type: "bool" }],
  },
  {
    type: "function",
    name: "getBuckets",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "buckets", type: "uint256[]" }],
  },
  {
    type: "function",
    name: "totalAssets",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "assets", type: "uint256" }],
  },
  {
    type: "function",
    name: "lpToValue",
    stateMutability: "view",
    inputs: [{ name: "bucket", type: "uint256" }],
    outputs: [{ name: "value", type: "uint256" }],
  },
  {
    type: "function",
    name: "drain",
    stateMutability: "nonpayable",
    inputs: [{ name: "bucket", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "move",
    stateMutability: "nonpayable",
    inputs: [
      { name: "fromIndex_", type: "uint256" },
      { name: "toIndex_", type: "uint256" },
      { name: "amt_", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "moveFromBuffer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "toIndex_", type: "uint256" },
      { name: "amt_", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "moveToBuffer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "fromIndex_", type: "uint256" },
      { name: "amt_", type: "uint256" },
    ],
    outputs: [],
  },
]);

const VAULT_AUTH_ABI = JSON.stringify([
  {
    type: "function",
    name: "bufferRatio",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "ratio", type: "uint256" }],
  },
  {
    type: "function",
    name: "minBucketIndex",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "index", type: "uint256" }],
  },
]);

const BUFFER_ABI = JSON.stringify([
  {
    type: "function",
    name: "total",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "bufferTotal", type: "uint256" }],
  },
]);

function poolOverrides(
  slugPrefix: string,
  pairLabel: string
): Record<string, AbiFunctionOverride> {
  return {
    kickerInfo: {
      slug: `${slugPrefix}-kicker-info`,
      label: `${pairLabel} Kicker Info`,
      description: `Get kicker bond information in the ${pairLabel} pool`,
      inputs: {
        kicker_: { label: "Kicker Address" },
      },
      outputs: {
        claimable: { label: "Claimable Bond (WAD)", decimals: 18 },
        locked: { label: "Locked Bond (WAD)", decimals: 18 },
      },
    },
    auctionInfo: {
      slug: `${slugPrefix}-auction-info`,
      label: `${pairLabel} Auction Info`,
      description: `Get auction details for a borrower in the ${pairLabel} pool`,
      inputs: {
        borrower_: { label: "Borrower Address" },
      },
      outputs: {
        kicker: { label: "Kicker Address" },
        bondFactor: { label: "Bond Factor (WAD)", decimals: 18 },
        bondSize: { label: "Bond Size (WAD)", decimals: 18 },
        kickTime: { label: "Kick Timestamp" },
        referencePrice: { label: "Reference Price (WAD)", decimals: 18 },
        neutralPrice: { label: "Neutral Price (WAD)", decimals: 18 },
        debtToCollateral: { label: "Debt to Collateral (WAD)", decimals: 18 },
        head: { label: "Head Address" },
        next: { label: "Next Address" },
        prev: { label: "Prev Address" },
      },
    },
    bucketInfo: {
      slug: `${slugPrefix}-bucket-info`,
      label: `${pairLabel} Bucket Info`,
      description: `Get bucket information at a given index in the ${pairLabel} pool`,
      inputs: {
        index_: { label: "Bucket Index" },
      },
      outputs: {
        price: { label: "Bucket Price (WAD)", decimals: 18 },
        quoteTokens: { label: "Quote Tokens (WAD)", decimals: 18 },
        collateral: { label: "Collateral (WAD)", decimals: 18 },
        bucketLP: { label: "LP Amount (WAD)", decimals: 18 },
        scale: { label: "Bucket Scale (WAD)", decimals: 18 },
      },
    },
    inflatorInfo: {
      slug: `${slugPrefix}-inflator-info`,
      label: `${pairLabel} Inflator Info`,
      description: `Get pool inflator and last update timestamp for ${pairLabel} pool`,
      outputs: {
        inflator: { label: "Pool Inflator (WAD)", decimals: 18 },
        lastUpdate: { label: "Last Update Timestamp" },
      },
    },
    kick: {
      slug: `${slugPrefix}-kick`,
      label: `${pairLabel} Kick`,
      description: `Kick an undercollateralized borrower to start a liquidation auction in the ${pairLabel} pool`,
      inputs: {
        borrower_: { label: "Borrower Address" },
        limitIndex_: { label: "Limit Bucket Index" },
      },
    },
    bucketTake: {
      slug: `${slugPrefix}-bucket-take`,
      label: `${pairLabel} Bucket Take`,
      description: `Take from a liquidation auction using bucket liquidity in the ${pairLabel} pool`,
      inputs: {
        borrowerAddress_: { label: "Borrower Address" },
        depositTake_: { label: "Use Deposit Take" },
        index_: { label: "Bucket Index" },
      },
    },
    settle: {
      slug: `${slugPrefix}-settle`,
      label: `${pairLabel} Settle`,
      description: `Settle a completed liquidation auction in the ${pairLabel} pool`,
      inputs: {
        borrowerAddress_: { label: "Borrower Address" },
        maxDepth_: { label: "Max Bucket Depth" },
      },
    },
    withdrawBonds: {
      slug: `${slugPrefix}-withdraw-bonds`,
      label: `${pairLabel} Withdraw Bonds`,
      description: `Withdraw claimable kicker bonds from the ${pairLabel} pool`,
      inputs: {
        recipient_: { label: "Recipient Address" },
        maxAmount_: { label: "Max Amount (WAD)" },
      },
    },
    updateInterest: {
      slug: `${slugPrefix}-update-interest`,
      label: `${pairLabel} Update Interest`,
      description: `Update interest rate for the ${pairLabel} pool`,
    },
    depositIndex: {
      slug: `${slugPrefix}-deposit-index`,
      label: `${pairLabel} Deposit Index`,
      description: `Get the bucket index containing a given amount of deposit in the ${pairLabel} pool`,
      inputs: {
        debt_: { label: "Debt Amount (WAD)" },
      },
      outputs: {
        index: { label: "Deposit Bucket Index" },
      },
    },
  };
}

function vaultOverrides(
  slugPrefix: string,
  pairLabel: string
): Record<string, AbiFunctionOverride> {
  return {
    paused: {
      slug: `${slugPrefix}-is-paused`,
      label: `${pairLabel} Is Paused`,
      description: `Check if the ${pairLabel} vault is paused`,
      outputs: {
        isPaused: { label: "Is Vault Paused" },
      },
    },
    getBuckets: {
      slug: `${slugPrefix}-get-buckets`,
      label: `${pairLabel} Get Buckets`,
      description: `Get all active bucket indices in the ${pairLabel} vault`,
      outputs: {
        buckets: { label: "Active Bucket Indices" },
      },
    },
    totalAssets: {
      slug: `${slugPrefix}-total-assets`,
      label: `${pairLabel} Total Assets`,
      description: `Get total assets managed by the ${pairLabel} vault`,
      outputs: {
        assets: { label: "Total Assets (WAD)", decimals: 18 },
      },
    },
    lpToValue: {
      slug: `${slugPrefix}-lp-to-value`,
      label: `${pairLabel} LP to Value`,
      description: `Convert LP amount to quote token value for a bucket in the ${pairLabel} vault`,
      inputs: {
        bucket: { label: "Bucket Index" },
      },
      outputs: {
        value: { label: "Value (WAD)", decimals: 18 },
      },
    },
    drain: {
      slug: `${slugPrefix}-drain`,
      label: `${pairLabel} Drain Bucket`,
      description: `Drain all liquidity from a bucket in the ${pairLabel} vault`,
      inputs: {
        bucket: { label: "Bucket Index" },
      },
    },
    move: {
      slug: `${slugPrefix}-move`,
      label: `${pairLabel} Move Liquidity`,
      description: `Move liquidity between buckets in the ${pairLabel} vault`,
      inputs: {
        fromIndex_: { label: "Source Bucket Index" },
        toIndex_: { label: "Destination Bucket Index" },
        amt_: { label: "Amount (WAD)" },
      },
    },
    moveFromBuffer: {
      slug: `${slugPrefix}-move-from-buffer`,
      label: `${pairLabel} Move From Buffer`,
      description: `Move liquidity from the buffer to a pool bucket in the ${pairLabel} vault`,
      inputs: {
        toIndex_: { label: "Destination Bucket Index" },
        amt_: { label: "Amount (WAD)" },
      },
    },
    moveToBuffer: {
      slug: `${slugPrefix}-move-to-buffer`,
      label: `${pairLabel} Move To Buffer`,
      description: `Move liquidity from a pool bucket to the buffer in the ${pairLabel} vault`,
      inputs: {
        fromIndex_: { label: "Source Bucket Index" },
        amt_: { label: "Amount (WAD)" },
      },
    },
  };
}

function vaultAuthOverrides(
  slugPrefix: string,
  pairLabel: string
): Record<string, AbiFunctionOverride> {
  return {
    bufferRatio: {
      slug: `${slugPrefix}-buffer-ratio`,
      label: `${pairLabel} Buffer Ratio`,
      description: `Get the target buffer ratio for the ${pairLabel} vault`,
      outputs: {
        ratio: { label: "Buffer Ratio (WAD)", decimals: 18 },
      },
    },
    minBucketIndex: {
      slug: `${slugPrefix}-min-bucket-index`,
      label: `${pairLabel} Min Bucket Index`,
      description: `Get the minimum allowed bucket index for the ${pairLabel} vault`,
      outputs: {
        index: { label: "Min Bucket Index" },
      },
    },
  };
}

function bufferOverrides(
  slugPrefix: string,
  pairLabel: string
): Record<string, AbiFunctionOverride> {
  return {
    total: {
      slug: `${slugPrefix}-buffer-total`,
      label: `${pairLabel} Buffer Total`,
      description: `Get total liquidity held in the ${pairLabel} buffer contract`,
      outputs: {
        bufferTotal: { label: "Buffer Total (WAD)", decimals: 18 },
      },
    },
  };
}

export default defineAbiProtocol({
  name: "Ajna",
  slug: "ajna",
  description:
    "Ajna permissionless lending protocol: liquidation and vault keeper operations on Base",
  website: "https://www.ajna.finance",
  icon: "/protocols/ajna.png",

  testData: TEST_DATA,

  contracts: {
    poolInfoUtils: {
      label: "Ajna Pool Info Utils",
      abi: POOL_INFO_UTILS_ABI,
      addresses: {
        // Base
        "8453": "0x97fa9b0909C238D170C1ab3B5c728A3a45BBEcBa",
      },
      overrides: {
        auctionStatus: {
          slug: "get-auction-status",
          label: "Get Auction Status",
          description:
            "Get current auction status for a borrower in an Ajna pool",
          inputs: {
            ajnaPool_: { label: "Pool Address" },
            borrower_: { label: "Borrower Address" },
          },
          outputs: {
            kickTime_: { label: "Kick Timestamp" },
            collateral_: { label: "Collateral (WAD)", decimals: 18 },
            debtToCover_: { label: "Debt to Cover (WAD)", decimals: 18 },
            isCollateralized_: { label: "Is Collateralized" },
            price_: { label: "Current Price (WAD)", decimals: 18 },
            neutralPrice_: { label: "Neutral Price (WAD)", decimals: 18 },
            referencePrice_: {
              label: "Reference Price (WAD)",
              decimals: 18,
            },
            debtToCollateral_: {
              label: "Debt to Collateral (WAD)",
              decimals: 18,
            },
            bondFactor_: { label: "Bond Factor (WAD)", decimals: 18 },
          },
        },
        hpbIndex: {
          slug: "get-hpb-index",
          label: "Get HPB Index",
          description: "Get the highest price bucket index of an Ajna pool",
          inputs: {
            ajnaPool_: { label: "Pool Address" },
          },
          outputs: {
            index: { label: "HPB Index" },
          },
        },
        lup: {
          slug: "get-pool-lup",
          label: "Get Pool LUP",
          description: "Get the Lowest Utilized Price of an Ajna pool",
          inputs: {
            ajnaPool_: { label: "Pool Address" },
          },
          outputs: {
            lup: { label: "LUP (WAD)", decimals: 18 },
          },
        },
        htp: {
          slug: "get-pool-htp",
          label: "Get Pool HTP",
          description: "Get the Highest Threshold Price of an Ajna pool",
          inputs: {
            ajnaPool_: { label: "Pool Address" },
          },
          outputs: {
            htp: { label: "HTP (WAD)", decimals: 18 },
          },
        },
        borrowerInfo: {
          slug: "get-borrower-info",
          label: "Get Borrower Info",
          description:
            "Get borrower loan information including debt, collateral, and threshold price",
          inputs: {
            ajnaPool_: { label: "Pool Address" },
            borrower_: { label: "Borrower Address" },
          },
          outputs: {
            debt: { label: "Borrower Debt (WAD)", decimals: 18 },
            collateral: { label: "Borrower Collateral (WAD)", decimals: 18 },
            t0Np: { label: "T0 Neutral Price (WAD)", decimals: 18 },
            thresholdPrice: { label: "Threshold Price (WAD)", decimals: 18 },
          },
        },
        priceToIndex: {
          label: "Price to Bucket Index",
          description: "Convert a price to its corresponding Ajna bucket index",
          inputs: {
            price: { label: "Price (WAD)" },
          },
          outputs: {
            index: { label: "Bucket Index" },
          },
        },
        indexToPrice: {
          label: "Bucket Index to Price",
          description: "Convert a bucket index to its corresponding price",
          inputs: {
            index_: { label: "Bucket Index" },
          },
          outputs: {
            price: { label: "Price (WAD)", decimals: 18 },
          },
        },
      },
    },
    pool1: {
      label: "cbBTC/usBTCd Pool",
      abi: POOL_ABI,
      addresses: {
        // Base
        "8453": "0x46Acc253133b3Ec0953fe4445B5Ba8E6CFe10500",
      },
      overrides: poolOverrides("pool1", "cbBTC/usBTCd"),
    },
    pool2: {
      label: "usBTCd/webmx Pool",
      abi: POOL_ABI,
      addresses: {
        // Base
        "8453": "0x7e86Fd9eEceC773dE51625533fC9edF5f44719d9",
      },
      overrides: poolOverrides("pool2", "usBTCd/webmx"),
    },
    vault1: {
      label: "cbBTC/usBTCd ERC-4626 Vault",
      abi: VAULT_ABI,
      addresses: {
        // Base
        "8453": "0xFE8f1651a781f98dd349EA87DFF8F2814a1B0eB5",
      },
      overrides: vaultOverrides("vault1", "cbBTC/usBTCd"),
    },
    vault2: {
      label: "usBTCd/webmx ERC-4626 Vault",
      abi: VAULT_ABI,
      addresses: {
        // Base
        "8453": "0xeA9F4105Be9A9Bd49a810b7D044f4e12e1958Db6",
      },
      overrides: vaultOverrides("vault2", "usBTCd/webmx"),
    },
    vaultAuth1: {
      label: "cbBTC/usBTCd Vault Config",
      abi: VAULT_AUTH_ABI,
      addresses: {
        // Base
        "8453": "0xC1F8F3E59c65D3E7d378711E8FdF007e9e03e804",
      },
      overrides: vaultAuthOverrides("vault1", "cbBTC/usBTCd"),
    },
    vaultAuth2: {
      label: "usBTCd/webmx Vault Config",
      abi: VAULT_AUTH_ABI,
      addresses: {
        // Base
        "8453": "0x6caEe7adE308EF5f9879018b008308dE4c08F451",
      },
      overrides: vaultAuthOverrides("vault2", "usBTCd/webmx"),
    },
    buffer1: {
      label: "cbBTC/usBTCd Buffer",
      abi: BUFFER_ABI,
      addresses: {
        // Base
        "8453": "0x79eD528FbA19717c3d8DE682c6C06f7af749FbdC",
      },
      overrides: bufferOverrides("vault1", "cbBTC/usBTCd"),
    },
    buffer2: {
      label: "usBTCd/webmx Buffer",
      abi: BUFFER_ABI,
      addresses: {
        // Base
        "8453": "0xef093900fdD98F128Bd80761C74A94ab1687A020",
      },
      overrides: bufferOverrides("vault2", "usBTCd/webmx"),
    },
  },
});
