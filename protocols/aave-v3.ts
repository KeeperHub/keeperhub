import { defineAbiProtocol } from "@/lib/protocol-registry";
import {
  amount,
  contract,
  type ProtocolTestData,
  wallet,
} from "@/lib/test-data/types";

// KEEP-458 protocol-coverage test data. Co-located with the protocol
// definition; consumed programmatically by `lib/test-data/build-workflow.ts`.
//
// Mainnet (fork mode) uses the USDC reserve: LTV 7500, collateral and
// borrowing enabled, active, not frozen, supply cap 2.5B with ample
// headroom -- verified 2026-07-02 via eth_call against
// PoolDataProvider.getReserveConfigurationData/getReserveCaps. DAI is
// unusable as collateral on mainnet (governance set its LTV to 0), so the
// Sepolia pattern does not transfer. Setup provisions USDC from the fork
// whale, approves the Pool, then supplies 100 USDC so the write coverage
// (withdraw/borrow/repay/set-collateral) has a real position.
//
// Sepolia uses the Aave V3 testnet LINK reserve. DAI/USDC/USDT all hit
// `SUPPLY_CAP_EXCEEDED` (error 51) on Aave Sepolia, verified 2026-05-12
// via eth_call against Pool.supply(). LINK has headroom and is borrowable.
// Setup mints LINK via the permissionless Aave faucet, approves the Pool,
// then supplies 100 LINK so the write coverage (withdraw/borrow/repay/
// set-collateral) has a real position to operate on.
const TEST_DATA: ProtocolTestData = {
  "1": {
    setup: {
      minNativeHuman: "0.05",
      // 100 USDC initial supply + 10 USDC per-test supply + buffer.
      requiredTokens: [{ symbol: "USDC", human: "200" }],
      approvals: [{ token: "USDC", spender: contract("pool"), human: "200" }],
      protocolSteps: [
        {
          protocol: "aave-v3",
          action: "supply",
          inputs: {
            asset: "USDC",
            amount: amount("USDC", "100"),
            onBehalfOf: wallet(),
            referralCode: "0",
          },
        },
      ],
    },
    actions: {
      "get-user-account-data": {
        user: wallet(),
      },
      "get-user-reserve-data": {
        asset: "USDC",
        user: wallet(),
      },
      supply: {
        asset: "USDC",
        amount: amount("USDC", "10"),
        onBehalfOf: wallet(),
        referralCode: "0",
      },
      withdraw: {
        asset: "USDC",
        amount: amount("USDC", "1"),
        to: wallet(),
      },
      borrow: {
        asset: "USDC",
        amount: amount("USDC", "1"),
        interestRateMode: "2",
        referralCode: "0",
        onBehalfOf: wallet(),
      },
      repay: {
        asset: "USDC",
        amount: amount("USDC", "1"),
        interestRateMode: "2",
        onBehalfOf: wallet(),
      },
      "set-collateral": {
        asset: "USDC",
        useAsCollateral: "true",
      },
    },
    // Both reads run after setup supplied 100 USDC, so the position values
    // are self-provisioned -- no dependency on third-party chain state.
    expectations: {
      "get-user-account-data": [
        { field: "totalCollateralBase", nonZero: true },
        { field: "healthFactor", nonZero: true },
      ],
      "get-user-reserve-data": [
        { field: "currentATokenBalance", nonZero: true },
        { field: "usageAsCollateralEnabled", equals: "true" },
      ],
    },
  },
  "11155111": {
    setup: {
      minNativeHuman: "0.001",
      // 100 LINK initial supply + 10 LINK per-test supply + buffer.
      requiredTokens: [{ symbol: "LINK", human: "200" }],
      approvals: [{ token: "LINK", spender: contract("pool"), human: "200" }],
      protocolSteps: [
        {
          protocol: "aave-v3",
          action: "supply",
          inputs: {
            asset: "LINK",
            amount: amount("LINK", "100"),
            onBehalfOf: wallet(),
            referralCode: "0",
          },
        },
      ],
    },
    actions: {
      "get-user-account-data": {
        user: wallet(),
      },
      "get-user-reserve-data": {
        asset: "LINK",
        user: wallet(),
      },
      supply: {
        asset: "LINK",
        amount: amount("LINK", "10"),
        onBehalfOf: wallet(),
        referralCode: "0",
      },
      withdraw: {
        asset: "LINK",
        amount: amount("LINK", "1"),
        to: wallet(),
      },
      borrow: {
        asset: "LINK",
        amount: amount("LINK", "1"),
        interestRateMode: "2",
        referralCode: "0",
        onBehalfOf: wallet(),
      },
      repay: {
        asset: "LINK",
        amount: amount("LINK", "1"),
        interestRateMode: "2",
        onBehalfOf: wallet(),
      },
      "set-collateral": {
        asset: "LINK",
        useAsCollateral: "true",
      },
    },
  },
};

