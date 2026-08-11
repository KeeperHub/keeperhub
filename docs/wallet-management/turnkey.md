---
title: "Turnkey Wallet Integration"
description: "How KeeperHub integrates with Turnkey for secure enclave wallet management with key export."
---

# Turnkey Integration

Turnkey is the wallet provider in KeeperHub. It uses secure enclaves to protect private keys and supports key export for advanced users.

## Creating a Turnkey Wallet

Your organization's Turnkey wallet is provisioned automatically once your email is verified. The wallet is shared across your organization, and its address is visible in the Wallet tab.

## How It Works

Turnkey generates and stores private keys inside secure hardware enclaves (TEEs). Signing requests are authenticated and executed within the enclave.

- **Secure enclave storage** -- keys never leave the hardware boundary during normal operation
- **Private key export** -- export your key if you need to migrate to another solution
- **Integrated operations** -- seamless signing for workflow transactions

On networks where gas is sponsored, a workflow write is submitted on your
wallet's behalf rather than directly by it, so on a block explorer it shows a
sender and a contract you will not recognise and a value of `0`. See
[What Your Transaction Looks Like On-Chain](/wallet-management/onchain-appearance)
before concluding a run did not work.

## Wallet Funding

Topping up your Turnkey EOA with native gas tokens (ETH on Ethereum, ETH on Base, MATIC on Polygon, SOL on Solana, etc.) is required for any workflow that broadcasts a transaction.

**When funding is needed**:

- Write function calls (require gas fees)
- Token or ETH transfer operations
- Any workflow steps that execute blockchain transactions

**When funding is not needed**:

- Read-only monitoring workflows
- Multisig monitoring workflows
- Read function calls

### Gas vs transactable balance

The EOA plays two distinct roles in a workflow write. Keep them separate when topping up.

1. **Gas (always the EOA).** Every workflow transaction is signed and broadcast by the EOA, and the gas fee is paid from the EOA's native balance. This is true whether or not you have a Safe configured as the Sender.

2. **Transactable balance (the active Sender).** If you have a [Safe](/wallet-management/safe) deployed and marked as the Sender on a chain, the Safe's balance is what gets debited when the workflow transfers a native token, approves or transfers an ERC20, swaps, or deposits into a protocol. If no Safe is the Sender, the EOA's own token balance is used instead.

The most common surprise: you turn on a Safe Sender, fund the Safe with USDC, and the workflow fails because the EOA still has no ETH for gas. Or vice versa: you fund the EOA but the Safe is the Sender, so the EOA's USDC sits idle while the swap fails for insufficient Safe balance.

Rule of thumb: **always keep some native gas on the EOA. Keep transactable tokens on whichever account is the active Sender.**

Balance updates are reflected in the KeeperHub interface and displayed per network.

## Wallet Management

**Deposit**: Transfer ETH to your Turnkey wallet address to fund workflow operations.

**Withdraw**: Use the Withdraw function in the UI to transfer wallet balance out of KeeperHub.

**Export Key**: Use the key export feature to retrieve your private key if you need to migrate to another wallet solution. When your organization has both EVM and Solana accounts provisioned, you can choose which key to export.

## Network Support

Turnkey wallets work across all EVM chains KeeperHub supports, including Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain, and Avalanche, plus their testnets. Solana mainnet and devnet are also supported through the same Turnkey wallet: KeeperHub provisions a separate Solana address alongside your EVM address, and both share the same Turnkey sub-organization. See the live [Chains](/api/chains) list for the current set.

## Capabilities

- Private key export whenever you need portability
- Hardware enclave security model
- Key portability for your organization
