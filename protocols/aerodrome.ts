import { defineAbiProtocol } from "@/lib/protocol-registry";
import { type ProtocolTestData, wallet } from "@/lib/test-data/types";

// Base token/factory addresses for the one bindable pool read. The gauge,
// veAERO-lock, and swap reads need a specific pool/gauge/tokenId or token
// balances that a coverage fixture does not yet provision, so they are
// documented skips.
const BASE_WETH = "0x4200000000000000000000000000000000000006";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const AERODROME_POOL_FACTORY = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";

const TEST_DATA: ProtocolTestData = {
  "8453": {
    setup: { minNativeHuman: "0.01", requiredTokens: [], approvals: [] },
    actions: {
      "get-total-weight": {},
      "get-all-pools-length": {},
      "get-pool-for-pair": {
        tokenA: BASE_WETH,
        tokenB: BASE_USDC,
        stable: "false",
        factory: AERODROME_POOL_FACTORY,
      },
      "aero-balance-of": { account: wallet() },
    },
    skipped: {
      "get-reserves":
        "requires a live token pair + factory with reserves fixtured",
      "is-gauge-alive": "requires a specific gauge address",
      "get-gauge-for-pool": "requires a specific pool address",
      "get-venft-balance": "requires an existing veAERO tokenId",
      "get-lock-details": "requires an existing veAERO tokenId",
      "get-amount-out": "requires a pool address and an input amount",
      "swap-exact-tokens": "requires token balance, approval and a route",
      "add-liquidity": "requires token balances and approvals",
      "remove-liquidity": "requires an existing LP position",
      vote: "requires a veAERO tokenId with voting power",
      "reset-votes": "requires a veAERO tokenId that has voted",
      "claim-rewards": "requires staked gauge positions",
      "create-lock": "requires an AERO balance and approval",
      "increase-lock-amount": "requires an existing veAERO lock",
      "increase-lock-duration": "requires an existing veAERO lock",
      "withdraw-lock": "requires an expired veAERO lock",
      "aero-approve": "requires an AERO balance for a meaningful allowance",
    },
    // Base-wide invariants: nonzero total voting weight and thousands of
    // deployed pools; the WETH/USDC volatile pool resolves to a real address.
    // aero-balance-of reads the unprovisioned wallet's AERO (zero) and stays
    // liveness-only. Unnamed outputs take no field; poolFor's output is named
    // "pool".
    expectations: {
      "get-total-weight": [{ nonZero: true }],
      "get-all-pools-length": [{ nonZero: true }],
      "get-pool-for-pair": [{ field: "pool", notEmpty: true }],
    },
    // The Base event emitter wraps ETH for the pool swap and pulls AERO from
    // the veAERO escrow under impersonation, then drives a swap, a lock, a
    // vote, a lock/withdraw, and an epoch distribute - six of the seven events.
    // gauge-created stays skipped: every whitelisted Base pair already has a
    // gauge, so emitting it would need a freshly deployed token to pair and
    // gauge, which the self-contained emitter does not set up.
    events: {
      skipped: {
        "gauge-created":
          "Voter.createGauge emits GaugeCreated only for a pool that has no gauge yet; every whitelisted Base pair already has one, so a fresh emission would require deploying a throwaway token to pair and gauge",
      },
    },
  },
};

