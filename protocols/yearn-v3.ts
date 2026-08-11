import { defineAbiProtocol } from "@/lib/protocol-registry";
import {
  amount,
  native,
  type ProtocolTestData,
  wallet,
} from "@/lib/test-data/types";
import { erc4626AbiOverrides } from "@/lib/web3/standards/erc4626";

// The vault contract is userSpecifiedAddress, so every action binds a
// concrete vault. The registry's chain-1 fallback (a 45-byte proxy with
// no live implementation) is not callable; target the live USDC-1 yVault
// instead - verified 2026-07-03 via eth_call (name, asset=USDC,
// totalAssets ~25.6M).
const MAINNET_TEST_VAULT = "0xBe53A109B494E5c9f97b9Cd39Fe969BE68BF6204";

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
      "get-price-per-share": { contractAddress: MAINNET_TEST_VAULT },
      "get-total-idle": { contractAddress: MAINNET_TEST_VAULT },
      "get-total-debt": { contractAddress: MAINNET_TEST_VAULT },
      "get-is-shutdown": { contractAddress: MAINNET_TEST_VAULT },
      "get-api-version": { contractAddress: MAINNET_TEST_VAULT },
      "get-profit-max-unlock-time": { contractAddress: MAINNET_TEST_VAULT },
      "get-full-profit-unlock-date": { contractAddress: MAINNET_TEST_VAULT },
      "get-accountant": { contractAddress: MAINNET_TEST_VAULT },
      "get-deposit-limit": { contractAddress: MAINNET_TEST_VAULT },
      "get-role-manager": { contractAddress: MAINNET_TEST_VAULT },
      "get-use-default-queue": { contractAddress: MAINNET_TEST_VAULT },
      "get-minimum-total-idle": { contractAddress: MAINNET_TEST_VAULT },
      "get-vault-decimals": { contractAddress: MAINNET_TEST_VAULT },
      "vault-deposit": {
        contractAddress: MAINNET_TEST_VAULT,
        assets: amount("USDC", "100"),
        receiver: wallet(),
      },
      "vault-mint": {
        contractAddress: MAINNET_TEST_VAULT,
        shares: amount("USDC", "10"),
        receiver: wallet(),
      },
      "vault-withdraw": {
        contractAddress: MAINNET_TEST_VAULT,
        assets: amount("USDC", "20"),
        receiver: wallet(),
        owner: wallet(),
      },
      "vault-redeem": {
        contractAddress: MAINNET_TEST_VAULT,
        shares: amount("USDC", "10"),
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
    },
    // Live-vault invariants on the USDC-1 vault. Yearn V3's inline ABI has
    // unnamed outputs, so assertions target the bare result (no field). asset
    // is a permanent address; totals/supply/price-per-share are large and
    // monotonic; convert/preview are pure per-share quotes; decimals mirrors
    // USDC (6); the vault is live (not shut down) with a set role manager and
    // a version string. max-deposit/mint are omitted deliberately: V3 vaults
    // carry a deposit_limit, so maxDeposit can legitimately be zero at cap.
    // Caller-position reads (balance, max-withdraw/redeem) and the
    // can-legitimately-be-zero config reads (total-idle, total-debt,
    // accountant, minimum-total-idle) are left unasserted.
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
      "get-price-per-share": [{ nonZero: true }],
      "get-vault-decimals": [{ equals: "6" }],
      "get-api-version": [{ notEmpty: true }],
      "get-is-shutdown": [{ equals: "false" }],
      "get-role-manager": [{ notEmpty: true }],
    },
  },
};

