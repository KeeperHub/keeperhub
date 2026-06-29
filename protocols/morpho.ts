import { defineProtocol } from "@/lib/protocol-registry";
import { erc4626VaultActions } from "@/lib/web3/standards/erc4626";
import {
  amount,
  contract,
  type ProtocolTestData,
  wallet,
} from "@/lib/test-data/types";

// wstETH/USDC 86% LLTV market on Morpho Blue mainnet.
// Params source: Morpho public analytics; verify via get-market-params on the fork.
const WSTETH_USDC_MARKET = {
  loanToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
  collateralToken: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0", // wstETH
  oracle: "0x48F7E36EB6B826B2dF4B2E630B62Cd25e89E40e2",
  irm: "0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC", // AdaptiveCurveIrm
  lltv: "860000000000000000", // 86%
} as const;
const MARKET_ID =
  "0xb323495f7e4148be5643a4ea4a8221eef163e4bccfdedc2a6f4696baacbc86cc";

// MetaMorpho vault actions (userSpecifiedAddress) are skipped: the vault
// contract address is unknown at test time and must come from user input.
const VAULT_SKIPS: Record<string, string> = {
  "vault-deposit": "vault address required (userSpecifiedAddress)",
  "vault-mint": "vault address required (userSpecifiedAddress)",
  "vault-withdraw": "vault address required (userSpecifiedAddress)",
  "vault-redeem": "vault address required (userSpecifiedAddress)",
  "vault-asset": "vault address required (userSpecifiedAddress)",
  "vault-total-assets": "vault address required (userSpecifiedAddress)",
  "vault-total-supply": "vault address required (userSpecifiedAddress)",
  "vault-balance": "vault address required (userSpecifiedAddress)",
  "vault-convert-to-assets": "vault address required (userSpecifiedAddress)",
  "vault-convert-to-shares": "vault address required (userSpecifiedAddress)",
  "vault-preview-deposit": "vault address required (userSpecifiedAddress)",
  "vault-preview-mint": "vault address required (userSpecifiedAddress)",
  "vault-preview-withdraw": "vault address required (userSpecifiedAddress)",
  "vault-preview-redeem": "vault address required (userSpecifiedAddress)",
  "vault-max-deposit": "vault address required (userSpecifiedAddress)",
  "vault-max-mint": "vault address required (userSpecifiedAddress)",
  "vault-max-withdraw": "vault address required (userSpecifiedAddress)",
  "vault-max-redeem": "vault address required (userSpecifiedAddress)",
};

export const TEST_DATA: ProtocolTestData = {
  "1": {
    setup: {
      minNativeHuman: "0.01",
      requiredTokens: [
        { symbol: "WSTETH", human: "0.15" },
        { symbol: "USDC", human: "150" },
      ],
      approvals: [
        { token: "WSTETH", spender: contract("morpho"), human: "0.15" },
        { token: "USDC", spender: contract("morpho"), human: "150" },
      ],
    },
    skipped: {
      ...VAULT_SKIPS,
      liquidate: "requires undercollateralized position",
      "flash-loan": "requires callback contract implementation",
    },
    actions: {
      // Read actions
      "get-market": { id: MARKET_ID },
      "get-position": { id: MARKET_ID, user: wallet() },
      "get-market-params": { id: MARKET_ID },
      "is-authorized": { authorizer: wallet(), authorized: wallet() },
      // Write actions ordered for sequential fork state dependency:
      // accrue-interest and set-authorization have no prerequisites.
      // supply-collateral before borrow; supply before borrow (liquidity needed);
      // repay after borrow; withdraw after supply; withdraw-collateral after repay.
      "accrue-interest": { ...WSTETH_USDC_MARKET },
      "set-authorization": {
        authorized: "0x000000000000000000000000000000000000dEaD",
        newIsAuthorized: "false",
      },
      "supply-collateral": {
        ...WSTETH_USDC_MARKET,
        assets: amount("WSTETH", "0.1"),
        onBehalf: wallet(),
        data: "0x",
      },
      supply: {
        ...WSTETH_USDC_MARKET,
        assets: amount("USDC", "100"),
        shares: "0",
        onBehalf: wallet(),
        data: "0x",
      },
      borrow: {
        ...WSTETH_USDC_MARKET,
        assets: amount("USDC", "20"),
        shares: "0",
        onBehalf: wallet(),
        receiver: wallet(),
      },
      repay: {
        ...WSTETH_USDC_MARKET,
        assets: amount("USDC", "15"),
        shares: "0",
        onBehalf: wallet(),
        data: "0x",
      },
      withdraw: {
        ...WSTETH_USDC_MARKET,
        assets: amount("USDC", "50"),
        shares: "0",
        onBehalf: wallet(),
        receiver: wallet(),
      },
      "withdraw-collateral": {
        ...WSTETH_USDC_MARKET,
        assets: amount("WSTETH", "0.05"),
        onBehalf: wallet(),
        receiver: wallet(),
      },
      // Vault actions: skipped at runtime (no vault address available), but
      // build-workflow.test.ts still builds a workflow for every action that
      // has TEST_DATA. Placeholder bindings satisfy the builder; the runner
      // skips them via VAULT_SKIPS.
      "vault-deposit": { assets: amount("USDC", "1"), receiver: wallet() },
      "vault-mint": { shares: "1000000", receiver: wallet() },
      "vault-withdraw": {
        assets: amount("USDC", "1"),
        receiver: wallet(),
        owner: wallet(),
      },
      "vault-redeem": { shares: "1000000", receiver: wallet(), owner: wallet() },
      "vault-asset": {},
      "vault-total-assets": {},
      "vault-total-supply": {},
      "vault-balance": { account: wallet() },
      "vault-convert-to-assets": { shares: "1000000" },
      "vault-convert-to-shares": { assets: amount("USDC", "1") },
      "vault-preview-deposit": { assets: amount("USDC", "1") },
      "vault-preview-mint": { shares: "1000000" },
      "vault-preview-withdraw": { assets: amount("USDC", "1") },
      "vault-preview-redeem": { shares: "1000000" },
      "vault-max-deposit": { receiver: wallet() },
      "vault-max-mint": { receiver: wallet() },
      "vault-max-withdraw": { owner: wallet() },
      "vault-max-redeem": { owner: wallet() },
    },
  },
};

