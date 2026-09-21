import { defineAbiProtocol } from "@/lib/protocol-registry";
import { type ProtocolTestData, wallet } from "@/lib/test-data/types";
import ezethAbi from "./abis/renzo-ezeth.json";
import restakeManagerAbi from "./abis/renzo-restake-manager.json";
import riskOracleMiddlewareAbi from "./abis/renzo-risk-oracle-middleware.json";

// Renzo is a liquid restaking protocol on Ethereum. Deposit native ETH into
// the RestakeManager to mint ezETH, a non-rebasing restaked-ETH token whose
// value accrues against ETH as staking and EigenLayer restaking rewards come
// in. This is a sibling to the Lido, Rocket Pool and Frax Ether integrations
// already in the registry.
//
// Three mainnet contracts, verified on 2026-09-10 and re-read on 2026-09-21 at
// block 26024442 over a public RPC:
//   - ezETH name "Renzo Restaked ETH", symbol ezETH, 18 decimals, ~41,324 ETH
//     supply.
//   - RestakeManager.paused() returned false, and renzoOracle() returned a
//     live oracle address, confirming the manager is the active deployment.
//   - RestakeManager.riskOracleMiddleware() returned
//     0x08921F17A32110F8df44A3d5007F2acd09Cfae6d, whose depositPaused()
//     returned false. See the deposit gate note below.
//
// The deposit gate is two conditions, not one. depositETH() carries the
// manager's notPaused modifier, which in the deployed implementation
// (0xd5b3be349ed0b7c82dbd9271ce3739a381fc7aa0, RestakeManager.sol:93, Sourcify
// exact_match) reads:
//
//   if (paused || riskOracleMiddleware.depositPaused()) revert ContractPaused();
//
// So the manager's own `paused` storage getter is half the gate. Renzo can halt
// deposits through the risk-oracle middleware with `paused` still false, and a
// workflow gated on the manager flag alone would decide deposits are open. Both
// halves are exposed as reads - `paused` and `deposit-paused` - and each action
// says in its own description that it is one of two conditions, so a gate that
// means "deposits are accepted" has to read both. `riskOracleMiddleware` is
// declared `immutable` on the manager (RestakeManager.sol:31), so the address
// below can only move with a manager implementation upgrade; the address itself
// is a TransparentUpgradeableProxy, so Renzo's own upgrades land behind it.
//
// This first cut exposes the native-ETH deposit path (depositETH), both halves
// of the pause gate, and the ezETH balance and supply reads. The
// ERC20-collateral deposit variants and the withdrawal queue are separate
// surfaces deferred to a follow-up. Mainnet only: minting settles on the beacon
// chain.
//
// The RestakeManager ABI carries two error fragments so a failed stake is named
// rather than shown as a raw selector. ContractPaused() (0xab35696f) is the
// manager's own, declared in its verified ABI. InvalidTokenAmount()
// (0x21607339) is declared by RenzoOracle (RenzoOracle.sol:144) and bubbles up
// through the manager's mint-amount call at RestakeManager.sol:637; it is
// carried here because that selector is what depositETH() actually reverts with
// when it is sent no value, measured on mainnet, and classifyRevert only
// consults the target contract's own interface. Neither the ezETH nor the
// middleware document declares errors: their exposed functions are `view` and
// have no reachable revert to name.

const RENZO_DOCS =
  "https://docs.renzoprotocol.com/docs/contracts/ethereum-mainnet";

const TEST_DATA: ProtocolTestData = {
  "1": {
    setup: {
      minNativeHuman: "0.02",
      requiredTokens: [],
      approvals: [],
    },
    actions: {
      // depositETH() reverts while either half of the gate is set; both reads
      // gate it.
      paused: {},
      "deposit-paused": {},
      "ez-balance-of": { account: wallet() },
      "ez-total-supply": {},
      // Write: stake native ETH for ezETH.
      stake: { ethValue: "0.02" },
    },
    // Both halves of the deposit gate are false on mainnet as of 2026-09-21
    // (block 26024442); a flip to true on either is an emergency stop that
    // would make the stake action fail for users, so a red suite there is
    // signal. Total supply is five figures of ETH; zero means the read decoded
    // garbage.
    expectations: {
      paused: [{ field: "paused", equals: "false" }],
      "deposit-paused": [{ field: "depositPaused", equals: "false" }],
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
    "Liquid restaking on Ethereum. Deposit ETH to mint ezETH, a non-rebasing restaked-ETH token earning staking plus EigenLayer restaking rewards, and read both halves of the deposit pause gate plus ezETH balances.",
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
            "Deposit native ETH into the Renzo Restake Manager and mint ezETH to the sending address. Send ETH value with the transaction; the manager returns ezETH tracking the deposit plus staking and restaking rewards. depositETH() takes no arguments, so there is no minimum-received bound to set: the mint is whatever the Renzo oracle prices the deposit at when the transaction lands.",
          docUrl: RENZO_DOCS,
        },
        paused: {
          slug: "paused",
          label: "Check Manager Pause Flag",
          description:
            "Read the Renzo Restake Manager's own pause flag. This is one of the two conditions that halt deposits: the manager reverts a deposit when this flag is set OR when the risk-oracle middleware reports deposits paused. A workflow gating on whether deposits are accepted must read Check Risk Oracle Deposit Pause as well.",
          docUrl: RENZO_DOCS,
          outputs: {
            paused: {
              label: "Manager Paused",
            },
          },
        },
      },
    },
    riskOracleMiddleware: {
      label: "Renzo Risk Oracle Middleware",
      abi: JSON.stringify(riskOracleMiddlewareAbi),
      addresses: {
        // RestakeManager.riskOracleMiddleware() returned this on 2026-09-21 at
        // block 26024442 and unchanged at blocks 25974443, 25824443 and
        // 25524443. It is read from an `immutable` on the manager, so it cannot
        // move without a manager implementation upgrade. The integration suite
        // re-reads the getter against the declared value on every run.
        "1": "0x08921F17A32110F8df44A3d5007F2acd09Cfae6d",
      },
      overrides: {
        depositPaused: {
          slug: "deposit-paused",
          label: "Check Risk Oracle Deposit Pause",
          description:
            "Read whether Renzo's risk-oracle middleware has deposits paused. This is the second of the two conditions that halt deposits: the Restake Manager reverts a deposit when this is true OR when its own pause flag is set. A workflow gating on whether deposits are accepted must read Check Manager Pause Flag as well.",
          docUrl: RENZO_DOCS,
          outputs: {
            depositPaused: {
              label: "Risk Oracle Deposits Paused",
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
            balance: {
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
            totalSupply: {
              label: "Total ezETH Supply (wei)",
              decimals: 18,
            },
          },
        },
      },
    },
  },
});
