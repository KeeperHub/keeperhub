---
title: "Safe"
description: "Safe multisig wallet actions -- read owners, threshold, nonce, module status, and monitor pending transactions."
---

# Safe

Safe (formerly Gnosis Safe) is the most widely used multisig wallet on EVM chains. This plugin provides read-only on-chain actions for querying Safe multisig state (owner lists, confirmation thresholds, transaction nonces, module status) and off-chain actions for monitoring pending transactions via the Safe Transaction Service API.

Unlike other protocols with fixed contract addresses, Safe wallets are deployed at user-specific addresses. You provide your Safe address when configuring the workflow action.

Supported chains for on-chain reads: Ethereum, Base, Arbitrum, Optimism. Pending transaction monitoring supports: Ethereum, Arbitrum, Optimism, Polygon, Base, BSC, Avalanche, Gnosis, Sepolia, Base Sepolia.

## Setup

On-chain read actions (Get Owners, Get Threshold, etc.) require no credentials.

For **Get Pending Transactions**, you need a Safe Transaction Service API key:

1. Go to [developer.safe.global](https://developer.safe.global/) and create an API project
2. Copy the JWT API key
3. In KeeperHub, go to **Connections > Add Connection > Safe**
4. Paste the API key and save

## Actions

| Action | Type | Credentials | Description |
|--------|------|-------------|-------------|
| Get Owners | Read | No | Get the list of owner addresses |
| Get Threshold | Read | No | Get the required confirmation count |
| Is Owner | Read | No | Check if an address is an owner |
| Get Nonce | Read | No | Get the current transaction nonce |
| Is Module Enabled | Read | No | Check if a module is enabled |
| Get Modules Paginated | Read | No | Get paginated list of enabled modules |
| Get Pending Transactions | API | API key | Fetch unexecuted multisig transactions |

---

## Get Owners

Get the list of all owner addresses for a Safe multisig wallet.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | Safe Multisig Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| owners | address[] | Owner Addresses |

**When to use:** Monitor ownership changes, verify signer lists, audit multisig configuration.

---

## Get Threshold

Get the number of required confirmations (M of N) for executing a Safe transaction.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | Safe Multisig Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| threshold | uint256 | Required Confirmations |

**When to use:** Monitor threshold changes, verify security settings, alert if threshold drops below expected value.

---

## Is Owner

Check whether a specific address is an owner of the Safe multisig.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | Safe Multisig Address |
| owner | address | Address to Check |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| isOwner | bool | Is Owner |

**When to use:** Verify address membership, monitor owner additions/removals, validate access control.

---

## Get Nonce

Get the current transaction nonce of the Safe multisig. Each executed transaction increments the nonce.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | Safe Multisig Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| nonce | uint256 | Current Nonce |

**When to use:** Track transaction activity, detect new executed transactions, monitor Safe usage frequency.

---

## Is Module Enabled

Check whether a specific module is enabled on the Safe multisig. Modules can execute transactions without owner confirmations.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | Safe Multisig Address |
| module | address | Module Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| isEnabled | bool | Module Enabled |

**When to use:** Audit enabled modules, verify module installation, monitor module changes for security.

---

## Get Pending Transactions

Fetch pending multisig transactions that have not been executed yet. Optionally filter for transactions a specific signer has not confirmed.

**Inputs:** Safe Address, Network, Signer Address (optional -- filters for txs this address has not signed)

**Outputs:** `success`, `transactions` (array), `count`, `error`

Each transaction includes: `safeTxHash`, `to`, `value`, `data`, `operation` (0=CALL, 1=DELEGATECALL), `operationLabel`, `nonce`, `confirmations`, `confirmationsRequired`, `confirmationsCollected`, `dataDecoded`, `submissionDate`, `safe`

**When to use:** Monitor your Safe for new transactions awaiting your signature, verify transaction calldata before signing, detect suspicious proposals (DELEGATECALL, proxy upgrades, unknown targets).

---

## Example Workflows

### Monitor Safe Ownership Changes

`Schedule (hourly) -> Safe: Get Owners -> Code (compare with previous) -> Condition (changed) -> Discord: Send Message`

Periodically check the owner list and alert via Discord if any owners are added or removed.

### Threshold Security Alert

`Schedule (daily) -> Safe: Get Threshold -> Condition (< 2) -> SendGrid: Send Email`

Monitor the confirmation threshold and send an email alert if it drops below a safe minimum.

### Transaction Activity Tracker

`Schedule (every 10 min) -> Safe: Get Nonce -> Condition (> previous nonce) -> Discord: Send Message`

Track the Safe nonce to detect newly executed transactions and notify your team in real time.

### Pending Transaction Verification

```
Schedule (every 5 min)
  -> Safe: Get Pending Transactions (signer = your address)
  -> For Each: pending transaction
    -> Decode Calldata: {{GetPendingTransactions.transactions.data}}
    -> Assess Transaction Risk: decoded calldata + context
    -> Condition: operation == 1 (DELEGATECALL) OR riskScore > 70
    -> Discord: "Suspicious Safe tx: {{DecodeCalldata.functionName}} on {{GetPendingTransactions.transactions.to}}"
```

---

## Supported Chains

| Chain | On-chain Reads | Pending Transactions |
|-------|---------------|---------------------|
| Ethereum (1) | Yes | Yes |
| Base (8453) | Yes | Yes |
| Arbitrum (42161) | Yes | Yes |
| Optimism (10) | Yes | Yes |
| Polygon | No | Yes |
| BSC | No | Yes |
| Avalanche | No | Yes |
| Gnosis | No | Yes |
| Sepolia | No | Yes |
| Base Sepolia | No | Yes |

Safe wallets are deployed at unique, user-specified addresses on all chains. Provide your Safe address when configuring each action.
