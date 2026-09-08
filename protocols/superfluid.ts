import { defineAbiProtocol } from "@/lib/protocol-registry";
import {
  amount,
  fromSetupOutput,
  type ProtocolTestData,
  wallet,
} from "@/lib/test-data/types";

// KEEP-458 protocol-coverage test data. Ethereum mainnet (fork mode) uses
// the canonical DAI / DAIx pair: DAIx resolved from the on-chain Superfluid
// resolver ("supertokens.v1.DAIx", verified 2026-07-07) and funded via the
// existing DAI whale. DAIx was chosen over USDCx (whose upgrade() routes
// underlying into Sky savings and reliably runs out of gas under
// exact-estimate sends on an anvil fork) and over ETHx (a native super
// token: underlying is address(0), so the registry's wrap/unwrap actions
// - SuperToken.upgrade/downgrade - revert on it; funding would also need
// upgradeByETH, which is not a registry action).
const TEST_DATA: ProtocolTestData = {
  "1": {
    setup: {
      minNativeHuman: "0.001",
      // Mainnet governance sets DAIx's CFA minimum deposit to 69 DAI
      // (read from SuperfluidGovernance 2026-07-07): a create-flow at any
      // rate locks that much, so wrap 100 in setup - 10 (the sepolia
      // sizing) reverts with CFA_INSUFFICIENT_BALANCE.
      requiredTokens: [{ symbol: "DAI", human: "200" }],
      approvals: [
        // Wrap requires the SuperToken (DAIX) to spend underlying DAI.
        { token: "DAI", spender: "DAIX", human: "200" },
      ],
      protocolSteps: [
        {
          protocol: "superfluid",
          action: "wrap",
          inputs: {
            contractAddress: "DAIX",
            amount: amount("DAIX", "100"),
          },
        },
      ],
    },
    // GDA pool actions bind the pool the create-pool action deploys, piped in
    // via fromSetupOutput (see `captures` below). The fork simulation tier
    // predicts that address (eth_call of create-pool's calldata returns
    // (bool, address pool)) and runs these actions against it. The app
    // coverage tier cannot: its write step returns `result: undefined` with
    // no logs, so create-pool's pool address is not queryable from
    // workflow_execution_logs.output_raw the way a read's structured result
    // is - surfacing it needs an executor change. Until then these stay in
    // skippedCoverage (app tier skips, fork tier runs).
    captures: {
      "create-pool": { kind: "gda-pool", as: "create-pool", field: "pool" },
    },
    skippedCoverage: {
      "update-member-units":
        "app tier cannot capture create-pool's pool address (executor write output); piped and run in the fork tier",
      distribute:
        "app tier cannot capture create-pool's pool address (executor write output); piped and run in the fork tier",
      "distribute-flow":
        "app tier cannot capture create-pool's pool address (executor write output); piped and run in the fork tier",
      "connect-pool":
        "app tier cannot capture create-pool's pool address (executor write output); piped and run in the fork tier",
    },
    actions: {
      // Reads. get-flow reads the wallet -> sink flow the write fixtures
      // manage, so the post-write oracles below can assert on it (before
      // create-flow it reads as all-zero, which is fine for liveness).
      "get-flow": {
        token: "DAIX",
        sender: wallet(),
        receiver: "0x000000000000000000000000000000000000dEaD",
      },
      // superToken contract is userSpecifiedAddress: pass `contractAddress`.
      "get-super-token-balance": {
        contractAddress: "DAIX",
        account: wallet(),
      },
      "get-underlying-token": { contractAddress: "DAIX" },
      "get-cfa-net-flow": {
        token: "DAIX",
        account: wallet(),
      },
      "get-net-flow": {
        token: "DAIX",
        account: wallet(),
      },
      // Writes -- wallet -> burn address. Superfluid CFA reverts with
      // CFA_NO_SELF_FLOW (0xa47338ef) when sender == receiver, so self-streams
      // aren't usable. 0x...dEaD is a stable, contract-free sink: streaming a
      // few wei/sec there costs only the SuperToken buffer (69 DAI minimum
      // deposit on mainnet, returned on delete-flow). Sender stays as the
      // test wallet so create/update/delete operate on the same flow row.
      "create-flow": {
        token: "DAIX",
        sender: wallet(),
        receiver: "0x000000000000000000000000000000000000dEaD",
        flowRate: "1",
        userData: "0x",
      },
      "update-flow": {
        token: "DAIX",
        sender: wallet(),
        receiver: "0x000000000000000000000000000000000000dEaD",
        flowRate: "2",
        userData: "0x",
      },
      "delete-flow": {
        token: "DAIX",
        sender: wallet(),
        receiver: "0x000000000000000000000000000000000000dEaD",
        userData: "0x",
      },
      // SuperToken is userSpecifiedAddress: pass contractAddress explicitly.
      wrap: {
        contractAddress: "DAIX",
        amount: amount("DAIX", "1"),
      },
      unwrap: {
        contractAddress: "DAIX",
        amount: amount("DAIX", "1"),
      },
      // GDA pool actions. `pool` is piped from the create-pool action via
      // fromSetupOutput: the fork tier captures the deployed pool address
      // (see `captures`) and resolves it here. On the app tier these are in
      // skippedCoverage, so the binding resolves to an unused placeholder and
      // is never executed.
      "create-pool": {
        token: "DAIX",
        admin: wallet(),
        // bools transferabilityForUnitsOwner / distributionFromAnyAddress
        // have `default: "false"` in the protocol def; the resolver picks
        // those up automatically.
      },
      "update-member-units": {
        pool: fromSetupOutput("create-pool", "pool"),
        member: wallet(),
        units: "1",
        userData: "0x",
      },
      distribute: {
        token: "DAIX",
        from: wallet(),
        pool: fromSetupOutput("create-pool", "pool"),
        amount: amount("DAIX", "1"),
        userData: "0x",
      },
      "distribute-flow": {
        token: "DAIX",
        from: wallet(),
        pool: fromSetupOutput("create-pool", "pool"),
        flowRate: "1",
        userData: "0x",
      },
      "connect-pool": {
        pool: fromSetupOutput("create-pool", "pool"),
        userData: "0x",
      },
      // CFA flow-operator permissions: grant the burn address full permissions
      // on DAIX. Self-operator (flowOperator == msg.sender) reverts with a
      // CFA forwarder ACL custom error; using a stable sink address sidesteps
      // it without affecting any real account.
      "grant-flow-operator": {
        token: "DAIX",
        flowOperator: "0x000000000000000000000000000000000000dEaD",
        permissions: "7", // CREATE | UPDATE | DELETE = 1 | 2 | 4
        flowRateAllowance: "1",
      },
    },
    // Cold first-touch fan-out through the fork upstream: the GDA pool
    // factory and the CFA ACL surfaces exceed the default two-minute
    // execution wait on a fresh fork (measured: still running at 120s,
    // full CFA lifecycle green in seconds once warm). Warmed fork caches
    // make these overrides irrelevant; until then give them headroom.
    executionWaitMs: {
      "grant-flow-operator": 420_000,
      "create-pool": 420_000,
    },
    expectations: {
      // Setup wraps 100 DAIx for the wallet; on a long-lived fork the
      // balance only accumulates across runs, so nonZero is history-safe.
      "get-super-token-balance": [{ nonZero: true }],
      // Long-lived chain invariant: DAIx always wraps canonical DAI.
      "get-underlying-token": [
        { equals: "0x6B175474E89094C44Da98b954EedeAC495271d0F" },
      ],
    },
    // Simulation-tier post-write oracles: a mined receipt alone cannot
    // prove the flow actually opened or closed. get-flow reads the same
    // wallet -> sink pair the write fixtures bind.
    writeExpectations: {
      "create-flow": [
        { read: "get-flow", expect: { field: "flowRate", nonZero: true } },
      ],
      // update-flow runs after create-flow and before delete-flow, so the
      // flow is still open with a nonzero rate when its probe reads.
      "update-flow": [
        { read: "get-flow", expect: { field: "flowRate", nonZero: true } },
      ],
      "delete-flow": [
        { read: "get-flow", expect: { field: "flowRate", equals: "0" } },
      ],
      // wrap upgrades DAI into DAIx, crediting the super-token balance (the
      // read has no field - the balance output is unnamed). nonZero is
      // history-safe: the balance only grows across runs.
      wrap: [{ read: "get-super-token-balance", expect: { nonZero: true } }],
    },
  },
};

