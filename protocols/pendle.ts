import { defineAbiProtocol } from "@/lib/protocol-registry";
import {
  amount,
  contract,
  type ProtocolTestData,
  wallet,
} from "@/lib/test-data/types";

// Pinned-block fixture: Pendle markets expire, so live-head bindings rot
// on the market's schedule. The chain-1 fixtures instead bind state
// recorded at a pinned mainnet block, and the Tier 1 harness runs pendle
// against a dedicated fork at that block (PROTOCOL_SIM_RPC_1_PINNED), so
// the bindings stay verifiable regardless of wall clock. Market chosen
// from Pendle's active-markets API (mature high-liquidity wstETH market,
// expiry 2027-12-30, the most distant on mainnet at recording time) and
// verified 2026-07-08 via eth_call at the pin: readTokens() returned the
// SY/PT/YT below, expiry() = 1830124800, isExpired() = false, code
// present at every address, decimals 18 across SY/PT/YT, and the market
// held ~1306 SY (the SY_WSTETH whale in chain-test-data.ts). Refresh
// procedure: specs/protocol-coverage-methodology.md ("Pendle pinned-block
// fixtures").
const MAINNET_PINNED_BLOCK = 25_487_331;
const MAINNET_MARKET_WSTETH = "0x34280882267ffa6383B363E278B027Be083bBe3b";
const MAINNET_SY_WSTETH = "0xcbC72d92b2dc8187414F6734718563898740C0BC";
const MAINNET_PT_WSTETH = "0xb253Eff1104802b97aC7E3aC9FdD73AecE295a2c";
const MAINNET_YT_WSTETH = "0x04B7Fa1e727d7290D6E24fA9b426d0c940283a95";
const MAINNET_MARKET_EXPIRY = "1830124800";

const TEST_DATA: ProtocolTestData = {
  "1": {
    pinnedBlock: MAINNET_PINNED_BLOCK,
    setup: {
      minNativeHuman: "0.01",
      requiredTokens: [{ symbol: "SY_WSTETH", human: "10" }],
      // The router pulls SY on mintPyFromSy and PT+YT on redeemPyToSy
      // (both via transferFrom), so all three need allowances. PT/YT are
      // held only after the mint write runs; approving them up front is
      // fine (approve needs no balance).
      approvals: [
        { token: "SY_WSTETH", spender: contract("router"), human: "10" },
        { token: "PT_WSTETH", spender: contract("router"), human: "5" },
        { token: "YT_WSTETH", spender: contract("router"), human: "5" },
      ],
      // Three real signed txs through the app; each has been observed
      // to take 100-220s under CI's shared-wallet contention on a cold
      // fork, so the single-tx 300s default cannot fit this setup.
      // 600_000 was too tight: three worst-case approvals total ~660s and
      // raced the wait, so a fully successful setup still timed out at the
      // boundary. 900_000 clears the worst case with margin.
      executionWaitMs: 900_000,
    },
    actions: {
      "get-ve-pendle-balance": { user: wallet() },
      "get-ve-pendle-total-supply": {},
      "get-ve-pendle-position": { user: wallet() },
      "get-market-expiry": { contractAddress: MAINNET_MARKET_WSTETH },
      "is-market-expired": { contractAddress: MAINNET_MARKET_WSTETH },
      "get-lp-balance": {
        contractAddress: MAINNET_MARKET_WSTETH,
        account: wallet(),
      },
      "get-active-lp-balance": {
        contractAddress: MAINNET_MARKET_WSTETH,
        user: wallet(),
      },
      "get-pt-balance": {
        contractAddress: MAINNET_PT_WSTETH,
        account: wallet(),
      },
      "is-pt-expired": { contractAddress: MAINNET_PT_WSTETH },
      "get-yt-balance": {
        contractAddress: MAINNET_YT_WSTETH,
        account: wallet(),
      },
      "get-sy-balance": {
        contractAddress: MAINNET_SY_WSTETH,
        account: wallet(),
      },
      "get-sy-exchange-rate": { contractAddress: MAINNET_SY_WSTETH },
      // Write sequence: mint splits 5 of the 10 funded SY into PT+YT
      // (netPyOut ~ netSyIn * pyIndex, index was ~1.24 at the pin), then
      // redeem merges 2 PT+YT back - well inside what the mint produced.
      "mint-py-from-sy": {
        receiver: wallet(),
        YT: MAINNET_YT_WSTETH,
        netSyIn: amount("SY_WSTETH", "5"),
        minPyOut: "1",
      },
      "redeem-py-to-sy": {
        receiver: wallet(),
        YT: MAINNET_YT_WSTETH,
        netPyIn: amount("PT_WSTETH", "2"),
        minSyOut: "1",
      },
    },
    // Same constraint as the setup wait: a signed write through the app
    // has been observed to take 100-220s on a cold fork under CI's
    // shared-wallet contention, above the 120s per-action default.
    executionWaitMs: {
      "mint-py-from-sy": 300_000,
      "redeem-py-to-sy": 300_000,
    },
    expectations: {
      // Chain invariants of the recorded market: its expiry is immutable
      // on-chain, and the pinned fork's clock never reaches it.
      "get-market-expiry": [{ equals: MAINNET_MARKET_EXPIRY }],
      "is-market-expired": [{ equals: "false" }],
      "is-pt-expired": [{ equals: "false" }],
      "get-sy-exchange-rate": [{ nonZero: true }],
      // Setup funds 10 SY; only this protocol's fixtures move it.
      "get-sy-balance": [{ nonZero: true }],
      // vePENDLE total supply is a nine-figure chain aggregate, independent
      // of the test wallet (which locks no PENDLE).
      "get-ve-pendle-total-supply": [{ nonZero: true }],
    },
    writeExpectations: {
      "mint-py-from-sy": [
        { read: "get-pt-balance", expect: { nonZero: true } },
        { read: "get-yt-balance", expect: { nonZero: true } },
      ],
      "redeem-py-to-sy": [
        { read: "get-sy-balance", expect: { nonZero: true } },
      ],
    },
    // The event emitter mints fresh SY from wstETH and drives the YT and
    // market directly (low-level mint/swap/burn, YT mintPY/redeemPY, and an
    // interest claim after a time warp), covering seven of the eight events.
    // redeem-rewards stays skipped: the wstETH market carries no external
    // reward tokens, so YT.redeemDueInterestAndRewards emits RedeemInterest
    // but never RedeemRewards.
    events: {
      skipped: {
        "redeem-rewards":
          "YT.redeemDueInterestAndRewards emits RedeemRewards only when the market has external reward tokens; the wstETH market has none, so the log never fires",
      },
    },
  },
};

