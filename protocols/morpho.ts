import { AbiCoder, keccak256 } from "ethers";
import { defineAbiProtocol } from "@/lib/protocol-registry";
import {
  type ActionInputBindings,
  amount,
  contract,
  native,
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

// Morpho Blue's on-chain market id is keccak256(abi.encode(MarketParams)),
// the 5 fields above in struct order. Deriving it here (rather than hand-
// copying the hash) means it can never drift from WSTETH_USDC_MARKET.
const MARKET_ID = keccak256(
  AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "address", "address", "uint256"],
    [
      WSTETH_USDC_MARKET.loanToken,
      WSTETH_USDC_MARKET.collateralToken,
      WSTETH_USDC_MARKET.oracle,
      WSTETH_USDC_MARKET.irm,
      WSTETH_USDC_MARKET.lltv,
    ]
  )
);

// MetaMorpho vault actions target a live mainnet vault: the contract is
// userSpecifiedAddress, so every action binds Steakhouse USDC explicitly
// (verified 2026-07-03 via eth_call: name, asset=USDC, totalAssets ~94M).
//
// Single source for the 18 standard ERC-4626 vault action slugs (must match
// the "vault-*" slugs produced by contracts.vault.overrides below), typed
// as Record<VaultActionSlug, _> so a missing or misspelled slug is a
// compile error instead of a silent gap.
const VAULT_ACTION_SLUGS = [
  "vault-deposit",
  "vault-mint",
  "vault-withdraw",
  "vault-redeem",
  "vault-asset",
  "vault-total-assets",
  "vault-total-supply",
  "vault-balance",
  "vault-convert-to-assets",
  "vault-convert-to-shares",
  "vault-preview-deposit",
  "vault-preview-mint",
  "vault-preview-withdraw",
  "vault-preview-redeem",
  "vault-max-deposit",
  "vault-max-mint",
  "vault-max-withdraw",
  "vault-max-redeem",
] as const;
type VaultActionSlug = (typeof VAULT_ACTION_SLUGS)[number];

const MAINNET_TEST_METAMORPHO = "0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB";

