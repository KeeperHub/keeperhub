import { defineAbiProtocol } from "@/lib/protocol-registry";
import {
  amount,
  native,
  type ProtocolTestData,
  wallet,
} from "@/lib/test-data/types";

// The pool contract is userSpecifiedAddress; bind the canonical mainnet
// 3pool explicitly (same address as the registry fallback, which
// resolveContractAddress ignores for user-specified contracts).
const MAINNET_3POOL = "0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7";

const TEST_DATA: ProtocolTestData = {
  "1": {
    setup: {
      minNativeHuman: "0.01",
      // DAI funds the exchange (swap coin 0 -> coin 1) via the MCD_JOIN_DAI
      // whale, with a fabricated 3pool approval. remove-liquidity (needs 3CRV
      // LP) and crv-transfer (needs CRV) stay skipped pending those tokens.
      requiredTokens: [{ symbol: "DAI", human: "100" }],
      approvals: [],
      fabricatedApprovals: [
        { token: "DAI", spender: MAINNET_3POOL, human: "100" },
      ],
    },
    actions: {
      exchange: {
        contractAddress: MAINNET_3POOL,
        i: "0",
        j: "1",
        dx: amount("DAI", "10"),
        min_dy: "0",
      },
      "get-dy": {
        contractAddress: MAINNET_3POOL,
        i: "0",
        j: "1",
        dx: native("1"),
      },
      "get-virtual-price": { contractAddress: MAINNET_3POOL },
      "get-coin": { contractAddress: MAINNET_3POOL, arg0: "0" },
      "get-pool-balance": { contractAddress: MAINNET_3POOL, arg0: "0" },
      "calc-withdraw-one-coin": {
        contractAddress: MAINNET_3POOL,
        _token_amount: native("1"),
        i: "0",
      },
      "crv-balance-of": { account: wallet() },
      "crv-approve": { spender: wallet() },
      "crv-transfer": { to: wallet() },
      "remove-liquidity-one-coin": {},
    },
    skipped: {
      "remove-liquidity-one-coin": "requires LP token balance",
      "crv-transfer": "requires CRV balance",
    },
    // 3pool invariants (unnamed Vyper outputs, so no field): virtual price is
    // monotonic and >= 1e18, the 1-DAI get-dy quote and the one-coin withdraw
    // calc are always positive, coin 0 is a permanent address, and the pool
    // balance of coin 0 is large. crv-balance-of is a shared-wallet balance
    // (moved by other suites/fabrication) and left unasserted.
    expectations: {
      "get-virtual-price": [{ nonZero: true }],
      "get-dy": [{ nonZero: true }],
      "get-coin": [{ notEmpty: true }],
      "get-pool-balance": [{ nonZero: true }],
      "calc-withdraw-one-coin": [{ nonZero: true }],
    },
    // The Tier 2 app approve path attempts gas sponsorship, which is
    // unconfigured on the CI fork, then falls back to direct signing;
    // that confirmation can take minutes, past the default 120s wait.
    executionWaitMs: {
      "crv-approve": 240_000,
    },
  },
};