/**
 * Chain IDs (as strings, matching ProtocolContract.addresses keys) where the
 * Superfluid CFAv1 and GDAv1 forwarders are deployed.
 *
 * Adding a chain: append its ID here. Both forwarders pick it up automatically
 * via sameOnAllChains() because Superfluid pins both forwarders to identical
 * addresses on every chain currently in SUPERFLUID_CHAIN_IDS. This is NOT
 * universal across all chains Superfluid supports -- Avalanche Fuji (43113)
 * uses a different CFAv1Forwarder address. The unit test in
 * tests/unit/superfluid-protocol.test.ts cross-checks every chain here
 * against @superfluid-finance/metadata and will fail if a chain whose
 * forwarders deviate is added without replacing sameOnAllChains() with a
 * per-chain map.
 */
export const SUPERFLUID_CHAIN_IDS = [
  "1", // Ethereum Mainnet
  "10", // Optimism
  "56", // BNB Smart Chain
  "137", // Polygon
  "8453", // Base
  "42161", // Arbitrum One
  "43114", // Avalanche C-Chain
  "11155111", // Sepolia
] as const;

/**
 * Build the per-chain address map for a contract that's deployed at the same
 * address on every chain in SUPERFLUID_CHAIN_IDS. Both forwarders use this --
 * Superfluid intentionally pins them to identical addresses cross-chain.
 */
