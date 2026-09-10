import { defineAbiProtocol } from "@/lib/protocol-registry";
import { type ProtocolTestData, wallet } from "@/lib/test-data/types";
import ezethAbi from "./abis/renzo-ezeth.json";
import restakeManagerAbi from "./abis/renzo-restake-manager.json";

// Renzo is a liquid restaking protocol on Ethereum. Deposit native ETH into
// the RestakeManager to mint ezETH, a non-rebasing restaked-ETH token whose
// value accrues against ETH as staking and EigenLayer restaking rewards come
// in. This is a sibling to the ether.fi, Lido, Rocket Pool and Frax Ether
// integrations already in the registry.
//
// Two mainnet contracts, verified on 2026-09-10 by reading them over a public
// RPC:
//   - ezETH name "Renzo Restaked ETH", symbol ezETH, 18 decimals, ~41,324 ETH
//     supply.
//   - RestakeManager.paused() returned false, and renzoOracle() returned a
//     live oracle address, confirming the manager is the active deployment.
//
// This first cut exposes the native-ETH deposit path (depositETH), the
// paused gate, and the ezETH balance and supply reads. The ERC20-collateral
// deposit variants and the withdrawal queue are separate surfaces deferred to
// a follow-up. Mainnet only: minting settles on the beacon chain.

const RENZO_DOCS = "https://docs.renzoprotocol.com";

const TEST_DATA: ProtocolTestData = {
  "1": {
    setup: {
      minNativeHuman: "0.02",
      requiredTokens: [],
      approvals: [],
    },
    actions: {
      // depositETH() reverts while the manager is paused; the read gates it.
      paused: {},
      "ez-balance-of": { account: wallet() },
      "ez-total-supply": {},
      // Write: stake native ETH for ezETH.
      stake: { ethValue: "0.02" },
    },
    skipped: {
      // depositETH mints ezETH ~pro-rata to TVL; on a fork with no prior
      // Renzo state the mint can round to zero for a tiny deposit, so the
      // credit is asserted by the write-expectation rather than a fixed
      // amount.
    },
    // paused() is false on mainnet as of 2026-09-10; a flip to true is an
    // emergency stop that would make the stake action fail for users, so a red
    // suite there is signal. Total supply is five figures of ETH; zero means
    // the read decoded garbage.
    expectations: {
      paused: [{ equals: "false" }],
      "ez-total-supply": [{ field: "totalSupply", nonZero: true }],
    },
    // Simulation-tier post-write oracle: staking must actually credit ezETH.
    // nonZero is history-safe on a long-lived fork.
    writeExpectations: {
      stake: [
        {
          read: "ez-balance-of",
          expect: { field: "balance", nonZero: true },
        },
      ],
    },
  },
};

export default defineAbiProtocol({
  name: "Renzo",
  slug: "renzo",
  description:
    "Liquid restaking on Ethereum. Deposit ETH to mint ezETH, a non-rebasing restaked-ETH token earning staking plus EigenLayer restaking rewards, and read the pause gate and ezETH balances.",
  website: "https://www.renzoprotocol.com",
  icon: "/protocols/renzo.png",

  testData: TEST_DATA,

  contracts: {
    restakeManager: {
      label: "Renzo Restake Manager",
      abi: JSON.stringify(restakeManagerAbi),
      addresses: {
        "1": "0x74a09653A083691711cF8215a6ab074BB4e99ef5",
      },
      overrides: {
        depositETH: {
          slug: "stake",
          label: "Stake ETH for ezETH",
          description:
            "Deposit native ETH into the Renzo Restake Manager and mint ezETH to the sending address. Send ETH value with the transaction; the manager returns ezETH tracking the deposit plus staking and restaking rewards.",
          docUrl: RENZO_DOCS,
        },
        paused: {
          slug: "paused",
          label: "Check Deposit Pause Status",
          description:
            "Read whether the Renzo Restake Manager is paused. Useful as a gate in a workflow to skip the stake action when deposits are halted.",
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
    ezeth: {
      label: "ezETH Token",
      abi: JSON.stringify(ezethAbi),
      addresses: {
        "1": "0xbf5495Efe5DB9ce00f80364C8B423567e58d2110",
      },
      overrides: {
        balanceOf: {
          slug: "ez-balance-of",
          label: "Get ezETH Balance",
          description: "Check the ezETH balance of an address.",
          docUrl: RENZO_DOCS,
          inputs: {
            account: {
              label: "Wallet Address",
              helpTip: "Address whose ezETH balance will be read.",
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
          slug: "ez-total-supply",
          label: "Get ezETH Total Supply",
          description: "Get the total supply of ezETH in circulation.",
          docUrl: RENZO_DOCS,
          outputs: {
            result: {
              name: "totalSupply",
              label: "Total ezETH Supply (wei)",
              decimals: 18,
            },
          },
        },
      },
    },
  },
});
