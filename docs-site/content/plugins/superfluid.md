---
title: "Superfluid"
description: "Programmable streaming payments: open per-second money streams, distribute pro-rata to pool members, and wrap/unwrap SuperTokens."
---

# Superfluid

Superfluid enables programmable streaming payments: continuous, per-second token transfers ("flows") between addresses via the Constant Flow Agreement (CFA), and pro-rata distributions to a group of members via the General Distribution Agreement (GDA). Streams and distributions move value in real time without repeated transactions. This plugin also exposes wrap and unwrap actions for converting an underlying ERC-20 into its SuperToken form and back.

Supported chains: Ethereum, Optimism, Base, Arbitrum, and Sepolia (the CFAv1 and GDAv1 forwarder contracts are pinned to identical addresses across every chain Superfluid deploys to, including BNB Smart Chain, Polygon, and Avalanche C-Chain). SuperToken actions work on whichever of these chains the SuperToken you provide is deployed on. Read-only actions work without credentials. Write actions require a connected wallet.

## Actions

Actions are grouped below by contract: the CFAv1 Forwarder (streams), the GDAv1 Forwarder (distribution pools), and the SuperToken contract (wrap/unwrap and balance).

### CFAv1 Forwarder (Streams)

| Action | Slug | Type | Description |
|--------|------|------|-------------|
| Open Money Stream | `create-flow` | Write | Open a continuous wei/sec stream of a SuperToken from sender to receiver |
| Update Stream Rate | `update-flow` | Write | Change the wei/sec rate of an existing stream |
| Close Money Stream | `delete-flow` | Write | Close an open stream between sender and receiver |
| Read Flow Between Two Addresses | `get-flow` | Read | Read the current flow rate, deposit, and last-updated timestamp for a stream |
| Read CFA Net Flow Rate of an Address | `get-cfa-net-flow` | Read | Read an address's net flow rate from CFA streams only |
| Grant Flow-Operator Permissions | `grant-flow-operator` | Write | Authorize another address to manage your flows of a SuperToken up to a wei/sec allowance |

**Inputs for Open Money Stream:** token (SuperToken Address), sender, receiver, flowRate (wei/sec), userData (advanced, default `0x`).

**When to use:** Set up payroll or subscription-style streams, monitor a counterparty's net flow before extending credit, revoke or update a stream when conditions change.

### GDAv1 Forwarder (Distribution Pools)

| Action | Slug | Type | Description |
|--------|------|------|-------------|
| Create Distribution Pool | `create-pool` | Write | Create a GDA distribution pool with the supplied address as administrator |
| Set Member Units in a Pool | `update-member-units` | Write | Set a recipient's pro-rata share in a distribution pool |
| Instant Distribution to a Pool | `distribute` | Write | Push a one-shot distribution into a pool, split pro-rata by member units |
| Stream Into a Pool | `distribute-flow` | Write | Open a continuous stream into a pool, split pro-rata by member units in real time |
| Connect to a Pool (Member Opt-In) | `connect-pool` | Write | Members must call this from their own wallet to start receiving distributions |
| Read Net Flow Rate of an Address | `get-net-flow` | Read | Read an address's net flow rate combining CFA streams and GDA pool distributions |

The new pool address from Create Distribution Pool is emitted in the `PoolCreated` event; chain a Web3 event-query action after this action to capture it for use in subsequent pool actions.

**When to use:** Distribute protocol revenue or rewards pro-rata to a set of members, run a streaming payroll pool, monitor combined CFA and GDA flow for an address.

### SuperToken (Wrap/Unwrap)

The SuperToken contract address is user-provided (for example a DAIx or USDCx address), so it works with any SuperToken deployed on a supported chain.

| Action | Slug | Type | Description |
|--------|------|------|-------------|
| Wrap to SuperToken | `wrap` | Write | Wrap an underlying ERC-20 amount into its SuperToken |
| Unwrap from SuperToken | `unwrap` | Write | Unwrap a SuperToken amount back to its underlying ERC-20 |
| Get SuperToken Balance | `get-super-token-balance` | Read | Read an address's current SuperToken balance |
| Get Underlying ERC-20 Address | `get-underlying-token` | Read | Read the underlying ERC-20 address for a SuperToken |

Wrapping requires a prior ERC-20 approval for the SuperToken address.

**When to use:** Fund a stream by wrapping the underlying token, unwrap back to the underlying asset when closing out a position, check available SuperToken balance before opening a stream.

---

## Example Workflows

### Open a Payroll Stream

`Manual -> Web3: Approve Token (underlying -> SuperToken) -> Superfluid: Wrap to SuperToken -> Superfluid: Open Money Stream`

Approve and wrap an underlying token into its SuperToken form, then open a continuous stream to a recipient.

### Net Flow Alert

`Schedule (hourly) -> Superfluid: Read Net Flow Rate of an Address -> Condition (< 0) -> Discord: Send Message`

Monitor an address's combined CFA and GDA net flow rate and alert when it turns negative (net outflow).

---

## Supported Chains

| Chain | CFAv1 / GDAv1 Forwarders |
|-------|--------------------------|
| Ethereum (1) | Available |
| Optimism (10) | Available |
| Base (8453) | Available |
| Arbitrum (42161) | Available |
| Sepolia (11155111) | Available |

The forwarder contracts are deployed at the same address on every chain Superfluid supports; the table above lists the chains currently supported by KeeperHub. The full, current action list for this protocol is available in the app's action grid and via the `search_protocol_actions` MCP tool.