// Minimal Aave V3 Pool ABI. The Aave V3 Pool is an upgradeable proxy
// (InitializableImmutableAdminUpgradeabilityProxy) whose Etherscan entry
// does not flag it as a proxy and returns the proxy's own ABI -- so the
// auto-resolver fails to find pool functions. Embedding the implementation
// ABI inline so resolveAbi short-circuits via the "definition" source. KEEP-396.
// Only the 6 functions we expose are included to avoid generating extra actions.
// Action order must be preserved: supply → withdraw → borrow → repay →
// set-collateral. The protocol-coverage runner executes write actions in
// definition order; reordering this array will silently break the suite.
const POOL_ABI = JSON.stringify([
  {
    type: "function",
    name: "supply",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "onBehalfOf", type: "address" },
      { name: "referralCode", type: "uint16" },
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
      { name: "to", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "borrow",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "interestRateMode", type: "uint256" },
      { name: "referralCode", type: "uint16" },
      { name: "onBehalfOf", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "repay",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "interestRateMode", type: "uint256" },
      { name: "onBehalfOf", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "setUserUseReserveAsCollateral",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "useAsCollateral", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getUserAccountData",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [
      { name: "totalCollateralBase", type: "uint256" },
      { name: "totalDebtBase", type: "uint256" },
      { name: "availableBorrowsBase", type: "uint256" },
      { name: "currentLiquidationThreshold", type: "uint256" },
      { name: "ltv", type: "uint256" },
      { name: "healthFactor", type: "uint256" },
    ],
  },
]);

const POOL_DATA_PROVIDER_ABI = JSON.stringify([
  {
    type: "function",
    name: "getUserReserveData",
    stateMutability: "view",
    inputs: [
      { name: "asset", type: "address" },
      { name: "user", type: "address" },
    ],
    outputs: [
      { name: "currentATokenBalance", type: "uint256" },
      { name: "currentStableDebtTokenBalance", type: "uint256" },
      { name: "currentVariableDebtTokenBalance", type: "uint256" },
      { name: "principalStableDebt", type: "uint256" },
      { name: "scaledVariableDebt", type: "uint256" },
      { name: "stableBorrowRate", type: "uint256" },
      { name: "liquidityRate", type: "uint256" },
      { name: "stableRateLastUpdated", type: "uint40" },
      { name: "usageAsCollateralEnabled", type: "bool" },
    ],
  },
]);

