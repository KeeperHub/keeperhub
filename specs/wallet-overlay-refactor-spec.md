# Wallet Overlay Refactor Spec

**Ticket**: KEEP-1176
**Status**: Draft
**Component**: `keeperhub/components/overlays/wallet-overlay.tsx`

---

## Overview

Refactor the wallet overlay to improve UX with better formatting, block explorer links, and instant withdrawal functionality.

---

## 1. Account Details Display Format

**Current**: Wallet address and email are displayed separately with different styling.

**Target**: Match the attached design mockup.

### Requirements

- Group wallet address and email into an "Account details" section
- Display email first (full email shown) - keepd the edit button
- Display truncated wallet address below (format: `0xca9...b2102`)
- Add copy-to-clipboard button next to the wallet address

### UI Structure

```
Account details
scott.cameron@ethereum.org [edit]
0xca9...b2102 [copy icon]
```

---

## 2. Block Explorer Links per Network

**Current**: Network balances are displayed without external links.

**Target**: Each network row links to the wallet address on its respective block explorer.

### Requirements

- Add external link icon next to each network name
- Link opens the wallet address on the chain's block explorer
- Use existing `explorerConfigs` table data:
  - `explorerUrl` + `explorerAddressPath` (replace `{address}` placeholder)
- Use existing utility: `lib/explorer/index.ts` > `getAddressUrl(config, address)`

### Data Source

Block explorer URLs are already seeded in the database via `scripts/seed/seed-chains.ts`:

| Chain         | Explorer URL               |
| ------------- | -------------------------- |
| Ethereum      | etherscan.io               |
| Sepolia       | sepolia.etherscan.io       |
| Base          | basescan.org               |
| Base Sepolia  | sepolia.basescan.org       |
| Tempo         | explorer.tempo.xyz         |
| Tempo Testnet | explorer.testnet.tempo.xyz |
| Solana        | solscan.io                 |
| Solana Devnet | solscan.io/?cluster=devnet |

### Implementation Notes

- Query `explorerConfigs` when loading balances
- Pass config to `getAddressUrl()` helper
- Open links in new tab (`target="_blank"`)

---

## 3. Instant Withdrawal Feature

**Current**: No withdrawal functionality exists. Users cannot move funds out of their wallet.

**Target**: Allow users to withdraw funds instantly without creating a workflow.

### Requirements

- Add "Withdraw" button per token balance row (or per network section)
- Open withdrawal modal with:
  - Source: wallet (read-only)
  - Token selection (if multiple tokens on that chain)
  - Amount input (with "Max" button)
  - Destination address input (validate format)
  - Gas estimate display
  - Confirm button
- Execute transfer directly using Turnkey signer
- Show transaction status (pending, confirmed, failed)
- Link to block explorer after success

### Technical Approach

- Use existing Turnkey signer: `lib/web3/wallet-helpers.ts` > `initializeWalletSigner()`
- Create new API route: `keeperhub/api/user/wallet/withdraw/route.ts`
- Handle both native token transfers and ERC20 transfers
- Admin-only access (consistent with other wallet management)

### Withdrawal Modal Fields

1. **Token**: Dropdown or pre-selected based on which row user clicked
2. **Amount**: Number input with balance validation
3. **Recipient Address**: Text input with address format validation
4. **Network Fee**: Estimated gas cost (informational)
5. **Confirm**: Button to execute transaction

### Edge Cases

- Insufficient balance for amount + gas
- Invalid recipient address format
- Transaction fails on-chain
- Network congestion / timeout
- User has no balance on selected token

---

## Files to Modify

| File                                               | Changes                                                  |
| -------------------------------------------------- | -------------------------------------------------------- |
| `keeperhub/components/overlays/wallet-overlay.tsx` | Account details section, explorer links, withdraw button |
| `keeperhub/api/user/wallet/withdraw/route.ts`      | New route for withdrawal execution                       |
| `keeperhub/components/overlays/withdraw-modal.tsx` | New modal component for withdrawal flow                  |

---

## Out of Scope

- Batch withdrawals
- Withdrawal scheduling
- Withdrawal to non-EVM chains from EVM wallet
- Fiat off-ramp integration
