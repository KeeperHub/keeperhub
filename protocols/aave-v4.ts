import { defineAbiProtocol } from "@/lib/protocol-registry";
import { amount, type ProtocolTestData, wallet } from "@/lib/test-data/types";
import aaveV4Abi from "./abis/aave-v4.json";

// The Lido Spoke connects to the Aave V4 CORE hub. Reserve ids resolved via
// getReserveId(CORE_HUB, assetId) on the mainnet fork (2026-07-13): wstETH
// (hub assetId 1) -> reserveId 0; WETH (hub assetId 0) -> reserveId 1.
const LIDO_SPOKE = "0xe1900480ac69f0B296841Cd01cC37546d92F35Cd";
const CORE_HUB = "0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9";
const RESERVE_WSTETH = "0";
const RESERVE_WETH = "1";

// Funded: wstETH from the mainnet whale + fabricated Spoke approvals. Setup
// pre-supplies wstETH and enables it as collateral, so the full sweep runs:
// supply/withdraw/set-collateral on wstETH (reserveId 0) and borrow/repay on
// WETH (reserveId 1) against that collateral, plus the reserveId-scoped reads.
// get-reserve-id resolves WETH (hub assetId 0) to reserveId 1 via the CORE hub;
// with no debt the account reports the maximum (nonzero) health factor.
const TEST_DATA: ProtocolTestData = {
  "1": {
    setup: {
      minNativeHuman: "0.01",
      requiredTokens: [{ symbol: "WSTETH", human: "5" }],
      approvals: [],
      fabricatedApprovals: [
        { token: "WSTETH", spender: LIDO_SPOKE, human: "5" },
        { token: "WETH", spender: LIDO_SPOKE, human: "1" },
      ],
      // Pre-supply wstETH and enable it as collateral before the action sweep,
      // so borrow (3rd in registry order) has collateral - set-collateral runs
      // last in the sweep and cannot enable it in time.
      protocolSteps: [
        {
          protocol: "aave-v4",
          action: "supply",
          inputs: {
            reserveId: RESERVE_WSTETH,
            amount: amount("WSTETH", "2"),
            onBehalfOf: wallet(),
          },
        },
        {
          protocol: "aave-v4",
          action: "set-collateral",
          inputs: {
            reserveId: RESERVE_WSTETH,
            usingAsCollateral: "true",
            onBehalfOf: wallet(),
          },
        },
      ],
    },
    actions: {
      "get-user-account-data": { user: wallet() },
      "get-reserve-id": { hub: CORE_HUB, assetId: "0" },
      "get-user-supplied-assets": {
        reserveId: RESERVE_WSTETH,
        user: wallet(),
      },
      "get-user-debt": { reserveId: RESERVE_WETH, user: wallet() },
      supply: {
        reserveId: RESERVE_WSTETH,
        amount: amount("WSTETH", "1"),
        onBehalfOf: wallet(),
      },
      withdraw: {
        reserveId: RESERVE_WSTETH,
        amount: amount("WSTETH", "0.05"),
        onBehalfOf: wallet(),
      },
      borrow: {
        reserveId: RESERVE_WETH,
        amount: amount("WETH", "0.1"),
        onBehalfOf: wallet(),
      },
      repay: {
        reserveId: RESERVE_WETH,
        amount: amount("WETH", "0.08"),
        onBehalfOf: wallet(),
      },
      "set-collateral": {
        reserveId: RESERVE_WSTETH,
        usingAsCollateral: "true",
        onBehalfOf: wallet(),
      },
    },
    skipped: {},
    expectations: {
      "get-user-account-data": [{ field: "healthFactor", nonZero: true }],
      "get-reserve-id": [{ equals: "1" }],
    },
    writeExpectations: {
      supply: [{ read: "get-user-supplied-assets", expect: { nonZero: true } }],
      // After borrowing WETH the account carries debt; totalDebtValueRay is a
      // named field of the account-data struct.
      borrow: [
        {
          read: "get-user-account-data",
          expect: { field: "totalDebtValueRay", nonZero: true },
        },
      ],
    },
  },
};

// Aave V4 launched on Ethereum mainnet 2026-03-30 with a Hub-and-Spoke
// architecture. Users interact with Spokes (not Hubs) for supply/borrow.
// Each Spoke is tied to an ecosystem partner and has its own set of reserves
// identified by an opaque uint256 reserveId. Use `get-reserve-id` to resolve
// an asset into its reserveId before calling supply/withdraw/borrow/repay.
//
// This first cut exposes the Lido Spoke only - the most established of the
// six launch Spokes (Lido, EtherFi, Kelp, Ethena Correlated, Ethena
// Ecosystem, Lombard BTC). Additional Spokes can be added as contract
// entries sharing the same ABI.
//
// Integration tests are gated on the separate aave-v4-mainnet-onchain
// test file - no Sepolia V4 deployment exists at launch.

