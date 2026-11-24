---
title: "Gas Management"
description: "Understanding gas limit estimation and configuration for blockchain transactions in KeeperHub."
---

# Gas Management

KeeperHub handles gas configuration automatically for all blockchain transactions. This page explains how gas limits are calculated and how to override the defaults when needed.

## How Gas Limit Estimation Works

Every transaction goes through three stages:

1. **Estimate** - KeeperHub calls `eth_estimateGas` on the network to get the minimum gas units required
2. **Multiply** - The estimate is multiplied by a safety factor (the gas limit multiplier) to account for on-chain state changes between estimation and execution
3. **Submit** - The final gas limit is set on the transaction

```
Final Gas Limit = Estimated Gas x Multiplier
```

The multiplier exists because gas estimates are point-in-time snapshots. Between estimation and on-chain execution, contract state can change (other transactions may execute first), which can increase the actual gas required. Without a buffer, transactions risk running out of gas and reverting -- wasting the gas fee while accomplishing nothing.

## Default Multipliers

Defaults vary by chain type. L2 networks use lower multipliers because their gas estimates tend to be more accurate.

| Network | Multiplier |
|---------|-----------|
| Ethereum, Ethereum Sepolia | 2.0x |
| Polygon, Polygon Amoy | 2.0x |
| 0G, 0G Galileo | 2.0x |
| Arbitrum One, Arbitrum Sepolia | 1.5x |
| Base, Base Sepolia | 1.5x |
| Robinhood Chain and its testnet | 1.5x |
| Tempo, Tempo Moderato | 1.5x |
| Any other EVM network | 2.0x (global default) |

The same multiplier applies however the workflow was triggered. A manual run, a scheduled run, a webhook, and an event trigger hitting the same contract on the same network all receive the same gas limit.

These defaults are resolved in order: database chain config > hardcoded chain overrides > global default (2.0x).

## Gas Limit Override

You can set an absolute gas limit per action node:

1. Open the action node configuration (Transfer Native Token, Transfer ERC20 Token, Approve ERC20 Token, or Write Contract)
2. Expand the **Advanced** section
3. Set the **Gas Limit** field to an absolute gas unit value (e.g. 500000)

### Field Behavior

- **When empty**: The chain's default multiplier (see [Default Multipliers](#default-multipliers)) is applied to the gas estimate at execution time
- **When set**: Your absolute value is used directly as the transaction gas limit, bypassing the multiplier

The field also shows a live gas estimate when enough configuration is filled in (network, contract address, function, etc.). This helps you choose an appropriate gas limit. If your value is below the current estimate, a warning is shown.

### Example

If the network estimates 100,000 gas for your transaction and the network's default multiplier is 2.0x:

| Gas Limit Setting | Result |
|-------------------|--------|
| Empty (default) | 200,000 (estimate x 2.0) |
| 150,000 | 150,000 (used directly) |
| 500,000 | 500,000 (used directly) |

Setting a gas limit below the estimate will cause the transaction to revert with an out-of-gas error. Setting it close to the estimate risks failure if on-chain state changes between estimation and execution.

### Gas Limit and gas sponsorship

A sponsored transaction does not use your Gas Limit. The gas sponsor builds the transaction and sets its own limit.

