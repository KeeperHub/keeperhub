---
title: "Aerodrome"
description: "Aerodrome Finance DEX on Base -- pool reserves, swap quotes, liquidity management, ve(3,3) voting, gauge management, and AERO token operations."
---

# Aerodrome

Aerodrome Finance is the leading decentralized exchange on Base, built as a fork of Velodrome V2. It uses a ve(3,3) model with concentrated and volatile liquidity pools, voting escrow tokenomics, and gauge-based emissions. This plugin provides actions for querying pool state, managing liquidity, checking voting power, managing veAERO locks, and executing swaps.

Supported chains: Base (8453). Read-only actions work without credentials. Write actions require a connected wallet.

## Actions

| Action | Type | Credentials | Description |
|--------|------|-------------|-------------|
| Get Pool Reserves | Read | No | Get current reserves for a token pair pool |
| Get Pool Address | Read | No | Resolve pool address from a token pair |
| Get Expected Output | Read | No | Get expected output amount for a swap from a specific pool |
| Get Total Pool Count | Read | No | Get total number of pools in the factory |
| Get Total Voting Weight | Read | No | Get total voting weight across all gauges |
| Check Gauge Status | Read | No | Check whether a gauge is active |
| Get Gauge for Pool | Read | No | Look up gauge address for a pool |
| Get veNFT Voting Power | Read | No | Get voting power of a veAERO NFT |
| Get Lock Details | Read | No | Get locked amount and unlock timestamp for a veNFT |
| Get AERO Balance | Read | No | Check AERO token balance of an address |
| Swap Exact Tokens | Write | Wallet | Swap exact input tokens for output tokens via routes |
| Add Liquidity | Write | Wallet | Add liquidity to a pool and receive LP tokens |
| Remove Liquidity | Write | Wallet | Remove liquidity from a pool by burning LP tokens |
| Vote on Gauges | Write | Wallet | Cast votes for pool gauges using veAERO |
| Reset Votes | Write | Wallet | Reset all gauge votes for a veNFT |
| Create veAERO Lock | Write | Wallet | Lock AERO tokens to create a veNFT |
| Increase Lock Amount | Write | Wallet | Add more AERO to an existing veNFT lock |
| Increase Lock Duration | Write | Wallet | Extend lock duration of a veNFT |
| Withdraw Expired Lock | Write | Wallet | Withdraw AERO from an expired veNFT lock |
| Claim Gauge Rewards | Write | Wallet | Claim accumulated rewards from gauges |
| Approve AERO | Write | Wallet | Approve an address to spend AERO tokens |

## Events

| Event | Contract | Description |
|-------|----------|-------------|
| Pool Swap | Pool | Fires when a swap occurs in a pool |
| Pool Reserves Synced | Pool | Fires when reserves update after any pool operation |
| veAERO Deposit | VotingEscrow | Fires when AERO tokens are locked or added to a veNFT |
| veAERO Withdrawal | VotingEscrow | Fires when AERO is withdrawn from an expired lock |
| Gauge Vote Cast | Voter | Fires when a veNFT holder casts gauge votes |
| Gauge Created | Voter | Fires when a new gauge is created for a pool |
| Reward Distributed | Voter | Fires when AERO emissions are distributed to a gauge |

---

## Get Pool Reserves

Get the current reserves for an Aerodrome pool by token pair. Reserve values are in raw wei and reflect each token's native decimals.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| tokenA | address | Token A Address |
| tokenB | address | Token B Address |
| stable | bool | Stable Pool (true/false) |
| factory | address | Pool Factory Address (defaults to Aerodrome factory) |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| reserveA | uint256 | Reserve A (raw wei) |
| reserveB | uint256 | Reserve B (raw wei) |

**When to use:** Monitor pool liquidity depth, calculate token prices from reserves, detect significant reserve changes, build liquidity monitoring dashboards.

---

## Get Pool Address

Resolve the pool address for a token pair and pool type (stable/volatile). Use this to look up pool addresses before calling pool-specific actions.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| tokenA | address | Token A Address |
| tokenB | address | Token B Address |
| stable | bool | Stable Pool (true/false) |
| factory | address | Pool Factory Address (defaults to Aerodrome factory) |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| pool | address | Pool Address |

**When to use:** Resolve pool addresses before calling Get Expected Output or other pool-specific actions, discover pools for token pairs.

---

## Get Expected Output

Get the expected output amount for a swap from a specific Aerodrome pool. Requires the pool address (use Get Pool Address to resolve it).

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| amountIn | uint256 | Input Amount (wei) |
| tokenIn | address | Input Token Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| amountOut | uint256 | Expected Output (wei) |

