import { defineAbiProtocol } from "@/lib/protocol-registry";
import { type ProtocolTestData, wallet } from "@/lib/test-data/types";
import depositPoolAbi from "./abis/rocket-pool-deposit-pool.json";
import rethAbi from "./abis/rocket-pool-reth.json";

const ROCKET_POOL_DOCS = "https://docs.rocketpool.net";

const TEST_DATA: ProtocolTestData = {
  "1": {
    setup: {
      minNativeHuman: "0.01",
      requiredTokens: [],
      approvals: [],
    },
    actions: {
      "get-exchange-rate": {},
      "balance-of": { account: wallet() },
      "total-supply": {},
      "get-total-collateral": {},
      burn: {},
      // Deposits are open with ~6M ETH of headroom and a 0.01 ETH minimum
      // (verified 2026-07-02 via getMaximumDepositAmount/getBalance).
      deposit: { ethValue: "0.02" },
    },
    skipped: {
      burn: "requires rETH balance and deposit-pool excess liquidity, which can legitimately be zero",
    },
    events: {
      skipped: {
        "tokens-burned":
          "emitted only by rETH.burn, which needs the rETH contract to hold enough ETH collateral to redeem; deposit-pool excess collateral can legitimately be zero on the fork (same constraint that skips the burn action)",
      },
    },
    // Chain invariants: the exchange rate only ratchets up from 1e18 and
    // rETH supply is nine figures; both being zero means the read decoded
    // garbage. No expectation on balance-of: the deposit fixture mints the
    // wallet rETH mid-run, so its value depends on run history on a
    // long-lived fork.
    expectations: {
      "get-exchange-rate": [{ field: "rate", nonZero: true }],
      "total-supply": [{ field: "totalSupply", nonZero: true }],
    },
    // Simulation-tier post-write oracle: deposit must actually credit
    // rETH (a mined receipt alone misses the stale-deposit-pool failure
    // class). nonZero is history-safe on a long-lived fork.
    writeExpectations: {
      deposit: [
        { read: "balance-of", expect: { field: "balance", nonZero: true } },
      ],
    },
  },
};

export default defineAbiProtocol({
  name: "Rocket Pool",
  slug: "rocket-pool",
  description:
    "Decentralized Ethereum liquid staking: deposit ETH for rETH, monitor exchange rates, and manage staking positions",
  website: "https://rocketpool.net",
  icon: "/protocols/rocket-pool.png",

  testData: TEST_DATA,

  contracts: {
    reth: {
      label: "rETH Token",
      abi: JSON.stringify(rethAbi),
      addresses: {
        "1": "0xae78736Cd615f374D3085123A210448E74Fc6393",
      },
      overrides: {
        getExchangeRate: {
          label: "Get rETH Exchange Rate",
          description:
            "Get the current ETH value of 1 rETH (exchange rate from rETH to ETH)",
          docUrl: ROCKET_POOL_DOCS,
          outputs: {
            rate: {
              label: "Exchange Rate (wei per rETH)",
              decimals: 18,
            },
          },
        },
        balanceOf: {
          label: "Get rETH Balance",
          description: "Check the rETH balance of an address",
          docUrl: ROCKET_POOL_DOCS,
          inputs: {
            account: {
              label: "Wallet Address",
              helpTip:
                "Address whose rETH balance will be read from the contract.",
              docUrl: ROCKET_POOL_DOCS,
            },
          },
          outputs: {
            balance: {
              label: "rETH Balance (wei)",
              decimals: 18,
            },
          },
        },
        totalSupply: {
          label: "Get rETH Total Supply",
          description: "Get the total supply of rETH tokens in circulation",
          docUrl: ROCKET_POOL_DOCS,
          outputs: {
            totalSupply: {
              label: "Total rETH Supply (wei)",
              decimals: 18,
            },
          },
        },
        getTotalCollateral: {
          label: "Get Total ETH Collateral",
          description:
            "Get the total amount of ETH collateral held by the rETH contract",
          docUrl: ROCKET_POOL_DOCS,
          outputs: {
            totalCollateral: {
              label: "Total ETH Collateral (wei)",
              decimals: 18,
            },
          },
        },
        burn: {
          label: "Burn rETH for ETH",
          description:
            "Burn rETH tokens to receive the underlying ETH back at the current exchange rate",
          docUrl: ROCKET_POOL_DOCS,
          inputs: {
            _rethAmount: {
              name: "amount",
              label: "rETH Amount (wei)",
              helpTip:
                "Amount of rETH to burn, in wei. The contract returns ETH at the current exchange rate (see Get rETH Exchange Rate).",
              docUrl: ROCKET_POOL_DOCS,
              decimals: 18,
            },
          },
        },
      },
      events: {
        TokensMinted: {
          label: "rETH Minted",
          description: "Fires when rETH tokens are minted after an ETH deposit",
        },
        TokensBurned: {
          label: "rETH Burned",
          description:
            "Fires when rETH tokens are burned to redeem the underlying ETH",
        },
      },
    },
    depositPool: {
      label: "Rocket Deposit Pool",
      abi: JSON.stringify(depositPoolAbi),
      addresses: {
        // Resolved from RocketStorage getAddress(keccak("contract.address" +
        // "rocketDepositPool")) on 2026-07-03. Rocket Pool upgrades this
        // contract; deposits to superseded deployments revert with
        // "Invalid or outdated contract" even though reads still work.
        "1": "0xCE15294273CFb9D9b628F4D61636623decDF4fdC",
      },
      overrides: {
        deposit: {
          label: "Deposit ETH for rETH",
          description:
            "Deposit ETH into Rocket Pool to receive rETH liquid staking tokens",
          docUrl: ROCKET_POOL_DOCS,
        },
      },
      events: {
        DepositReceived: {
          label: "Deposit Received",
          description:
            "Fires when ETH is deposited into the Rocket Pool deposit pool",
        },
      },
    },
  },
});