- With **Sponsor gas** on, your Gas Limit is used only when the node ends up paying its own gas, for example when your gas credits are spent and the send falls back to your wallet.
- With **Sponsor gas** off, your Gas Limit is always used.
- A node with a [Priority Fee](#priority-fee) or [Max Fee](#max-fee) set has Sponsor gas off, so its Gas Limit is always used.

The editor shows a warning under the Gas Limit field while the node would be sponsored. To make sure your limit is applied, turn off Sponsor gas and keep the sending wallet funded. See [Custom gas settings and sponsorship](#custom-gas-settings-and-sponsorship).

When the node sends through a Safe, the gas limit is estimated for the Safe transaction and the Gas Limit field is not applied.

## Priority Fee

The priority fee (tip) is what you pay the block builder on top of the base fee. Transactions in the same block are ordered by priority fee, so a higher tip puts your transaction ahead of others that compete for the same call, such as a liquidation or a job that anyone can trigger once a cooldown ends.

### Setting the priority fee

The setting is available on Write Contract and Batch Write Contract:

1. Open the action node configuration
2. Expand the **Advanced** section
3. On Write Contract, turn off **Sponsor gas** if it is shown. The priority fee field appears only while the node pays its own gas
4. Set **Priority Fee (gwei)** to a value in gwei (e.g. 3)

| Setting | Result |
|---------|--------|
| Empty (default) | KeeperHub's adaptive fee strategy picks the tip from recent blocks, within the network's minimum and maximum |
| Set | Your value is used as the tip, even when it is above or below the network's usual range. The max fee is set to the base fee buffer plus your tip, unless a [Max Fee](#max-fee) lowers it |

### Priority fee and gas sponsorship

Sponsored transactions cannot carry a custom priority fee. The gas sponsor sets the fees of the transactions it pays for. So on Write Contract the two are exclusive:

- **Sponsor gas on**: the Priority Fee field is hidden and the network's default tip is used, paid by the sponsor.
- **Sponsor gas off**: the Priority Fee field is shown. The node pays gas from the sending wallet, with your tip.
- Any change that hides the field clears the priority fee, so a hidden value never changes how the node sends; the editor shows a notice when it does. For example: turning Sponsor gas on, or, with Sponsor gas on, setting Simulate at back to Latest block, switching to a network that gas sponsorship covers, moving off a private mempool or a Safe, or switching from Batch Write Contract to Write Contract.

The field is also shown when the node cannot be sponsored anyway: on a network that gas sponsorship does not cover, through a private mempool, through a Safe, or with Simulate at set to Next block.

With a priority fee, the sending wallet must hold enough of the network's native token to pay the gas. If it does not, the step fails before anything is sent. No gas credits are used for that node.

Batch Write Contract is never sponsored, so its Priority Fee field is always shown and always applies.

A priority fee sent through the [direct execution API](/api/direct-execution) also takes the call off sponsorship. See [Custom gas settings and sponsorship](#custom-gas-settings-and-sponsorship).

### Priority fee with a Safe

When the node sends through a Safe, the priority fee applies to the transaction your wallet sends to execute the Safe transaction.

### Accepted values

- A plain decimal number of gwei, greater than 0 and at most 10000, with at most 9 decimal places (1 wei). For example `3`, `0.5` or `1.25`.
- Templates are accepted, so a previous step can compute the tip.
- A value that is set but not valid (for example `abc`, `0x5`, `1e3` or `0`) fails the step before anything is sent. It does not fall back to the default tip.

## Max Fee

The max fee is the most you are willing to pay per unit of gas, base fee and priority fee together. Setting it puts a ceiling on the cost of each send, which is useful when you raise the [Priority Fee](#priority-fee) or run a workflow often.

### Setting the max fee

The setting is available on Write Contract and Batch Write Contract:

1. Open the action node configuration
2. Expand the **Advanced** section
3. On Write Contract, turn off **Sponsor gas** if it is shown. The max fee field appears only while the node pays its own gas
4. Set **Max Fee (gwei)** to a value in gwei (e.g. 50)

| Situation | Result |
|-----------|--------|
| Empty (default) | No cap. KeeperHub's adaptive fee strategy sets the max fee |
| Computed max fee at or below your cap | Sent unchanged |
| Computed max fee above your cap | The max fee is lowered to your cap. The priority fee is lowered too if it would exceed the cap |
| Next block's base fee above your cap | The step fails before anything is sent, because a transaction capped below the base fee could not be included in that block |

Before sending, KeeperHub asks the network for the next block's base fee. If your cap is below it, the step fails with a message that shows both values. With **Fail workflow on error** off, this failure is softened and the workflow continues, so a workflow that runs often can skip a gas spike and try again on its next run. If the base fee cannot be read, the transaction is sent with your cap.

The base fee can still rise after the check. A capped transaction whose base fee rises above the cap waits until the base fee falls back under it, and later sends from the same wallet wait behind it. Leave headroom above the base fee you expect.

### Max fee and gas sponsorship

Sponsored transactions cannot carry a custom max fee. The gas sponsor sets the fees of the transactions it pays for. So on Write Contract the two are exclusive:

- **Sponsor gas on**: the Max Fee field is hidden and there is no cap; the sponsor sets the fees.
- **Sponsor gas off**: the Max Fee field is shown. The node pays gas from the sending wallet, within your cap.
- Any change that hides the field clears the max fee, so a hidden value never changes how the node sends; the editor shows a notice when it does. For example: turning Sponsor gas on, or, with Sponsor gas on, setting Simulate at back to Latest block, switching to a network that gas sponsorship covers, moving off a private mempool or a Safe, or switching from Batch Write Contract to Write Contract.

The field is also shown when the node cannot be sponsored anyway: on a network that gas sponsorship does not cover, through a private mempool, through a Safe, or with Simulate at set to Next block.

With a max fee, the sending wallet must hold enough of the network's native token to pay the gas. If it does not, the step fails before anything is sent. No gas credits are used for that node.

Batch Write Contract is never sponsored, so its Max Fee field is always shown and always applies. See [Custom gas settings and sponsorship](#custom-gas-settings-and-sponsorship).

### Max fee with a Safe

When the node sends through a Safe, the max fee applies to the transaction your wallet sends to execute the Safe transaction.

### Accepted values

- A plain decimal number of gwei, greater than 0 and at most 10000, with at most 9 decimal places (1 wei).
- It must be at least the [Priority Fee](#priority-fee) when both are set.
- Templates are accepted.
- A value that is set but not valid fails the step before anything is sent.

## Gas Sponsorship

On supported networks, KeeperHub can sponsor the **gas fee** of a workflow transaction through Turnkey's Gas Station, so a workflow can run even when the sending wallet holds no native gas token. Sponsorship is enabled per organization and metered against a monthly gas credit allowance shown on your billing page.

Sponsorship also changes how the transaction appears on a block explorer. See [What Your Transaction Looks Like On-Chain](/wallet-management/onchain-appearance).

### What sponsorship covers

Sponsorship pays the **transaction fee only**. It does not provide the assets your transaction moves. The native value a transaction sends (for example, the ETH amount in a Transfer Native Token action) is always debited from your own wallet.

To send 0.1 ETH to another address, your wallet must hold at least 0.1 ETH; sponsorship only means it does not also need extra ETH to cover the gas fee. A token transfer (USDC and similar) likewise requires the token balance in your wallet. Only the gas is sponsored.

If the wallet holds USDC but no ETH, [Gas Top-Up](/api/direct-execution#gas-top-up) (`POST /api/execute/gas-top-up`, or the `top_up_gas` MCP tool) converts up to 100 USD of that USDC into native ETH on the same wallet, using sponsored transactions on Ethereum, Base, and Arbitrum.

### When a transaction is sponsored

A transaction is sponsored only when all of the following are true. Otherwise it falls back to paying gas from your wallet, and it fails if that wallet has no native balance.

- **Supported network**: Ethereum, Base, Polygon, and Arbitrum, plus their testnets (Sepolia, Base Sepolia, Polygon Amoy, Arbitrum Sepolia).
- **Direct wallet sender (no Safe)**: the active Sender is the wallet itself.
- **Public mempool**: transactions routed through a private mempool are not sponsored.
- **Gas credits available**: your organization still has gas credits for the current period.
- **Sponsor gas is on for the node**: the action's own toggle, described below.
- **No custom fees**: a node with a [Priority Fee](#priority-fee) or [Max Fee](#max-fee) set pays gas from your wallet. In the editor these fields show only while the node is not sponsored.

### Sponsor gas toggle

Each write action decides for itself whether to use sponsorship:

1. Open the action node configuration (Transfer Native Token, Transfer ERC20 Token, Approve ERC20 Token, Write Contract, or any protocol write action)
2. Pick a network that gas sponsorship covers, listed above
3. Expand the **Advanced** section
4. Set **Sponsor gas**

The toggle appears only once the node points at a network sponsorship covers. On any other network there is nothing for it to turn off, so it stays hidden and the wallet pays gas as usual.

The toggle is on by default, which is the behavior every existing workflow already had: the action tries sponsorship first and falls back to your own wallet when any eligibility condition above is not met.

Turn it off to keep the action on your own wallet. Sponsorship is then not attempted at all, so the action spends no gas credits and the sending wallet must hold enough native token for both the gas fee and any value the transaction sends. Use it when you want a predictable sender and fee source for one action, for example a transaction whose gas you want billed to the wallet rather than your gas credit allowance.

Through the API or MCP the field is `sponsorGas`, and it takes `true` or `false` (or the strings `"true"` and `"false"`). A save with a template or any other value in it is refused, unless the step already held it (see [On/off toggles](/workflows/templating#onoff-toggles) for when such a value is kept). Leave it out to use the default (on).

To decide per run, branch with a Condition node to two write nodes, one with **Sponsor gas** on and one with it off.

The toggle only removes sponsorship. Turning it on does not override the conditions above: an unsupported network, a Safe sender, a private mempool route, or an exhausted credit allowance still pays gas from the wallet.

### Safe wallets

Workflows that route through a Safe (Sender ON) are not gas sponsored. The sponsored transaction is built as a direct call from your wallet, so applying it to a Safe write would change `msg.sender` away from the Safe. Safe writes pay gas from the wallet that signs the outer transaction; direct wallet sends remain eligible for sponsorship.

### Gas credits

Sponsored gas is metered in USD against your plan's monthly gas credit cap (shown on the billing page). Mainnet usage counts against the cap; testnet usage is not charged. When the cap is reached, sponsorship pauses for the rest of the period and transactions pay gas from the wallet.

### When sponsorship falls back

Sponsorship is attempted first and falls back to direct signing (your wallet pays
the gas) whenever any eligibility condition above is not met. Sponsorship can
also be unavailable for a specific organization or wallet even when all of them
hold: Turnkey can reject an activity at submission time, and the step then falls
back the same way.

The Runs panel shows a **Gas sponsored** badge on each sponsored step; a step
that fell back has no badge. The badge is per step, so a run with one sponsored
step and one fallback step still shows it on the sponsored step. The run-level
**Sponsored** filter (under **Used gas**) lists runs that drew on gas credits.
The run output does not say why sponsorship was skipped.

What the fallback does next depends on the wallet balance:

- **Wallet holds native gas**: the run completes, paid from your wallet.
- **Wallet has no native gas**: the gas preflight runs before the transaction is
  broadcast and fails the step with:

  ```
  Insufficient ETH balance. Have: 0.0, Need: 0.000000231. Fund
  0x...orgWallet with at least 0.000000231 ETH on this chain and retry.
  ```

  Nothing was broadcast at this point, so there is no transaction hash to look
  up. Fund the address named in the message and retry. The preflight caches the
  balance and the gas price for about ten seconds, so a retry started right
  after the funds land can repeat the same error; give it a few seconds.

The preflight runs in the Web3 plugin's EVM write actions and in the protocol
actions built on them. Actions on chains with their own transaction path, such
as Tempo, do not run it. Reaching the preflight means the wallet is paying gas
itself -- either the step was never eligible for sponsorship, or a sponsored
attempt fell back -- and funding the address fixes the run either way. For a
write that sends no native value, restoring the eligibility conditions above can
also fix it without funding. A write that sends native value always needs that
value in the wallet, because sponsorship covers the fee only (see
[What sponsorship covers](#what-sponsorship-covers)).


### Custom gas settings and sponsorship

Sponsored transactions are built and paid for by the gas sponsor, which sets their gas limit and fees. A sponsored transaction cannot use the Gas Limit, Priority Fee or Max Fee you set on a node. KeeperHub handles each setting this way on Write Contract:

| Setting | With Sponsor gas on | With Sponsor gas off |
|---------|---------------------|----------------------|
| [Gas Limit](#gas-limit-and-gas-sponsorship) | Shown, with a warning. A sponsored send ignores it; it is used only if sponsorship falls back for that run | Always used |
| [Priority Fee](#priority-fee-and-gas-sponsorship) | Hidden while the node is sponsored, and cleared when it becomes sponsored | Shown and used |
| [Max Fee](#max-fee-and-gas-sponsorship) | Hidden while the node is sponsored, and cleared when it becomes sponsored | Shown and used |

Priority Fee and Max Fee are hidden while sponsored because a fee you choose cannot be honoured on a sponsored transaction. The Gas Limit stays visible because it still applies whenever the node ends up paying its own gas.

The fee fields are also shown when the node cannot be sponsored anyway: on a network that gas sponsorship does not cover, through a private mempool, through a Safe, or with Simulate at set to Next block (see [Simulate at the next block](/plugins/web3#simulate-at-the-next-block)). A node with a fee set pays gas from the sending wallet, so keep that wallet funded with the network's native token.

Batch Write Contract is never sponsored, so its Gas Limit, Priority Fee and Max Fee always show and always apply.

A `priorityFeeGwei` sent through the [direct execution API](/api/direct-execution) is honoured, and the call pays its own gas instead of being sponsored.

## FAQ

### What happens if I leave the gas limit empty?

The chain's default multiplier is applied to the gas estimate at execution time: 2.0x on most networks, 1.5x on the L2s listed under [Default Multipliers](#default-multipliers). The trigger type has no effect on it.

### What happens if my gas limit is too low?

The transaction is mined but reverts with an "out of gas" error, and you still pay for the gas consumed up to the limit. KeeperHub does not retry it: the run fails and reports the revert, including the transaction hash. Raise or clear the gas limit and run the workflow again.

### What happens if my gas limit is too high?

The transaction reserves more gas but only consumes what it needs. Unused gas is refunded. There is no direct cost penalty, but very high limits may cause the transaction to be deprioritized by some networks.

### Does the gas limit affect gas price/fees?

No. The gas limit only sets the maximum gas units. Gas pricing is handled separately by KeeperHub's adaptive fee strategy. To set the tip yourself on a contract write, use the [Priority Fee](#priority-fee) field, and to bound the total fee, use [Max Fee](#max-fee).

## Solana Fees

Solana transactions do not use EVM-style gas limits or multipliers. Instead, fees are paid in lamports from your SOL balance.

Every confirmed transaction includes a **base signature fee** of 5,000 lamports. If the transaction sets a compute-unit price, KeeperHub also reports the priority component derived from consumed compute units and the effective micro-lamport price.

In workflow outputs for Solana transfers:

- `gasUsed` is the total lamport fee paid
- `gasUsedUnits` is the compute units consumed
- `effectiveGasPrice` is the micro-lamports-per-compute-unit price used for the priority component

There is no gas limit multiplier on Solana write actions. Ensure the wallet holds enough SOL to cover both the transfer amount (for native SOL sends) and the transaction fee, plus any rent required when creating a recipient associated token account during SPL transfers.

## Wallet Funding

Ensure your Turnkey wallet has sufficient ETH to cover:

- Transaction gas costs
- Retry attempts
- Potential gas price spikes during network congestion

A wallet funded with USDC can convert some of it to ETH with [Gas Top-Up](/api/direct-execution#gas-top-up). This is separate from pay-as-you-go billing: USDC sent for billing pays for executions, while a gas top-up turns the wallet's own USDC into ETH that stays in the wallet.

See [Turnkey Integration](/wallet-management/turnkey) for wallet funding details.