// Yearn V3 vaults are EIP-1167 minimal proxies. The ABI cache cannot resolve
// implementation ABIs for clones, so we provide the ABI inline.
// Covers the full ERC-4626 interface plus Yearn-specific view functions
// from VaultV3.vy. snake_case Vyper function names need slug overrides.
const YEARN_V3_VAULT_ABI = JSON.stringify([
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
  // Yearn V3 specific view functions
  {
    name: "pricePerShare",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "totalIdle",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "totalDebt",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "isShutdown",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "apiVersion",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    name: "profitMaxUnlockTime",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "fullProfitUnlockDate",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "accountant",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "deposit_limit",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "role_manager",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "use_default_queue",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "minimum_total_idle",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
]);

export default defineAbiProtocol({
  name: "Yearn V3",
  slug: "yearn",
  description:
    "Yearn V3 yield vaults: fully ERC-4626 compliant yield aggregators with automated strategy management",
  website: "https://yearn.fi",
  icon: "/protocols/yearn.png",

  testData: TEST_DATA,

  contracts: {
    vault: {
      label: "Yearn V3 Vault",
      abi: YEARN_V3_VAULT_ABI,
      userSpecifiedAddress: true,
      addresses: {
        // Ethereum Mainnet (yvUSDC example — actual address is user-specified)
        "1": "0x22028E652a2e937c876F2577f8E78f692d6DAA93",
        // Polygon
        "137": "0xA013Fbd4b711f9ded6fB09C1c0d358E2FbC2EAA0",
        // Arbitrum One
        "42161": "0x6FAF8b7fFeE3306EfcFc2BA9Fec912b4d49834C1",
      },
      overrides: {
        // 18 standard ERC-4626 overrides
        ...erc4626AbiOverrides(),

        // Yearn V3 specific reads
        pricePerShare: {
          slug: "get-price-per-share",
          label: "Price Per Share",
          description:
            "Get the current price per vault share in underlying asset terms",
          outputs: {
            result: { name: "pricePerShare", label: "Price Per Share" },
          },
        },
        totalIdle: {
          slug: "get-total-idle",
          label: "Total Idle Assets",
          description:
            "Get the total amount of underlying assets sitting idle in the vault (not deployed to strategies)",
          outputs: {
            result: { name: "totalIdle", label: "Total Idle Assets" },
          },
        },
        totalDebt: {
          slug: "get-total-debt",
          label: "Total Debt",
          description:
            "Get the total amount of underlying assets deployed to strategies",
          outputs: {
            result: { name: "totalDebt", label: "Total Debt" },
          },
        },
        isShutdown: {
          slug: "get-is-shutdown",
          label: "Is Vault Shutdown",
          description: "Check whether the vault has been shut down",
          outputs: {
            result: { name: "isShutdown", label: "Shutdown Status" },
          },
        },
        apiVersion: {
          slug: "get-api-version",
          label: "API Version",
          description: "Get the Yearn vault API version string",
          outputs: {
            result: { name: "apiVersion", label: "API Version" },
          },
        },
        profitMaxUnlockTime: {
          slug: "get-profit-max-unlock-time",
          label: "Profit Max Unlock Time",
          description:
            "Get the time in seconds over which profits are linearly unlocked",
          outputs: {
            result: {
              name: "profitMaxUnlockTime",
              label: "Unlock Duration (seconds)",
            },
          },
        },
        fullProfitUnlockDate: {
          slug: "get-full-profit-unlock-date",
          label: "Full Profit Unlock Date",
          description:
            "Get the Unix timestamp when all current profits will be fully unlocked",
          outputs: {
            result: { name: "fullProfitUnlockDate", label: "Unlock Timestamp" },
          },
        },
        accountant: {
          slug: "get-accountant",
          label: "Vault Accountant",
          description:
            "Get the address of the vault accountant contract that manages fees and profit reporting",
          outputs: {
            result: { name: "accountant", label: "Accountant Address" },
          },
        },
        deposit_limit: {
          slug: "get-deposit-limit",
          label: "Deposit Limit",
          description:
            "Get the maximum total deposit limit for the vault (0 means deposits are closed)",
          outputs: {
            result: { name: "depositLimit", label: "Deposit Limit" },
          },
        },
        role_manager: {
          slug: "get-role-manager",
          label: "Role Manager",
          description: "Get the address of the vault role manager contract",
          outputs: {
            result: { name: "roleManager", label: "Role Manager Address" },
          },
        },
        use_default_queue: {
          slug: "get-use-default-queue",
          label: "Use Default Queue",
          description:
            "Check whether the vault uses the default withdrawal queue order",
          outputs: {
            result: { name: "useDefaultQueue", label: "Use Default Queue" },
          },
        },
        minimum_total_idle: {
          slug: "get-minimum-total-idle",
          label: "Minimum Total Idle",
          description:
            "Get the minimum amount of underlying assets the vault keeps liquid",
          outputs: {
            result: {
              name: "minimumTotalIdle",
              label: "Minimum Total Idle (wei)",
            },
          },
        },
        decimals: {
          slug: "get-vault-decimals",
          label: "Vault Decimals",
          description: "Get the number of decimals for the vault share token",
          outputs: {
            result: { name: "decimals", label: "Decimals" },
          },
        },
      },
    },
  },
});