export default defineAbiProtocol({
  name: "Aave V3",
  slug: "aave-v3",
  description:
    "Aave V3 lending and borrowing protocol: supply, borrow, repay, and monitor account health",
  website: "https://aave.com",
  icon: "/protocols/aave.png",

  contracts: {
    pool: {
      label: "Aave V3 Pool",
      abi: POOL_ABI,
      addresses: {
        // Ethereum Mainnet
        "1": "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
        // Base
        "8453": "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
        // Arbitrum One
        "42161": "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
        // Optimism
        "10": "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
        // Sepolia Testnet
        "11155111": "0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951",
        // Base Sepolia Testnet (bgd-labs AaveV3BaseSepolia.POOL)
        "84532": "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27",
      },
      overrides: {
        supply: {
          label: "Supply Asset",
          description:
            "Supply an asset to the Aave V3 lending pool to earn interest",
          inputs: {
            asset: { label: "Asset Token Address" },
            amount: { label: "Amount (wei)" },
            onBehalfOf: { label: "On Behalf Of Address" },
            referralCode: { label: "Referral Code", default: "0" },
          },
        },
        withdraw: {
          label: "Withdraw Asset",
          description:
            "Withdraw a supplied asset from the Aave V3 lending pool",
          inputs: {
            asset: { label: "Asset Token Address" },
            amount: { label: "Amount (wei)" },
            to: { label: "Recipient Address" },
          },
        },
        borrow: {
          label: "Borrow Asset",
          description:
            "Borrow an asset from the Aave V3 lending pool against supplied collateral",
          inputs: {
            asset: { label: "Asset Token Address" },
            amount: { label: "Amount (wei)" },
            interestRateMode: {
              label: "Interest Rate Mode (2=Variable)",
              default: "2",
            },
            referralCode: { label: "Referral Code", default: "0" },
            onBehalfOf: { label: "On Behalf Of Address" },
          },
        },
        repay: {
          label: "Repay Debt",
          description: "Repay a borrowed asset to the Aave V3 lending pool",
          inputs: {
            asset: { label: "Asset Token Address" },
            amount: { label: "Amount (wei)" },
            interestRateMode: {
              label: "Interest Rate Mode (2=Variable)",
              default: "2",
            },
            onBehalfOf: { label: "On Behalf Of Address" },
          },
        },
        setUserUseReserveAsCollateral: {
          slug: "set-collateral",
          label: "Set Asset as Collateral",
          description:
            "Enable or disable a supplied asset as collateral in Aave V3",
          inputs: {
            asset: { label: "Asset Token Address" },
            useAsCollateral: {
              label: "Use as Collateral",
              helpTip:
                "Toggles the entire supplied balance of this asset as collateral. There is no partial collateral in Aave V3.",
            },
          },
        },
        getUserAccountData: {
          slug: "get-user-account-data",
          label: "Get User Account Data",
          description:
            "Get overall account health including collateral, debt, borrow power, and health factor",
          inputs: {
            user: { label: "User Address" },
          },
          outputs: {
            totalCollateralBase: {
              label: "Total Collateral (base currency)",
              decimals: 8,
            },
            totalDebtBase: {
              label: "Total Debt (base currency)",
              decimals: 8,
            },
            availableBorrowsBase: {
              label: "Available Borrows (base currency)",
              decimals: 8,
            },
            currentLiquidationThreshold: {
              label: "Liquidation Threshold (basis points)",
            },
            ltv: { label: "Loan-to-Value (basis points)" },
            healthFactor: { label: "Health Factor", decimals: 18 },
          },
        },
      },
    },
    poolDataProvider: {
      label: "Aave V3 Pool Data Provider",
      abi: POOL_DATA_PROVIDER_ABI,
      addresses: {
        // Ethereum Mainnet
        "1": "0x0a16f2FCC0D44FaE41cc54e079281D84A363bECD",
        // Base
        "8453": "0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A",
        // Arbitrum One
        "42161": "0x243Aa95cAC2a25651eda86e80bEe66114413c43b",
        // Optimism
        "10": "0x243Aa95cAC2a25651eda86e80bEe66114413c43b",
        // Sepolia Testnet
        "11155111": "0x3e9708d80f7B3e43118013075F7e95CE3AB31F31",
        // Base Sepolia Testnet (bgd-labs AaveV3BaseSepolia.POOL_DATA_PROVIDER)
        "84532": "0xBc9f5b7E248451CdD7cA54e717a2BFe1F32b566b",
      },
      overrides: {
        getUserReserveData: {
          slug: "get-user-reserve-data",
          label: "Get User Reserve Data",
          description:
            "Get per-asset position data including supplied balance, debt, and rates",
          inputs: {
            asset: { label: "Asset Token Address" },
            user: { label: "User Address" },
          },
          outputs: {
            currentATokenBalance: { label: "Supplied Balance (aToken)" },
            currentStableDebtTokenBalance: { label: "Stable Debt Balance" },
            currentVariableDebtTokenBalance: { label: "Variable Debt Balance" },
            principalStableDebt: { label: "Principal Stable Debt" },
            scaledVariableDebt: { label: "Scaled Variable Debt" },
            stableBorrowRate: {
              label: "Stable Borrow Rate (ray)",
              decimals: 27,
            },
            liquidityRate: { label: "Supply APY (ray)", decimals: 27 },
            stableRateLastUpdated: {
              label: "Stable Rate Last Updated (timestamp)",
            },
            usageAsCollateralEnabled: { label: "Used as Collateral" },
          },
        },
      },
    },
  },

  testData: TEST_DATA,
});
