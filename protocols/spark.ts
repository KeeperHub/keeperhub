import { defineAbiProtocol } from "@/lib/protocol-registry";
import {
  amount,
  contract,
  native,
  type ProtocolTestData,
  wallet,
} from "@/lib/test-data/types";
import { erc4626AbiOverrides } from "@/lib/web3/standards/erc4626";

const TEST_DATA: ProtocolTestData = {
  "1": {
    setup: {
      minNativeHuman: "0.01",
      // WETH arrives via balances-slot fabrication (no whale registered);
      // DAI from the MCD_JOIN_DAI whale. WETH is the collateral asset:
      // SparkLend's mainnet DAI reserve has LTV 0 (verified via
      // getReserveConfigurationData 2026-07-08), so DAI supplies earn but
      // cannot back a borrow - the core sequence supplies WETH
      // (LTV 85%) and borrows DAI against it.
      requiredTokens: [
        { symbol: "WETH", human: "1" },
        { symbol: "DAI", human: "200" },
      ],
      approvals: [],
      // Fabricated (anvil_setStorageAt) rather than real approve-token
      // nodes: the app's approve-token path takes minutes per approval on
      // the CI fork, and three of them would blow the 300s setup timeout.
      fabricatedApprovals: [
        { token: "WETH", spender: contract("pool"), human: "1" },
        { token: "DAI", spender: contract("pool"), human: "150" },
        { token: "DAI", spender: contract("sdai"), human: "150" },
      ],
    },
    actions: {
      "get-user-account-data": { user: wallet() },
      "get-user-reserve-data": { asset: "DAI", user: wallet() },
      "vault-asset": {},
      "vault-total-assets": {},
      "vault-total-supply": {},
      "vault-balance": { account: wallet() },
      "vault-convert-to-assets": { shares: native("1") },
      "vault-convert-to-shares": { assets: native("1") },
      "vault-preview-deposit": { assets: native("1") },
      "vault-preview-mint": { shares: native("1") },
      "vault-preview-withdraw": { assets: native("1") },
      "vault-preview-redeem": { shares: native("1") },
      "vault-max-deposit": { receiver: wallet() },
      "vault-max-mint": { receiver: wallet() },
      "vault-max-withdraw": { owner: wallet() },
      "vault-max-redeem": { owner: wallet() },
      // Core sequence in registry order: supply opens the WETH position
      // (auto-enabled as collateral on first supply), withdraw trims it,
      // borrow/repay run against it with wide margin (0.45 WETH backing
      // 100 DAI), set-collateral re-asserts the already-on flag.
      supply: {
        asset: "WETH",
        amount: amount("WETH", "0.5"),
        onBehalfOf: wallet(),
      },
      withdraw: { asset: "WETH", amount: amount("WETH", "0.05"), to: wallet() },
      borrow: {
        asset: "DAI",
        amount: amount("DAI", "100"),
        onBehalfOf: wallet(),
      },
      repay: {
        asset: "DAI",
        amount: amount("DAI", "80"),
        onBehalfOf: wallet(),
      },
      "set-collateral": { asset: "WETH", useAsCollateral: "true" },
      "vault-deposit": { assets: amount("DAI", "100"), receiver: wallet() },
      "vault-mint": { shares: amount("DAI", "10"), receiver: wallet() },
      "vault-withdraw": {
        assets: amount("DAI", "20"),
        receiver: wallet(),
        owner: wallet(),
      },
      "vault-redeem": {
        shares: amount("DAI", "10"),
        receiver: wallet(),
        owner: wallet(),
      },
    },
    // sDAI vault invariants (unnamed ERC-4626 outputs, so no field): asset
    // is a permanent address; totals/supply are large and monotonic;
    // convert/preview are pure per-share quotes; max-deposit/mint are the
    // uncapped limits. The aave-style get-user-* reads are NOT asserted here
    // - no position exists at the read phase (supply is a write that runs
    // after), so they read zero; they carry post-write oracles below
    // instead. Caller-position vault reads (balance, max-withdraw/redeem)
    // are likewise history-dependent and left unasserted.
    expectations: {
      "vault-asset": [{ notEmpty: true }],
      "vault-total-assets": [{ nonZero: true }],
      "vault-total-supply": [{ nonZero: true }],
      "vault-convert-to-assets": [{ nonZero: true }],
      "vault-convert-to-shares": [{ nonZero: true }],
      "vault-preview-deposit": [{ nonZero: true }],
      "vault-preview-mint": [{ nonZero: true }],
      "vault-preview-withdraw": [{ nonZero: true }],
      "vault-preview-redeem": [{ nonZero: true }],
      "vault-max-deposit": [{ nonZero: true }],
      "vault-max-mint": [{ nonZero: true }],
    },
    // Post-write oracles: supply must register collateral, borrow must
    // register debt, and a vault deposit/mint must credit sDAI shares. All
    // nonZero (history-safe: the values only grow within the run).
    // set-collateral is liveness-only: the only reserve-data read is bound to
    // DAI, but set-collateral acts on the WETH reserve, so there is no aligned
    // probe (supply already asserts collateral registered via
    // totalCollateralBase).
    writeExpectations: {
      supply: [
        {
          read: "get-user-account-data",
          expect: { field: "totalCollateralBase", nonZero: true },
        },
      ],
      borrow: [
        {
          read: "get-user-account-data",
          expect: { field: "totalDebtBase", nonZero: true },
        },
      ],
      "vault-deposit": [{ read: "vault-balance", expect: { nonZero: true } }],
      "vault-mint": [{ read: "vault-balance", expect: { nonZero: true } }],
    },
  },
};