export default defineProtocol({
  name: "Morpho",
  slug: "morpho",
  description:
    "Trustless lending protocol: overcollateralized borrowing and lending of ERC-20 tokens via a singleton contract",
  website: "https://app.morpho.org",
  icon: "/protocols/morpho.png",
  testData: TEST_DATA,

  contracts: {
    morpho: {
      label: "Morpho Blue",
      addresses: {
        // Ethereum Mainnet
        "1": "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
        // Base
        "8453": "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
        // Sepolia
        "11155111": "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
      },
      // ABI omitted -- resolved automatically via abi-cache
    },
    vault: {
      label: "MetaMorpho Vault",
      addresses: {},
      userSpecifiedAddress: true,
    },
  },

  actions: [
    // MetaMorpho ERC-4626 vault actions (user-specified vault address)
    ...erc4626VaultActions("vault"),

    // Morpho Blue lending market actions
    {
      slug: "get-position",
      label: "Get Position",
      description:
        "Check a user's supply shares, borrow shares, and collateral in a Morpho market",
      type: "read",
      contract: "morpho",
      function: "position",
      inputs: [
        { name: "id", type: "bytes32", label: "Market ID" },
        { name: "user", type: "address", label: "User Address" },
      ],
      outputs: [
        {
          name: "supplyShares",
          type: "uint256",
          label: "Supply Shares",
        },
        {
          name: "borrowShares",
          type: "uint128",
          label: "Borrow Shares",
        },
        {
          name: "collateral",
          type: "uint128",
          label: "Collateral",
        },
      ],
    },
    {
      slug: "get-market",
      label: "Get Market",
      description:
        "Check total supply, borrows, last update time, and fee for a Morpho market",
      type: "read",
      contract: "morpho",
      function: "market",
      inputs: [{ name: "id", type: "bytes32", label: "Market ID" }],
      outputs: [
        {
          name: "totalSupplyAssets",
          type: "uint128",
          label: "Total Supply Assets",
        },
        {
          name: "totalSupplyShares",
          type: "uint128",
          label: "Total Supply Shares",
        },
        {
          name: "totalBorrowAssets",
          type: "uint128",
          label: "Total Borrow Assets",
        },
        {
          name: "totalBorrowShares",
          type: "uint128",
          label: "Total Borrow Shares",
        },
        {
          name: "lastUpdate",
          type: "uint128",
          label: "Last Update Timestamp",
        },
        {
          name: "fee",
          type: "uint128",
          label: "Fee",
        },
      ],
    },
    {
      slug: "get-market-params",
      label: "Get Market Params",
      description:
        "Resolve a market ID to its parameters: loan token, collateral token, oracle, IRM, and LLTV",
      type: "read",
      contract: "morpho",
      function: "idToMarketParams",
      inputs: [{ name: "id", type: "bytes32", label: "Market ID" }],
      outputs: [
        {
          name: "loanToken",
          type: "address",
          label: "Loan Token",
        },
        {
          name: "collateralToken",
          type: "address",
          label: "Collateral Token",
        },
        {
          name: "oracle",
          type: "address",
          label: "Oracle",
        },
        {
          name: "irm",
          type: "address",
          label: "Interest Rate Model",
        },
        {
          name: "lltv",
          type: "uint256",
          label: "Liquidation LTV",
        },
      ],
    },
    {
      slug: "is-authorized",
      label: "Check Authorization",
      description:
        "Check if an address is authorized to act on behalf of another in Morpho",
      type: "read",
      contract: "morpho",
      function: "isAuthorized",
      inputs: [
        {
          name: "authorizer",
          type: "address",
          label: "Authorizer Address",
        },
        {
          name: "authorized",
          type: "address",
          label: "Authorized Address",
        },
      ],
      outputs: [
        {
          name: "isAuthorized",
          type: "bool",
          label: "Is Authorized",
        },
      ],
    },
    {
      slug: "set-authorization",
      label: "Set Authorization",
      description:
        "Grant or revoke authorization for another address to act on your behalf in Morpho",
      type: "write",
      contract: "morpho",
      function: "setAuthorization",
      inputs: [
        {
          name: "authorized",
          type: "address",
          label: "Authorized Address",
        },
        { name: "newIsAuthorized", type: "bool", label: "Authorize" },
      ],
    },
    {
      slug: "flash-loan",
      label: "Flash Loan",
      description:
        "Borrow tokens and repay within the same transaction via Morpho flash loan",
      type: "write",
      contract: "morpho",
      function: "flashLoan",
      inputs: [
        { name: "token", type: "address", label: "Token Address" },
        {
          name: "assets",
          type: "uint256",
          label: "Amount (wei)",
          decimals: true,
        },
        { name: "data", type: "bytes", label: "Callback Data" },
      ],
    },
    {
      slug: "supply",
      label: "Supply",
      description:
        "Supply loan tokens to a Morpho market. Specify amount in assets or shares (set the other to 0)",
      type: "write",
      contract: "morpho",
      function: "supply",
      inputs: [
        { name: "loanToken", type: "address", label: "Loan Token Address" },
        {
          name: "collateralToken",
          type: "address",
          label: "Collateral Token Address",
        },
        { name: "oracle", type: "address", label: "Oracle Address" },
        { name: "irm", type: "address", label: "IRM Address" },
        { name: "lltv", type: "uint256", label: "Liquidation LTV" },
        {
          name: "assets",
          type: "uint256",
          label: "Asset Amount",
          decimals: true,
        },
        {
          name: "shares",
          type: "uint256",
          label: "Share Amount",
          default: "0",
        },
        { name: "onBehalf", type: "address", label: "On Behalf Of" },
        { name: "data", type: "bytes", label: "Callback Data", default: "0x" },
      ],
    },
    {
      slug: "withdraw",
      label: "Withdraw",
      description:
        "Withdraw supplied loan tokens from a Morpho market. Specify amount in assets or shares (set the other to 0)",
      type: "write",
      contract: "morpho",
      function: "withdraw",
      inputs: [
        { name: "loanToken", type: "address", label: "Loan Token Address" },
        {
          name: "collateralToken",
          type: "address",
          label: "Collateral Token Address",
        },
        { name: "oracle", type: "address", label: "Oracle Address" },
        { name: "irm", type: "address", label: "IRM Address" },
        { name: "lltv", type: "uint256", label: "Liquidation LTV" },
        {
          name: "assets",
          type: "uint256",
          label: "Asset Amount",
          decimals: true,
        },
        {
          name: "shares",
          type: "uint256",
          label: "Share Amount",
          default: "0",
        },
        { name: "onBehalf", type: "address", label: "On Behalf Of" },
        { name: "receiver", type: "address", label: "Receiver Address" },
      ],
    },
    {
      slug: "borrow",
      label: "Borrow",
      description:
        "Borrow loan tokens from a Morpho market against deposited collateral",
      type: "write",
      contract: "morpho",
      function: "borrow",
      inputs: [
        { name: "loanToken", type: "address", label: "Loan Token Address" },
        {
          name: "collateralToken",
          type: "address",
          label: "Collateral Token Address",
        },
        { name: "oracle", type: "address", label: "Oracle Address" },
        { name: "irm", type: "address", label: "IRM Address" },
        { name: "lltv", type: "uint256", label: "Liquidation LTV" },
        {
          name: "assets",
          type: "uint256",
          label: "Asset Amount",
          decimals: true,
        },
        {
          name: "shares",
          type: "uint256",
          label: "Share Amount",
          default: "0",
        },
        { name: "onBehalf", type: "address", label: "On Behalf Of" },
        { name: "receiver", type: "address", label: "Receiver Address" },
      ],
    },
    {
      slug: "repay",
      label: "Repay",
      description:
        "Repay borrowed loan tokens to a Morpho market. Specify amount in assets or shares (set the other to 0)",
      type: "write",
      contract: "morpho",
      function: "repay",
      inputs: [
        { name: "loanToken", type: "address", label: "Loan Token Address" },
        {
          name: "collateralToken",
          type: "address",
          label: "Collateral Token Address",
        },
        { name: "oracle", type: "address", label: "Oracle Address" },
        { name: "irm", type: "address", label: "IRM Address" },
        { name: "lltv", type: "uint256", label: "Liquidation LTV" },
        {
          name: "assets",
          type: "uint256",
          label: "Asset Amount",
          decimals: true,
        },
        {
          name: "shares",
          type: "uint256",
          label: "Share Amount",
          default: "0",
        },
        { name: "onBehalf", type: "address", label: "On Behalf Of" },
        { name: "data", type: "bytes", label: "Callback Data", default: "0x" },
      ],
    },
    {
      slug: "supply-collateral",
      label: "Supply Collateral",
      description:
        "Deposit collateral tokens into a Morpho market for borrowing",
      type: "write",
      contract: "morpho",
      function: "supplyCollateral",
      inputs: [
        { name: "loanToken", type: "address", label: "Loan Token Address" },
        {
          name: "collateralToken",
          type: "address",
          label: "Collateral Token Address",
        },
        { name: "oracle", type: "address", label: "Oracle Address" },
        { name: "irm", type: "address", label: "IRM Address" },
        { name: "lltv", type: "uint256", label: "Liquidation LTV" },
        {
          name: "assets",
          type: "uint256",
          label: "Collateral Amount",
          decimals: true,
        },
        { name: "onBehalf", type: "address", label: "On Behalf Of" },
        { name: "data", type: "bytes", label: "Callback Data", default: "0x" },
      ],
    },
    {
      slug: "withdraw-collateral",
      label: "Withdraw Collateral",
      description: "Remove collateral tokens from a Morpho market position",
      type: "write",
      contract: "morpho",
      function: "withdrawCollateral",
      inputs: [
        { name: "loanToken", type: "address", label: "Loan Token Address" },
        {
          name: "collateralToken",
          type: "address",
          label: "Collateral Token Address",
        },
        { name: "oracle", type: "address", label: "Oracle Address" },
        { name: "irm", type: "address", label: "IRM Address" },
        { name: "lltv", type: "uint256", label: "Liquidation LTV" },
        {
          name: "assets",
          type: "uint256",
          label: "Collateral Amount",
          decimals: true,
        },
        { name: "onBehalf", type: "address", label: "On Behalf Of" },
        { name: "receiver", type: "address", label: "Receiver Address" },
      ],
    },
    {
      slug: "liquidate",
      label: "Liquidate",
      description:
        "Liquidate an undercollateralized position in a Morpho market",
      type: "write",
      contract: "morpho",
      function: "liquidate",
      inputs: [
        { name: "loanToken", type: "address", label: "Loan Token Address" },
        {
          name: "collateralToken",
          type: "address",
          label: "Collateral Token Address",
        },
        { name: "oracle", type: "address", label: "Oracle Address" },
        { name: "irm", type: "address", label: "IRM Address" },
        { name: "lltv", type: "uint256", label: "Liquidation LTV" },
        { name: "borrower", type: "address", label: "Borrower Address" },
        {
          name: "seizedAssets",
          type: "uint256",
          label: "Seized Collateral Amount",
          decimals: true,
        },
        {
          name: "repaidShares",
          type: "uint256",
          label: "Repaid Shares",
          default: "0",
        },
        { name: "data", type: "bytes", label: "Callback Data", default: "0x" },
      ],
    },
    {
      slug: "accrue-interest",
      label: "Accrue Interest",
      description:
        "Trigger interest accrual for a Morpho market to update supply and borrow indices",
      type: "write",
      contract: "morpho",
      function: "accrueInterest",
      inputs: [
        { name: "loanToken", type: "address", label: "Loan Token Address" },
        {
          name: "collateralToken",
          type: "address",
          label: "Collateral Token Address",
        },
        { name: "oracle", type: "address", label: "Oracle Address" },
        { name: "irm", type: "address", label: "IRM Address" },
        { name: "lltv", type: "uint256", label: "Liquidation LTV" },
      ],
    },
  ],
});
