---
title: "Turnkey Wallet Integration"
description: "How KeeperHub integrates with Turnkey for secure enclave wallet management with key export."
---

# Turnkey Integration

Turnkey is the wallet provider in KeeperHub. It uses secure enclaves to protect private keys and supports key export for advanced users.

## Creating a Turnkey Wallet

Your organization's Turnkey wallet is provisioned automatically once your email is verified. The wallet is shared across your organization, and its address is visible under Settings > Organization > Wallets.

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

Whether your Turnkey EOA needs native gas tokens depends on the route the write takes. This
route condition applies to EVM chains (ETH on Ethereum, ETH on Base, MATIC on Polygon, etc.)
only -- there is no sponsored route on Solana, so a Solana account always pays its own
transaction fee from its SOL balance.

- **On a sponsored EVM route**, the transaction is submitted on your wallet's behalf and the gas
  is paid for you, so the EOA can hold zero native balance. Eligibility is per organization and
  is metered against your gas credits, so it is a condition rather than a guarantee. See
  [Gas Management](/wallet-management/gas) for what sponsorship covers and when it applies.
- **On an unsponsored EVM route**, the wallet that signs and broadcasts pays the fee, so it
  needs native gas.
- **On Solana**, fund the account with SOL to cover the transaction fee; sponsorship does not
  apply.

Value is a separate question from gas. Any transaction that moves ETH or tokens needs the sending
account to hold that asset, whether or not the gas is sponsored.

**When funding is needed**:

- Write function calls on an unsponsored route (the signer pays the gas fee)
- Token or ETH transfer operations (the sender must hold the asset being moved)
- Any workflow step that both executes onchain and is not covered by sponsorship

**When funding is not needed**:

- Read-only monitoring workflows
- Multisig monitoring workflows
- Read function calls

### Gas vs transactable balance

The EOA plays two distinct roles in a workflow write. Keep them separate when topping up.

1. **Gas (depends on the route).** The EOA always signs. On an unsponsored route it also broadcasts and pays the fee from its own native balance. On a sponsored route the transaction is submitted on the wallet's behalf and the gas is paid for it, so the EOA's native balance is untouched. See [Wallet Funding](#wallet-funding) above and [Gas Management](/wallet-management/gas). A Safe configured as the Sender forces the unsponsored route, so the EOA needs native gas whenever a Safe is the Sender -- see [Safe wallets](/wallet-management/gas#safe-wallets).

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
