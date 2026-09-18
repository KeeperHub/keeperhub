import { defineAbiProtocol } from "@/lib/protocol-registry";
import {
  amount,
  native,
  type ProtocolTestData,
  wallet,
} from "@/lib/test-data/types";
import { erc4626AbiOverrides } from "@/lib/web3/standards/erc4626";

// The vault contract is userSpecifiedAddress, so every action binds a concrete
// EVault. Euler v2 deploys one vault per market, so there is no single canonical
// address; the registry fallback below is only a default.
//
// The mainnet test vault is eUSDC-2, one of Euler's early USDC markets - verified
// 2026-09-11 via eth_call: symbol eUSDC-2, decimals 6, asset = USDC
// (0xA0b8...eB48), totalAssets ~2.036M USDC, maxDeposit ~72.96M USDC of headroom.
//
// Headroom matters here. EVaults carry a supply cap, and a capped vault returns
// maxDeposit() == 0 and reverts the deposit leg. The largest USDC vault by TVL
// (eUSDC-64, ~14.4M) is at its cap and is deliberately not used.
const MAINNET_TEST_VAULT = "0x797DD80692c3b2dAdabCe8e30C07fDE5307D48a9";

const TEST_DATA: ProtocolTestData = {
  "1": {
    setup: {
      minNativeHuman: "0.01",
      requiredTokens: [{ symbol: "USDC", human: "1000" }],
      approvals: [],
      fabricatedApprovals: [
        { token: "USDC", spender: MAINNET_TEST_VAULT, human: "1000" },
      ],
    },
    actions: {
      "vault-asset": { contractAddress: MAINNET_TEST_VAULT },
      "vault-total-assets": { contractAddress: MAINNET_TEST_VAULT },
      "vault-total-supply": { contractAddress: MAINNET_TEST_VAULT },
      "vault-balance": {
        contractAddress: MAINNET_TEST_VAULT,
        account: wallet(),
      },
      "vault-convert-to-assets": {
        contractAddress: MAINNET_TEST_VAULT,
        shares: native("1"),
      },
      "vault-convert-to-shares": {
        contractAddress: MAINNET_TEST_VAULT,
        assets: native("1"),
      },
      "vault-preview-deposit": {
        contractAddress: MAINNET_TEST_VAULT,
        assets: native("1"),
      },
      "vault-preview-mint": {
        contractAddress: MAINNET_TEST_VAULT,
        shares: native("1"),
      },
      "vault-preview-withdraw": {
        contractAddress: MAINNET_TEST_VAULT,
        assets: native("1"),
      },
      "vault-preview-redeem": {
        contractAddress: MAINNET_TEST_VAULT,
        shares: native("1"),
      },
      "vault-max-deposit": {
        contractAddress: MAINNET_TEST_VAULT,
        receiver: wallet(),
      },
      "vault-max-mint": {
        contractAddress: MAINNET_TEST_VAULT,
        receiver: wallet(),
      },
      "vault-max-withdraw": {
        contractAddress: MAINNET_TEST_VAULT,
        owner: wallet(),
      },
      "vault-max-redeem": {
        contractAddress: MAINNET_TEST_VAULT,
        owner: wallet(),
      },
      "get-cash": { contractAddress: MAINNET_TEST_VAULT },
      "get-total-borrows": { contractAddress: MAINNET_TEST_VAULT },
      "get-interest-rate": { contractAddress: MAINNET_TEST_VAULT },
      "get-interest-accumulator": { contractAddress: MAINNET_TEST_VAULT },
      "get-accumulated-fees": { contractAddress: MAINNET_TEST_VAULT },
      "get-debt-of": {
        contractAddress: MAINNET_TEST_VAULT,
        account: wallet(),
      },
      "get-vault-decimals": { contractAddress: MAINNET_TEST_VAULT },
      "get-oracle": { contractAddress: MAINNET_TEST_VAULT },
      "get-unit-of-account": { contractAddress: MAINNET_TEST_VAULT },
      "get-evc": { contractAddress: MAINNET_TEST_VAULT },
      "get-creator": { contractAddress: MAINNET_TEST_VAULT },
      "vault-deposit": {
        contractAddress: MAINNET_TEST_VAULT,
        assets: amount("USDC", "10"),
        receiver: wallet(),
      },
      "vault-mint": {
        contractAddress: MAINNET_TEST_VAULT,
        shares: amount("USDC", "1"),
        receiver: wallet(),
      },
      "vault-withdraw": {
        contractAddress: MAINNET_TEST_VAULT,
        assets: amount("USDC", "1"),
        receiver: wallet(),
        owner: wallet(),
      },
      "vault-redeem": {
        contractAddress: MAINNET_TEST_VAULT,
        shares: amount("USDC", "1"),
        receiver: wallet(),
        owner: wallet(),
      },
    },
    // Funded: USDC (the vault asset) from the mainnet whale plus a fabricated
    // vault approval unlock the deposit/mint/withdraw/redeem sequence (deposits
    // run first in registry order and open the share position the withdraws
    // spend).
    skipped: {},
    writeExpectations: {
      "vault-deposit": [{ read: "vault-balance", expect: { nonZero: true } }],
      "vault-mint": [{ read: "vault-balance", expect: { nonZero: true } }],
      "vault-withdraw": [
        { read: "vault-max-withdraw", expect: { nonZero: true } },
      ],
      "vault-redeem": [{ read: "vault-balance", expect: { nonZero: true } }],
    },
    // Live-vault invariants on the eUSDC-2 market. asset, oracle, unitOfAccount,
    // EVC and creator are permanent addresses; totals and the interest
    // accumulator are large and monotonic; convert/preview are pure per-share
    // quotes; decimals mirrors USDC (6). cash, total-borrows, accumulated-fees
    // and the caller-position reads (balance, debt-of, max-withdraw/redeem) can
    // legitimately be zero and are left unasserted. max-deposit/mint are omitted
    // deliberately: EVaults carry a supply cap, so maxDeposit is legitimately
    // zero once a vault reaches it.
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
      "get-interest-accumulator": [{ nonZero: true }],
      "get-vault-decimals": [{ equals: "6" }],
      "get-oracle": [{ notEmpty: true }],
      "get-unit-of-account": [{ notEmpty: true }],
      "get-evc": [{ notEmpty: true }],
      "get-creator": [{ notEmpty: true }],
    },
  },
};

