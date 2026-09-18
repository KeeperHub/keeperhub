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

const WITHDRAWAL_QUEUE_ABI = JSON.stringify([
  {
    type: "function",
    name: "requestWithdrawals",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_amounts", type: "uint256[]" },
      { name: "_owner", type: "address" },
    ],
    outputs: [{ name: "requestIds", type: "uint256[]" }],
  },
  {
    type: "function",
    name: "requestWithdrawalsWstETH",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_amounts", type: "uint256[]" },
      { name: "_owner", type: "address" },
    ],
    outputs: [{ name: "requestIds", type: "uint256[]" }],
  },
  {
    type: "function",
    name: "getWithdrawalRequests",
    stateMutability: "view",
    inputs: [{ name: "_owner", type: "address" }],
    outputs: [{ name: "requestsIds", type: "uint256[]" }],
  },
  {
    type: "function",
    name: "getWithdrawalStatus",
    stateMutability: "view",
    inputs: [{ name: "_requestIds", type: "uint256[]" }],
    outputs: [
      {
        name: "statuses",
        type: "tuple[]",
        components: [
          { name: "amountOfStETH", type: "uint256" },
          { name: "amountOfShares", type: "uint256" },
          { name: "owner", type: "address" },
          { name: "timestamp", type: "uint256" },
          { name: "isFinalized", type: "bool" },
          { name: "isClaimed", type: "bool" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getLastCheckpointIndex",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "lastCheckpointIndex", type: "uint256" }],
  },
  {
    type: "function",
    name: "findCheckpointHints",
    stateMutability: "view",
    inputs: [
      { name: "_requestIds", type: "uint256[]" },
      { name: "_firstIndex", type: "uint256" },
      { name: "_lastIndex", type: "uint256" },
    ],
    outputs: [{ name: "hints", type: "uint256[]" }],
  },
  {
    type: "function",
    name: "getClaimableEther",
    stateMutability: "view",
    inputs: [
      { name: "_requestIds", type: "uint256[]" },
      { name: "_hints", type: "uint256[]" },
    ],
    outputs: [{ name: "claimableEther", type: "uint256[]" }],
  },
  {
    type: "function",
    name: "claimWithdrawals",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_requestIds", type: "uint256[]" },
      { name: "_hints", type: "uint256[]" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "WithdrawalRequested",
    inputs: [
      { name: "requestId", type: "uint256", indexed: true },
      { name: "requestor", type: "address", indexed: true },
      { name: "owner", type: "address", indexed: true },
      { name: "amountOfStETH", type: "uint256", indexed: false },
      { name: "amountOfShares", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "WithdrawalsFinalized",
    inputs: [
      { name: "from", type: "uint256", indexed: true },
      { name: "to", type: "uint256", indexed: true },
      { name: "amountOfETHLocked", type: "uint256", indexed: false },
      { name: "sharesToBurn", type: "uint256", indexed: false },
      { name: "timestamp", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "WithdrawalClaimed",
    inputs: [
      { name: "requestId", type: "uint256", indexed: true },
      { name: "owner", type: "address", indexed: true },
      { name: "receiver", type: "address", indexed: true },
      { name: "amountOfETH", type: "uint256", indexed: false },
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
        requiredTokens: [{ symbol: "WSTETH", human: "1" }],
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
        "request-withdrawals": {
          amounts: '["1000000000000000000"]',
          owner: wallet(),
        },
        "request-withdrawals-wsteth": {
          amounts: '["1000000000000000000"]',
          owner: wallet(),
        },
        "get-withdrawal-requests": { owner: wallet() },
        "get-last-checkpoint-index": {},
        "get-withdrawal-status": { requestIds: '["135184"]' },
        "find-checkpoint-hints": {
          requestIds: '["135184"]',
          firstIndex: "1",
          lastIndex: "1216",
        },
        "get-claimable-ether": {
          requestIds: '["135184"]',
          hints: '["1216"]',
        },
        "claim-withdrawals": {
          requestIds: '["135184"]',
          hints: '["1216"]',
        },
      },
      skipped: {
        wrap: "requires stETH balance - not provisioned in fork setup (stETH's share-derived balanceOf defeats slot fabrication; needs a whale entry)",
        unwrap:
          "requires wstETH balance - not provisioned in fork setup (wrap is skipped, so no wstETH position exists)",
        "request-withdrawals":
          "requires a separately approved stETH balance; the focused fixture provisions wstETH for the canonical queue write instead",
        "request-withdrawals-wsteth":
          "requires an approval of the Withdrawal Queue after the fixture's wstETH funding step; added once the queue request receipt is covered",
        "claim-withdrawals":
          "requires an oracle-finalized request owned by the test wallet; unit tests cover the owner-only ABI shape",
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
        // get-withdrawal-requests is intentionally liveness-only: the shared
        // test wallet does not own a durable queue NFT at the pinned block, so
        // an empty array is a valid response.
        "get-withdrawal-status": [{ field: "statuses", notEmpty: true }],
        "get-last-checkpoint-index": [
          { field: "lastCheckpointIndex", nonZero: true },
        ],
        "find-checkpoint-hints": [{ field: "hints", notEmpty: true }],
        "get-claimable-ether": [{ field: "claimableEther", notEmpty: true }],
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
      events: {
        skipped: {
          "withdrawal-requested":
            "requires a funded and approved stETH or wstETH balance for the Withdrawal Queue on the mainnet fork",
          "withdrawals-finalized":
            "requires Lido oracle finalization privileges and a funded finalization transaction",
          "withdrawal-claimed":
            "requires an oracle-finalized withdrawal NFT owned by the fork test wallet",
        },
      },
    },
  },

  contracts: {
    withdrawalQueue: {
      label: "Lido Withdrawal Queue",
      abi: WITHDRAWAL_QUEUE_ABI,
      addresses: {
        // Ethereum Mainnet -- proxy
        "1": "0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1",
      },
      overrides: {
        requestWithdrawals: {
          slug: "request-withdrawals",
          label: "Request stETH Withdrawal",
          description:
            "Lock one or more stETH amounts in Lido's queue and mint the withdrawal NFT to the specified owner.",
          inputs: {
            _amounts: {
              name: "amounts",
              label: "stETH Amounts (wei)",
              helpTip:
                "Approve the Lido Withdrawal Queue as the stETH spender before running this request.",
            },
            _owner: {
              name: "owner",
              label: "Withdrawal NFT Owner",
              helpTip:
                "Use the executing wallet if this workflow will also claim the withdrawal later.",
            },
          },
        },
        requestWithdrawalsWstETH: {
          slug: "request-withdrawals-wsteth",
          label: "Request wstETH Withdrawal",
          description:
            "Lock one or more wstETH amounts in Lido's queue and mint the withdrawal NFT to the specified owner.",
          inputs: {
            _amounts: {
              name: "amounts",
              label: "wstETH Amounts (wei)",
              helpTip:
                "Add a web3/approve-token step for the Lido Withdrawal Queue before running this request.",
            },
            _owner: {
              name: "owner",
              label: "Withdrawal NFT Owner",
              helpTip:
                "Use the executing wallet if this workflow will also claim the withdrawal later.",
            },
          },
        },
        getWithdrawalRequests: {
          slug: "get-withdrawal-requests",
          label: "Get Withdrawal Requests",
          description: "List withdrawal request IDs owned by an address.",
          inputs: { _owner: { name: "owner", label: "Withdrawal NFT Owner" } },
          outputs: {
            requestsIds: {
              label: "Withdrawal Request IDs",
            },
          },
        },
        getWithdrawalStatus: {
          slug: "get-withdrawal-status",
          label: "Get Withdrawal Status",
          description:
            "Read the owner, locked amount, and finalization state for withdrawal request IDs.",
          inputs: { _requestIds: { name: "requestIds", label: "Request IDs" } },
          outputs: {
            statuses: {
              label: "Withdrawal Statuses (stETH and share amounts are wei)",
            },
          },
        },
        getLastCheckpointIndex: {
          slug: "get-last-checkpoint-index",
          label: "Get Last Checkpoint Index",
          description:
            "Read the final checkpoint index used to calculate claim hints.",
          outputs: {
            lastCheckpointIndex: {
              label: "Last Checkpoint Index",
            },
          },
        },
        findCheckpointHints: {
          slug: "find-checkpoint-hints",
          label: "Find Withdrawal Checkpoint Hints",
          description: "Calculate claim hints for withdrawal request IDs.",
          inputs: {
            _requestIds: { name: "requestIds", label: "Request IDs" },
            _firstIndex: {
              name: "firstIndex",
              label: "First Checkpoint Index",
            },
            _lastIndex: { name: "lastIndex", label: "Last Checkpoint Index" },
          },
          outputs: {
            hints: {
              label: "Checkpoint Hints",
            },
          },
        },
        getClaimableEther: {
          slug: "get-claimable-ether",
          label: "Get Claimable ETH",
          description:
            "Read the ETH currently claimable for finalized withdrawal requests.",
          inputs: {
            _requestIds: { name: "requestIds", label: "Request IDs" },
            _hints: { name: "hints", label: "Checkpoint Hints" },
          },
          outputs: {
            claimableEther: {
              label: "Claimable ETH Amounts (wei)",
              decimals: 18,
            },
          },
        },
        claimWithdrawals: {
          slug: "claim-withdrawals",
          label: "Claim Finalized Withdrawals",
          description:
            "Claim finalized requests to the request owner. This action has no arbitrary recipient field.",
          inputs: {
            _requestIds: { name: "requestIds", label: "Request IDs" },
            _hints: { name: "hints", label: "Checkpoint Hints" },
          },
        },
      },
      events: {
        WithdrawalRequested: {
          slug: "withdrawal-requested",
          label: "Withdrawal Requested",
          description: "Fires when Lido creates a withdrawal request NFT.",
        },
        WithdrawalsFinalized: {
          slug: "withdrawals-finalized",
          label: "Withdrawals Finalized",
          description:
            "Fires when a range of Lido withdrawal requests becomes claimable.",
        },
        WithdrawalClaimed: {
          slug: "withdrawal-claimed",
          label: "Withdrawal Claimed",
          description: "Fires when a finalized withdrawal request is claimed.",
        },
      },
    },
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