const VAULT_BINDINGS: Record<VaultActionSlug, ActionInputBindings> = {
  "vault-asset": { contractAddress: MAINNET_TEST_METAMORPHO },
  "vault-total-assets": { contractAddress: MAINNET_TEST_METAMORPHO },
  "vault-total-supply": { contractAddress: MAINNET_TEST_METAMORPHO },
  "vault-balance": {
    contractAddress: MAINNET_TEST_METAMORPHO,
    account: wallet(),
  },
  "vault-convert-to-assets": {
    contractAddress: MAINNET_TEST_METAMORPHO,
    shares: native("1"),
  },
  "vault-convert-to-shares": {
    contractAddress: MAINNET_TEST_METAMORPHO,
    assets: amount("USDC", "1"),
  },
  "vault-preview-deposit": {
    contractAddress: MAINNET_TEST_METAMORPHO,
    assets: amount("USDC", "1"),
  },
  "vault-preview-mint": {
    contractAddress: MAINNET_TEST_METAMORPHO,
    shares: native("1"),
  },
  "vault-preview-withdraw": {
    contractAddress: MAINNET_TEST_METAMORPHO,
    assets: amount("USDC", "1"),
  },
  "vault-preview-redeem": {
    contractAddress: MAINNET_TEST_METAMORPHO,
    shares: native("1"),
  },
  "vault-max-deposit": {
    contractAddress: MAINNET_TEST_METAMORPHO,
    receiver: wallet(),
  },
  "vault-max-mint": {
    contractAddress: MAINNET_TEST_METAMORPHO,
    receiver: wallet(),
  },
  "vault-max-withdraw": {
    contractAddress: MAINNET_TEST_METAMORPHO,
    owner: wallet(),
  },
  "vault-max-redeem": {
    contractAddress: MAINNET_TEST_METAMORPHO,
    owner: wallet(),
  },
  // Write order follows the registry: deposit provides the share balance
  // the later writes consume.
  "vault-deposit": {
    contractAddress: MAINNET_TEST_METAMORPHO,
    assets: amount("USDC", "50"),
    receiver: wallet(),
  },
  "vault-mint": {
    contractAddress: MAINNET_TEST_METAMORPHO,
    shares: native("0.000001"),
    receiver: wallet(),
  },
  "vault-withdraw": {
    contractAddress: MAINNET_TEST_METAMORPHO,
    assets: amount("USDC", "10"),
    receiver: wallet(),
    owner: wallet(),
  },
  "vault-redeem": {
    contractAddress: MAINNET_TEST_METAMORPHO,
    shares: native("0.000001"),
    receiver: wallet(),
    owner: wallet(),
  },
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
        // MetaMorpho vault deposits pull USDC from the wallet directly.
        { token: "USDC", spender: MAINNET_TEST_METAMORPHO, human: "60" },
      ],
    },
    skipped: {
      liquidate: "requires undercollateralized position",
      "flash-loan": "requires callback contract implementation",
    },
    actions: {
      ...VAULT_BINDINGS,
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
        // Must flip state or Morpho reverts "already set": fresh forks
        // start unauthorized, so grant rather than revoke.
        newIsAuthorized: "true",
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
        // Small relative to the 0.1 wstETH collateral so the health check
        // holds with wide margin at every later step regardless of accrued
        // interest between writes (one borderline failure observed at 20).
        assets: amount("USDC", "10"),
        shares: "0",
        onBehalf: wallet(),
        receiver: wallet(),
      },
      repay: {
        ...WSTETH_USDC_MARKET,
        // Must stay below the outstanding debt (borrow of 10 plus interest):
        // Morpho reverts when repaying more assets than are owed.
        assets: amount("USDC", "8"),
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
        // Withdraw a small fraction: residual interest debt after repay
        // means removing too much collateral trips the health check.
        assets: amount("WSTETH", "0.02"),
        onBehalf: wallet(),
        receiver: wallet(),
      },
      // vault-* actions need no bindings here: they're all in `skipped`
      // (no real vault address at test time), and the builder now fills
      // unbound address inputs on skipped actions with a placeholder.
      //
      // liquidate and flash-loan are also skipped (state/callback
      // prerequisites, not a missing address), but keep explicit bindings
      // since they document what a real call against WSTETH_USDC_MARKET
      // looks like.
      liquidate: {
        ...WSTETH_USDC_MARKET,
        borrower: wallet(),
        seizedAssets: amount("WSTETH", "0.01"),
        repaidShares: "0",
        data: "0x",
      },
      "flash-loan": { token: "USDC", assets: amount("USDC", "1"), data: "0x" },
    },
    // Named outputs throughout (Morpho Blue + MetaMorpho ABIs). MetaMorpho
    // vault invariants: asset is a permanent address; totals/supply large and
    // monotonic; convert/preview pure per-share quotes; max-deposit/mint the
    // vault caps. Morpho Blue market invariants: the wstETH/USDC market has
    // live supply/borrow; its lltv is a fixed 86% and loanToken is permanent;
    // isAuthorized(wallet, wallet) is false on a fresh fork (the write
    // authorizes dEaD, not the wallet, so this stays false). Caller-position
    // reads (get-position, vault-balance, vault-max-withdraw/redeem) read zero
    // at the read phase and carry post-write oracles below instead.
    expectations: {
      "vault-asset": [{ field: "asset", notEmpty: true }],
      "vault-total-assets": [{ field: "totalAssets", nonZero: true }],
      "vault-total-supply": [{ field: "totalSupply", nonZero: true }],
      "vault-convert-to-assets": [{ field: "assets", nonZero: true }],
      "vault-convert-to-shares": [{ field: "shares", nonZero: true }],
      "vault-preview-deposit": [{ field: "shares", nonZero: true }],
      "vault-preview-mint": [{ field: "assets", nonZero: true }],
      "vault-preview-withdraw": [{ field: "shares", nonZero: true }],
      "vault-preview-redeem": [{ field: "assets", nonZero: true }],
      "vault-max-deposit": [{ field: "maxAssets", nonZero: true }],
      "vault-max-mint": [{ field: "maxShares", nonZero: true }],
      "get-market": [
        { field: "totalSupplyAssets", nonZero: true },
        { field: "totalBorrowAssets", nonZero: true },
      ],
      "get-market-params": [
        { field: "lltv", equals: "860000000000000000" },
        { field: "loanToken", notEmpty: true },
      ],
      "is-authorized": [{ field: "isAuthorized", equals: "false" }],
    },
    // Post-write oracles: collateral/supply/borrow must register on the
    // caller position, accrue-interest keeps the market solvent, and a vault
    // deposit/mint must credit shares. All nonZero (history-safe: grow within
    // the run). set-authorization has no aligned probe (the read binds
    // wallet/wallet, the write authorizes dEaD) and is left liveness-only.
    writeExpectations: {
      "supply-collateral": [
        {
          read: "get-position",
          expect: { field: "collateral", nonZero: true },
        },
      ],
      supply: [
        {
          read: "get-position",
          expect: { field: "supplyShares", nonZero: true },
        },
      ],
      borrow: [
        {
          read: "get-position",
          expect: { field: "borrowShares", nonZero: true },
        },
      ],
      "accrue-interest": [
        {
          read: "get-market",
          expect: { field: "totalSupplyAssets", nonZero: true },
        },
      ],
      "vault-deposit": [
        { read: "vault-balance", expect: { field: "balance", nonZero: true } },
      ],
      "vault-mint": [
        { read: "vault-balance", expect: { field: "balance", nonZero: true } },
      ],
    },
  },
};

