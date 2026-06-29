import { defineAbiProtocol } from "@/lib/protocol-registry";

export default defineAbiProtocol({
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
          outputs: [
            { name: "balance", type: "uint128" },
            { name: "_reserved", type: "uint128" },
          ],
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
            result: { name: "utilization", label: "Utilization Rate", decimals: 18 },
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