**When to use:** Get swap quotes before executing, compare prices across pools, build price monitoring workflows.

---

## Get Total Pool Count

Get the total number of pools created by the Aerodrome factory.

**Inputs:** None

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| count | uint256 | Total Pool Count |

**When to use:** Monitor protocol growth, track new pool deployments, build protocol analytics dashboards.

---

## Get Total Voting Weight

Get the total voting weight across all gauges in the Aerodrome Voter contract.

**Inputs:** None

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| totalWeight | uint256 | Total Weight (18 decimals) |

**When to use:** Monitor overall voting activity, calculate gauge weight percentages, track voting participation over time.

---

## Check Gauge Status

Check whether a gauge is active and receiving emissions. Inactive gauges do not distribute rewards.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| _gauge | address | Gauge Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| alive | bool | Is Alive |

**When to use:** Verify a gauge is active before voting, monitor gauge health, detect gauge deactivation for alerting.

---

## Get Gauge for Pool

Look up the gauge address for a pool. Use this before voting or checking gauge status.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| _pool | address | Pool Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| gauge | address | Gauge Address |

**When to use:** Resolve gauge addresses before voting or claiming rewards, build workflows that chain pool lookup to gauge operations.

---

## Get veNFT Voting Power

Get the current voting power of a veAERO NFT position. Voting power decays linearly over the lock duration.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| _tokenId | uint256 | veNFT Token ID |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| balance | uint256 | Voting Power (18 decimals) |

**When to use:** Monitor voting power decay, plan lock extensions, track veNFT positions for governance participation.

---

## Get Lock Details

Get the locked AERO amount and unlock timestamp for a veNFT position.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| _tokenId | uint256 | veNFT Token ID |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| amount | int128 | Locked Amount (raw) |
| end | uint256 | Unlock Timestamp (unix) |

**When to use:** Check lock expiration dates, monitor locked amounts, determine when a veNFT can be withdrawn, plan lock extensions.

---

## Get AERO Balance

Check the AERO token balance of an address.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| account | address | Wallet Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| balance | uint256 | AERO Balance (18 decimals) |

**When to use:** Monitor AERO holdings, track reward accumulation, trigger workflows based on balance thresholds.

---

## Swap Exact Tokens

Swap an exact amount of input tokens for as many output tokens as possible via Aerodrome routes.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| amountIn | uint256 | Input Amount (wei) |
| amountOutMin | uint256 | Minimum Output (wei) |
| routes | tuple[] | Swap Routes (JSON array of {from, to, stable, factory}) |
| to | address | Recipient Address |
| deadline | uint256 | Deadline (unix timestamp) |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Execute token swaps, automate trading strategies, rebalance portfolios.

---

## Add Liquidity

Add liquidity to an Aerodrome pool and receive LP tokens.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| tokenA | address | Token A Address |
| tokenB | address | Token B Address |
| stable | bool | Stable Pool (true/false) |
| amountADesired | uint256 | Desired Amount A (wei) |
| amountBDesired | uint256 | Desired Amount B (wei) |
| amountAMin | uint256 | Minimum Amount A (wei) |
| amountBMin | uint256 | Minimum Amount B (wei) |
| to | address | Recipient Address |
| deadline | uint256 | Deadline (unix timestamp) |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Provide liquidity to earn trading fees, build LP management workflows, automate liquidity provisioning strategies.

---

## Remove Liquidity

Remove liquidity from an Aerodrome pool by burning LP tokens.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| tokenA | address | Token A Address |
| tokenB | address | Token B Address |
| stable | bool | Stable Pool (true/false) |
| liquidity | uint256 | LP Token Amount (wei) |
| amountAMin | uint256 | Minimum Amount A (wei) |
| amountBMin | uint256 | Minimum Amount B (wei) |
| to | address | Recipient Address |
| deadline | uint256 | Deadline (unix timestamp) |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Exit liquidity positions, rebalance LP allocations, automate withdrawal strategies based on conditions.

---

## Vote on Gauges

Cast votes for pool gauges using veAERO voting power. Votes determine emission distribution to liquidity pools.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| _tokenId | uint256 | veNFT Token ID |
| _poolVote | address[] | Pool Addresses (comma-separated) |
| _weights | uint256[] | Vote Weights (comma-separated) |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Participate in gauge voting, automate weekly vote rebalancing, optimize emission allocation.

---

## Reset Votes

Reset all gauge votes for a veNFT. Required before changing vote allocations in a new epoch.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| _tokenId | uint256 | veNFT Token ID |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Clear previous epoch votes before re-voting, automate weekly vote reset + re-vote workflows.