// Vyper-style snake_case function names mean camelToKebab produces "get_dy",
// not "get-dy". Every function therefore needs an explicit slug override.
// Input param names match the current action definitions for backward compat.
const POOL_ABI = JSON.stringify([
  {
    type: "function",
    name: "get_dy",
    stateMutability: "view",
    inputs: [
      { name: "i", type: "int128" },
      { name: "j", type: "int128" },
      { name: "dx", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "get_virtual_price",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "coins",
    stateMutability: "view",
    inputs: [{ name: "arg0", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "balances",
    stateMutability: "view",
    inputs: [{ name: "arg0", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "calc_withdraw_one_coin",
    stateMutability: "view",
    inputs: [
      { name: "_token_amount", type: "uint256" },
      { name: "i", type: "int128" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "exchange",
    stateMutability: "nonpayable",
    inputs: [
      { name: "i", type: "int128" },
      { name: "j", type: "int128" },
      { name: "dx", type: "uint256" },
      { name: "min_dy", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "remove_liquidity_one_coin",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_token_amount", type: "uint256" },
      { name: "i", type: "int128" },
      { name: "_min_amount", type: "uint256" },
    ],
    outputs: [],
  },
]);

const CRV_TOKEN_ABI = JSON.stringify([
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
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
]);

export default defineAbiProtocol({
  name: "Curve",
  slug: "curve",
  description:
    "Curve Finance: stableswap pools, token exchanges, liquidity management, and CRV token operations",
  website: "https://curve.fi",
  icon: "/protocols/curve.png",

  testData: TEST_DATA,

  contracts: {
    pool: {
      label: "Curve Pool",
      abi: POOL_ABI,
      userSpecifiedAddress: true,
      addresses: {
        // Ethereum Mainnet (3pool)
        "1": "0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7",
        // Base (4pool)
        "8453": "0x6e53131F68a034873b6bFA15502aF094Ef0c5854",
        // Arbitrum One (2CRV)
        "42161": "0x7f90122BF0700F9E7e1F688fe926940E8839F353",
        // Optimism (3pool)
        "10": "0x1337BedC9D22ecbe766dF105c9623922A27963EC",
      },
      overrides: {
        get_dy: {
          slug: "get-dy",
          label: "Get Expected Output",
          description:
            "Get the expected output amount for a token exchange in a Curve pool",
          inputs: {
            i: { label: "Input Coin Index" },
            j: { label: "Output Coin Index" },
            dx: { label: "Input Amount (wei)" },
          },
          outputs: {
            result: { name: "dy", label: "Expected Output (wei)" },
          },
        },
        get_virtual_price: {
          slug: "get-virtual-price",
          label: "Get Virtual Price",
          description: "Get the virtual price of the pool's LP token",
          outputs: {
            result: {
              name: "virtualPrice",
              label: "Virtual Price",
              decimals: 18,
            },
          },
        },
        coins: {
          slug: "get-coin",
          label: "Get Coin Address",
          description: "Get the token address at a specific index in the pool",
          inputs: {
            arg0: { label: "Coin Index" },
          },
          outputs: {
            result: { name: "coin", label: "Token Address" },
          },
        },
        balances: {
          slug: "get-pool-balance",
          label: "Get Pool Balance",
          description: "Get the pool's balance of a specific coin by index",
          inputs: {
            arg0: { label: "Coin Index" },
          },
          outputs: {
            result: { name: "balance", label: "Coin Balance (wei)" },
          },
        },
        calc_withdraw_one_coin: {
          slug: "calc-withdraw-one-coin",
          label: "Calculate Withdraw One Coin",
          description:
            "Calculate the amount received when withdrawing a single coin from the pool",
          inputs: {
            _token_amount: { label: "LP Token Amount (wei)" },
            i: { label: "Output Coin Index" },
          },
          outputs: {
            result: { name: "amount", label: "Withdraw Amount (wei)" },
          },
        },
        exchange: {
          label: "Exchange Tokens",
          description: "Swap tokens in a Curve pool",
          inputs: {
            i: { label: "Input Coin Index" },
            j: { label: "Output Coin Index" },
            dx: { label: "Input Amount (wei)" },
            min_dy: { label: "Minimum Output (wei)" },
          },
        },
        remove_liquidity_one_coin: {
          slug: "remove-liquidity-one-coin",
          label: "Remove Liquidity (Single Coin)",
          description: "Withdraw liquidity from a Curve pool as a single token",
          inputs: {
            _token_amount: { label: "LP Token Amount (wei)" },
            i: { label: "Output Coin Index" },
            _min_amount: { label: "Minimum Output (wei)" },
          },
        },
      },
    },
    crvToken: {
      label: "CRV Token",
      abi: CRV_TOKEN_ABI,
      addresses: {
        // Ethereum Mainnet
        "1": "0xD533a949740bb3306d119CC777fa900bA034cd52",
        // Arbitrum One
        "42161": "0x11cDb42B0EB46D95f990BeDD4695A6e3fA034978",
        // Optimism
        "10": "0x0994206dfE8De6Ec6920FF4D779B0d950605Fb53",
      },
      overrides: {
        balanceOf: {
          slug: "crv-balance-of",
          label: "Get CRV Balance",
          description: "Check CRV token balance of an address",
          inputs: { account: { label: "Wallet Address" } },
          outputs: {
            result: { name: "balance", label: "CRV Balance", decimals: 18 },
          },
        },
        approve: {
          slug: "crv-approve",
          label: "Approve CRV",
          description: "Approve an address to spend CRV tokens",
          inputs: {
            spender: { label: "Spender Address" },
            amount: { label: "Amount (wei)" },
          },
        },
        transfer: {
          slug: "crv-transfer",
          label: "Transfer CRV",
          description: "Transfer CRV tokens to an address",
          inputs: {
            to: { label: "Recipient Address" },
            amount: { label: "Amount (wei)" },
          },
        },
      },
    },
  },
});
