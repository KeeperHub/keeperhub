import { defineAbiProtocol } from "@/lib/protocol-registry";
import { amount, contract, native, wallet } from "@/lib/test-data/types";
import { erc4626AbiOverrides } from "@/lib/web3/standards/erc4626";
import sUsdeAbi from "./abis/ethena-susde.json";

const SUSDE_ALLOWED = new Set<string>([
  "asset",
  "totalAssets",
  "totalSupply",
  "balanceOf",
  "convertToShares",
  "convertToAssets",
  "previewDeposit",
  "previewMint",
  "previewWithdraw",
  "previewRedeem",
  "maxDeposit",
  "maxMint",
  "maxWithdraw",
  "maxRedeem",
  "deposit",
  "mint",
  "withdraw",
  "redeem",
  "cooldownAssets",
  "cooldownShares",
  "cooldownDuration",
  "cooldowns",
  "unstake",
]);
const SUSDE_ABI = JSON.stringify(
  sUsdeAbi.filter((fn) => SUSDE_ALLOWED.has(fn.name))
);

const ERC20_MINIMAL_ABI = JSON.stringify([
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

const ERC20_BALANCE_ABI = JSON.stringify([
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
]);

export default defineAbiProtocol({
  name: "Ethena",
  slug: "ethena",
  description:
    "Ethena Protocol: sUSDe staking vault (ERC-4626), USDe stablecoin, and ENA governance token on Ethereum",
  website: "https://ethena.fi",
  icon: "/protocols/ethena.png",

  testData: {
    "1": {
      setup: {
        minNativeHuman: "0.01",
        // USDe arrives via balances-slot fabrication (no whale
        // registered). Budget: deposit 100 + mint 10 shares
        // (~12.4 USDe at the 2026-07-08 rate) against the 200 approval.
        requiredTokens: [{ symbol: "USDE", human: "300" }],
        approvals: [],
        // Fabricated (anvil_setStorageAt) rather than a real approve-token
        // node: the app's approve-token path takes minutes on the CI fork
        // and pushes the setup toward its 300s timeout.
        fabricatedApprovals: [
          { token: "USDE", spender: contract("sUsde"), human: "200" },
        ],
      },
      actions: {
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
        "get-cooldown-duration": {},
        "get-cooldown-status": { account: wallet() },
        "get-usde-balance": { account: wallet() },
        "get-ena-balance": { account: wallet() },
        "approve-usde": { spender: wallet() },
        // Registry order sequences the writes: deposit/mint open the
        // share position, the cooldown calls burn shares and escrow
        // USDe into the silo, and unstake claims it (its fabrication
        // below marks the real cooldown elapsed first).
        "cooldown-assets": { assets: amount("USDE", "10") },
        "cooldown-shares": { shares: amount("USDE", "10") },
        unstake: { receiver: wallet() },
        "vault-deposit": { assets: amount("USDE", "100"), receiver: wallet() },
        "vault-mint": { shares: amount("USDE", "10"), receiver: wallet() },
        "vault-withdraw": { receiver: wallet(), owner: wallet() },
        "vault-redeem": { receiver: wallet(), owner: wallet() },
      },
      // approve-usde exercises the app's real approve-token path (the same
      // one the setup above fabricates around) and unstake claims through
      // the silo; both fan out cold contract state on a fresh fork and run
      // past the default two-minute wait, so give them the same headroom as
      // lido approve-steth / curve crv-approve.
      executionWaitMs: {
        "approve-usde": 240_000,
        unstake: 240_000,
      },
      fabrications: {
        // cooldown-shares runs immediately before unstake in registry
        // order and re-arms the cooldown timer (86400s on mainnet,
        // verified 2026-07-08); rewrite the real cooldown's timestamp
        // to elapsed so unstake claims the genuinely escrowed USDe.
        unstake: [{ kind: "elapsed-cooldown", contract: contract("sUsde") }],
      },
      skipped: {
        "vault-withdraw":
          "cooldown mode disables ERC4626 withdraw (cooldownDuration is 86400s on mainnet, verified 2026-07-08; StakedUSDeV2 reverts while it is nonzero) - exits are covered by cooldown-shares + unstake",
        "vault-redeem":
          "cooldown mode disables ERC4626 redeem (cooldownDuration is 86400s on mainnet, verified 2026-07-08; StakedUSDeV2 reverts while it is nonzero) - exits are covered by cooldown-shares + unstake",
      },
      // sUSDe (StakedUSDeV2) invariants (unnamed ERC-4626 outputs, so no
      // field): asset is a permanent address; totals/supply are large and
      // monotonic; convert/preview are pure per-share quotes; max-deposit/mint
      // are the uncapped limits; the cooldown duration is a fixed protocol
      // config (86400s, verified 2026-07-08). Caller-position reads (balance,
      // max-withdraw/redeem, cooldown-status) and shared-wallet token balances
      // are history-dependent and left unasserted.
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
        "get-cooldown-duration": [{ equals: "86400" }],
      },
      // Post-write oracle: a deposit/mint must actually credit sUSDe shares
      // (checked right after the write mines, before the cooldown burns
      // them). nonZero is history-safe on the simulation wallet.
      writeExpectations: {
        "vault-deposit": [{ read: "vault-balance", expect: { nonZero: true } }],
        "vault-mint": [{ read: "vault-balance", expect: { nonZero: true } }],
      },
    },
  },

  contracts: {
    sUsde: {
      label: "sUSDe (Staked USDe)",
      abi: SUSDE_ABI,
      addresses: {
        // Ethereum Mainnet
        "1": "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497",
      },
      overrides: {
        // 18 standard ERC-4626 overrides
        ...erc4626AbiOverrides(),

        // Ethena-specific: cooldown writes
        cooldownAssets: {
          slug: "cooldown-assets",
          label: "Cooldown Assets",
          description:
            "Initiate the cooldown period to unstake a specific amount of underlying USDe assets. After the cooldown duration (7 days), call unstake to claim.",
          inputs: {
            assets: { label: "USDe Amount (wei)" },
          },
        },
        cooldownShares: {
          slug: "cooldown-shares",
          label: "Cooldown Shares",
          description:
            "Initiate the cooldown period to unstake a specific number of sUSDe shares. After the cooldown duration (7 days), call unstake to claim.",
          inputs: {
            shares: { label: "sUSDe Shares (wei)" },
          },
        },
        unstake: {
          label: "Unstake (Claim After Cooldown)",
          description:
            "Claim USDe after the cooldown period has elapsed. Must have previously called cooldownAssets or cooldownShares.",
          inputs: {
            receiver: { label: "Receiver Address" },
          },
        },

        // Ethena-specific: cooldown reads
        cooldownDuration: {
          slug: "get-cooldown-duration",
          label: "Get Cooldown Duration",
          description:
            "Get the current cooldown duration in seconds required before unstaking",
          outputs: {
            result: {
              name: "cooldownDuration",
              label: "Cooldown Duration (seconds)",
            },
          },
        },
        cooldowns: {
          slug: "get-cooldown-status",
          label: "Get Cooldown Status",
          description:
            "Get the cooldown end timestamp and USDe amount pending for an address",
          inputs: {
            // ABI param name is "" -- defaults to "arg0"
            arg0: { name: "account", label: "Wallet Address" },
          },
          outputs: {
            cooldownEnd: { label: "Cooldown End Timestamp" },
            underlyingAmount: { label: "Pending USDe Amount (wei)" },
          },
        },
      },
    },
    usde: {
      label: "USDe Stablecoin",
      abi: ERC20_MINIMAL_ABI,
      addresses: {
        "1": "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3",
      },
      overrides: {
        balanceOf: {
          slug: "get-usde-balance",
          label: "Get USDe Balance",
          description: "Check the USDe stablecoin balance of an address",
          inputs: { account: { label: "Wallet Address" } },
          outputs: {
            result: {
              name: "balance",
              label: "USDe Balance (wei)",
              decimals: 18,
            },
          },
        },
        approve: {
          slug: "approve-usde",
          label: "Approve USDe Spending",
          description:
            "Approve a spender to transfer USDe on your behalf. Required before depositing into the sUSDe vault.",
          inputs: {
            spender: { label: "Spender Address" },
            amount: { label: "Approval Amount (wei)" },
          },
        },
      },
    },
    ena: {
      label: "ENA Governance Token",
      abi: ERC20_BALANCE_ABI,
      addresses: {
        "1": "0x57e114B691Db790C35207b2e685D4A43181e6061",
      },
      overrides: {
        balanceOf: {
          slug: "get-ena-balance",
          label: "Get ENA Balance",
          description: "Check the ENA governance token balance of an address",
          inputs: { account: { label: "Wallet Address" } },
          outputs: {
            result: {
              name: "balance",
              label: "ENA Balance (wei)",
              decimals: 18,
            },
          },
        },
      },
    },
  },
});
