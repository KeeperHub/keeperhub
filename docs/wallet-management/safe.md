---
title: "Safe Smart Accounts"
description: "Deploy a Safe per chain, scope workflow writes with Zodiac Roles, and withdraw funds directly from the Safe."
---

# Safe Smart Accounts

KeeperHub can deploy a [Safe](https://safe.global) smart account on each chain your organization uses. Safes hold funds independently from your Turnkey EOA, let you scope workflow writes to a pre-audited protocol allowlist with per-token spending caps, and serve as the `msg.sender` at the target contract.

The Turnkey EOA stays in the picture as the Safe's sole owner (threshold 1) and as the signer that broadcasts transactions on chain. Workflow writes can flow through the Safe in two modes:

- **Safe (owner-signed)** — workflows execute via `safe.execTransaction` signed by the Turnkey EOA. `msg.sender` at the target is the Safe.
- **Safe + Zodiac Roles** — workflows execute via `rolesModifier.execTransactionWithRole`. The modifier validates the call against an on-chain allowlist of protocols, functions, and per-token allowances before forwarding to the Safe.

If you don't enable the Safe as the workflow sender for a given chain, writes continue to sign directly from the Turnkey EOA. Existing workflows are unchanged until you flip the toggle.

## Supported chains

Safe deployment and Zodiac Roles installation work on the EVM chains where Safe v1.4.1 and the Zodiac Roles Modifier v2.0.0 are deployed at their canonical addresses: Ethereum, Base, Arbitrum, Optimism, Polygon, and Ethereum Sepolia.

## Deploying a Safe

From the wallet overlay:

1. Open the wallet overlay and click **Deploy a Safe**.
2. Pick the network.
3. (Optional) Configure on-chain policies — pick protocols to allow and per-token caps. You can skip and add them later.
4. Review the simulated cost. The Turnkey EOA pays the deploy gas.
5. Confirm.

The Safe address is deterministic per `(org, chain)`: re-running the deploy on the same chain returns the existing Safe rather than creating a duplicate. The same org resolves to the same Safe address on every chain it's deployed to.

## Workflow signer routing

Each deployed Safe has a **Sender** toggle on its account row. When ON, workflow writes for that chain route through the Safe (`msg.sender` at the target contract is the Safe address). When OFF, the same writes sign directly from the Turnkey EOA.

The Turnkey EOA always signs the outer transaction — the toggle only changes what the inner call's `msg.sender` looks like to the target contract. Gas is paid by the EOA in either mode.

ERC-4337 gas sponsorship is only available when the toggle is OFF; the bundler swaps `msg.sender` to its own smart account, which would change what the target contract sees.

## Who pays for what

Two distinct accounts are involved in every workflow write. Confusing them is the most common source of "out of funds" errors, so it's worth spelling out.

| Concern | Who covers it | Why |
|---|---|---|
| Gas (the outer ETH fee on the L1/L2 itself) | Always the Turnkey EOA | The EOA broadcasts and signs the outer transaction. It needs native ETH on every chain you run workflows on. |
| Native token sends (e.g. transfer 0.1 ETH to someone) | The active **Sender** (Safe if its toggle is ON, EOA otherwise) | The Sender is `msg.sender` at the target. Native value comes from `msg.sender`'s balance. |
| ERC20 transfers and approvals | The active **Sender**'s token balance | `IERC20.transfer` debits `msg.sender`. If the Safe is Sender, the Safe needs the tokens; the EOA's balance is irrelevant. |
| Swap inputs (Uniswap, etc.) | The active **Sender**'s token balance | Same reason. The swap pulls tokens from `msg.sender` via `transferFrom` after the approve. |
| Protocol deposits (Aave supply, etc.) | The active **Sender**'s token balance | The protocol pulls `msg.sender`'s tokens and credits the position to `msg.sender`. |

In other words: **the EOA always pays gas, and the Sender's balance is what gets debited for everything else.** Fund both accounts on every chain you transact on. Gas goes on the EOA, transactable balance on the Sender.

If you flip the Sender toggle from EOA to Safe and your workflow starts failing with insufficient balance, the most likely cause is that the tokens are still on the EOA and need to be moved to the Safe.

## Side-by-side: signer modes

Three modes a workflow write can run in, depending on whether a Safe is deployed, whether its Sender toggle is ON, and whether a Zodiac Roles modifier is installed.

| Aspect | EOA only | Safe (Sender ON, no Role) | Safe + Zodiac Roles |
|---|---|---|---|
| `msg.sender` at the target contract | Turnkey EOA | Safe | Safe |
| Signs the outer tx | Turnkey EOA | Turnkey EOA (via `safe.execTransaction`) | Turnkey EOA (via `rolesModifier.execTransactionWithRole`) |
| Pays gas | Turnkey EOA | Turnkey EOA | Turnkey EOA |
| Native sends debit | Turnkey EOA balance | Safe balance | Safe balance |
| ERC20 transfers/approvals debit | Turnkey EOA balance | Safe balance | Safe balance (capped by allowances) |
| Swap inputs come from | Turnkey EOA balance | Safe balance | Safe balance (capped by allowances) |
| Protocol position credited to | Turnkey EOA | Safe | Safe |
| ERC4337 gas sponsorship eligible | Yes | No (bundler would change `msg.sender`) | No (same reason) |
| Policy gating (function and arg allowlist) | None | None | Yes, per role scope |
| Per-token spending caps | None | None | Yes, per allowance bucket |
| Survives a compromised EOA | N/A | No (EOA owner can call `execTransaction` directly) | No (EOA owner can call `execTransaction` directly, bypassing the modifier) |

The "compromised EOA" row is intentional: at threshold 1, the role is policy, not boundary. See the [Owner-bypass property](#owner-bypass-property) below for what that means and how multi-owner Safes close the gap.

## Per-node Sender override

Workflow nodes that send transactions (Transfer Native Token, Transfer ERC20, Approve ERC20, Write Contract, and any protocol action that writes on chain) have a **Web3 Connection** picker in their config.

| Option | What it does | Stored value | Use when |
|---|---|---|---|
| Default Sender (Safe) | Routes through the org's active Safe Sender on this chain. Auto-switches if you change the Sender later. | `default` | Standard production setup once a Safe is the active Sender. |
| Default Sender (EOA) | No Safe is the active Sender, so this falls back to the Turnkey EOA. Auto-switches if you turn on a Safe Sender later. | `default` | Default state before you turn on a Safe. |
| EOA | Pins this node to the Turnkey EOA even if a Safe is the active Sender. Bypasses any Zodiac Roles policy. | `eoa` | Diagnostics, or a one-off node that must skip the Safe entirely. The picker shows a yellow warning when you pick this while a Safe is the org default. |
| Safe `0x…` | Pins this node to a specific Safe by id, regardless of the org default. Only deployed, signing-active Safes on the node's chain appear. | `safe:<safeWalletId>` | You have multiple Safes and want one node to always use a specific one. |

If the node's network is templated (e.g. `{{trigger.chainId}}`), only Default and EOA are pickable. A specific Safe can't be bound to a chain that isn't known until runtime.

## On-chain policies (Zodiac Roles)

The Zodiac Roles Modifier sits between the Safe and its workflow caller. When installed, every workflow write goes through the modifier first; the modifier checks the call against the role's scope and forwards to the Safe only if the call is allowed. The owner EOA holds the role and is the only address authorised to use it.

Policies have two kinds of scope:

- **Protocol presets** — audited per-parameter rules from [karpatkey/defi-kit](https://github.com/karpatkey/defi-kit). Per-parameter mode pins the function selector AND the function arguments (e.g. for Aave V3 `supply`: pins `onBehalfOf` to the Safe). Contract-allowlist mode pins only the target contract — any function on that contract is allowed.
- **Direct rules** — per-recipient ERC-20 transfers/approvals or native sends not tied to a protocol preset. Each direct rule binds `(kind, counterparty, token)` to its own on-chain allowance bucket, so an approve to spender A and a transfer to recipient B don't share a weekly cap.

Each enabled protocol gets its own per-token allowance bucket. Two protocols holding USDC each have independent caps; they never share a weekly limit.

### Per-parameter vs contract-allowlist

The wizard surfaces this on every protocol card as a small badge:

- **Per-parameter policy** — KeeperHub controls both the function selector AND the function arguments. Anything else reverts on chain.
- **Contract allowlist** — KeeperHub controls only the target contract. Any function on the contract is callable by the role, including admin functions if the contract exposes them. Per-token spending caps still apply on top.

Per-parameter is strictly tighter. Contract-allowlist is used for protocols where no audited per-parameter preset exists yet; the per-token cap is the only protection against unbounded calls.

### Owner-bypass property

At threshold 1 the role is **policy, not boundary**. The Turnkey EOA is both the Safe's sole owner AND the role holder, so it can:

1. Call `rolesModifier.execTransactionWithRole(...)` — gated by the role's scope and allowances.
2. Call `safe.execTransaction(...)` directly — bypasses the modifier entirely.

KeeperHub itself only ever routes workflows through path (1) when the signer toggle is on. The bypass property matters because a compromised Turnkey EOA could drain the Safe via path (2). Treat policies as a workflow-scoping tool, not as an absolute spending boundary. Multi-owner Safes with `threshold > 1` close this gap; the schema already supports that configuration even though the deploy wizard sets `threshold = 1`.

## Refresh from chain

On-chain state (allowance buckets, role membership, modifier installation status) is the source of truth. The role permissions card has a **Refresh from chain** button that:

1. Reads the Safe's enabled modules via `getModulesPaginated`.
2. Identifies the Zodiac Roles Modifier (if any).
3. Probes each known allowance bucket via `Allowances(key)` and updates the DB cache.
4. Pulls direct-rule details (kind, counterparty) from the Zodiac subgraph.

If the subgraph is unreachable during a write (install / update), KeeperHub refuses to proceed rather than computing a diff against stale state. Retry once the subgraph is back online.

## Withdrawing funds

Each Safe's Assets tab shows the Safe's own balance (native + tracked ERC-20s). Click **Withdraw** on a token row to send funds out of the Safe to any address. The transaction routes through `safe.execTransaction` signed by the Turnkey EOA owner — independent of whether the signer toggle is on, since the owner can always move the Safe's funds.

Tokens added with **+ Add token** are scoped to the Safe they're added from, not to the organization. The same token can be tracked separately under the Turnkey EOA, the Safe on Ethereum, and the Safe on Base — each view shows only the funds at the address it represents.

## Observability

Prometheus metrics emitted from `lib/metrics/instrumentation/safe.ts`:

| Metric | Type | Labels | Fires on |
|--------|------|--------|---------|
| `keeperhub_safe_deploy_total` | counter | `chain_id`, `outcome` (`success` / `already_deployed` / `failure`) | Safe deploy attempts |
| `keeperhub_safe_deploy_duration_ms` | histogram | same | Safe deploy duration |
| `keeperhub_safe_role_install_total` | counter | `chain_id`, `outcome` | Zodiac Roles install attempts |
| `keeperhub_safe_role_install_duration_ms` | histogram | same | Zodiac Roles install duration |
| `keeperhub_safe_tx_total` | counter | `chain_id`, `route` (`exec` / `role`), `kind` (`native` / `erc20` / `contract`), `outcome` | Safe-routed transactions (both owner-signed `execTransaction` and role-routed `execTransactionWithRole`) |
| `keeperhub_safe_tx_duration_ms` | histogram | same | Safe-routed transaction duration |
| `keeperhub_safe_withdraw_total` | counter | `chain_id`, `kind`, `outcome` | User-initiated Safe withdrawals |

Grafana alerts cover deploy failures, role-install failures, Safe-routed transaction failure rate above 20%, and any user-initiated withdraw failure.
