import { defineAbiProtocol } from "@/lib/protocol-registry";
import { amount, native, wallet } from "@/lib/test-data/types";

const WSTETH_ABI = JSON.stringify([
  {
    type: "function",
    name: "wrap",
    stateMutability: "nonpayable",
    inputs: [{ name: "_stETHAmount", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "unwrap",
    stateMutability: "nonpayable",
    inputs: [{ name: "_wstETHAmount", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getStETHByWstETH",
    stateMutability: "view",
    inputs: [{ name: "_wstETHAmount", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getWstETHByStETH",
    stateMutability: "view",
    inputs: [{ name: "_stETHAmount", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "stEthPerToken",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "tokensPerStEth",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
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
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
]);

const STETH_ABI = JSON.stringify([
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "_account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_spender", type: "address" },
      { name: "_amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "event",
    name: "Submitted",
    inputs: [
      { name: "sender", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "referral", type: "address", indexed: false },
    ],
  },
]);

export default defineAbiProtocol({
  name: "Lido",
  slug: "lido",
  description:
    "Liquid staking for Ethereum: wrap stETH to wstETH, unwrap back, and query exchange rates",
  website: "https://lido.fi",
  icon: "/protocols/lido.png",

  testData: {
    "1": {
      setup: {
        minNativeHuman: "0.01",
        requiredTokens: [],
        approvals: [],
      },
      actions: {
        "get-steth-by-wsteth": { _wstETHAmount: amount("WSTETH", "1") },
        "get-wsteth-by-steth": { _stETHAmount: native("1") },
        "steth-per-token": {},
        "tokens-per-steth": {},
        "get-wsteth-balance": { account: wallet() },
        "get-wsteth-total-supply": {},
        "get-steth-balance": { account: wallet() },
        "approve-steth": { spender: wallet() },
      },
      skipped: {
        wrap: "requires stETH balance - not provisioned in fork setup (stETH's share-derived balanceOf defeats slot fabrication; needs a whale entry)",
        unwrap:
          "requires wstETH balance - not provisioned in fork setup (wrap is skipped, so no wstETH position exists)",
      },
      // Chain invariants (unnamed outputs, so no field): the wstETH<->stETH
      // exchange rates only ratchet up from 1e18, the 1-unit conversions are
      // pure rate reads, and wstETH total supply is nine figures - each being
      // zero means the read decoded garbage. The caller-balance reads
      // (get-wsteth-balance, get-steth-balance) are shared-wallet values and
      // left unasserted.
      expectations: {
        "steth-per-token": [{ nonZero: true }],
        "tokens-per-steth": [{ nonZero: true }],
        "get-steth-by-wsteth": [{ nonZero: true }],
        "get-wsteth-by-steth": [{ nonZero: true }],
        "get-wsteth-total-supply": [{ nonZero: true }],
      },
      // The Tier 2 app approve path attempts gas sponsorship, which is
      // unconfigured on the CI fork, then falls back to direct signing;
      // that confirmation can take minutes, past the default 120s wait.
      executionWaitMs: {
        "approve-steth": 240_000,
      },
      // stETH.submit stakes ETH for stETH and emits Submitted; the event
      // harness covers it with a targeted submit (needs only native gas,
      // unlike wrap/unwrap which stay skipped pending a stETH whale).
      events: {},
    },
  },

  contracts: {
    wsteth: {
      label: "wstETH (Wrapped stETH)",
      abi: WSTETH_ABI,
      addresses: {
        // Ethereum Mainnet
        "1": "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
        // Base
        "8453": "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452",
        // Sepolia Testnet
        "11155111": "0xB82381A3fBD3FaFA77B3a7bE693342618240067b",
      },
      overrides: {
        wrap: {
          label: "Wrap stETH to wstETH",
          description:
            "Wrap stETH tokens into non-rebasing wstETH (requires stETH approval first)",
          inputs: {
            _stETHAmount: { label: "stETH Amount (wei)" },
          },
        },
        unwrap: {
          label: "Unwrap wstETH to stETH",
          description:
            "Unwrap wstETH back to rebasing stETH at the current exchange rate",
          inputs: {
            _wstETHAmount: { label: "wstETH Amount (wei)" },
          },
        },
        getStETHByWstETH: {
          slug: "get-steth-by-wsteth",
          label: "Get stETH by wstETH",
          description:
            "Convert a wstETH amount to its equivalent stETH value at the current rate",
          inputs: {
            _wstETHAmount: { label: "wstETH Amount (wei)" },
          },
          outputs: {
            result: {
              name: "stETHAmount",
              label: "stETH Value (wei)",
              decimals: 18,
            },
          },
        },
        getWstETHByStETH: {
          slug: "get-wsteth-by-steth",
          label: "Get wstETH by stETH",
          description:
            "Convert a stETH amount to its equivalent wstETH value at the current rate",
          inputs: {
            _stETHAmount: { label: "stETH Amount (wei)" },
          },
          outputs: {
            result: {
              name: "wstETHAmount",
              label: "wstETH Value (wei)",
              decimals: 18,
            },
          },
        },
        stEthPerToken: {
          slug: "steth-per-token",
          label: "stETH Per Token (Exchange Rate)",
          description:
            "Get the current stETH value of 1 wstETH (exchange rate from wstETH to stETH)",
          outputs: {
            result: {
              name: "rate",
              label: "stETH per wstETH (wei)",
              decimals: 18,
            },
          },
        },
        tokensPerStEth: {
          slug: "tokens-per-steth",
          label: "wstETH Per stETH (Inverse Rate)",
          description:
            "Get the current wstETH value of 1 stETH (inverse exchange rate)",
          outputs: {
            result: {
              name: "rate",
              label: "wstETH per stETH (wei)",
              decimals: 18,
            },
          },
        },
        balanceOf: {
          slug: "get-wsteth-balance",
          label: "Get wstETH Balance",
          description: "Check the wstETH balance of an address",
          inputs: {
            account: { label: "Wallet Address" },
          },
          outputs: {
            result: {
              name: "balance",
              label: "wstETH Balance (wei)",
              decimals: 18,
            },
          },
        },
        totalSupply: {
          slug: "get-wsteth-total-supply",
          label: "Get wstETH Total Supply",
          description: "Get the total supply of wstETH tokens",
          outputs: {
            result: {
              name: "totalSupply",
              label: "Total wstETH Supply (wei)",
              decimals: 18,
            },
          },
        },
      },
    },
    steth: {
      label: "stETH (Lido Staked ETH)",
      abi: STETH_ABI,
      addresses: {
        // Ethereum Mainnet -- proxy
        "1": "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84",
        // Sepolia Testnet
        "11155111": "0x3e3FE7dBc6B4C189E7128855dD526361c49b40Af",
      },
      overrides: {
        approve: {
          slug: "approve-steth",
          label: "Approve stETH Spending",
          description:
            "Approve the wstETH contract (or another spender) to transfer stETH on your behalf",
          inputs: {
            _spender: { name: "spender", label: "Spender Address" },
            _amount: { name: "amount", label: "Approval Amount (wei)" },
          },
        },
        balanceOf: {
          slug: "get-steth-balance",
          label: "Get stETH Balance",
          description: "Check the stETH balance of an address",
          inputs: {
            _account: { name: "account", label: "Wallet Address" },
          },
          outputs: {
            result: {
              name: "balance",
              label: "stETH Balance (wei)",
              decimals: 18,
            },
          },
        },
      },
      events: {
        Submitted: {
          slug: "steth-submitted",
          label: "ETH Submitted for stETH",
          description: "Fires when ETH is submitted to Lido for stETH",
        },
      },
    },
  },
});
