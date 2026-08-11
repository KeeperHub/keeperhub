import type {
  AbiFunctionOverride,
  ProtocolAction,
} from "@/lib/protocol-registry";

/**
 * Returns the 18 standard ERC-4626 vault actions for a given contract key.
 * Use this in protocol definitions to avoid duplicating vault action boilerplate.
 *
 * 4 write actions: deposit, mint, withdraw, redeem
 * 14 read actions: asset, totalAssets, totalSupply, balanceOf, convertToAssets,
 *   convertToShares, previewDeposit, previewMint, previewWithdraw, previewRedeem,
 *   maxDeposit, maxMint, maxWithdraw, maxRedeem
 *
 * When a protocol has multiple ERC-4626 vaults, pass a slugPrefix to
 * disambiguate (e.g., "st-usds" produces "st-usds-vault-deposit").
 * The default (no prefix) produces "vault-deposit" for backwards compatibility.
 *
 * Pass `decimals` to override the default of 18 for vaults wrapping non-18-decimal
 * assets (e.g., USDC = 6, WBTC = 8).
 */
export function erc4626VaultActions(
  contract: string,
  options?: { slugPrefix?: string; labelPrefix?: string; decimals?: number }
): ProtocolAction[] {
  const p = options?.slugPrefix ? `${options.slugPrefix}-` : "";
  const lp = options?.labelPrefix ? `${options.labelPrefix} ` : "";
  const d = options?.decimals ?? 18;

  return [
    // Write actions

    {
      slug: `${p}vault-deposit`,
      label: `${lp}Vault Deposit`,
      description: "Deposit assets into the ERC-4626 vault and receive shares",
      type: "write",
      contract,
      function: "deposit",
      inputs: [
        { name: "assets", type: "uint256", label: "Asset Amount (wei)" },
        { name: "receiver", type: "address", label: "Receiver Address" },
      ],
    },
    {
      slug: `${p}vault-mint`,
      label: `${lp}Vault Mint`,
      description:
        "Mint exact vault shares by depositing the required amount of assets",
      type: "write",
      contract,
      function: "mint",
      inputs: [
        { name: "shares", type: "uint256", label: "Shares Amount (wei)" },
        { name: "receiver", type: "address", label: "Receiver Address" },
      ],
    },
    {
      slug: `${p}vault-withdraw`,
      label: `${lp}Vault Withdraw`,
      description:
        "Withdraw assets from the ERC-4626 vault by specifying asset amount",
      type: "write",
      contract,
      function: "withdraw",
      inputs: [
        { name: "assets", type: "uint256", label: "Asset Amount (wei)" },
        { name: "receiver", type: "address", label: "Receiver Address" },
        { name: "owner", type: "address", label: "Share Owner Address" },
      ],
    },
    {
      slug: `${p}vault-redeem`,
      label: `${lp}Vault Redeem`,
      description:
        "Redeem shares from the ERC-4626 vault for underlying assets",
      type: "write",
      contract,
      function: "redeem",
      inputs: [
        { name: "shares", type: "uint256", label: "Shares Amount (wei)" },
        { name: "receiver", type: "address", label: "Receiver Address" },
        { name: "owner", type: "address", label: "Share Owner Address" },
      ],
    },

    // Read actions

    {
      slug: `${p}vault-asset`,
      label: `${lp}Vault Underlying Asset`,
      description:
        "Get the address of the underlying asset token for this vault",
      type: "read",
      contract,
      function: "asset",
      inputs: [],
      outputs: [
        { name: "asset", type: "address", label: "Underlying Asset Address" },
      ],
    },
    {
      slug: `${p}vault-total-assets`,
      label: `${lp}Vault Total Assets`,
      description:
        "Get the total amount of underlying assets held by the vault",
      type: "read",
      contract,
      function: "totalAssets",
      inputs: [],
      outputs: [
        {
          name: "totalAssets",
          type: "uint256",
          label: "Total Assets (wei)",
          decimals: d,
        },
      ],
    },
    {
      slug: `${p}vault-total-supply`,
      label: `${lp}Vault Total Supply`,
      description: "Get the total supply of vault shares",
      type: "read",
      contract,
      function: "totalSupply",
      inputs: [],
      outputs: [
        {
          name: "totalSupply",
          type: "uint256",
          label: "Total Shares (wei)",
          decimals: d,
        },
      ],
    },
    {
      slug: `${p}vault-balance`,
      label: `${lp}Vault Share Balance`,
      description: "Get the vault share balance of an address",
      type: "read",
      contract,
      function: "balanceOf",
      inputs: [{ name: "account", type: "address", label: "Wallet Address" }],
      outputs: [
        {
          name: "balance",
          type: "uint256",
          label: "Share Balance (wei)",
          decimals: d,
        },
      ],
    },
    {
      slug: `${p}vault-convert-to-assets`,
      label: `${lp}Convert Shares to Assets`,
      description:
        "Convert a vault share amount to its underlying asset value at the current rate",
      type: "read",
      contract,
      function: "convertToAssets",
      inputs: [
        { name: "shares", type: "uint256", label: "Shares Amount (wei)" },
      ],
      outputs: [
        {
          name: "assets",
          type: "uint256",
          label: "Asset Value (wei)",
          decimals: d,
        },
      ],
    },
    {
      slug: `${p}vault-convert-to-shares`,
      label: `${lp}Convert Assets to Shares`,
      description:
        "Convert an asset amount to the equivalent vault shares at the current rate",
      type: "read",
      contract,
      function: "convertToShares",
      inputs: [
        { name: "assets", type: "uint256", label: "Asset Amount (wei)" },
      ],
      outputs: [
        {
          name: "shares",
          type: "uint256",
          label: "Shares Amount (wei)",
          decimals: d,
        },
      ],
    },
    {
      slug: `${p}vault-preview-deposit`,
      label: `${lp}Preview Vault Deposit`,
      description: "Preview how many shares a given asset deposit would yield",
      type: "read",
      contract,
      function: "previewDeposit",
      inputs: [
        { name: "assets", type: "uint256", label: "Asset Amount (wei)" },
      ],
      outputs: [
        {
          name: "shares",
          type: "uint256",
          label: "Shares Received (wei)",
          decimals: d,
        },
      ],
    },
    {
      slug: `${p}vault-preview-mint`,
      label: `${lp}Preview Vault Mint`,
      description:
        "Preview how many assets are needed to mint a given number of shares",
      type: "read",
      contract,
      function: "previewMint",
      inputs: [
        { name: "shares", type: "uint256", label: "Shares Amount (wei)" },
      ],
      outputs: [
        {
          name: "assets",
          type: "uint256",
          label: "Assets Required (wei)",
          decimals: d,
        },
      ],
    },
    {
      slug: `${p}vault-preview-withdraw`,
      label: `${lp}Preview Vault Withdraw`,
      description:
        "Preview how many shares must be burned to withdraw a given asset amount",
      type: "read",
      contract,
      function: "previewWithdraw",
      inputs: [
        { name: "assets", type: "uint256", label: "Asset Amount (wei)" },
      ],
      outputs: [
        {
          name: "shares",
          type: "uint256",
          label: "Shares Burned (wei)",
          decimals: d,
        },
      ],
    },
    {
      slug: `${p}vault-preview-redeem`,
      label: `${lp}Preview Vault Redeem`,
      description:
        "Preview how many assets a given share redemption would yield",
      type: "read",
      contract,
      function: "previewRedeem",
      inputs: [
        { name: "shares", type: "uint256", label: "Shares Amount (wei)" },
      ],
      outputs: [
        {
          name: "assets",
          type: "uint256",
          label: "Assets Received (wei)",
          decimals: d,
        },
      ],
    },
    {
      slug: `${p}vault-max-deposit`,
      label: `${lp}Max Vault Deposit`,
      description:
        "Get the maximum amount of assets that can be deposited for a receiver",
      type: "read",
      contract,
      function: "maxDeposit",
      inputs: [
        { name: "receiver", type: "address", label: "Receiver Address" },
      ],
      outputs: [
        {
          name: "maxAssets",
          type: "uint256",
          label: "Max Deposit (wei)",
          decimals: d,
        },
      ],
    },
    {
      slug: `${p}vault-max-mint`,
      label: `${lp}Max Vault Mint`,
      description:
        "Get the maximum number of shares that can be minted for a receiver",
      type: "read",
      contract,
      function: "maxMint",
      inputs: [
        { name: "receiver", type: "address", label: "Receiver Address" },
      ],
      outputs: [
        {
          name: "maxShares",
          type: "uint256",
          label: "Max Mint (wei)",
          decimals: d,
        },
      ],
    },
    {
      slug: `${p}vault-max-withdraw`,
      label: `${lp}Max Vault Withdraw`,
      description:
        "Get the maximum amount of assets that can be withdrawn by an owner",
      type: "read",
      contract,
      function: "maxWithdraw",
      inputs: [{ name: "owner", type: "address", label: "Owner Address" }],
      outputs: [
        {
          name: "maxAssets",
          type: "uint256",
          label: "Max Withdraw (wei)",
          decimals: d,
        },
      ],
    },
    {
      slug: `${p}vault-max-redeem`,
      label: `${lp}Max Vault Redeem`,
      description:
        "Get the maximum number of shares that can be redeemed by an owner",
      type: "read",
      contract,
      function: "maxRedeem",
      inputs: [{ name: "owner", type: "address", label: "Owner Address" }],
      outputs: [
        {
          name: "maxShares",
          type: "uint256",
          label: "Max Redeem (wei)",
          decimals: d,
        },
      ],
    },
  ];
}