export default defineAbiProtocol({
  name: "Pendle Finance",
  slug: "pendle",
  description:
    "Pendle Finance: yield tokenization protocol for trading fixed and variable yield on DeFi assets",
  website: "https://pendle.finance",
  icon: "/protocols/pendle.png",

  testData: TEST_DATA,

  contracts: {
    router: {
      label: "PendleRouter",
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
      abi: JSON.stringify([
        {
          type: "function",
          name: "mintPyFromSy",
          stateMutability: "nonpayable",
          inputs: [
            { name: "receiver", type: "address" },
            { name: "YT", type: "address" },
            { name: "netSyIn", type: "uint256" },
            { name: "minPyOut", type: "uint256" },
          ],
          outputs: [{ name: "netPyOut", type: "uint256" }],
        },
        {
          type: "function",
          name: "redeemPyToSy",
          stateMutability: "nonpayable",
          inputs: [
            { name: "receiver", type: "address" },
            { name: "YT", type: "address" },
            { name: "netPyIn", type: "uint256" },
            { name: "minSyOut", type: "uint256" },
          ],
          outputs: [{ name: "netSyOut", type: "uint256" }],
        },
      ]),
      overrides: {
        mintPyFromSy: {
          label: "Mint PT and YT from SY",
          description:
            "Split Standardized Yield tokens into Principal Tokens and Yield Tokens",
          inputs: {
            receiver: { label: "Receiver Address" },
            YT: { label: "YT Token Address" },
            netSyIn: { label: "SY Amount (wei)" },
            minPyOut: { label: "Minimum PT/YT Out (wei)" },
          },
        },
        redeemPyToSy: {
          label: "Redeem PT and YT to SY",
          description:
            "Merge Principal Tokens and Yield Tokens back into Standardized Yield tokens",
          inputs: {
            receiver: { label: "Receiver Address" },
            YT: { label: "YT Token Address" },
            netPyIn: { label: "PT/YT Amount (wei)" },
            minSyOut: { label: "Minimum SY Out (wei)" },
          },
        },
      },
    },

    vePendle: {
      label: "vePENDLE",
      addresses: {
        // Ethereum Mainnet
        "1": "0x4f30A9D41B80ecC5B94306AB4364951AE3170210",
      },
      abi: JSON.stringify([
        {
          type: "function",
          name: "balanceOf",
          stateMutability: "view",
          inputs: [{ name: "user", type: "address" }],
          outputs: [{ name: "", type: "uint128" }],
        },
        {
          type: "function",
          name: "totalSupplyStored",
          stateMutability: "view",
          inputs: [],
          outputs: [{ name: "", type: "uint128" }],
        },
        {
          type: "function",
          name: "positionData",
          stateMutability: "view",
          inputs: [{ name: "user", type: "address" }],
          outputs: [
            { name: "amount", type: "uint128" },
            { name: "expiry", type: "uint128" },
          ],
        },
      ]),
      overrides: {
        balanceOf: {
          slug: "get-ve-pendle-balance",
          label: "Get vePENDLE Balance",
          description: "Check the vePENDLE voting power balance of an address",
          inputs: {
            user: { label: "Wallet Address" },
          },
          outputs: {
            result: {
              name: "balance",
              label: "vePENDLE Balance",
              decimals: 18,
            },
          },
        },
        totalSupplyStored: {
          slug: "get-ve-pendle-total-supply",
          label: "Get vePENDLE Total Supply",
          description:
            "Get the stored total vePENDLE supply across all lockers",
          outputs: {
            result: {
              name: "totalSupply",
              label: "Total vePENDLE Supply",
              decimals: 18,
            },
          },
        },
        positionData: {
          slug: "get-ve-pendle-position",
          label: "Get vePENDLE Lock Position",
          description:
            "Get the lock position data for an address (amount and expiry)",
          inputs: {
            user: { label: "Wallet Address" },
          },
          outputs: {
            amount: { label: "Locked PENDLE Amount" },
            expiry: { label: "Lock Expiry Timestamp" },
          },
        },
      },
    },

    market: {
      label: "Pendle Market",
      userSpecifiedAddress: true,
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
      abi: JSON.stringify([
        {
          type: "function",
          name: "expiry",
          stateMutability: "view",
          inputs: [],
          outputs: [{ name: "", type: "uint256" }],
        },
        {
          type: "function",
          name: "isExpired",
          stateMutability: "view",
          inputs: [],
          outputs: [{ name: "", type: "bool" }],
        },
        {
          type: "function",
          name: "balanceOf",
          stateMutability: "view",
          inputs: [{ name: "account", type: "address" }],
          outputs: [{ name: "", type: "uint256" }],
        },
        {
          type: "function",
          name: "activeBalance",
          stateMutability: "view",
          inputs: [{ name: "user", type: "address" }],
          outputs: [{ name: "", type: "uint256" }],
        },
        {
          type: "event",
          name: "Swap",
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
          type: "event",
          name: "Mint",
          inputs: [
            { name: "receiver", type: "address", indexed: true },
            { name: "netLpMinted", type: "uint256", indexed: false },
            { name: "netSyUsed", type: "uint256", indexed: false },
            { name: "netPtUsed", type: "uint256", indexed: false },
          ],
        },
        {
          type: "event",
          name: "Burn",
          inputs: [
            { name: "receiverSy", type: "address", indexed: true },
            { name: "receiverPt", type: "address", indexed: true },
            { name: "netLpBurned", type: "uint256", indexed: false },
            { name: "netSyOut", type: "uint256", indexed: false },
            { name: "netPtOut", type: "uint256", indexed: false },
          ],
        },
        {
          type: "event",
          name: "UpdateImpliedRate",
          inputs: [
            { name: "timestamp", type: "uint256", indexed: true },
            { name: "lnLastImpliedRate", type: "uint256", indexed: false },
          ],
        },
      ]),
      overrides: {
        expiry: {
          slug: "get-market-expiry",
          label: "Get Market Expiry",
          description: "Get the expiry timestamp of a Pendle market",
          outputs: {
            result: { name: "expiry", label: "Expiry Timestamp" },
          },
        },
        isExpired: {
          slug: "is-market-expired",
          label: "Is Market Expired",
          description:
            "Check whether a Pendle market has passed its expiry date",
          outputs: {
            result: { name: "expired", label: "Is Expired" },
          },
        },
        balanceOf: {
          slug: "get-lp-balance",
          label: "Get LP Balance",
          description:
            "Check the LP token balance for a Pendle market position",
          inputs: {
            account: { label: "Wallet Address" },
          },
          outputs: {
            result: {
              name: "balance",
              label: "LP Token Balance",
              decimals: 18,
            },
          },
        },
        activeBalance: {
          slug: "get-active-lp-balance",
          label: "Get Active LP Balance",
          description:
            "Check the active (non-expired) LP balance earning rewards in a Pendle market",
          inputs: {
            user: { label: "Wallet Address" },
          },
          outputs: {
            result: {
              name: "balance",
              label: "Active LP Balance",
              decimals: 18,
            },
          },
        },
      },
      events: {
        Swap: {
          slug: "market-swap",
          label: "Market Swap",
          description:
            "Fires when a swap occurs in a Pendle market (PT/SY exchange)",
        },
        Mint: {
          slug: "market-mint",
          label: "Market LP Minted",
          description:
            "Fires when liquidity is added to a Pendle market (LP tokens minted)",
        },
        Burn: {
          slug: "market-burn",
          label: "Market LP Burned",
          description:
            "Fires when liquidity is removed from a Pendle market (LP tokens burned)",
        },
        UpdateImpliedRate: {
          slug: "update-implied-rate",
          label: "Implied Rate Updated",
          description:
            "Fires when the implied yield rate changes in a Pendle market",
        },
      },
    },

    pt: {
      label: "Principal Token (PT)",
      userSpecifiedAddress: true,
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
          name: "isExpired",
          stateMutability: "view",
          inputs: [],
          outputs: [{ name: "", type: "bool" }],
        },
      ]),
      overrides: {
        balanceOf: {
          slug: "get-pt-balance",
          label: "Get PT Balance",
          description: "Check the Principal Token balance of an address",
          inputs: {
            account: { label: "Wallet Address" },
          },
          outputs: {
            result: { name: "balance", label: "PT Balance", decimals: 18 },
          },
        },
        isExpired: {
          slug: "is-pt-expired",
          label: "Is PT Expired",
          description:
            "Check whether a Principal Token has passed its maturity date",
          outputs: {
            result: { name: "expired", label: "Is Expired" },
          },
        },
      },
    },

    yt: {
      label: "Yield Token (YT)",
      userSpecifiedAddress: true,
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
      abi: JSON.stringify([
        {
          type: "function",
          name: "balanceOf",
          stateMutability: "view",
          inputs: [{ name: "account", type: "address" }],
          outputs: [{ name: "", type: "uint256" }],
        },
        {
          type: "event",
          name: "Mint",
          inputs: [
            { name: "caller", type: "address", indexed: true },
            { name: "receiverPT", type: "address", indexed: true },
            { name: "receiverYT", type: "address", indexed: true },
            { name: "amountSyToMint", type: "uint256", indexed: false },
            { name: "amountPYOut", type: "uint256", indexed: false },
          ],
        },
        {
          type: "event",
          name: "Burn",
          inputs: [
            { name: "caller", type: "address", indexed: true },
            { name: "receiver", type: "address", indexed: true },
            { name: "amountPYToRedeem", type: "uint256", indexed: false },
            { name: "amountSyOut", type: "uint256", indexed: false },
          ],
        },
        {
          type: "event",
          name: "RedeemRewards",
          inputs: [{ name: "user", type: "address", indexed: true }],
        },
        {
          type: "event",
          name: "RedeemInterest",
          inputs: [
            { name: "user", type: "address", indexed: true },
            { name: "interestOut", type: "uint256", indexed: false },
          ],
        },
      ]),
      overrides: {
        balanceOf: {
          slug: "get-yt-balance",
          label: "Get YT Balance",
          description: "Check the Yield Token balance of an address",
          inputs: {
            account: { label: "Wallet Address" },
          },
          outputs: {
            result: { name: "balance", label: "YT Balance", decimals: 18 },
          },
        },
      },
      events: {
        Mint: {
          slug: "yt-mint",
          label: "PT/YT Minted",
          description:
            "Fires when SY is split into PT and YT via the Yield Token contract",
        },
        Burn: {
          slug: "yt-burn",
          label: "PT/YT Redeemed",
          description:
            "Fires when PT and YT are merged back into SY via the Yield Token contract",
        },
        RedeemRewards: {
          slug: "redeem-rewards",
          label: "Rewards Redeemed",
          description:
            "Fires when a user claims accrued rewards from a Yield Token position",
        },
        RedeemInterest: {
          slug: "redeem-interest",
          label: "Interest Redeemed",
          description:
            "Fires when a user claims accrued interest from a Yield Token position",
        },
      },
    },

    sy: {
      label: "Standardized Yield (SY)",
      userSpecifiedAddress: true,
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
          name: "exchangeRate",
          stateMutability: "view",
          inputs: [],
          outputs: [{ name: "", type: "uint256" }],
        },
      ]),
      overrides: {
        balanceOf: {
          slug: "get-sy-balance",
          label: "Get SY Balance",
          description:
            "Check the Standardized Yield token balance of an address",
          inputs: {
            account: { label: "Wallet Address" },
          },
          outputs: {
            result: { name: "balance", label: "SY Balance", decimals: 18 },
          },
        },
        exchangeRate: {
          slug: "get-sy-exchange-rate",
          label: "Get SY Exchange Rate",
          description:
            "Get the current exchange rate between SY and its underlying asset",
          outputs: {
            result: {
              name: "exchangeRate",
              label: "Exchange Rate",
              decimals: 18,
            },
          },
        },
      },
    },
  },
});