function sameOnAllChains(address: string): Record<string, string> {
  return Object.fromEntries(SUPERFLUID_CHAIN_IDS.map((id) => [id, address]));
}

const FLOW_RATE_HELP =
  "Wei per second (int96). 1 USDCx/month is approximately 385,802,469,135 wei/s at 18 decimals. Computed: amount * 10^decimals / seconds.";

const CREATE_FLOW_RATE_HELP = `${FLOW_RATE_HELP} Sender needs at least ~3 hours of stream value as a deposit; verify with get-super-token-balance before opening the stream.`;

/**
 * CFAv1Forwarder address. Pinned identical across every chain in
 * SUPERFLUID_CHAIN_IDS by Superfluid's deployment design.
 */
export const CFA_FORWARDER_ADDRESS =
  "0xcfA132E353cB4E398080B9700609bb008eceB125";

// Write functions return bool success. Strip outputs to avoid deriving a
// spurious "Result" output field -- the current action schema has no outputs
// on CFA/GDA write actions.
const CFA_FORWARDER_ABI = JSON.stringify([
  {
    type: "function",
    name: "createFlow",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "sender", type: "address" },
      { name: "receiver", type: "address" },
      { name: "flowRate", type: "int96" },
      { name: "userData", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "updateFlow",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "sender", type: "address" },
      { name: "receiver", type: "address" },
      { name: "flowRate", type: "int96" },
      { name: "userData", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "deleteFlow",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "sender", type: "address" },
      { name: "receiver", type: "address" },
      { name: "userData", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getFlowInfo",
    stateMutability: "view",
    inputs: [
      { name: "token", type: "address" },
      { name: "sender", type: "address" },
      { name: "receiver", type: "address" },
    ],
    outputs: [
      { name: "lastUpdated", type: "uint256" },
      { name: "flowRate", type: "int96" },
      { name: "deposit", type: "uint256" },
      { name: "owedDeposit", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "getAccountFlowrate",
    stateMutability: "view",
    inputs: [
      { name: "token", type: "address" },
      { name: "account", type: "address" },
    ],
    outputs: [{ name: "", type: "int96" }],
  },
  {
    type: "function",
    name: "updateFlowOperatorPermissions",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "flowOperator", type: "address" },
      { name: "permissions", type: "uint8" },
      { name: "flowRateAllowance", type: "int96" },
    ],
    outputs: [],
  },
]);