// Euler v2 EVaults are deployed by GenericFactory as proxies carrying trailing
// metadata, and dispatch each call to a module by delegatecall. The ABI cache
// cannot resolve an implementation ABI through that indirection, so the ABI is
// provided inline.
//
// Note on the write functions: deposit/mint/withdraw/redeem carry a
// callThroughEVC modifier (Dispatch.sol). When the caller is not the Ethereum
// Vault Connector, the vault routes the call through the EVC itself and
// re-enters, so a direct call from an ordinary wallet works with no EVC
// awareness on the caller side. deposit and mint additionally pass
// CHECKACCOUNT_NONE, so no account status check runs on the supply path.
// withdraw and redeem are not symmetric with them: both check the share owner,
// so withdrawing on behalf of a third party needs EVC authorisation, and even a
// self-withdrawal can revert while that account has an open Euler borrow.
const EULER_V2_VAULT_ABI = JSON.stringify([
  // ERC-4626 write functions
  {
    name: "deposit",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "assets", type: "uint256" },
      { name: "receiver", type: "address" },
    ],
    outputs: [{ name: "shares", type: "uint256" }],
  },
  {
    name: "mint",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "shares", type: "uint256" },
      { name: "receiver", type: "address" },
    ],
    outputs: [{ name: "assets", type: "uint256" }],
  },
  {
    name: "withdraw",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "assets", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "owner", type: "address" },
    ],
    outputs: [{ name: "shares", type: "uint256" }],
  },
  {
    name: "redeem",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "shares", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "owner", type: "address" },
    ],
    outputs: [{ name: "assets", type: "uint256" }],
  },
  // ERC-4626 read functions
  {
    name: "asset",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "totalAssets",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "totalSupply",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "convertToAssets",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "shares", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "convertToShares",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "assets", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "previewDeposit",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "assets", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "previewMint",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "shares", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "previewWithdraw",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "assets", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "previewRedeem",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "shares", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "maxDeposit",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "receiver", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "maxMint",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "receiver", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "maxWithdraw",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "maxRedeem",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  // Euler v2 specific reads
  {
    name: "cash",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "totalBorrows",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "interestRate",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "interestAccumulator",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "accumulatedFees",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "debtOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "oracle",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "unitOfAccount",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "EVC",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "creator",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
]);

