import { defineAbiProtocol } from "@/lib/protocol-registry";
import { amount, contract, wallet } from "@/lib/test-data/types";
import { erc4626AbiOverrides } from "@/lib/web3/standards/erc4626";

// Standard ERC-4626 interface. Input param names must match the keys in
// erc4626AbiOverrides so overrides bind correctly. All outputs are unnamed
// (single-output functions resolve to "result").
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

const ERC20_ABI = JSON.stringify([
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
]);

const ERC20_READONLY_ABI = JSON.stringify([
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
]);

const ERC20_READONLY_WITH_SUPPLY_ABI = JSON.stringify([
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
]);

const DAI_USDS_CONVERTER_ABI = JSON.stringify([
  {
    type: "function",
    name: "daiToUsds",
    stateMutability: "nonpayable",
    inputs: [
      { name: "usr", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "usdsToDai",
    stateMutability: "nonpayable",
    inputs: [
      { name: "usr", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
]);

const MKR_SKY_CONVERTER_ABI = JSON.stringify([
  {
    type: "function",
    name: "mkrToSky",
    stateMutability: "nonpayable",
    inputs: [
      { name: "usr", type: "address" },
      { name: "mkrAmt", type: "uint256" },
    ],
    outputs: [],
  },
]);

export default defineAbiProtocol({
  name: "Sky",
  slug: "sky",
  description:
    "Sky Protocol (formerly MakerDAO): USDS savings, token management, and DAI/MKR migration",
  website: "https://sky.money",
  icon: "/protocols/sky.png",

  testData: {
    "1": {
      setup: {
        minNativeHuman: "0.01",
        // USDS and MKR arrive via balances-slot fabrication (no live
        // whale: the PSM USDS whale drained by 2026-07-08; MKR never had
        // one). DAI comes from the MCD_JOIN_DAI whale. Budgets: the
        // sUSDS/stUSDS deposit+mint fixtures consume ~232 USDS combined
        // (mint pulls previewMint assets at ~1.06-1.10 USDS/share,
        // observed 2026-07-08), converters take 10 DAI and 0.5 MKR.
        requiredTokens: [
          { symbol: "USDS", human: "500" },
          { symbol: "DAI", human: "25" },
          { symbol: "MKR", human: "1" },
        ],
        approvals: [],
        // Fabricated (anvil_setStorageAt) rather than real approve-token
        // nodes: five approvals through the app's approve-token path,
        // whose gas-sponsorship fallback takes minutes each on the CI
        // fork, would blow the 300s setup timeout.
        fabricatedApprovals: [
          { token: "USDS", spender: contract("sUsds"), human: "200" },
          { token: "USDS", spender: contract("stUsds"), human: "200" },
          { token: "USDS", spender: contract("daiUsdsConverter"), human: "50" },
          { token: "DAI", spender: contract("daiUsdsConverter"), human: "25" },
          { token: "MKR", spender: contract("mkrSkyConverter"), human: "1" },
        ],
      },
      actions: {
        // sUSDS vault reads
        "vault-asset": {},
        "vault-total-assets": {},
        "vault-total-supply": {},
        "vault-balance": { account: wallet() },
        "vault-convert-to-assets": { shares: amount("USDS", "1") },
        "vault-convert-to-shares": { assets: amount("USDS", "1") },
        "vault-preview-deposit": { assets: amount("USDS", "1") },
        "vault-preview-mint": { shares: amount("USDS", "1") },
        "vault-preview-withdraw": { assets: amount("USDS", "1") },
        "vault-preview-redeem": { shares: amount("USDS", "1") },
        "vault-max-deposit": { receiver: wallet() },
        "vault-max-mint": { receiver: wallet() },
        "vault-max-withdraw": { owner: wallet() },
        "vault-max-redeem": { owner: wallet() },
        // stUSDS vault reads
        "st-usds-vault-asset": {},
        "st-usds-vault-total-assets": {},
        "st-usds-vault-total-supply": {},
        "st-usds-vault-balance": { account: wallet() },
        "st-usds-vault-convert-to-assets": { shares: amount("USDS", "1") },
        "st-usds-vault-convert-to-shares": { assets: amount("USDS", "1") },
        "st-usds-vault-preview-deposit": { assets: amount("USDS", "1") },
        "st-usds-vault-preview-mint": { shares: amount("USDS", "1") },
        "st-usds-vault-preview-withdraw": { assets: amount("USDS", "1") },
        "st-usds-vault-preview-redeem": { shares: amount("USDS", "1") },
        "st-usds-vault-max-deposit": { receiver: wallet() },
        "st-usds-vault-max-mint": { receiver: wallet() },
        "st-usds-vault-max-withdraw": { owner: wallet() },
        "st-usds-vault-max-redeem": { owner: wallet() },
        // Token balances
        "get-usds-balance": { account: wallet() },
        "get-dai-balance": { account: wallet() },
        "get-sky-balance": { account: wallet() },
        "approve-dai": { spender: wallet() },
        "approve-usds": { spender: wallet() },
        "convert-dai-to-usds": { usr: wallet(), amount: amount("DAI", "10") },
        "convert-usds-to-dai": { usr: wallet(), amount: amount("USDS", "10") },
        "convert-mkr-to-sky": { usr: wallet(), mkrAmt: amount("MKR", "0.5") },
        // Writes run in registry order, so the deposits open the share
        // positions the withdraw/redeem fixtures spend.
        "vault-deposit": {
          assets: amount("USDS", "100"),
          receiver: wallet(),
        },
        "vault-mint": { shares: amount("USDS", "10"), receiver: wallet() },
        "vault-withdraw": {
          assets: amount("USDS", "20"),
          receiver: wallet(),
          owner: wallet(),
        },
        "vault-redeem": {
          shares: amount("USDS", "10"),
          receiver: wallet(),
          owner: wallet(),
        },
        "st-usds-vault-deposit": {
          assets: amount("USDS", "100"),
          receiver: wallet(),
        },
        "st-usds-vault-mint": {
          shares: amount("USDS", "10"),
          receiver: wallet(),
        },
        "st-usds-vault-withdraw": {
          assets: amount("USDS", "20"),
          receiver: wallet(),
          owner: wallet(),
        },
        "st-usds-vault-redeem": {
          shares: amount("USDS", "10"),
          receiver: wallet(),
          owner: wallet(),
        },
      },
      skipped: {
        "get-susds-balance-l2":
          "L2 action - sUsdsL2 contract only on Base/Arbitrum",
        "get-susds-total-supply-l2":
          "L2 action - sUsdsL2 contract only on Base/Arbitrum",
      },
      // approve-dai and approve-usds run the app's real approve-token path,
      // which fans out cold token state on a fresh fork and runs past the
      // default two-minute wait; give them the same headroom as ethena
      // approve-usde / lido approve-steth / curve crv-approve.
      executionWaitMs: {
        "approve-dai": 240_000,
        "approve-usds": 240_000,
      },
      // Chain invariants on both ERC-4626 vaults (sUSDS, stUSDS). All
      // outputs are unnamed, so assertions target the bare result (no
      // field). asset is a permanent address; totals/supply are large and
      // monotonic; convert/preview are pure per-share quotes independent of
      // the caller; max-deposit/mint are the vaults' uncapped limits. The
      // caller-position reads (balance, max-withdraw, max-redeem) and the
      // shared-wallet token balances are history-dependent and left
      // unasserted, matching the rules in
      // specs/protocol-coverage-methodology.md.
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
        "st-usds-vault-asset": [{ notEmpty: true }],
        "st-usds-vault-total-assets": [{ nonZero: true }],
        "st-usds-vault-total-supply": [{ nonZero: true }],
        "st-usds-vault-convert-to-assets": [{ nonZero: true }],
        "st-usds-vault-convert-to-shares": [{ nonZero: true }],
        "st-usds-vault-preview-deposit": [{ nonZero: true }],
        "st-usds-vault-preview-mint": [{ nonZero: true }],
        "st-usds-vault-preview-withdraw": [{ nonZero: true }],
        "st-usds-vault-preview-redeem": [{ nonZero: true }],
        "st-usds-vault-max-deposit": [{ nonZero: true }],
        "st-usds-vault-max-mint": [{ nonZero: true }],
      },
      // Post-write oracles: a deposit/mint must actually credit vault shares
      // (a mined receipt alone misses a no-op write). nonZero is
      // history-safe on the simulation tier's dedicated wallet.
      writeExpectations: {
        "vault-deposit": [{ read: "vault-balance", expect: { nonZero: true } }],
        "vault-mint": [{ read: "vault-balance", expect: { nonZero: true } }],
        "st-usds-vault-deposit": [
          { read: "st-usds-vault-balance", expect: { nonZero: true } },
        ],
        "st-usds-vault-mint": [
          { read: "st-usds-vault-balance", expect: { nonZero: true } },
        ],
      },
    },
    "8453": {
      setup: {
        minNativeHuman: "0.01",
        requiredTokens: [],
        approvals: [],
      },
      actions: {
        "get-susds-balance-l2": { account: wallet() },
        "get-susds-total-supply-l2": {},
        // USDS itself is deployed on Base, so its balance read belongs in
        // the run set rather than the skip list.
        "get-usds-balance": { account: wallet() },
      },
      skipped: {
        "vault-asset": "Mainnet only - sUsds contract not on Base",
        "vault-total-assets": "Mainnet only - sUsds contract not on Base",
        "vault-total-supply": "Mainnet only - sUsds contract not on Base",
        "vault-balance": "Mainnet only - sUsds contract not on Base",
        "vault-convert-to-assets": "Mainnet only - sUsds contract not on Base",
        "vault-convert-to-shares": "Mainnet only - sUsds contract not on Base",
        "vault-preview-deposit": "Mainnet only - sUsds contract not on Base",
        "vault-preview-mint": "Mainnet only - sUsds contract not on Base",
        "vault-preview-withdraw": "Mainnet only - sUsds contract not on Base",
        "vault-preview-redeem": "Mainnet only - sUsds contract not on Base",
        "vault-max-deposit": "Mainnet only - sUsds contract not on Base",
        "vault-max-mint": "Mainnet only - sUsds contract not on Base",
        "vault-max-withdraw": "Mainnet only - sUsds contract not on Base",
        "vault-max-redeem": "Mainnet only - sUsds contract not on Base",
        "vault-deposit": "Mainnet only - sUsds contract not on Base",
        "vault-mint": "Mainnet only - sUsds contract not on Base",
        "vault-withdraw": "Mainnet only - sUsds contract not on Base",
        "vault-redeem": "Mainnet only - sUsds contract not on Base",
        "st-usds-vault-asset": "Mainnet only - stUsds contract not on Base",
        "st-usds-vault-total-assets":
          "Mainnet only - stUsds contract not on Base",
        "st-usds-vault-total-supply":
          "Mainnet only - stUsds contract not on Base",
        "st-usds-vault-balance": "Mainnet only - stUsds contract not on Base",
        "st-usds-vault-convert-to-assets":
          "Mainnet only - stUsds contract not on Base",
        "st-usds-vault-convert-to-shares":
          "Mainnet only - stUsds contract not on Base",
        "st-usds-vault-preview-deposit":
          "Mainnet only - stUsds contract not on Base",
        "st-usds-vault-preview-mint":
          "Mainnet only - stUsds contract not on Base",
        "st-usds-vault-preview-withdraw":
          "Mainnet only - stUsds contract not on Base",
        "st-usds-vault-preview-redeem":
          "Mainnet only - stUsds contract not on Base",
        "st-usds-vault-max-deposit":
          "Mainnet only - stUsds contract not on Base",
        "st-usds-vault-max-mint": "Mainnet only - stUsds contract not on Base",
        "st-usds-vault-max-withdraw":
          "Mainnet only - stUsds contract not on Base",
        "st-usds-vault-max-redeem":
          "Mainnet only - stUsds contract not on Base",
        "st-usds-vault-deposit": "Mainnet only - stUsds contract not on Base",
        "st-usds-vault-mint": "Mainnet only - stUsds contract not on Base",
        "st-usds-vault-withdraw": "Mainnet only - stUsds contract not on Base",
        "st-usds-vault-redeem": "Mainnet only - stUsds contract not on Base",
        "approve-usds":
          "USDS is on Base, but this block provisions no approvals - the approve-token write path is covered on chain 1",
        "get-dai-balance": "Mainnet only - dai contract not on Base",
        "approve-dai": "Mainnet only - dai contract not on Base",
        "get-sky-balance": "Mainnet only - sky contract not on Base",
        "convert-dai-to-usds": "Mainnet only - daiUsds contract not on Base",
        "convert-usds-to-dai": "Mainnet only - daiUsds contract not on Base",
        "convert-mkr-to-sky": "Mainnet only - mkrSky contract not on Base",
      },
      expectations: {
        "get-susds-total-supply-l2": [{ nonZero: true }],
      },
    },
    "42161": {
      setup: {
        minNativeHuman: "0.01",
        requiredTokens: [],
        approvals: [],
      },
      actions: {
        "get-susds-balance-l2": { account: wallet() },
        "get-susds-total-supply-l2": {},
        // USDS itself is deployed on Arbitrum, so its balance read belongs
        // in the run set rather than the skip list.
        "get-usds-balance": { account: wallet() },
      },
      skipped: {
        "vault-asset": "Mainnet only - sUsds contract not on Arbitrum",
        "vault-total-assets": "Mainnet only - sUsds contract not on Arbitrum",
        "vault-total-supply": "Mainnet only - sUsds contract not on Arbitrum",
        "vault-balance": "Mainnet only - sUsds contract not on Arbitrum",
        "vault-convert-to-assets":
          "Mainnet only - sUsds contract not on Arbitrum",
        "vault-convert-to-shares":
          "Mainnet only - sUsds contract not on Arbitrum",
        "vault-preview-deposit":
          "Mainnet only - sUsds contract not on Arbitrum",
        "vault-preview-mint": "Mainnet only - sUsds contract not on Arbitrum",
        "vault-preview-withdraw":
          "Mainnet only - sUsds contract not on Arbitrum",
        "vault-preview-redeem": "Mainnet only - sUsds contract not on Arbitrum",
        "vault-max-deposit": "Mainnet only - sUsds contract not on Arbitrum",
        "vault-max-mint": "Mainnet only - sUsds contract not on Arbitrum",
        "vault-max-withdraw": "Mainnet only - sUsds contract not on Arbitrum",
        "vault-max-redeem": "Mainnet only - sUsds contract not on Arbitrum",
        "vault-deposit": "Mainnet only - sUsds contract not on Arbitrum",
        "vault-mint": "Mainnet only - sUsds contract not on Arbitrum",
        "vault-withdraw": "Mainnet only - sUsds contract not on Arbitrum",
        "vault-redeem": "Mainnet only - sUsds contract not on Arbitrum",
        "st-usds-vault-asset": "Mainnet only - stUsds contract not on Arbitrum",
        "st-usds-vault-total-assets":
          "Mainnet only - stUsds contract not on Arbitrum",
        "st-usds-vault-total-supply":
          "Mainnet only - stUsds contract not on Arbitrum",
        "st-usds-vault-balance":
          "Mainnet only - stUsds contract not on Arbitrum",
        "st-usds-vault-convert-to-assets":
          "Mainnet only - stUsds contract not on Arbitrum",
        "st-usds-vault-convert-to-shares":
          "Mainnet only - stUsds contract not on Arbitrum",
        "st-usds-vault-preview-deposit":
          "Mainnet only - stUsds contract not on Arbitrum",
        "st-usds-vault-preview-mint":
          "Mainnet only - stUsds contract not on Arbitrum",
        "st-usds-vault-preview-withdraw":
          "Mainnet only - stUsds contract not on Arbitrum",
        "st-usds-vault-preview-redeem":
          "Mainnet only - stUsds contract not on Arbitrum",
        "st-usds-vault-max-deposit":
          "Mainnet only - stUsds contract not on Arbitrum",
        "st-usds-vault-max-mint":
          "Mainnet only - stUsds contract not on Arbitrum",
        "st-usds-vault-max-withdraw":
          "Mainnet only - stUsds contract not on Arbitrum",
        "st-usds-vault-max-redeem":
          "Mainnet only - stUsds contract not on Arbitrum",
        "st-usds-vault-deposit":
          "Mainnet only - stUsds contract not on Arbitrum",
        "st-usds-vault-mint": "Mainnet only - stUsds contract not on Arbitrum",
        "st-usds-vault-withdraw":
          "Mainnet only - stUsds contract not on Arbitrum",
        "st-usds-vault-redeem":
          "Mainnet only - stUsds contract not on Arbitrum",
        "approve-usds":
          "USDS is on Arbitrum, but this block provisions no approvals - the approve-token write path is covered on chain 1",
        "get-dai-balance": "Mainnet only - dai contract not on Arbitrum",
        "approve-dai": "Mainnet only - dai contract not on Arbitrum",
        "get-sky-balance": "Mainnet only - sky contract not on Arbitrum",
        "convert-dai-to-usds":
          "Mainnet only - daiUsds contract not on Arbitrum",
        "convert-usds-to-dai":
          "Mainnet only - daiUsds contract not on Arbitrum",
        "convert-mkr-to-sky": "Mainnet only - mkrSky contract not on Arbitrum",
      },
      expectations: {
        "get-susds-total-supply-l2": [{ nonZero: true }],
      },
    },
  },

  contracts: {
    sUsds: {
      label: "sUSDS (Savings USDS)",
      abi: ERC4626_VAULT_ABI,
      addresses: {
        // Ethereum Mainnet -- proxy
        "1": "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD",
      },
      overrides: erc4626AbiOverrides(),
    },
    sUsdsL2: {
      label: "sUSDS (Savings USDS) - L2",
      abi: ERC20_READONLY_WITH_SUPPLY_ABI,
      addresses: {
        // Base - only ERC-20 functions (ERC-4626 vault functions not implemented)
        "8453": "0x5875eEE11Cf8398102FdAd704C9E96607675467a",
        // Arbitrum One - only ERC-20 functions (ERC-4626 vault functions not implemented)
        "42161": "0xdDb46999F8891663a8F2828d25298f70416d7610",
      },
      overrides: {
        balanceOf: {
          slug: "get-susds-balance-l2",
          label: "Get sUSDS Balance (L2)",
          description: "Check the sUSDS balance of an address on L2",
          inputs: { account: { label: "Wallet Address" } },
          outputs: {
            result: {
              name: "balance",
              label: "sUSDS Balance (wei)",
              decimals: 18,
            },
          },
        },
        totalSupply: {
          slug: "get-susds-total-supply-l2",
          label: "Get sUSDS Total Supply (L2)",
          description: "Get the total supply of sUSDS tokens on L2",
          outputs: {
            result: {
              name: "totalSupply",
              label: "Total sUSDS Supply (wei)",
              decimals: 18,
            },
          },
        },
      },
    },
    stUsds: {
      label: "stUSDS (Staked USDS)",
      abi: ERC4626_VAULT_ABI,
      addresses: {
        // Ethereum Mainnet
        "1": "0x99CD4Ec3f88A45940936F469E4bB72A2A701EEB9",
      },
      overrides: erc4626AbiOverrides({
        slugPrefix: "st-usds",
        labelPrefix: "stUSDS",
      }),
    },
    usds: {
      label: "USDS Stablecoin",
      abi: ERC20_ABI,
      addresses: {
        // Ethereum Mainnet -- proxy
        "1": "0xdC035D45d973E3EC169d2276DDab16f1e407384F",
        // Base
        "8453": "0x820C137fa70C8691f0e44Dc420a5e53c168921Dc",
        // Arbitrum One
        "42161": "0x6491c05A82219b8D1479057361ff1654749b876b",
      },
      overrides: {
        balanceOf: {
          slug: "get-usds-balance",
          label: "Get USDS Balance",
          description: "Check the USDS balance of an address",
          inputs: { account: { label: "Wallet Address" } },
          outputs: {
            result: {
              name: "balance",
              label: "USDS Balance (wei)",
              decimals: 18,
            },
          },
        },
        approve: {
          slug: "approve-usds",
          label: "Approve USDS Spending",
          description: "Approve a spender to transfer USDS on your behalf",
          inputs: {
            spender: { label: "Spender Address" },
            amount: { label: "Approval Amount (wei)" },
          },
        },
      },
    },
    dai: {
      label: "DAI Stablecoin (Legacy)",
      abi: ERC20_ABI,
      addresses: {
        // Ethereum Mainnet
        "1": "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      },
      overrides: {
        balanceOf: {
          slug: "get-dai-balance",
          label: "Get DAI Balance",
          description: "Check the DAI balance of an address",
          inputs: { account: { label: "Wallet Address" } },
          outputs: {
            result: {
              name: "balance",
              label: "DAI Balance (wei)",
              decimals: 18,
            },
          },
        },
        approve: {
          slug: "approve-dai",
          label: "Approve DAI Spending",
          description: "Approve a spender to transfer DAI on your behalf",
          inputs: {
            spender: { label: "Spender Address" },
            amount: { label: "Approval Amount (wei)" },
          },
        },
      },
    },
    sky: {
      label: "SKY Governance Token",
      abi: ERC20_READONLY_ABI,
      addresses: {
        // Ethereum Mainnet
        "1": "0x56072C95FAA701256059aa122697B133aDEd9279",
      },
      overrides: {
        balanceOf: {
          slug: "get-sky-balance",
          label: "Get SKY Balance",
          description: "Check the SKY balance of an address",
          inputs: { account: { label: "Wallet Address" } },
          outputs: {
            result: {
              name: "balance",
              label: "SKY Balance (wei)",
              decimals: 18,
            },
          },
        },
      },
    },
    daiUsdsConverter: {
      label: "DAI-USDS Converter",
      abi: DAI_USDS_CONVERTER_ABI,
      addresses: {
        // Ethereum Mainnet
        "1": "0x3225737a9Bbb6473CB4a45b7244ACa2BeFdB276A",
      },
      overrides: {
        daiToUsds: {
          slug: "convert-dai-to-usds",
          label: "Convert DAI to USDS",
          description:
            "Convert DAI to USDS at a 1:1 rate via the official converter (Ethereum only)",
          inputs: {
            usr: { label: "Recipient Address" },
            amount: { label: "DAI Amount (wei)" },
          },
        },
        usdsToDai: {
          slug: "convert-usds-to-dai",
          label: "Convert USDS to DAI",
          description:
            "Convert USDS back to DAI at a 1:1 rate via the official converter (Ethereum only)",
          inputs: {
            usr: { label: "Recipient Address" },
            amount: { label: "USDS Amount (wei)" },
          },
        },
      },
    },
    mkrSkyConverter: {
      label: "MKR-SKY Converter",
      abi: MKR_SKY_CONVERTER_ABI,
      addresses: {
        // Ethereum Mainnet
        "1": "0xA1Ea1bA18E88C381C724a75F23a130420C403f9a",
      },
      overrides: {
        mkrToSky: {
          slug: "convert-mkr-to-sky",
          label: "Convert MKR to SKY",
          description:
            "Convert MKR governance tokens to SKY via the official converter (Ethereum only)",
          inputs: {
            usr: { label: "Recipient Address" },
            mkrAmt: { label: "MKR Amount (wei)" },
          },
        },
      },
    },
  },
});