/**
 * Returns overrides for all 18 standard ERC-4626 vault functions, mapping each
 * auto-derived slug (e.g. "balance-of") to the "vault-*" slug pattern used by
 * erc4626VaultActions. Use this in defineAbiProtocol contracts to produce the
 * same slugs as erc4626VaultActions without duplicating 18 entries.
 *
 * Pass the same options you would pass to erc4626VaultActions so slug/label
 * prefixes and decimals remain consistent between the two helpers.
 */
export function erc4626AbiOverrides(options?: {
  slugPrefix?: string;
  labelPrefix?: string;
  decimals?: number;
}): Record<string, AbiFunctionOverride> {
  const p = options?.slugPrefix ? `${options.slugPrefix}-` : "";
  const lp = options?.labelPrefix ? `${options.labelPrefix} ` : "";
  const d = options?.decimals ?? 18;

  return {
    deposit: {
      slug: `${p}vault-deposit`,
      label: `${lp}Vault Deposit`,
      description: "Deposit assets into the ERC-4626 vault and receive shares",
      inputs: {
        assets: { label: "Asset Amount (wei)" },
        receiver: { label: "Receiver Address" },
      },
    },
    mint: {
      slug: `${p}vault-mint`,
      label: `${lp}Vault Mint`,
      description:
        "Mint exact vault shares by depositing the required amount of assets",
      inputs: {
        shares: { label: "Shares Amount (wei)" },
        receiver: { label: "Receiver Address" },
      },
    },
    withdraw: {
      slug: `${p}vault-withdraw`,
      label: `${lp}Vault Withdraw`,
      description:
        "Withdraw assets from the ERC-4626 vault by specifying asset amount",
      inputs: {
        assets: { label: "Asset Amount (wei)" },
        receiver: { label: "Receiver Address" },
        owner: { label: "Share Owner Address" },
      },
    },
    redeem: {
      slug: `${p}vault-redeem`,
      label: `${lp}Vault Redeem`,
      description:
        "Redeem shares from the ERC-4626 vault for underlying assets",
      inputs: {
        shares: { label: "Shares Amount (wei)" },
        receiver: { label: "Receiver Address" },
        owner: { label: "Share Owner Address" },
      },
    },
    asset: {
      slug: `${p}vault-asset`,
      label: `${lp}Vault Underlying Asset`,
      description:
        "Get the address of the underlying asset token for this vault",
      outputs: { result: { name: "asset", label: "Underlying Asset Address" } },
    },
    totalAssets: {
      slug: `${p}vault-total-assets`,
      label: `${lp}Vault Total Assets`,
      description:
        "Get the total amount of underlying assets held by the vault",
      outputs: {
        result: {
          name: "totalAssets",
          label: "Total Assets (wei)",
          decimals: d,
        },
      },
    },
    totalSupply: {
      slug: `${p}vault-total-supply`,
      label: `${lp}Vault Total Supply`,
      description: "Get the total supply of vault shares",
      outputs: {
        result: {
          name: "totalSupply",
          label: "Total Shares (wei)",
          decimals: d,
        },
      },
    },
    balanceOf: {
      slug: `${p}vault-balance`,
      label: `${lp}Vault Share Balance`,
      description: "Get the vault share balance of an address",
      inputs: { account: { label: "Wallet Address" } },
      outputs: {
        result: { name: "balance", label: "Share Balance (wei)", decimals: d },
      },
    },
    convertToAssets: {
      slug: `${p}vault-convert-to-assets`,
      label: `${lp}Convert Shares to Assets`,
      description:
        "Convert a vault share amount to its underlying asset value at the current rate",
      inputs: { shares: { label: "Shares Amount (wei)" } },
      outputs: {
        result: { name: "assets", label: "Asset Value (wei)", decimals: d },
      },
    },
    convertToShares: {
      slug: `${p}vault-convert-to-shares`,
      label: `${lp}Convert Assets to Shares`,
      description:
        "Convert an asset amount to the equivalent vault shares at the current rate",
      inputs: { assets: { label: "Asset Amount (wei)" } },
      outputs: {
        result: { name: "shares", label: "Shares Amount (wei)", decimals: d },
      },
    },
    previewDeposit: {
      slug: `${p}vault-preview-deposit`,
      label: `${lp}Preview Vault Deposit`,
      description: "Preview how many shares a given asset deposit would yield",
      inputs: { assets: { label: "Asset Amount (wei)" } },
      outputs: {
        result: { name: "shares", label: "Shares Received (wei)", decimals: d },
      },
    },
    previewMint: {
      slug: `${p}vault-preview-mint`,
      label: `${lp}Preview Vault Mint`,
      description:
        "Preview how many assets are needed to mint a given number of shares",
      inputs: { shares: { label: "Shares Amount (wei)" } },
      outputs: {
        result: { name: "assets", label: "Assets Required (wei)", decimals: d },
      },
    },
    previewWithdraw: {
      slug: `${p}vault-preview-withdraw`,
      label: `${lp}Preview Vault Withdraw`,
      description:
        "Preview how many shares must be burned to withdraw a given asset amount",
      inputs: { assets: { label: "Asset Amount (wei)" } },
      outputs: {
        result: { name: "shares", label: "Shares Burned (wei)", decimals: d },
      },
    },
    previewRedeem: {
      slug: `${p}vault-preview-redeem`,
      label: `${lp}Preview Vault Redeem`,
      description:
        "Preview how many assets a given share redemption would yield",
      inputs: { shares: { label: "Shares Amount (wei)" } },
      outputs: {
        result: { name: "assets", label: "Assets Received (wei)", decimals: d },
      },
    },
    maxDeposit: {
      slug: `${p}vault-max-deposit`,
      label: `${lp}Max Vault Deposit`,
      description:
        "Get the maximum amount of assets that can be deposited for a receiver",
      inputs: { receiver: { label: "Receiver Address" } },
      outputs: {
        result: { name: "maxAssets", label: "Max Deposit (wei)", decimals: d },
      },
    },
    maxMint: {
      slug: `${p}vault-max-mint`,
      label: `${lp}Max Vault Mint`,
      description:
        "Get the maximum number of shares that can be minted for a receiver",
      inputs: { receiver: { label: "Receiver Address" } },
      outputs: {
        result: { name: "maxShares", label: "Max Mint (wei)", decimals: d },
      },
    },
    maxWithdraw: {
      slug: `${p}vault-max-withdraw`,
      label: `${lp}Max Vault Withdraw`,
      description:
        "Get the maximum amount of assets that can be withdrawn by an owner",
      inputs: { owner: { label: "Owner Address" } },
      outputs: {
        result: { name: "maxAssets", label: "Max Withdraw (wei)", decimals: d },
      },
    },
    maxRedeem: {
      slug: `${p}vault-max-redeem`,
      label: `${lp}Max Vault Redeem`,
      description:
        "Get the maximum number of shares that can be redeemed by an owner",
      inputs: { owner: { label: "Owner Address" } },
      outputs: {
        result: { name: "maxShares", label: "Max Redeem (wei)", decimals: d },
      },
    },
  };
}