// Minimal SparkLend Pool ABI. Named Aave V3 outputs are preserved so the
// derived output names match the existing action output keys.
const SPARK_POOL_ABI = JSON.stringify([
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

// Standard ERC-4626 vault interface for sDAI.
const ERC4626_VAULT_ABI = JSON.stringify([
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "assets", type: "uint256" },
      { name: "receiver", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "shares", type: "uint256" },
      { name: "receiver", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "assets", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "owner", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "redeem",
    stateMutability: "nonpayable",
    inputs: [
      { name: "shares", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "owner", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "asset",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "totalAssets",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
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
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "convertToAssets",
    stateMutability: "view",
    inputs: [{ name: "shares", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "convertToShares",
    stateMutability: "view",
    inputs: [{ name: "assets", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "previewDeposit",
    stateMutability: "view",
    inputs: [{ name: "assets", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "previewMint",
    stateMutability: "view",
    inputs: [{ name: "shares", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "previewWithdraw",
    stateMutability: "view",
    inputs: [{ name: "assets", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "previewRedeem",
    stateMutability: "view",
    inputs: [{ name: "shares", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "maxDeposit",
    stateMutability: "view",
    inputs: [{ name: "receiver", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "maxMint",
    stateMutability: "view",
    inputs: [{ name: "receiver", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "maxWithdraw",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "maxRedeem",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
]);

export default defineAbiProtocol({
  name: "Spark",
  slug: "spark",
  description:
    "Spark Protocol (Aave V3 fork): lending, borrowing, and sDAI savings in the Sky/Maker ecosystem",
  website: "https://spark.fi",
  icon: "/protocols/spark.png",

  testData: TEST_DATA,

  contracts: {
    pool: {
      label: "SparkLend Pool",
      abi: SPARK_POOL_ABI,
      addresses: {
        // Ethereum Mainnet
        "1": "0xC13e21B648A5Ee794902342038FF3aDAB66BE987",
        // Gnosis Chain
        "100": "0x2Dae5307c5E3FD1CF5A72Cb6F698f915860607e0",
      },
      overrides: {
        supply: {
          label: "Supply Asset",
          description:
            "Supply an asset to the SparkLend lending pool to earn interest",
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
            "Withdraw a supplied asset from the SparkLend lending pool",
          inputs: {
            asset: { label: "Asset Token Address" },
            amount: { label: "Amount (wei)" },
            to: { label: "Recipient Address" },
          },
        },
        borrow: {
          label: "Borrow Asset",
          description:
            "Borrow an asset from SparkLend against supplied collateral",
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
          description: "Repay a borrowed asset to the SparkLend lending pool",
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
            "Enable or disable a supplied asset as collateral in SparkLend",
          inputs: {
            asset: { label: "Asset Token Address" },
            useAsCollateral: {
              label: "Use as Collateral",
              helpTip:
                "Toggles the entire supplied balance of this asset as collateral. There is no partial collateral in Aave V3/Spark.",
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
      label: "Spark Pool Data Provider",
      abi: POOL_DATA_PROVIDER_ABI,
      addresses: {
        // Ethereum Mainnet
        "1": "0xFc21d6d146E6086B8359705C8b28512a983db0cb",
        // Gnosis Chain
        "100": "0x2a002054A06546bB5a264D57A81347e23Af91D18",
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
            currentATokenBalance: { label: "Supplied Balance (spToken)" },
            currentStableDebtTokenBalance: { label: "Stable Debt Balance" },
            currentVariableDebtTokenBalance: {
              label: "Variable Debt Balance",
            },
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
    sdai: {
      label: "sDAI (Savings DAI)",
      abi: ERC4626_VAULT_ABI,
      addresses: {
        // Ethereum Mainnet -- proxy
        "1": "0x83F20F44975D03b1b09e64809B757c47f942BEeA",
      },
      overrides: erc4626AbiOverrides(),
    },
  },
});