export default defineAbiProtocol({
  name: "Aerodrome",
  slug: "aerodrome",
  testData: TEST_DATA,
  description:
    "Aerodrome Finance: the leading DEX on Base with volatile/stable pools, ve(3,3) voting, and gauge-based emissions",
  website: "https://aerodrome.finance",
  icon: "/protocols/aerodrome.png",

  contracts: {
    router: {
      label: "Aerodrome Router",
      addresses: {
        // Base
        "8453": "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43",
      },
      abi: JSON.stringify([
        {
          type: "function",
          name: "getReserves",
          stateMutability: "view",
          inputs: [
            { name: "tokenA", type: "address" },
            { name: "tokenB", type: "address" },
            { name: "stable", type: "bool" },
            { name: "factory", type: "address" },
          ],
          outputs: [
            { name: "reserveA", type: "uint256" },
            { name: "reserveB", type: "uint256" },
          ],
        },
        {
          type: "function",
          name: "poolFor",
          stateMutability: "view",
          inputs: [
            { name: "tokenA", type: "address" },
            { name: "tokenB", type: "address" },
            { name: "stable", type: "bool" },
            { name: "factory", type: "address" },
          ],
          outputs: [{ name: "pool", type: "address" }],
        },
        {
          type: "function",
          name: "swapExactTokensForTokens",
          stateMutability: "nonpayable",
          inputs: [
            { name: "amountIn", type: "uint256" },
            { name: "amountOutMin", type: "uint256" },
            {
              name: "routes",
              type: "tuple[]",
              components: [
                { name: "from", type: "address" },
                { name: "to", type: "address" },
                { name: "stable", type: "bool" },
                { name: "factory", type: "address" },
              ],
            },
            { name: "to", type: "address" },
            { name: "deadline", type: "uint256" },
          ],
          outputs: [{ name: "amounts", type: "uint256[]" }],
        },
        {
          type: "function",
          name: "addLiquidity",
          stateMutability: "nonpayable",
          inputs: [
            { name: "tokenA", type: "address" },
            { name: "tokenB", type: "address" },
            { name: "stable", type: "bool" },
            { name: "amountADesired", type: "uint256" },
            { name: "amountBDesired", type: "uint256" },
            { name: "amountAMin", type: "uint256" },
            { name: "amountBMin", type: "uint256" },
            { name: "to", type: "address" },
            { name: "deadline", type: "uint256" },
          ],
          outputs: [
            { name: "amountA", type: "uint256" },
            { name: "amountB", type: "uint256" },
            { name: "liquidity", type: "uint256" },
          ],
        },
        {
          type: "function",
          name: "removeLiquidity",
          stateMutability: "nonpayable",
          inputs: [
            { name: "tokenA", type: "address" },
            { name: "tokenB", type: "address" },
            { name: "stable", type: "bool" },
            { name: "liquidity", type: "uint256" },
            { name: "amountAMin", type: "uint256" },
            { name: "amountBMin", type: "uint256" },
            { name: "to", type: "address" },
            { name: "deadline", type: "uint256" },
          ],
          outputs: [
            { name: "amountA", type: "uint256" },
            { name: "amountB", type: "uint256" },
          ],
        },
      ]),
      overrides: {
        getReserves: {
          label: "Get Pool Reserves",
          description:
            "Get the current reserves for an Aerodrome pool by token pair",
          inputs: {
            tokenA: { label: "Token A Address" },
            tokenB: { label: "Token B Address" },
            stable: { label: "Stable Pool (true/false)" },
            factory: {
              label: "Pool Factory Address",
              default: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da",
            },
          },
          outputs: {
            reserveA: { label: "Reserve A (raw wei)" },
            reserveB: { label: "Reserve B (raw wei)" },
          },
        },
        poolFor: {
          slug: "get-pool-for-pair",
          label: "Get Pool Address",
          description:
            "Resolve the pool address for a token pair and pool type (stable/volatile)",
          inputs: {
            tokenA: { label: "Token A Address" },
            tokenB: { label: "Token B Address" },
            stable: { label: "Stable Pool (true/false)" },
            factory: {
              label: "Pool Factory Address",
              default: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da",
            },
          },
          outputs: {
            pool: { label: "Pool Address" },
          },
        },
        swapExactTokensForTokens: {
          slug: "swap-exact-tokens",
          label: "Swap Exact Tokens",
          description:
            "Swap an exact amount of input tokens for as many output tokens as possible via Aerodrome routes",
          inputs: {
            amountIn: { label: "Input Amount (wei)" },
            amountOutMin: { label: "Minimum Output (wei)" },
            routes: {
              label: "Swap Routes (JSON array of {from, to, stable, factory})",
              helpTip:
                "Each route is an object with from (address), to (address), stable (bool), factory (address). For single-hop swaps use one route entry.",
            },
            to: { label: "Recipient Address" },
            deadline: { label: "Deadline (unix timestamp)" },
          },
        },
        addLiquidity: {
          label: "Add Liquidity",
          description:
            "Add liquidity to an Aerodrome pool and receive LP tokens",
          inputs: {
            tokenA: { label: "Token A Address" },
            tokenB: { label: "Token B Address" },
            stable: { label: "Stable Pool (true/false)" },
            amountADesired: { label: "Desired Amount A (wei)" },
            amountBDesired: { label: "Desired Amount B (wei)" },
            amountAMin: { label: "Minimum Amount A (wei)" },
            amountBMin: { label: "Minimum Amount B (wei)" },
            to: { label: "Recipient Address" },
            deadline: { label: "Deadline (unix timestamp)" },
          },
        },
        removeLiquidity: {
          label: "Remove Liquidity",
          description:
            "Remove liquidity from an Aerodrome pool by burning LP tokens",
          inputs: {
            tokenA: { label: "Token A Address" },
            tokenB: { label: "Token B Address" },
            stable: { label: "Stable Pool (true/false)" },
            liquidity: { label: "LP Token Amount (wei)" },
            amountAMin: { label: "Minimum Amount A (wei)" },
            amountBMin: { label: "Minimum Amount B (wei)" },
            to: { label: "Recipient Address" },
            deadline: { label: "Deadline (unix timestamp)" },
          },
        },
      },
    },

    voter: {
      label: "Aerodrome Voter",
      addresses: {
        // Base
        "8453": "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5",
      },
      abi: JSON.stringify([
        {
          type: "function",
          name: "totalWeight",
          stateMutability: "view",
          inputs: [],
          outputs: [{ name: "", type: "uint256" }],
        },
        {
          type: "function",
          name: "isAlive",
          stateMutability: "view",
          inputs: [{ name: "_gauge", type: "address" }],
          outputs: [{ name: "", type: "bool" }],
        },
        {
          type: "function",
          name: "gauges",
          stateMutability: "view",
          inputs: [{ name: "_pool", type: "address" }],
          outputs: [{ name: "", type: "address" }],
        },
        {
          type: "function",
          name: "vote",
          stateMutability: "nonpayable",
          inputs: [
            { name: "_tokenId", type: "uint256" },
            { name: "_poolVote", type: "address[]" },
            { name: "_weights", type: "uint256[]" },
          ],
          outputs: [],
        },
        {
          type: "function",
          name: "reset",
          stateMutability: "nonpayable",
          inputs: [{ name: "_tokenId", type: "uint256" }],
          outputs: [],
        },
        {
          type: "function",
          name: "claimRewards",
          stateMutability: "nonpayable",
          inputs: [{ name: "_gauges", type: "address[]" }],
          outputs: [],
        },
        {
          type: "event",
          name: "Voted",
          inputs: [
            { name: "voter", type: "address", indexed: true },
            { name: "pool", type: "address", indexed: true },
            { name: "tokenId", type: "uint256", indexed: true },
            { name: "weight", type: "uint256", indexed: false },
            { name: "totalWeight", type: "uint256", indexed: false },
            { name: "timestamp", type: "uint256", indexed: false },
          ],
        },
        {
          type: "event",
          name: "GaugeCreated",
          inputs: [
            { name: "poolFactory", type: "address", indexed: true },
            { name: "votingRewardsFactory", type: "address", indexed: true },
            { name: "gaugeFactory", type: "address", indexed: true },
            { name: "pool", type: "address", indexed: false },
            { name: "bribeVotingReward", type: "address", indexed: false },
            { name: "feeVotingReward", type: "address", indexed: false },
            { name: "gauge", type: "address", indexed: false },
            { name: "creator", type: "address", indexed: false },
          ],
        },
        {
          type: "event",
          name: "DistributeReward",
          inputs: [
            { name: "sender", type: "address", indexed: true },
            { name: "gauge", type: "address", indexed: true },
            { name: "amount", type: "uint256", indexed: false },
          ],
        },
      ]),
      overrides: {
        totalWeight: {
          slug: "get-total-weight",
          label: "Get Total Voting Weight",
          description: "Get the total voting weight across all gauges",
          outputs: {
            result: {
              name: "totalWeight",
              label: "Total Weight",
              decimals: 18,
            },
          },
        },
        isAlive: {
          slug: "is-gauge-alive",
          label: "Check Gauge Status",
          description:
            "Check whether a gauge is active and receiving emissions",
          inputs: {
            _gauge: { label: "Gauge Address" },
          },
          outputs: {
            result: { name: "alive", label: "Is Alive" },
          },
        },
        gauges: {
          slug: "get-gauge-for-pool",
          label: "Get Gauge for Pool",
          description:
            "Look up the gauge address for a pool to check status or vote",
          inputs: {
            _pool: { label: "Pool Address" },
          },
          outputs: {
            result: { name: "gauge", label: "Gauge Address" },
          },
        },
        vote: {
          label: "Vote on Gauges",
          description: "Cast votes for pool gauges using veAERO voting power",
          inputs: {
            _tokenId: { label: "veNFT Token ID" },
            _poolVote: { label: "Pool Addresses (comma-separated)" },
            _weights: { label: "Vote Weights (comma-separated)" },
          },
        },
        reset: {
          slug: "reset-votes",
          label: "Reset Votes",
          description:
            "Reset all gauge votes for a veNFT, required before changing vote allocations in a new epoch",
          inputs: {
            _tokenId: { label: "veNFT Token ID" },
          },
        },
        claimRewards: {
          label: "Claim Gauge Rewards",
          description: "Claim accumulated AERO rewards from gauges",
          inputs: {
            _gauges: { label: "Gauge Addresses (comma-separated)" },
          },
        },
      },
      events: {
        Voted: {
          slug: "voter-voted",
          label: "Gauge Vote Cast",
          description: "Fires when a veNFT holder casts votes for a pool gauge",
        },
        GaugeCreated: {
          slug: "gauge-created",
          label: "Gauge Created",
          description: "Fires when a new gauge is created for a pool",
        },
        DistributeReward: {
          slug: "distribute-reward",
          label: "Reward Distributed",
          description: "Fires when AERO emissions are distributed to a gauge",
        },
      },
    },

    poolFactory: {
      label: "Aerodrome Pool Factory",
      addresses: {
        // Base
        "8453": "0x420DD381b31aEf6683db6B902084cB0FFECe40Da",
      },
      abi: JSON.stringify([
        {
          type: "function",
          name: "allPoolsLength",
          stateMutability: "view",
          inputs: [],
          outputs: [{ name: "", type: "uint256" }],
        },
      ]),
      overrides: {
        allPoolsLength: {
          slug: "get-all-pools-length",
          label: "Get Total Pool Count",
          description:
            "Get the total number of pools created by the Aerodrome factory",
          outputs: {
            result: { name: "count", label: "Total Pool Count" },
          },
        },
      },
    },

    votingEscrow: {
      label: "Aerodrome VotingEscrow (veAERO)",
      addresses: {
        // Base
        "8453": "0xeBf418Fe2512e7E6bd9b87a8F0f294aCDC67e6B4",
      },
      abi: JSON.stringify([
        {
          type: "function",
          name: "balanceOfNFT",
          stateMutability: "view",
          inputs: [{ name: "_tokenId", type: "uint256" }],
          outputs: [{ name: "", type: "uint256" }],
        },
        {
          type: "function",
          name: "locked",
          stateMutability: "view",
          inputs: [{ name: "_tokenId", type: "uint256" }],
          outputs: [
            { name: "amount", type: "int128" },
            { name: "end", type: "uint256" },
          ],
        },
        {
          type: "function",
          name: "create_lock",
          stateMutability: "nonpayable",
          inputs: [
            { name: "_value", type: "uint256" },
            { name: "_lockDuration", type: "uint256" },
          ],
          outputs: [{ name: "", type: "uint256" }],
        },
        {
          type: "function",
          name: "increase_amount",
          stateMutability: "nonpayable",
          inputs: [
            { name: "_tokenId", type: "uint256" },
            { name: "_value", type: "uint256" },
          ],
          outputs: [],
        },
        {
          type: "function",
          name: "increase_unlock_time",
          stateMutability: "nonpayable",
          inputs: [
            { name: "_tokenId", type: "uint256" },
            { name: "_lockDuration", type: "uint256" },
          ],
          outputs: [],
        },
        {
          type: "function",
          name: "withdraw",
          stateMutability: "nonpayable",
          inputs: [{ name: "_tokenId", type: "uint256" }],
          outputs: [],
        },
        {
          type: "event",
          name: "Deposit",
          inputs: [
            { name: "provider", type: "address", indexed: true },
            { name: "tokenId", type: "uint256", indexed: true },
            { name: "depositType", type: "uint8", indexed: true },
            { name: "value", type: "uint256", indexed: false },
            { name: "locktime", type: "uint256", indexed: false },
            { name: "ts", type: "uint256", indexed: false },
          ],
        },
        {
          type: "event",
          name: "Withdraw",
          inputs: [
            { name: "provider", type: "address", indexed: true },
            { name: "tokenId", type: "uint256", indexed: true },
            { name: "value", type: "uint256", indexed: false },
            { name: "ts", type: "uint256", indexed: false },
          ],
        },
      ]),
      overrides: {
        balanceOfNFT: {
          slug: "get-venft-balance",
          label: "Get veNFT Voting Power",
          description: "Get the current voting power of a veAERO NFT position",
          inputs: {
            _tokenId: { label: "veNFT Token ID" },
          },
          outputs: {
            result: { name: "balance", label: "Voting Power", decimals: 18 },
          },
        },
        locked: {
          slug: "get-lock-details",
          label: "Get Lock Details",
          description:
            "Get the locked AERO amount and unlock timestamp for a veNFT position",
          inputs: {
            _tokenId: { label: "veNFT Token ID" },
          },
          outputs: {
            amount: { label: "Locked Amount (raw)" },
            end: { label: "Unlock Timestamp (unix)" },
          },
        },
        create_lock: {
          slug: "create-lock",
          label: "Create veAERO Lock",
          description:
            "Lock AERO tokens to create a veAERO NFT position with voting power",
          inputs: {
            _value: { label: "AERO Amount (wei)", decimals: 18 },
            _lockDuration: { label: "Lock Duration (seconds)" },
          },
          outputs: {
            result: { name: "tokenId", label: "veNFT Token ID" },
          },
        },
        increase_amount: {
          slug: "increase-lock-amount",
          label: "Increase Lock Amount",
          description:
            "Add more AERO tokens to an existing veNFT lock position",
          inputs: {
            _tokenId: { label: "veNFT Token ID" },
            _value: { label: "Additional AERO Amount (wei)", decimals: 18 },
          },
        },
        increase_unlock_time: {
          slug: "increase-lock-duration",
          label: "Increase Lock Duration",
          description: "Extend the lock duration of an existing veNFT position",
          inputs: {
            _tokenId: { label: "veNFT Token ID" },
            _lockDuration: { label: "New Lock Duration (seconds)" },
          },
        },
        withdraw: {
          slug: "withdraw-lock",
          label: "Withdraw Expired Lock",
          description:
            "Withdraw AERO tokens from an expired veNFT lock position",
          inputs: {
            _tokenId: { label: "veNFT Token ID" },
          },
        },
      },
      events: {
        Deposit: {
          slug: "ve-deposit",
          label: "veAERO Deposit",
          description:
            "Fires when AERO tokens are locked or added to a veNFT position",
        },
        Withdraw: {
          slug: "ve-withdraw",
          label: "veAERO Withdrawal",
          description:
            "Fires when AERO tokens are withdrawn from an expired veNFT lock",
        },
      },
    },

    pool: {
      label: "Aerodrome Pool",
      userSpecifiedAddress: true,
      addresses: {
        // Base -- reference address (WETH/USDC pool); runtime address from user input
        "8453": "0xcDAC0d6c6C59727a65F871236188350531885C43",
      },
      abi: JSON.stringify([
        {
          type: "function",
          name: "getAmountOut",
          stateMutability: "view",
          inputs: [
            { name: "amountIn", type: "uint256" },
            { name: "tokenIn", type: "address" },
          ],
          outputs: [{ name: "", type: "uint256" }],
        },
        {
          type: "event",
          name: "Swap",
          inputs: [
            { name: "sender", type: "address", indexed: true },
            { name: "to", type: "address", indexed: true },
            { name: "amount0In", type: "uint256", indexed: false },
            { name: "amount1In", type: "uint256", indexed: false },
            { name: "amount0Out", type: "uint256", indexed: false },
            { name: "amount1Out", type: "uint256", indexed: false },
          ],
        },
        {
          type: "event",
          name: "Sync",
          inputs: [
            { name: "reserve0", type: "uint256", indexed: false },
            { name: "reserve1", type: "uint256", indexed: false },
          ],
        },
      ]),
      overrides: {
        getAmountOut: {
          label: "Get Expected Output",
          description:
            "Get the expected output amount for a swap from a specific Aerodrome pool",
          inputs: {
            amountIn: { label: "Input Amount (wei)" },
            tokenIn: { label: "Input Token Address" },
          },
          outputs: {
            result: { name: "amountOut", label: "Expected Output (wei)" },
          },
        },
      },
      events: {
        Swap: {
          slug: "pool-swap",
          label: "Pool Swap",
          description: "Fires when a swap occurs in an Aerodrome pool",
        },
        Sync: {
          slug: "pool-sync",
          label: "Pool Reserves Synced",
          description:
            "Fires when pool reserves are updated after any operation (swap, mint, burn)",
        },
      },
    },

    aeroToken: {
      label: "AERO Token",
      addresses: {
        // Base
        "8453": "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
      },
      abi: JSON.stringify([
        {
          type: "function",
          name: "balanceOf",
          stateMutability: "view",
          inputs: [{ name: "account", type: "address" }],
          outputs: [{ name: "", type: "uint256" }],
        },
        {
          type: "function",
          name: "approve",
          stateMutability: "nonpayable",
          inputs: [
            { name: "spender", type: "address" },
            { name: "amount", type: "uint256" },
          ],
          outputs: [{ name: "", type: "bool" }],
        },
      ]),
      overrides: {
        balanceOf: {
          slug: "aero-balance-of",
          label: "Get AERO Balance",
          description: "Check AERO token balance of an address",
          inputs: {
            account: { label: "Wallet Address" },
          },
          outputs: {
            result: { name: "balance", label: "AERO Balance", decimals: 18 },
          },
        },
        approve: {
          slug: "aero-approve",
          label: "Approve AERO",
          description: "Approve an address to spend AERO tokens",
          inputs: {
            spender: { label: "Spender Address" },
            amount: { label: "Amount (wei)" },
          },
        },
      },
    },
  },
});
