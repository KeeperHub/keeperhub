---
title: "AgentGuard: Pause-Protected Vault Starter Template"
description: "Go from zero to your first on-chain protection transaction with a pause-protected vault — deploy a SecurityVault, run the workflow, and pause it on-chain via KeeperHub."
---

# AgentGuard: Pause-Protected Vault Starter Template

This template is the fastest way to get from zero to a **real protection
transaction executed on-chain through KeeperHub**. It was built for the
KeeperHub Agents Onchain hackathon and doubles as a reusable onboarding path:

```
deploy SecurityVault  →  run the AgentGuard pause workflow  →  vault is
paused on-chain (real tx)  →  inspect the audit trail
```

The agent never holds the private key: KeeperHub's execution layer
broadcasts the `pause()` call from the organization's Turnkey wallet, and
every run is recorded in the KeeperHub audit trail.

## What you get

| Asset | Path |
|---|---|
| Starter workflow fixture | `scripts/seed/fixtures/agentguard-pause.ts` |
| Minimal SecurityVault contract | Hardhat / Foundry, see contract below |
| This tutorial | `docs/getting-started/agentguard-pause-template.md` |

The fixture embeds the full `SecurityVault` ABI, so the workflow runs even
before the contract is verified on a block explorer — no manual ABI entry.

## How it works

```
Manual trigger ──► web3/write-contract: pause("risk score 70 >= 70")
                        │
                        ▼
              KeeperHub execution layer
              (broadcasts from the org's Turnkey guardian wallet)
                        │
                        ▼
              SecurityVault.pause() on-chain (VaultPaused event)
```

## Step 1: Deploy a SecurityVault

Use any EVM chain KeeperHub supports. The example below is Sepolia
(`11155111`); swap in `8453` for Base mainnet.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Minimal pause-protected vault. Only the guardian (the KeeperHub
///         org wallet) or the owner can pause; only the owner can unpause.
contract SecurityVault is Ownable {
    address public guardian;
    address public recovery;
    bool public paused;

    event VaultPaused(address indexed by, uint256 ts, string reason);
    event VaultUnpaused(address indexed by, uint256 ts);
    event GuardianChanged(address indexed oldGuardian, address indexed newGuardian);
    event RecoveryChanged(address indexed oldRecovery, address indexed newRecovery);

    modifier onlyGuardian() {
        require(msg.sender == guardian || msg.sender == owner(), "UnauthorizedGuardian");
        _;
    }

    constructor(address _guardian, address _recovery) Ownable(msg.sender) {
        require(_recovery != address(0), "RecoveryCannotBeZero");
        guardian = _guardian;
        recovery = _recovery;
    }

    function pause(string calldata reason) external onlyGuardian {
        require(!paused, "AlreadyPaused");
        paused = true;
        emit VaultPaused(msg.sender, block.timestamp, reason);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit VaultUnpaused(msg.sender, block.timestamp);
    }

    function setGuardian(address _guardian) external onlyOwner {
        emit GuardianChanged(guardian, _guardian);
        guardian = _guardian;
    }

    function setRecovery(address _recovery) external onlyOwner {
        emit RecoveryChanged(recovery, _recovery);
        recovery = _recovery;
    }
}
```

Deploy it with your preferred toolchain (Hardhat, Foundry, Remix). The
**guardian address must be your KeeperHub organization wallet** — that is the
account the execution layer broadcasts from. You can find it in the KeeperHub
dashboard under **Wallet**, or via:

```bash
npx -p @keeperhub/wallet keeperhub-wallet info   # prints the org wallet
```

Note the deployed `contractAddress`.

## Step 2: Point the fixture at your vault

Open `scripts/seed/fixtures/agentguard-pause.ts` and replace the placeholder
`contractAddress` with your deployment:

```ts
contractAddress: "0xYourDeployedVaultAddress",
```

If you deployed to Base mainnet, also change:

```ts
network: 8453, // Base mainnet (default in the fixture is Sepolia 11155111)
```

## Step 3: Seed and run the workflow

Seed the workflow into your local database (the seeder is idempotent — safe
to re-run):

```bash
pnpm db:seed-agentguard-pause
```

Or, without a local database, import the fixture into the visual workflow
builder and click **Run** — the Manual trigger fires immediately.

## Step 4: Verify the protection transaction

After the run completes, open the workflow run in KeeperHub:

1. The run shows the submitted transaction hash.
2. On the block explorer, confirm the `VaultPaused` event was emitted from
   your vault address.
3. Confirm the vault is paused:

```bash
# Sepolia example (swap RPC/chain for Base)
cast call <vaultAddress> "paused()(bool)" --rpc-url https://ethereum-sepolia-rpc.publicnode.com
# → true
```

Every execution is recorded in the KeeperHub audit trail with its trigger,
simulation result, submitted transaction, gas used, outcome, and timestamp —
so the protection action is fully re-checkable.

## That's it

You went from zero to a real on-chain protection transaction through
KeeperHub in four steps — no private key ever left the Turnkey enclave.

See also:

- [Quick Start Guide](./quickstart)
- [Workflow Builder docs](/docs/workflows)
- [KeeperHub Execution](/docs/keeper-runs)