export default defineAbiProtocol({
  name: "Aave V4",
  slug: "aave-v4",
  testData: TEST_DATA,
  description:
    "Aave V4 Hub-and-Spoke lending protocol - supply, borrow, repay and monitor positions via the Lido Spoke",
  website: "https://aave.com",
  icon: "/protocols/aave.png",

  contracts: {
    lidoSpoke: {
      label: "Aave V4 Lido Spoke",
      abi: JSON.stringify(aaveV4Abi),
      addresses: {
        "1": "0xe1900480ac69f0B296841Cd01cC37546d92F35Cd",
      },
      overrides: {
        // Write actions (supply/withdraw/borrow/repay) omit output overrides
        // pending KEEP-296. writeContractCore returns result: undefined, so
        // UI template suggestions are gated in buildOutputFieldsFromAction;
        // named overrides would be dead metadata until the write path decodes
        // function returns.
        supply: {
          slug: "supply",
          label: "Supply Asset",
          description:
            "Supply an asset to the Aave V4 Lido Spoke to earn interest. Amount is in the underlying asset's smallest unit (wei for 18-decimal tokens).",
          inputs: {
            reserveId: {
              label: "Reserve ID",
              helpTip:
                "Opaque uint256 identifier for a reserve within this Spoke. Use the Get Reserve ID action to resolve from (hub, assetId).",
              docUrl: "https://aave.com/docs/aave-v4/liquidity/spokes",
            },
            amount: { label: "Amount (wei)" },
            onBehalfOf: { label: "On Behalf Of Address" },
          },
        },
        withdraw: {
          slug: "withdraw",
          label: "Withdraw Asset",
          description: "Withdraw a supplied asset from the Aave V4 Lido Spoke",
          inputs: {
            reserveId: {
              label: "Reserve ID",
              docUrl: "https://aave.com/docs/aave-v4/liquidity/spokes",
            },
            amount: { label: "Amount (wei)" },
            onBehalfOf: { label: "Recipient Address" },
          },
        },
        borrow: {
          slug: "borrow",
          label: "Borrow Asset",
          description:
            "Borrow an asset from the Aave V4 Lido Spoke against supplied collateral. V4 uses a single rate model (no stable/variable mode).",
          inputs: {
            reserveId: {
              label: "Reserve ID",
              docUrl: "https://aave.com/docs/aave-v4/positions/borrow",
            },
            amount: { label: "Amount (wei)" },
            onBehalfOf: { label: "On Behalf Of Address" },
          },
        },
        repay: {
          slug: "repay",
          label: "Repay Debt",
          description: "Repay a borrowed asset to the Aave V4 Lido Spoke",
          inputs: {
            reserveId: {
              label: "Reserve ID",
              docUrl: "https://aave.com/docs/aave-v4/positions/borrow",
            },
            amount: { label: "Amount (wei)" },
            onBehalfOf: { label: "On Behalf Of Address" },
          },
        },
        setUsingAsCollateral: {
          slug: "set-collateral",
          label: "Set Asset as Collateral",
          description:
            "Enable or disable a supplied reserve as collateral in the Aave V4 Lido Spoke",
          inputs: {
            reserveId: { label: "Reserve ID" },
            usingAsCollateral: {
              label: "Use as Collateral",
              helpTip:
                "Toggles the entire supplied balance of this reserve as collateral. There is no partial collateral in Aave V4.",
              docUrl: "https://aave.com/docs/aave-v4/positions/supply",
            },
            onBehalfOf: { label: "On Behalf Of Address" },
          },
        },
        getReserveId: {
          slug: "get-reserve-id",
          label: "Get Reserve ID",
          description:
            "Resolve an asset to its reserveId within this Spoke, given the Hub address and the Hub's assetId for that asset",
          inputs: {
            hub: { label: "Hub Address" },
            assetId: {
              label: "Hub Asset ID",
              helpTip:
                "Asset identifier within the Hub. Use the Hub's getAssetId(underlying) to resolve from an ERC-20 address.",
              docUrl: "https://aave.com/docs/aave-v4/liquidity/spokes",
            },
          },
          outputs: {
            result: {
              name: "reserveId",
              label: "Reserve ID",
            },
          },
        },
        getUserSuppliedAssets: {
          slug: "get-user-supplied-assets",
          label: "Get User Supplied Assets",
          description:
            "Get the amount of underlying asset supplied by a user for a given reserve",
          inputs: {
            reserveId: {
              label: "Reserve ID",
              docUrl: "https://aave.com/docs/aave-v4/positions/supply",
            },
            user: { label: "User Address" },
          },
          outputs: {
            result: {
              name: "suppliedAmount",
              label: "Supplied Amount (underlying)",
            },
          },
        },
        getUserDebt: {
          slug: "get-user-debt",
          label: "Get User Debt",
          description:
            "Get the debt of a user for a given reserve, split into drawn debt and premium debt. Total debt = drawn + premium.",
          inputs: {
            reserveId: {
              label: "Reserve ID",
              docUrl: "https://aave.com/docs/aave-v4/positions/borrow",
            },
            user: { label: "User Address" },
          },
          outputs: {
            result0: {
              name: "drawnDebt",
              label: "Drawn Debt (underlying)",
            },
            result1: {
              name: "premiumDebt",
              label: "Premium Debt (underlying)",
            },
          },
        },
        getUserAccountData: {
          slug: "get-user-account-data",
          label: "Get User Account Data",
          description:
            "Get overall account health including collateral value, debt, health factor, and risk premium. Returns a struct - access individual fields via dotted path (e.g. result.healthFactor).",
          inputs: {
            user: {
              label: "User Address",
              docUrl: "https://aave.com/docs/aave-v4/positions",
            },
          },
          outputs: {
            result: {
              name: "accountData",
              label:
                "Account Data (struct: riskPremium, avgCollateralFactor, healthFactor, totalCollateralValue, totalDebtValueRay, activeCollateralCount, borrowCount)",
            },
          },
        },
      },
    },
  },
});