const MARKET_PARAMS_TUPLE = {
  name: "marketParams",
  type: "tuple",
  components: [
    { name: "loanToken", type: "address" },
    { name: "collateralToken", type: "address" },
    { name: "oracle", type: "address" },
    { name: "irm", type: "address" },
    { name: "lltv", type: "uint256" },
  ],
};

const MARKET_PARAMS_INPUT_OVERRIDES = {
  loanToken: { label: "Loan Token Address" },
  collateralToken: { label: "Collateral Token Address" },
  oracle: { label: "Oracle Address" },
  irm: { label: "IRM Address" },
  lltv: { label: "Liquidation LTV" },
};

export default defineAbiProtocol({
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
      abi: JSON.stringify([
        {
          type: "function",
          name: "position",
          stateMutability: "view",
          inputs: [
            { name: "id", type: "bytes32" },
            { name: "user", type: "address" },
          ],
          outputs: [
            { name: "supplyShares", type: "uint256" },
            { name: "borrowShares", type: "uint128" },
            { name: "collateral", type: "uint128" },
          ],
        },
        {
          type: "function",
          name: "market",
          stateMutability: "view",
          inputs: [{ name: "id", type: "bytes32" }],
          outputs: [
            { name: "totalSupplyAssets", type: "uint128" },
            { name: "totalSupplyShares", type: "uint128" },
            { name: "totalBorrowAssets", type: "uint128" },
            { name: "totalBorrowShares", type: "uint128" },
            { name: "lastUpdate", type: "uint128" },
            { name: "fee", type: "uint128" },
          ],
        },
        {
          type: "function",
          name: "idToMarketParams",
          stateMutability: "view",
          inputs: [{ name: "id", type: "bytes32" }],
          outputs: [
            { name: "loanToken", type: "address" },
            { name: "collateralToken", type: "address" },
            { name: "oracle", type: "address" },
            { name: "irm", type: "address" },
            { name: "lltv", type: "uint256" },
          ],
        },
        {
          type: "function",
          name: "isAuthorized",
          stateMutability: "view",
          inputs: [
            { name: "authorizer", type: "address" },
            { name: "authorized", type: "address" },
          ],
          outputs: [{ name: "isAuthorized", type: "bool" }],
        },
        {
          type: "function",
          name: "setAuthorization",
          stateMutability: "nonpayable",
          inputs: [
            { name: "authorized", type: "address" },
            { name: "newIsAuthorized", type: "bool" },
          ],
          outputs: [],
        },
        {
          type: "function",
          name: "flashLoan",
          stateMutability: "nonpayable",
          inputs: [
            { name: "token", type: "address" },
            { name: "assets", type: "uint256" },
            { name: "data", type: "bytes" },
          ],
          outputs: [],
        },
        {
          type: "function",
          name: "supply",
          stateMutability: "nonpayable",
          inputs: [
            MARKET_PARAMS_TUPLE,
            { name: "assets", type: "uint256" },
            { name: "shares", type: "uint256" },
            { name: "onBehalf", type: "address" },
            { name: "data", type: "bytes" },
          ],
          outputs: [],
        },
        {
          type: "function",
          name: "withdraw",
          stateMutability: "nonpayable",
          inputs: [
            MARKET_PARAMS_TUPLE,
            { name: "assets", type: "uint256" },
            { name: "shares", type: "uint256" },
            { name: "onBehalf", type: "address" },
            { name: "receiver", type: "address" },
          ],
          outputs: [],
        },
        // Action order is registry order: supplyCollateral must precede
        // borrow so the coverage and simulation write sequences have
        // collateral before borrowing against it (cf. aave-v3 POOL_ABI).
        {
          type: "function",
          name: "supplyCollateral",
          stateMutability: "nonpayable",
          inputs: [
            MARKET_PARAMS_TUPLE,
            { name: "assets", type: "uint256" },
            { name: "onBehalf", type: "address" },
            { name: "data", type: "bytes" },
          ],
          outputs: [],
        },
        {
          type: "function",
          name: "borrow",
          stateMutability: "nonpayable",
          inputs: [
            MARKET_PARAMS_TUPLE,
            { name: "assets", type: "uint256" },
            { name: "shares", type: "uint256" },
            { name: "onBehalf", type: "address" },
            { name: "receiver", type: "address" },
          ],
          outputs: [],
        },
        {
          type: "function",
          name: "repay",
          stateMutability: "nonpayable",
          inputs: [
            MARKET_PARAMS_TUPLE,
            { name: "assets", type: "uint256" },
            { name: "shares", type: "uint256" },
            { name: "onBehalf", type: "address" },
            { name: "data", type: "bytes" },
          ],
          outputs: [],
        },
        {
          type: "function",
          name: "withdrawCollateral",
          stateMutability: "nonpayable",
          inputs: [
            MARKET_PARAMS_TUPLE,
            { name: "assets", type: "uint256" },
            { name: "onBehalf", type: "address" },
            { name: "receiver", type: "address" },
          ],
          outputs: [],
        },
        {
          type: "function",
          name: "liquidate",
          stateMutability: "nonpayable",
          inputs: [
            MARKET_PARAMS_TUPLE,
            { name: "borrower", type: "address" },
            { name: "seizedAssets", type: "uint256" },
            { name: "repaidShares", type: "uint256" },
            { name: "data", type: "bytes" },
          ],
          outputs: [],
        },
        {
          type: "function",
          name: "accrueInterest",
          stateMutability: "nonpayable",
          inputs: [MARKET_PARAMS_TUPLE],
          outputs: [],
        },
      ]),
      overrides: {
        position: {
          slug: "get-position",
          label: "Get Position",
          description:
            "Check a user's supply shares, borrow shares, and collateral in a Morpho market",
          inputs: {
            id: { label: "Market ID" },
            user: { label: "User Address" },
          },
        },
        market: {
          slug: "get-market",
          label: "Get Market",
          description:
            "Check total supply, borrows, last update time, and fee for a Morpho market",
          inputs: {
            id: { label: "Market ID" },
          },
          outputs: {
            lastUpdate: { label: "Last Update Timestamp" },
          },
        },
        idToMarketParams: {
          slug: "get-market-params",
          label: "Get Market Params",
          description:
            "Resolve a market ID to its parameters: loan token, collateral token, oracle, IRM, and LLTV",
          inputs: {
            id: { label: "Market ID" },
          },
          outputs: {
            irm: { label: "Interest Rate Model" },
            lltv: { label: "Liquidation LTV" },
          },
        },
        isAuthorized: {
          label: "Check Authorization",
          description:
            "Check if an address is authorized to act on behalf of another in Morpho",
          inputs: {
            authorizer: { label: "Authorizer Address" },
            authorized: { label: "Authorized Address" },
          },
        },
        setAuthorization: {
          description:
            "Grant or revoke authorization for another address to act on your behalf in Morpho",
          inputs: {
            authorized: { label: "Authorized Address" },
            newIsAuthorized: { label: "Authorize" },
          },
        },
        flashLoan: {
          description:
            "Borrow tokens and repay within the same transaction via Morpho flash loan",
          inputs: {
            token: { label: "Token Address" },
            assets: { label: "Amount (wei)", decimals: true },
            data: { label: "Callback Data", default: "0x" },
          },
        },
        supply: {
          description:
            "Supply loan tokens to a Morpho market. Specify amount in assets or shares (set the other to 0)",
          inputs: {
            ...MARKET_PARAMS_INPUT_OVERRIDES,
            assets: { label: "Asset Amount", decimals: true },
            shares: { label: "Share Amount", default: "0" },
            onBehalf: { label: "On Behalf Of" },
            data: { label: "Callback Data", default: "0x" },
          },
        },
        withdraw: {
          description:
            "Withdraw supplied loan tokens from a Morpho market. Specify amount in assets or shares (set the other to 0)",
          inputs: {
            ...MARKET_PARAMS_INPUT_OVERRIDES,
            assets: { label: "Asset Amount", decimals: true },
            shares: { label: "Share Amount", default: "0" },
            onBehalf: { label: "On Behalf Of" },
            receiver: { label: "Receiver Address" },
          },
        },
        borrow: {
          description:
            "Borrow loan tokens from a Morpho market against deposited collateral",
          inputs: {
            ...MARKET_PARAMS_INPUT_OVERRIDES,
            assets: { label: "Asset Amount", decimals: true },
            shares: { label: "Share Amount", default: "0" },
            onBehalf: { label: "On Behalf Of" },
            receiver: { label: "Receiver Address" },
          },
        },
        repay: {
          description:
            "Repay borrowed loan tokens to a Morpho market. Specify amount in assets or shares (set the other to 0)",
          inputs: {
            ...MARKET_PARAMS_INPUT_OVERRIDES,
            assets: { label: "Asset Amount", decimals: true },
            shares: { label: "Share Amount", default: "0" },
            onBehalf: { label: "On Behalf Of" },
            data: { label: "Callback Data", default: "0x" },
          },
        },
        supplyCollateral: {
          description:
            "Deposit collateral tokens into a Morpho market for borrowing",
          inputs: {
            ...MARKET_PARAMS_INPUT_OVERRIDES,
            assets: { label: "Collateral Amount", decimals: true },
            onBehalf: { label: "On Behalf Of" },
            data: { label: "Callback Data", default: "0x" },
          },
        },
        withdrawCollateral: {
          description: "Remove collateral tokens from a Morpho market position",
          inputs: {
            ...MARKET_PARAMS_INPUT_OVERRIDES,
            assets: { label: "Collateral Amount", decimals: true },
            onBehalf: { label: "On Behalf Of" },
            receiver: { label: "Receiver Address" },
          },
        },
        liquidate: {
          description:
            "Liquidate an undercollateralized position in a Morpho market",
          inputs: {
            ...MARKET_PARAMS_INPUT_OVERRIDES,
            borrower: { label: "Borrower Address" },
            seizedAssets: { label: "Seized Collateral Amount", decimals: true },
            repaidShares: { label: "Repaid Shares", default: "0" },
            data: { label: "Callback Data", default: "0x" },
          },
        },
        accrueInterest: {
          description:
            "Trigger interest accrual for a Morpho market to update supply and borrow indices",
          inputs: {
            ...MARKET_PARAMS_INPUT_OVERRIDES,
          },
        },
      },
    },
    vault: {
      label: "MetaMorpho Vault",
      addresses: {},
      userSpecifiedAddress: true,
      abi: JSON.stringify([
        {
          type: "function",
          name: "deposit",
          stateMutability: "nonpayable",
          inputs: [
            { name: "assets", type: "uint256" },
            { name: "receiver", type: "address" },
          ],
          outputs: [],
        },
        {
          type: "function",
          name: "mint",
          stateMutability: "nonpayable",
          inputs: [
            { name: "shares", type: "uint256" },
            { name: "receiver", type: "address" },
          ],
          outputs: [],
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
          outputs: [],
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
          outputs: [],
        },
        {
          type: "function",
          name: "asset",
          stateMutability: "view",
          inputs: [],
          outputs: [{ name: "asset", type: "address" }],
        },
        {
          type: "function",
          name: "totalAssets",
          stateMutability: "view",
          inputs: [],
          outputs: [{ name: "totalAssets", type: "uint256" }],
        },
        {
          type: "function",
          name: "totalSupply",
          stateMutability: "view",
          inputs: [],
          outputs: [{ name: "totalSupply", type: "uint256" }],
        },
        {
          type: "function",
          name: "balanceOf",
          stateMutability: "view",
          inputs: [{ name: "account", type: "address" }],
          outputs: [{ name: "balance", type: "uint256" }],
        },
        {
          type: "function",
          name: "convertToAssets",
          stateMutability: "view",
          inputs: [{ name: "shares", type: "uint256" }],
          outputs: [{ name: "assets", type: "uint256" }],
        },
        {
          type: "function",
          name: "convertToShares",
          stateMutability: "view",
          inputs: [{ name: "assets", type: "uint256" }],
          outputs: [{ name: "shares", type: "uint256" }],
        },
        {
          type: "function",
          name: "previewDeposit",
          stateMutability: "view",
          inputs: [{ name: "assets", type: "uint256" }],
          outputs: [{ name: "shares", type: "uint256" }],
        },
        {
          type: "function",
          name: "previewMint",
          stateMutability: "view",
          inputs: [{ name: "shares", type: "uint256" }],
          outputs: [{ name: "assets", type: "uint256" }],
        },
        {
          type: "function",
          name: "previewWithdraw",
          stateMutability: "view",
          inputs: [{ name: "assets", type: "uint256" }],
          outputs: [{ name: "shares", type: "uint256" }],
        },
        {
          type: "function",
          name: "previewRedeem",
          stateMutability: "view",
          inputs: [{ name: "shares", type: "uint256" }],
          outputs: [{ name: "assets", type: "uint256" }],
        },
        {
          type: "function",
          name: "maxDeposit",
          stateMutability: "view",
          inputs: [{ name: "receiver", type: "address" }],
          outputs: [{ name: "maxAssets", type: "uint256" }],
        },
        {
          type: "function",
          name: "maxMint",
          stateMutability: "view",
          inputs: [{ name: "receiver", type: "address" }],
          outputs: [{ name: "maxShares", type: "uint256" }],
        },
        {
          type: "function",
          name: "maxWithdraw",
          stateMutability: "view",
          inputs: [{ name: "owner", type: "address" }],
          outputs: [{ name: "maxAssets", type: "uint256" }],
        },
        {
          type: "function",
          name: "maxRedeem",
          stateMutability: "view",
          inputs: [{ name: "owner", type: "address" }],
          outputs: [{ name: "maxShares", type: "uint256" }],
        },
      ]),
      overrides: {
        deposit: {
          slug: "vault-deposit",
          label: "Vault Deposit",
          description:
            "Deposit assets into the ERC-4626 vault and receive shares",
          inputs: {
            assets: { label: "Asset Amount (wei)" },
            receiver: { label: "Receiver Address" },
          },
        },
        mint: {
          slug: "vault-mint",
          label: "Vault Mint",
          description:
            "Mint exact vault shares by depositing the required amount of assets",
          inputs: {
            shares: { label: "Shares Amount (wei)" },
            receiver: { label: "Receiver Address" },
          },
        },
        withdraw: {
          slug: "vault-withdraw",
          label: "Vault Withdraw",
          description:
            "Withdraw assets from the ERC-4626 vault by specifying asset amount",
          inputs: {
            assets: { label: "Asset Amount (wei)" },
            receiver: { label: "Receiver Address" },
            owner: { label: "Share Owner Address" },
          },
        },
        redeem: {
          slug: "vault-redeem",
          label: "Vault Redeem",
          description:
            "Redeem shares from the ERC-4626 vault for underlying assets",
          inputs: {
            shares: { label: "Shares Amount (wei)" },
            receiver: { label: "Receiver Address" },
            owner: { label: "Share Owner Address" },
          },
        },
        asset: {
          slug: "vault-asset",
          label: "Vault Underlying Asset",
          description:
            "Get the address of the underlying asset token for this vault",
          outputs: {
            asset: { label: "Underlying Asset Address" },
          },
        },
        totalAssets: {
          slug: "vault-total-assets",
          label: "Vault Total Assets",
          description:
            "Get the total amount of underlying assets held by the vault",
          outputs: {
            totalAssets: { label: "Total Assets (wei)", decimals: 18 },
          },
        },
        totalSupply: {
          slug: "vault-total-supply",
          label: "Vault Total Supply",
          description: "Get the total supply of vault shares",
          outputs: {
            totalSupply: { label: "Total Shares (wei)", decimals: 18 },
          },
        },
        balanceOf: {
          slug: "vault-balance",
          label: "Vault Share Balance",
          description: "Get the vault share balance of an address",
          inputs: {
            account: { label: "Wallet Address" },
          },
          outputs: {
            balance: { label: "Share Balance (wei)", decimals: 18 },
          },
        },
        convertToAssets: {
          slug: "vault-convert-to-assets",
          label: "Convert Shares to Assets",
          description:
            "Convert a vault share amount to its underlying asset value at the current rate",
          inputs: {
            shares: { label: "Shares Amount (wei)" },
          },
          outputs: {
            assets: { label: "Asset Value (wei)", decimals: 18 },
          },
        },
        convertToShares: {
          slug: "vault-convert-to-shares",
          label: "Convert Assets to Shares",
          description:
            "Convert an asset amount to the equivalent vault shares at the current rate",
          inputs: {
            assets: { label: "Asset Amount (wei)" },
          },
          outputs: {
            shares: { label: "Shares Amount (wei)", decimals: 18 },
          },
        },
        previewDeposit: {
          slug: "vault-preview-deposit",
          label: "Preview Vault Deposit",
          description:
            "Preview how many shares a given asset deposit would yield",
          inputs: {
            assets: { label: "Asset Amount (wei)" },
          },
          outputs: {
            shares: { label: "Shares Received (wei)", decimals: 18 },
          },
        },
        previewMint: {
          slug: "vault-preview-mint",
          label: "Preview Vault Mint",
          description:
            "Preview how many assets are needed to mint a given number of shares",
          inputs: {
            shares: { label: "Shares Amount (wei)" },
          },
          outputs: {
            assets: { label: "Assets Required (wei)", decimals: 18 },
          },
        },
        previewWithdraw: {
          slug: "vault-preview-withdraw",
          label: "Preview Vault Withdraw",
          description:
            "Preview how many shares must be burned to withdraw a given asset amount",
          inputs: {
            assets: { label: "Asset Amount (wei)" },
          },
          outputs: {
            shares: { label: "Shares Burned (wei)", decimals: 18 },
          },
        },
        previewRedeem: {
          slug: "vault-preview-redeem",
          label: "Preview Vault Redeem",
          description:
            "Preview how many assets a given share redemption would yield",
          inputs: {
            shares: { label: "Shares Amount (wei)" },
          },
          outputs: {
            assets: { label: "Assets Received (wei)", decimals: 18 },
          },
        },
        maxDeposit: {
          slug: "vault-max-deposit",
          label: "Max Vault Deposit",
          description:
            "Get the maximum amount of assets that can be deposited for a receiver",
          inputs: {
            receiver: { label: "Receiver Address" },
          },
          outputs: {
            maxAssets: { label: "Max Deposit (wei)", decimals: 18 },
          },
        },
        maxMint: {
          slug: "vault-max-mint",
          label: "Max Vault Mint",
          description:
            "Get the maximum number of shares that can be minted for a receiver",
          inputs: {
            receiver: { label: "Receiver Address" },
          },
          outputs: {
            maxShares: { label: "Max Mint (wei)", decimals: 18 },
          },
        },
        maxWithdraw: {
          slug: "vault-max-withdraw",
          label: "Max Vault Withdraw",
          description:
            "Get the maximum amount of assets that can be withdrawn by an owner",
          inputs: {
            owner: { label: "Owner Address" },
          },
          outputs: {
            maxAssets: { label: "Max Withdraw (wei)", decimals: 18 },
          },
        },
        maxRedeem: {
          slug: "vault-max-redeem",
          label: "Max Vault Redeem",
          description:
            "Get the maximum number of shares that can be redeemed by an owner",
          inputs: {
            owner: { label: "Owner Address" },
          },
          outputs: {
            maxShares: { label: "Max Redeem (wei)", decimals: 18 },
          },
        },
      },
    },
  },
});
