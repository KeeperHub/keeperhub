import { defineAbiProtocol } from "@/lib/protocol-registry";
import {
  type ActionInputBindings,
  amount,
  type OutputExpectation,
  type ProtocolTestData,
  wallet,
} from "@/lib/test-data/types";

// Comet (base USDC) market address per chain, and a WETH collateral address
// for the collateral-balance read. The comet is a userSpecifiedAddress
// contract, so every action binds the virtual `contractAddress` key.
const COMET_USDC: Record<string, string> = {
  "1": "0xc3d688B66703497DAA19211EEdff47f25384cdc3",
  "8453": "0xb125E6687d4313864e53df431d5425969c15Eb2F",
  "42161": "0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf",
};
const WETH: Record<string, string> = {
  "1": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  "8453": "0x4200000000000000000000000000000000000006",
  "42161": "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
};
// A mid-range utilization (0.5e18) for the rate reads: rates are a pure
// function of utilization, so a fixed nonzero input yields a nonzero rate
// without depending on the market's live utilization.
const MID_UTILIZATION = "500000000000000000";

function cometActions(
  comet: string,
  weth: string
): Record<string, ActionInputBindings> {
  return {
    "get-balance": { contractAddress: comet, account: wallet() },
    "get-collateral-balance": {
      contractAddress: comet,
      account: wallet(),
      asset: weth,
    },
    "get-borrow-balance": { contractAddress: comet, account: wallet() },
    "get-utilization": { contractAddress: comet },
    "get-supply-rate": { contractAddress: comet, utilization: MID_UTILIZATION },
    "get-borrow-rate": { contractAddress: comet, utilization: MID_UTILIZATION },
    "get-total-supply": { contractAddress: comet },
    "get-total-borrow": { contractAddress: comet },
    "is-liquidatable": { contractAddress: comet, account: wallet() },
    "get-num-assets": { contractAddress: comet },
    supply: { contractAddress: comet, asset: weth, amount: "1000000000000000" },
    withdraw: {
      contractAddress: comet,
      asset: weth,
      amount: "1000000000000000",
    },
  };
}

const COMET_SKIPS: Record<string, string> = {
  supply: "requires collateral token balance and a Comet approval",
  withdraw: "requires an open supplied/collateral position",
};

// Market invariants (unnamed outputs, so no field): an active Comet market has
// supply and borrows (nonzero utilization), positive per-second rates at a mid
// utilization, and a fixed set of collateral assets. Caller-position reads
// (base/collateral/borrow balance) read zero for the unprovisioned test wallet
// and stay liveness-only; is-liquidatable is a constant false for a wallet
// with no position.
const COMET_EXPECTATIONS: Record<string, OutputExpectation[]> = {
  "get-utilization": [{ nonZero: true }],
  "get-supply-rate": [{ nonZero: true }],
  "get-borrow-rate": [{ nonZero: true }],
  "get-total-supply": [{ nonZero: true }],
  "get-total-borrow": [{ nonZero: true }],
  "get-num-assets": [{ nonZero: true }],
  "is-liquidatable": [{ equals: "false" }],
};

function cometChain(chainId: string, funded = false): ProtocolTestData[string] {
  const comet = COMET_USDC[chainId];
  const actions = cometActions(comet, WETH[chainId]);
  if (!funded) {
    return {
      setup: { minNativeHuman: "0.01", requiredTokens: [], approvals: [] },
      actions,
      skipped: COMET_SKIPS,
      expectations: COMET_EXPECTATIONS,
    };
  }
  // Fund USDC (the base asset) - whale on mainnet, balance fabrication on the
  // L2 forks - and fabricate the Comet approval, so supply then withdraw of the
  // base asset execute in registry order on every chain. Supplying the base
  // makes the wallet a lender, so get-balance reads a nonzero base position
  // afterward.
  actions.supply = {
    contractAddress: comet,
    asset: "USDC",
    amount: amount("USDC", "100"),
  };
  actions.withdraw = {
    contractAddress: comet,
    asset: "USDC",
    amount: amount("USDC", "50"),
  };
  return {
    setup: {
      minNativeHuman: "0.01",
      requiredTokens: [{ symbol: "USDC", human: "1000" }],
      approvals: [],
      fabricatedApprovals: [{ token: "USDC", spender: comet, human: "1000" }],
    },
    actions,
    skipped: {},
    expectations: COMET_EXPECTATIONS,
    writeExpectations: {
      supply: [{ read: "get-balance", expect: { nonZero: true } }],
    },
  };
}

const TEST_DATA: ProtocolTestData = {
  "1": cometChain("1", true),
  "8453": cometChain("8453", true),
  "42161": cometChain("42161", true),
};

