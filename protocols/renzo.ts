import { defineAbiProtocol } from "@/lib/protocol-registry";
import { type ProtocolTestData, wallet } from "@/lib/test-data/types";
import renzoEzEthAbi from "./abis/renzo-ezeth.json";
import renzoRestakeManagerAbi from "./abis/renzo-restake-manager.json";

// Renzo is a liquid restaking protocol on Ethereum mainnet: native ETH is
// restaked through EigenLayer and the depositor receives ezETH, a
// yield-bearing receipt for the restaked position.
//
// This first cut exposes the RestakeManager's native-ETH deposit plus the
// reads a workflow needs in order to gate or value that position: the
// protocol's deposit pause flag, and ezETH balance and total supply.
// Without them a builder falls back to a raw web3/write-contract node with a
// hand-pasted ABI fragment, and loses the on-chain coverage every registered
// protocol gets.
//
// Mainnet-only (chain 1). Minting settles on the beacon chain; the L2 ezETH
// variants are bridged receipts, not mintable here.
//
// Deliberately left alone, correct with these reverted:
// - Native-ETH deposits only (`depositETH`). The ERC20-collateral deposit
//   overloads take a different token and allowance path; they are a separate
//   surface.
// - No withdrawal action. Renzo withdrawals are a request queue that settles
//   asynchronously, a distinct surface that can ship separately later.

const RENZO_DOCS =
  "https://docs.renzoprotocol.com/docs/contracts/ethereum-mainnet";

const TEST_DATA: ProtocolTestData = {
  "1": {
    setup: {
      minNativeHuman: "0.01",
      requiredTokens: [],
      approvals: [],
    },
    actions: {
      "deposits-paused": {},
      "balance-of": { account: wallet() },
      "total-supply": {},
      // depositETH is payable and takes no arguments: ETH in, ezETH out to
      // the sending address. ethValue is the builder's virtual msg.value key
      // for payable actions.
      deposit: { ethValue: "0.01" },
    },
    // paused() gates every deposit path through the notPaused modifier, which
    // ORs the contract flag with riskOracleMiddleware.depositPaused(). A
    // false reading is what the shipped deposit action assumes; a flip to
    // true means that action is failing for users, so a red suite here is
    // signal rather than flake.
    expectations: {
      "deposits-paused": [{ equals: "false" }],
      "total-supply": [{ field: "totalSupply", nonZero: true }],
    },
    // Simulation-tier post-write oracle: a deposit must actually credit
    // ezETH. A mined receipt alone would miss a deposit that is accepted but
    // mints nothing.
    writeExpectations: {
      deposit: [
        { read: "balance-of", expect: { field: "balance", nonZero: true } },
      ],
    },
  },
};

export default defineAbiProtocol({
  name: "Renzo",
  slug: "renzo",
  description:
    "Liquid restaking on Ethereum mainnet. Deposit native ETH into the RestakeManager to mint ezETH, and read the deposit pause state plus ezETH balances and supply.",
  website: "https://www.renzoprotocol.com",
  icon: "/protocols/renzo.png",

  testData: TEST_DATA,

  contracts: {
    restakeManager: {
      label: "Renzo Restake Manager",
      abi: JSON.stringify(renzoRestakeManagerAbi),
      addresses: {
        "1": "0x74a09653A083691711cF8215a6ab074BB4e99ef5",
      },
      overrides: {
        depositETH: {
          slug: "deposit",
          label: "Deposit ETH for ezETH",
          description:
            "Deposit native ETH into Renzo and mint ezETH to the sending address. Send ETH value with the transaction; the contract mints ezETH against the deposited value.",
          docUrl: RENZO_DOCS,
        },
        paused: {
          slug: "deposits-paused",
          label: "Check Deposit Pause Status",
          description:
            "Read whether the RestakeManager has deposits paused. Useful as a gate in a workflow to skip deposit actions while the contract is paused.",
          docUrl: RENZO_DOCS,
          outputs: {
            result: {
              name: "paused",
              label: "Deposits Paused",
            },
          },
        },
      },
    },
    ezEth: {
      label: "ezETH Token",
      abi: JSON.stringify(renzoEzEthAbi),
      addresses: {
        "1": "0xbf5495Efe5DB9ce00f80364C8B423567e58d2110",
      },
      overrides: {
        balanceOf: {
          slug: "balance-of",
          label: "Get ezETH Balance",
          description:
            "Read the ezETH balance held by an address. ezETH is Renzo's liquid restaking receipt for ETH restaked through EigenLayer.",
          docUrl: RENZO_DOCS,
          inputs: {
            account: {
              label: "Wallet Address",
              helpTip: "Address whose ezETH balance is read.",
              docUrl: RENZO_DOCS,
            },
          },
          outputs: {
            result: {
              name: "balance",
              label: "ezETH Balance (wei)",
              decimals: 18,
            },
          },
        },
        totalSupply: {
          slug: "total-supply",
          label: "Get ezETH Total Supply",
          description:
            "Read the total supply of ezETH in circulation. A non-zero reading is a liveness check on the token contract.",
          docUrl: RENZO_DOCS,
          outputs: {
            result: {
              name: "totalSupply",
              label: "ezETH Total Supply (wei)",
              decimals: 18,
            },
          },
        },
      },
    },
  },
});