export default defineAbiProtocol({
  name: "Euler V2",
  slug: "euler-v2",
  description:
    "Euler V2 lending vaults: modular ERC-4626 markets built on the Euler Vault Kit, each pairing a supply-side vault with its own oracle and risk configuration",
  website: "https://euler.finance",
  icon: "/protocols/euler-v2.png",

  testData: TEST_DATA,

  contracts: {
    vault: {
      label: "Euler V2 Vault",
      abi: EULER_V2_VAULT_ABI,
      userSpecifiedAddress: true,
      addresses: {
        // Ethereum Mainnet (eUSDC-2 example - actual address is user-specified)
        "1": "0x797DD80692c3b2dAdabCe8e30C07fDE5307D48a9",
        // Base (eUSDC-100 example - actual address is user-specified)
        "8453": "0x07954BEB7e137101A7cbb3e47864C684aEC50524",
      },
      overrides: {
        // 18 standard ERC-4626 overrides. The helper defaults to 18 decimals,
        // which is wrong for the USDC markets this protocol is most used for, so
        // 6 is passed explicitly. A vault's decimals follow its underlying asset,
        // so a Read Vault Decimals action is exposed for non-USDC markets.
        ...erc4626AbiOverrides({ decimals: 6 }),

        decimals: {
          slug: "get-vault-decimals",
          label: "Vault Decimals",
          description:
            "Get the number of decimals the vault share token uses, which mirrors the underlying asset",
          outputs: {
            result: { name: "decimals", label: "Decimals" },
          },
        },

        // Euler V2 specific reads
        cash: {
          slug: "get-cash",
          label: "Available Cash",
          description:
            "Get the amount of underlying asset held by the vault and available to withdraw or borrow",
          outputs: {
            result: { name: "cash", label: "Available Cash" },
          },
        },
        totalBorrows: {
          slug: "get-total-borrows",
          label: "Total Borrows",
          description:
            "Get the total amount of underlying asset currently borrowed from the vault",
          outputs: {
            result: { name: "totalBorrows", label: "Total Borrows" },
          },
        },
        interestRate: {
          slug: "get-interest-rate",
          label: "Borrow Interest Rate",
          description:
            "Get the current borrow interest rate as a yield per second, scaled by 10^27",
          outputs: {
            result: { name: "interestRate", label: "Borrow Interest Rate" },
          },
        },
        interestAccumulator: {
          slug: "get-interest-accumulator",
          label: "Interest Accumulator",
          description:
            "Get the vault's monotonically increasing interest accumulator, used to derive realised interest between two points in time",
          outputs: {
            result: {
              name: "interestAccumulator",
              label: "Interest Accumulator",
            },
          },
        },
        accumulatedFees: {
          slug: "get-accumulated-fees",
          label: "Accumulated Fees",
          description:
            "Get the shares accrued to the protocol and vault governor as fees but not yet converted",
          outputs: {
            result: { name: "accumulatedFees", label: "Accumulated Fees" },
          },
        },
        debtOf: {
          slug: "get-debt-of",
          label: "Debt Of Account",
          description:
            "Get the amount of underlying asset an account currently owes the vault",
          inputs: {
            account: { label: "Account Address" },
          },
          outputs: {
            result: { name: "debt", label: "Debt" },
          },
        },
        oracle: {
          slug: "get-oracle",
          label: "Vault Oracle",
          description:
            "Get the address of the price oracle this vault prices collateral and liabilities with",
          outputs: {
            result: { name: "oracle", label: "Oracle" },
          },
        },
        unitOfAccount: {
          slug: "get-unit-of-account",
          label: "Unit Of Account",
          description:
            "Get the unit of account the vault denominates risk calculations in. Often a token address, but USD-denominated EVK markets return the ISO-4217 code as an address (0x348 is 840, USD), which is not a contract",
          outputs: {
            result: { name: "unitOfAccount", label: "Unit Of Account" },
          },
        },
        EVC: {
          slug: "get-evc",
          label: "Vault Connector",
          description:
            "Get the address of the Ethereum Vault Connector this vault is bound to",
          outputs: {
            result: { name: "evc", label: "Vault Connector" },
          },
        },
        creator: {
          slug: "get-creator",
          label: "Vault Creator",
          description: "Get the address that deployed this vault",
          outputs: {
            result: { name: "creator", label: "Creator" },
          },
        },
      },
    },
  },
});