---

## Create veAERO Lock

Lock AERO tokens to create a veAERO NFT position with voting power. Longer lock durations yield more voting power.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| _value | uint256 | AERO Amount (wei, 18 decimals) |
| _lockDuration | uint256 | Lock Duration (seconds) |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Acquire voting power, participate in governance, earn trading fee rebates through voting.

---

## Increase Lock Amount

Add more AERO tokens to an existing veNFT lock position.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| _tokenId | uint256 | veNFT Token ID |
| _value | uint256 | Additional AERO Amount (wei, 18 decimals) |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Boost voting power by adding more AERO to an active lock, compound claimed rewards into an existing position.

---

## Increase Lock Duration

Extend the lock duration of an existing veNFT position.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| _tokenId | uint256 | veNFT Token ID |
| _lockDuration | uint256 | New Lock Duration (seconds) |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Restore decayed voting power by extending the lock, maintain maximum governance participation.

---

## Withdraw Expired Lock

Withdraw AERO tokens from an expired veNFT lock position.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| _tokenId | uint256 | veNFT Token ID |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Reclaim AERO after a lock expires, automate post-expiry withdrawal workflows.

---

## Claim Gauge Rewards

Claim accumulated AERO rewards from gauges.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| _gauges | address[] | Gauge Addresses (comma-separated) |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Harvest accumulated rewards, automate periodic reward collection, compound rewards into new positions.

---

## Approve AERO

Approve an address to spend AERO tokens on your behalf. Required before creating locks or interacting with contracts that need AERO allowance.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| spender | address | Spender Address |
| amount | uint256 | Amount (wei) |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Set up allowances before locking AERO, approve contracts for token transfers.

---

## Example Workflows

### Pool Reserve Monitor

`Schedule (hourly) -> Aerodrome: Get Pool Reserves -> Code: Format Reserves -> Condition (reserve < threshold) -> Discord: Low Liquidity Alert`

Monitor an Aerodrome pool's reserves hourly. If either reserve drops below a configured threshold, send a Discord alert with the current reserve values.

### Swap Quote Tracker

`Schedule (every 15 min) -> Aerodrome: Get Pool Address -> Aerodrome: Get Expected Output -> Code: Calculate Price -> Condition (price deviation) -> Webhook: Price Alert`

Resolve a pool for a token pair, get swap quotes, and alert via webhook when the price deviates significantly from expected.

### veNFT Voting Power Monitor

`Schedule (daily) -> Aerodrome: Get veNFT Voting Power -> Code: Format Power -> Condition (power < minimum) -> SendGrid: Lock Renewal Reminder`

Monitor veAERO voting power decay and send an email reminder when it drops below a threshold, signaling time to extend the lock.

### veNFT Lock Expiry Watchdog

`Schedule (daily) -> Aerodrome: Get Lock Details -> Code: Check Expiry -> Condition (expiry within 7 days) -> Aerodrome: Increase Lock Duration`

Check veNFT lock expiration daily and auto-extend the lock when it's within 7 days of expiring.

### Weekly Vote Reset and Re-Vote

`Schedule (weekly, epoch flip) -> Aerodrome: Reset Votes -> Aerodrome: Vote on Gauges`

Automate the weekly voting cycle: reset previous epoch votes and cast new votes for target gauge pools.

### Reward Harvesting and Compounding

`Schedule (weekly) -> Aerodrome: Claim Gauge Rewards -> Aerodrome: Get AERO Balance -> Condition (balance > minimum) -> Aerodrome: Increase Lock Amount`

Claim gauge rewards weekly and compound them into an existing veNFT lock position when the balance exceeds a threshold.

### LP Position Manager

`Schedule (daily) -> Aerodrome: Get Pool Reserves -> Code: Calculate Imbalance -> Condition (imbalance > threshold) -> Aerodrome: Remove Liquidity -> Aerodrome: Add Liquidity`

Monitor pool reserves and rebalance an LP position when the pool ratio drifts beyond a configured threshold.

### AERO Treasury Dashboard

`Schedule (daily) -> Aerodrome: Get AERO Balance -> Aerodrome: Get veNFT Voting Power -> Aerodrome: Get Lock Details -> Code: Summarize -> SendGrid: Daily Report`

Daily email report combining liquid AERO balance, veNFT voting power, and lock details into a treasury position summary.

---

## Supported Chains

| Chain | Contracts Available |
|-------|-------------------|
| Base (8453) | Router, Voter, Pool Factory, VotingEscrow, Pool, AERO Token |

All contracts are available on Base only.
