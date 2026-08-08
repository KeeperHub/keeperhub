---
title: "AgentGuard: Pause-Protected Vault Starter Template"
description: "Deploy a pause-protected vault and pause it on-chain through KeeperHub — a reusable pattern for guarding funds behind a guardian wallet."
---

# AgentGuard: Pause-Protected Vault Starter Template

This template shows how to guard funds behind a pause-protected vault and
pause it on-chain through KeeperHub:

```
deploy SecurityVault  →  create the pause workflow  →  run it  →  the vault
is paused on-chain (a real transaction)  →  inspect the audit trail
```

The agent never holds the private key: KeeperHub's execution layer broadcasts
the `pause()` call from the organization's Turnkey wallet, and every run is
recorded in the KeeperHub audit trail.

## How it works

```
Manual trigger ──► web3/write-contract: pause("reason")
                        │
                        ▼
              KeeperHub execution layer
              (broadcasts from the org's Turnkey guardian wallet)
                        │
                        ▼
              SecurityVault.pause() on-chain (VaultPaused event)
```

The pattern is reusable for any emergency-control workflow — pause,
emergency withdrawal, or a kill switch on a contract you control.

## Step 1: Deploy a SecurityVault

Use any EVM chain KeeperHub supports. The example below is Sepolia
(`11155111`); swap in `8453` for Base mainnet.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Pause-protected vault. Only the guardian (the KeeperHub org
///         wallet) or the owner can pause; only the owner can unpause.
///         Emergency withdrawals move the balance to a pre-registered
///         recovery address and are not blocked by the paused state.
contract SecurityVault is Ownable {
    address public guardian;
    address public recovery;
    bool public paused;

    event VaultPaused(address indexed by, uint256 ts, string reason);
    event VaultUnpaused(address indexed by, uint256 ts);
    event EmergencyWithdraw(address indexed to, uint256 amount, bytes32 runId);
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

    /// @notice Move the full balance to `recovery`. A protection action:
    ///         deliberately not blocked by `paused`.
    function emergencyWithdraw(bytes32 runId) external onlyGuardian {
        uint256 amount = address(this).balance;
        require(amount > 0, "VaultIsEmpty");
        (bool ok, ) = recovery.call{value: amount}("");
        require(ok, "TransferFailed");
        emit EmergencyWithdraw(recovery, amount, runId);
    }

    function setGuardian(address _guardian) external onlyOwner {
        emit GuardianChanged(guardian, _guardian);
        guardian = _guardian;
    }

    function setRecovery(address _recovery) external onlyOwner {
        emit RecoveryChanged(recovery, _recovery);
        recovery = _recovery;
    }

    receive() external payable {}
}
```

Deploy it with your preferred toolchain (Hardhat, Foundry, Remix). Note the
deployed `contractAddress`.

## Step 2: Find your organization wallet

The **guardian address must be your KeeperHub organization wallet** — that is
the account the execution layer broadcasts from.

1. Open the KeeperHub dashboard.
2. Go to the **Wallet** page (profile icon, top right).
3. Copy the organization wallet address and pass it as `_guardian` when you
   deploy the contract.

## Step 3: Create the pause workflow

Build the workflow in the visual builder — no code or local repository needed:

1. **New Workflow** → add a **Manual** trigger.
2. Add a **Write Contract** action:
   - **Network**: the chain you deployed on (e.g. Sepolia).
   - **Contract Address**: your deployed `contractAddress`.
   - **Function**: `pause`.
   - **Arguments**: a reason string, e.g. `risk score 70 >= 70`.
   - **ABI**: the workflow fetches the ABI automatically for verified
     contracts. If yours is unverified, paste the ABI (the contract above
     generates it with `forge inspect` or Hardhat's artifact).
3. Save the workflow.

> The same pattern — a pause-protected vault with a guardian-controlled
> emergency action — is reusable for any kill-switch or emergency-control
> workflow you want to guard behind the KeeperHub execution layer.

## Step 4: Run and verify

Click **Run** on the workflow. After it completes:

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

You now have a pause-protected vault with a one-click emergency control,
broadcast through KeeperHub — and the private key never left the Turnkey
enclave.

See also:

- [Quick Start Guide](./quickstart)
- [Workflow Builder docs](/workflows)
- [KeeperHub Execution](/keeper-runs)