/**
 * GDAv1Forwarder address. Pinned identical across every chain in
 * SUPERFLUID_CHAIN_IDS by Superfluid's deployment design.
 */
export const GDA_FORWARDER_ADDRESS =
  "0x6DA13Bde224A05a288748d857b9e7DDEffd1dE08";

// createPool returns (bool success, address pool) on-chain. Strip outputs to
// match the current action schema which shows no outputs for write actions.
const GDA_FORWARDER_ABI = JSON.stringify([
  {
    type: "function",
    name: "createPool",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "admin", type: "address" },
      {
        name: "config",
        type: "tuple",
        components: [
          { name: "transferabilityForUnitsOwner", type: "bool" },
          { name: "distributionFromAnyAddress", type: "bool" },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "updateMemberUnits",
    stateMutability: "nonpayable",
    inputs: [
      { name: "pool", type: "address" },
      { name: "member", type: "address" },
      { name: "units", type: "uint128" },
      { name: "userData", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "distribute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "from", type: "address" },
      { name: "pool", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "userData", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "distributeFlow",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "from", type: "address" },
      { name: "pool", type: "address" },
      { name: "flowRate", type: "int96" },
      { name: "userData", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "connectPool",
    stateMutability: "nonpayable",
    inputs: [
      { name: "pool", type: "address" },
      { name: "userData", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getNetFlow",
    stateMutability: "view",
    inputs: [
      { name: "token", type: "address" },
      { name: "account", type: "address" },
    ],
    outputs: [{ name: "", type: "int96" }],
  },
]);

const SUPER_TOKEN_ABI = JSON.stringify([
  {
    type: "function",
    name: "upgrade",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "downgrade",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
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
    name: "getUnderlyingToken",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
]);

// KEEP-458: the protocol-coverage test runner executes write actions in
// the order they appear in the ABI per contract, then contracts in the order
// they appear in `contracts`. The critical ordering constraints:
//   - update-flow MUST follow create-flow (cfaForwarder: createFlow before updateFlow)
//   - delete-flow MUST follow create-flow (cfaForwarder: createFlow before deleteFlow)
//   - wrap / unwrap operate on the SuperToken balance and are independent
//   - grant-flow-operator is independent
//   - create-pool is independent (the pool it creates is not consumed);
//     the remaining GDA pool actions (update-member-units/distribute/
//     distribute-flow/connect-pool) are in `skipped` so ordering doesn't
//     affect on-chain state.
export default defineAbiProtocol({
  name: "Superfluid",
  slug: "superfluid",
  description:
    "Programmable streaming payments: open per-second money streams between addresses, distribute pro-rata to pool members, and wrap/unwrap SuperTokens",
  website: "https://superfluid.org",
  icon: "/protocols/superfluid.png",

  contracts: {
    cfaForwarder: {
      label: "Superfluid CFAv1 Forwarder",
      abi: CFA_FORWARDER_ABI,
      addresses: sameOnAllChains(CFA_FORWARDER_ADDRESS),
      overrides: {
        createFlow: {
          label: "Open Money Stream",
          description:
            "Open a continuous wei/sec stream of a SuperToken from sender to receiver",
          inputs: {
            token: { label: "SuperToken Address" },
            sender: { label: "Sender Address" },
            receiver: { label: "Receiver Address" },
            flowRate: {
              label: "Flow Rate (wei/sec)",
              helpTip: CREATE_FLOW_RATE_HELP,
            },
            userData: { label: "User Data", default: "0x", advanced: true },
          },
        },
        updateFlow: {
          label: "Update Stream Rate",
          description:
            "Change the wei/sec rate of an existing stream. Use delete-flow to close a stream instead of setting rate to 0.",
          inputs: {
            token: { label: "SuperToken Address" },
            sender: { label: "Sender Address" },
            receiver: { label: "Receiver Address" },
            flowRate: {
              label: "New Flow Rate (wei/sec)",
              helpTip: FLOW_RATE_HELP,
            },
            userData: { label: "User Data", default: "0x", advanced: true },
          },
        },
        deleteFlow: {
          label: "Close Money Stream",
          description: "Close an open stream between sender and receiver",
          inputs: {
            token: { label: "SuperToken Address" },
            sender: { label: "Sender Address" },
            receiver: { label: "Receiver Address" },
            userData: { label: "User Data", default: "0x", advanced: true },
          },
        },
        getFlowInfo: {
          slug: "get-flow",
          label: "Read Flow Between Two Addresses",
          description:
            "Read the current flow rate, deposit, and last-updated timestamp for a stream between two addresses",
          inputs: {
            token: { label: "SuperToken Address" },
            sender: { label: "Sender Address" },
            receiver: { label: "Receiver Address" },
          },
          outputs: {
            lastUpdated: { label: "Last Updated (unix seconds)" },
            flowRate: { label: "Flow Rate (wei/sec)" },
            deposit: { label: "Deposit (wei)", decimals: 18 },
            owedDeposit: { label: "Owed Deposit (wei)", decimals: 18 },
          },
        },
        getAccountFlowrate: {
          slug: "get-cfa-net-flow",
          label: "Read CFA Net Flow Rate of an Address",
          description:
            "Read an address's net flow rate from CFA streams only (positive = net receiver, negative = net sender). Excludes GDA pool distributions. Use get-net-flow for the combined CFA+GDA reading.",
          inputs: {
            token: { label: "SuperToken Address" },
            account: { label: "Account Address" },
          },
          outputs: {
            result: {
              name: "flowRate",
              label: "CFA Net Flow Rate (wei/sec, signed)",
            },
          },
        },
        updateFlowOperatorPermissions: {
          slug: "grant-flow-operator",
          label: "Grant Flow-Operator Permissions",
          description:
            "Authorize another address to manage your flows of a SuperToken up to a wei/sec allowance",
          inputs: {
            token: { label: "SuperToken Address" },
            flowOperator: { label: "Flow Operator Address" },
            permissions: {
              label: "Permissions Bitmap",
              helpTip:
                "Bitmask: 1 = create, 2 = update, 4 = delete, 7 = all three. Combine via bitwise OR.",
            },
            flowRateAllowance: {
              label: "Flow Rate Allowance (wei/sec)",
              helpTip: FLOW_RATE_HELP,
            },
          },
        },
      },
    },
    gdaForwarder: {
      label: "Superfluid GDAv1 Forwarder",
      abi: GDA_FORWARDER_ABI,
      addresses: sameOnAllChains(GDA_FORWARDER_ADDRESS),
      overrides: {
        createPool: {
          label: "Create Distribution Pool",
          description:
            "Create a GDA distribution pool with the supplied address as administrator. The new pool address is emitted in the PoolCreated event. Chain a web3.query-events call after this action filtered by the returned tx hash to capture it.",
          inputs: {
            token: { label: "SuperToken Address" },
            admin: { label: "Pool Admin Address" },
            transferabilityForUnitsOwner: {
              label: "Transferability For Units Owner",
              default: "false",
              helpTip:
                "If true, members can transfer their pool units to other addresses. Most pools leave this false.",
            },
            distributionFromAnyAddress: {
              label: "Distribution From Any Address",
              default: "false",
              helpTip:
                "If true, any address can call distribute/distributeFlow into this pool. If false, only the pool admin can. Most pools leave this false.",
            },
          },
        },
        updateMemberUnits: {
          label: "Set Member Units in a Pool",
          description:
            "Set a recipient's pro-rata share in a distribution pool. New members must call connect-pool from their own wallet before they receive distributions.",
          inputs: {
            pool: { label: "Pool Address" },
            member: { label: "Member Address" },
            units: { label: "Units" },
            userData: { label: "User Data", default: "0x", advanced: true },
          },
        },
        distribute: {
          label: "Instant Distribution to a Pool",
          description:
            "Push a one-shot distribution into a pool. Amount divides pro-rata across members by their unit share.",
          inputs: {
            token: { label: "SuperToken Address" },
            from: { label: "Sender Address" },
            pool: { label: "Pool Address" },
            amount: { label: "Amount (wei)" },
            userData: { label: "User Data", default: "0x", advanced: true },
          },
        },
        distributeFlow: {
          label: "Stream Into a Pool",
          description:
            "Open a continuous stream into a pool. Members receive their pro-rata share by the second; updating member units changes the split in real time.",
          inputs: {
            token: { label: "SuperToken Address" },
            from: { label: "Sender Address" },
            pool: { label: "Pool Address" },
            flowRate: {
              label: "Flow Rate (wei/sec)",
              helpTip: FLOW_RATE_HELP,
            },
            userData: { label: "User Data", default: "0x", advanced: true },
          },
        },
        connectPool: {
          label: "Connect to a Pool (Member Opt-In)",
          description:
            "Members must call this from their own wallet to start receiving distributions. Without this, units exist but no money flows.",
          inputs: {
            pool: { label: "Pool Address" },
            userData: { label: "User Data", default: "0x", advanced: true },
          },
        },
        getNetFlow: {
          label: "Read Net Flow Rate of an Address",
          description:
            "Read an address's net flow rate for a SuperToken, combining CFA streams and GDA pool distributions (positive = net receiver, negative = net sender). Use get-cfa-net-flow if you need CFA-only.",
          inputs: {
            token: { label: "SuperToken Address" },
            account: { label: "Account Address" },
          },
          outputs: {
            result: {
              name: "flowRate",
              label: "Net Flow Rate (wei/sec, signed)",
            },
          },
        },
      },
    },
    superToken: {
      label: "Superfluid SuperToken",
      abi: SUPER_TOKEN_ABI,
      addresses: {},
      userSpecifiedAddress: true,
      overrides: {
        upgrade: {
          slug: "wrap",
          label: "Wrap to SuperToken",
          description:
            "Wrap an underlying ERC-20 amount into its SuperToken. Requires a prior web3.approve-token call against the SuperToken address.",
          inputs: {
            amount: { label: "Amount (wei)" },
          },
        },
        downgrade: {
          slug: "unwrap",
          label: "Unwrap from SuperToken",
          description:
            "Unwrap a SuperToken amount back to its underlying ERC-20",
          inputs: {
            amount: { label: "Amount (wei)" },
          },
        },
        balanceOf: {
          slug: "get-super-token-balance",
          label: "Get SuperToken Balance",
          description: "Read an address's current SuperToken balance",
          inputs: {
            account: { label: "Account Address" },
          },
          outputs: {
            result: {
              name: "balance",
              label: "Balance (wei)",
              decimals: 18,
            },
          },
        },
        getUnderlyingToken: {
          label: "Get Underlying ERC-20 Address",
          description:
            "Read the underlying ERC-20 address for this SuperToken (the token that gets escrowed when you wrap)",
          outputs: {
            result: {
              name: "underlying",
              label: "Underlying ERC-20 Address",
            },
          },
        },
      },
    },
  },

  testData: TEST_DATA,
});