export default defineAbiProtocol({
  testData: TEST_DATA,
  name: "Compound V3",
  slug: "compound",
  description:
    "Compound V3 (Comet) lending protocol: supply assets, borrow base tokens, and monitor balances across isolated markets",
  website: "https://compound.finance",
  icon: "/protocols/compound.png",

  contracts: {
    comet: {
      label: "Comet Market",
      userSpecifiedAddress: true,
      addresses: {
        "1": "0xc3d688B66703497DAA19211EEdff47f25384cdc3",
        "8453": "0xb125E6687d4313864e53df431d5425969c15Eb2F",
        "42161": "0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf",
      },
      abi: JSON.stringify([
        {
          type: "function",
          name: "supply",
          stateMutability: "nonpayable",
          inputs: [
            { name: "asset", type: "address" },
            { name: "amount", type: "uint256" },
          ],
          outputs: [],
        },
        {
          type: "function",
          name: "withdraw",
          stateMutability: "nonpayable",
          inputs: [
            { name: "asset", type: "address" },
            { name: "amount", type: "uint256" },
          ],
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
          name: "userCollateral",
          stateMutability: "view",
          inputs: [
            { name: "account", type: "address" },
            { name: "asset", type: "address" },
          ],
          outputs: [{ name: "balance", type: "uint128" }],
        },
        {
          type: "function",
          name: "borrowBalanceOf",
          stateMutability: "view",
          inputs: [{ name: "account", type: "address" }],
          outputs: [{ name: "", type: "uint256" }],
        },
        {
          type: "function",
          name: "getUtilization",
          stateMutability: "view",
          inputs: [],
          outputs: [{ name: "", type: "uint256" }],
        },
        {
          type: "function",
          name: "getSupplyRate",
          stateMutability: "view",
          inputs: [{ name: "utilization", type: "uint256" }],
          outputs: [{ name: "", type: "uint64" }],
        },
        {
          type: "function",
          name: "getBorrowRate",
          stateMutability: "view",
          inputs: [{ name: "utilization", type: "uint256" }],
          outputs: [{ name: "", type: "uint64" }],
        },
        {
          type: "function",
          name: "totalSupply",
          stateMutability: "view",
          inputs: [],
          outputs: [{ name: "", type: "uint256" }],
        },
        {
          type: "function",
          name: "totalBorrow",
          stateMutability: "view",
          inputs: [],
          outputs: [{ name: "", type: "uint256" }],
        },
        {
          type: "function",
          name: "isLiquidatable",
          stateMutability: "view",
          inputs: [{ name: "account", type: "address" }],
          outputs: [{ name: "", type: "bool" }],
        },
        {
          type: "function",
          name: "numAssets",
          stateMutability: "view",
          inputs: [],
          outputs: [{ name: "", type: "uint8" }],
        },
      ]),
      overrides: {
        supply: {
          label: "Supply Asset",
          description:
            "Supply base or collateral assets to a Compound V3 Comet market. Requires prior ERC-20 approval for the Comet contract.",
          inputs: {
            asset: { label: "Asset Token Address" },
            amount: { label: "Amount (wei)" },
          },
        },
        withdraw: {
          label: "Withdraw Asset",
          description:
            "Withdraw base or collateral assets from a Compound V3 Comet market",
          inputs: {
            asset: { label: "Asset Token Address" },
            amount: { label: "Amount (wei)" },
          },
        },
        balanceOf: {
          slug: "get-balance",
          label: "Get Base Balance",
          description:
            "Get the balance of the base asset (e.g. USDC) for an account in a Comet market",
          inputs: {
            account: { label: "Account Address" },
          },
          outputs: {
            result: { name: "balance", label: "Base Asset Balance" },
          },
        },
        userCollateral: {
          slug: "get-collateral-balance",
          label: "Get Collateral Balance",
          description:
            "Get the collateral balance of a specific asset for an account in a Comet market",
          inputs: {
            account: { label: "Account Address" },
            asset: { label: "Collateral Asset Address" },
          },
          outputs: {
            balance: { label: "Collateral Balance" },
          },
        },
        borrowBalanceOf: {
          slug: "get-borrow-balance",
          label: "Get Borrow Balance",
          description:
            "Get the borrow balance of the base asset for an account in a Comet market",
          inputs: {
            account: { label: "Account Address" },
          },
          outputs: {
            result: { name: "balance", label: "Borrow Balance" },
          },
        },
        getUtilization: {
          label: "Get Utilization",
          description:
            "Get the current utilization rate of a Comet market (ratio of borrows to supply, scaled to 1e18)",
          outputs: {
            result: {
              name: "utilization",
              label: "Utilization Rate",
              decimals: 18,
            },
          },
        },
        getSupplyRate: {
          label: "Get Supply Rate",
          description:
            "Get the per-second supply rate for a given utilization level. Multiply by seconds in a year (31536000) for APR.",
          inputs: {
            utilization: { label: "Utilization (from Get Utilization)" },
          },
          outputs: {
            result: { name: "rate", label: "Supply Rate Per Second" },
          },
        },
        getBorrowRate: {
          label: "Get Borrow Rate",
          description:
            "Get the per-second borrow rate for a given utilization level. Multiply by seconds in a year (31536000) for APR.",
          inputs: {
            utilization: { label: "Utilization (from Get Utilization)" },
          },
          outputs: {
            result: { name: "rate", label: "Borrow Rate Per Second" },
          },
        },
        totalSupply: {
          slug: "get-total-supply",
          label: "Get Total Supply",
          description:
            "Get the total base asset supplied to a Comet market across all users",
          outputs: {
            result: { name: "totalSupply", label: "Total Supply" },
          },
        },
        totalBorrow: {
          slug: "get-total-borrow",
          label: "Get Total Borrow",
          description:
            "Get the total base asset borrowed from a Comet market across all users",
          outputs: {
            result: { name: "totalBorrow", label: "Total Borrow" },
          },
        },
        isLiquidatable: {
          label: "Is Liquidatable",
          description:
            "Check if an account is currently liquidatable in a Comet market",
          inputs: {
            account: { label: "Account Address" },
          },
          outputs: {
            result: { name: "isLiquidatable", label: "Is Liquidatable" },
          },
        },
        numAssets: {
          slug: "get-num-assets",
          label: "Get Number of Assets",
          description:
            "Get the number of collateral assets supported by a Comet market",
          outputs: {
            result: { name: "numAssets", label: "Number of Collateral Assets" },
          },
        },
      },
    },
  },
});
