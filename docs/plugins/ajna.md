---
title: "Ajna Protocol"
description: "Liquidation and vault keeper operations for the Ajna permissionless lending protocol on Base."
---

# Ajna Protocol

Ajna is a permissionless, oracle-free lending protocol. This plugin provides actions for liquidation keeper operations (kick, bucket-take, settle, withdraw bonds) and vault keeper operations (drain, move liquidity, buffer management) across two lending pools on Base: cbBTC/usBTCd and usBTCd/webmx.

All read actions work without credentials. Write actions require a connected wallet.

Supported chains: Base (8453) only.

## Actions

| Action | Type | Credentials | Description |
|--------|------|-------------|-------------|
| Get Auction Status | Read | No | Get current auction status for a borrower in an Ajna pool |
| Get HPB Index | Read | No | Get the highest price bucket index of an Ajna pool |
| Get Pool LUP | Read | No | Get the Lowest Utilized Price of an Ajna pool |
| Get Pool HTP | Read | No | Get the Highest Threshold Price of an Ajna pool |
| Get Borrower Info | Read | No | Get borrower loan information including debt, collateral, and threshold price |
| Price to Bucket Index | Read | No | Convert a price to its corresponding Ajna bucket index |
| Bucket Index to Price | Read | No | Convert a bucket index to its corresponding price |
| Get Deposit Index | Read | No | Get the bucket index containing a given amount of deposit for an Ajna pool |
| Pool 1 Kicker Info | Read | No | Get kicker bond information in the cbBTC/usBTCd pool |
| Pool 1 Auction Info | Read | No | Get auction details for a borrower in the cbBTC/usBTCd pool |
| Pool 1 Bucket Info | Read | No | Get bucket information at a given index in the cbBTC/usBTCd pool |
| Pool 1 Inflator Info | Read | No | Get pool inflator and last update timestamp for cbBTC/usBTCd pool |
| Pool 1 Kick | Write | Wallet | Kick an undercollateralized borrower to start a liquidation auction in the cbBTC/usBTCd pool |
| Pool 1 Bucket Take | Write | Wallet | Take from a liquidation auction using bucket liquidity in the cbBTC/usBTCd pool |
| Pool 1 Settle | Write | Wallet | Settle a completed liquidation auction in the cbBTC/usBTCd pool |
| Pool 1 Withdraw Bonds | Write | Wallet | Withdraw claimable kicker bonds from the cbBTC/usBTCd pool |
| Pool 1 Update Interest | Write | Wallet | Update interest rate for the cbBTC/usBTCd pool |
| Pool 2 Kicker Info | Read | No | Get kicker bond information in the usBTCd/webmx pool |
| Pool 2 Auction Info | Read | No | Get auction details for a borrower in the usBTCd/webmx pool |
| Pool 2 Bucket Info | Read | No | Get bucket information at a given index in the usBTCd/webmx pool |
| Pool 2 Inflator Info | Read | No | Get pool inflator and last update timestamp for usBTCd/webmx pool |
| Pool 2 Kick | Write | Wallet | Kick an undercollateralized borrower to start a liquidation auction in the usBTCd/webmx pool |
| Pool 2 Bucket Take | Write | Wallet | Take from a liquidation auction using bucket liquidity in the usBTCd/webmx pool |
| Pool 2 Settle | Write | Wallet | Settle a completed liquidation auction in the usBTCd/webmx pool |
| Pool 2 Withdraw Bonds | Write | Wallet | Withdraw claimable kicker bonds from the usBTCd/webmx pool |
| Pool 2 Update Interest | Write | Wallet | Update interest rate for the usBTCd/webmx pool |
| Vault 1 Is Paused | Read | No | Check if the cbBTC/usBTCd vault is paused |
| Vault 1 Get Buckets | Read | No | Get all active bucket indices in the cbBTC/usBTCd vault |
| Vault 1 Total Assets | Read | No | Get total assets managed by the cbBTC/usBTCd vault |
| Vault 1 LP to Value | Read | No | Convert LP amount to quote token value for a bucket in the cbBTC/usBTCd vault |
| Vault 1 Drain Bucket | Write | Wallet | Drain all liquidity from a bucket in the cbBTC/usBTCd vault |
| Vault 1 Move Liquidity | Write | Wallet | Move liquidity between buckets in the cbBTC/usBTCd vault |
| Vault 1 Move From Buffer | Write | Wallet | Move liquidity from the buffer to a pool bucket in the cbBTC/usBTCd vault |
| Vault 1 Move To Buffer | Write | Wallet | Move liquidity from a pool bucket to the buffer in the cbBTC/usBTCd vault |
| Vault 2 Is Paused | Read | No | Check if the usBTCd/webmx vault is paused |
| Vault 2 Get Buckets | Read | No | Get all active bucket indices in the usBTCd/webmx vault |
| Vault 2 Total Assets | Read | No | Get total assets managed by the usBTCd/webmx vault |
| Vault 2 LP to Value | Read | No | Convert LP amount to quote token value for a bucket in the usBTCd/webmx vault |
| Vault 2 Drain Bucket | Write | Wallet | Drain all liquidity from a bucket in the usBTCd/webmx vault |
| Vault 2 Move Liquidity | Write | Wallet | Move liquidity between buckets in the usBTCd/webmx vault |
| Vault 2 Move From Buffer | Write | Wallet | Move liquidity from the buffer to a pool bucket in the usBTCd/webmx vault |
| Vault 2 Move To Buffer | Write | Wallet | Move liquidity from a pool bucket to the buffer in the usBTCd/webmx vault |
| Vault 1 Buffer Ratio | Read | No | Get the target buffer ratio for the cbBTC/usBTCd vault |
| Vault 1 Min Bucket Index | Read | No | Get the minimum allowed bucket index for the cbBTC/usBTCd vault |
| Vault 2 Buffer Ratio | Read | No | Get the target buffer ratio for the usBTCd/webmx vault |
| Vault 2 Min Bucket Index | Read | No | Get the minimum allowed bucket index for the usBTCd/webmx vault |
| Vault 1 Buffer Total | Read | No | Get total liquidity held in the cbBTC/usBTCd buffer contract |
| Vault 2 Buffer Total | Read | No | Get total liquidity held in the usBTCd/webmx buffer contract |

---

## Get Auction Status

Get the current auction state for a borrower across any Ajna pool. Returns kick time, collateral, debt to cover, price, neutral price, and bond factor.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| ajnaPool_ | address | Pool Address |
| borrower_ | address | Borrower Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| kickTime_ | uint256 | Kick Timestamp |
| collateral_ | uint256 | Collateral (WAD), 18 decimals |
| debtToCover_ | uint256 | Debt to Cover (WAD), 18 decimals |
| isCollateralized_ | bool | Is Collateralized |
| price_ | uint256 | Current Price (WAD), 18 decimals |
| neutralPrice_ | uint256 | Neutral Price (WAD), 18 decimals |
| referencePrice_ | uint256 | Reference Price (WAD), 18 decimals |
| debtToCollateral_ | uint256 | Debt to Collateral (WAD), 18 decimals |
| bondFactor_ | uint256 | Bond Factor (WAD), 18 decimals |

**When to use:** Check whether an auction is active and what price it is currently at before deciding to take. Use in combination with Pool Kick and Pool Bucket Take to build a complete liquidation keeper workflow.

---

## Get HPB Index

Get the highest price bucket index currently active in an Ajna pool.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| ajnaPool_ | address | Pool Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| index | uint256 | HPB Index |

**When to use:** Determine where the highest-priced liquidity sits. Useful as an input to bucket take operations and for monitoring pool health.

---

## Get Pool LUP

Get the Lowest Utilized Price of an Ajna pool.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| ajnaPool_ | address | Pool Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| lup | uint256 | LUP (WAD), 18 decimals |

**When to use:** Monitor the pool's liquidity utilization level. The LUP determines whether borrowers are collateralized and eligible for kicking.

---

## Get Pool HTP

Get the Highest Threshold Price of an Ajna pool.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| ajnaPool_ | address | Pool Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| htp | uint256 | HTP (WAD), 18 decimals |

**When to use:** Monitor the pool's highest threshold price to identify borrowers near liquidation. Compare against LUP to assess overall pool risk.

---

## Get Borrower Info

Get complete loan information for a specific borrower in an Ajna pool.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| ajnaPool_ | address | Pool Address |
| borrower_ | address | Borrower Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| debt | uint256 | Borrower Debt (WAD), 18 decimals |
| collateral | uint256 | Borrower Collateral (WAD), 18 decimals |
| t0Np | uint256 | T0 Neutral Price (WAD), 18 decimals |
| thresholdPrice | uint256 | Threshold Price (WAD), 18 decimals |
| neutralPrice | uint256 | Neutral Price (WAD), 18 decimals |

**When to use:** Inspect a specific borrower's position before deciding to kick them. Compare threshold price against LUP to confirm they are eligible for liquidation.

---

## Price to Bucket Index

Convert a WAD-denominated price to the corresponding Ajna bucket index.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| price | uint256 | Price (WAD) |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| index | uint256 | Bucket Index |

**When to use:** Translate a price value into a bucket index when configuring vault operations or targeting a specific price range for bucket take.

---

## Bucket Index to Price

Convert an Ajna bucket index to its corresponding WAD-denominated price.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| index_ | uint256 | Bucket Index |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| price | uint256 | Price (WAD), 18 decimals |

**When to use:** Look up the price represented by a given bucket index. Useful for display and for verifying bucket positions in vault workflows.

---

## Get Deposit Index

Get the bucket index that contains a given amount of deposit for an Ajna pool.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| ajnaPool_ | address | Pool Address |
| debt_ | uint256 | Debt Amount (WAD) |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| index | uint256 | Deposit Bucket Index |

**When to use:** Find which bucket holds enough deposit to cover a given debt level. Used to select the correct limit index when kicking borrowers.

---

## Pool 1 Kicker Info

Get the claimable and locked bond amounts for a kicker address in the cbBTC/usBTCd pool.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| kicker_ | address | Kicker Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| claimable | uint256 | Claimable Bond (WAD), 18 decimals |
| locked | uint256 | Locked Bond (WAD), 18 decimals |

**When to use:** Check how much bond is available to withdraw after auctions complete. Use before calling Pool 1 Withdraw Bonds to confirm the claimable amount.

---

## Pool 1 Auction Info

Get full auction details for a specific borrower in the cbBTC/usBTCd pool.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| borrower_ | address | Borrower Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| kicker | address | Kicker Address |
| bondFactor | uint256 | Bond Factor (WAD), 18 decimals |
| bondSize | uint256 | Bond Size (WAD), 18 decimals |
| kickTime | uint256 | Kick Timestamp |
| referencePrice | uint256 | Reference Price (WAD), 18 decimals |
| neutralPrice | uint256 | Neutral Price (WAD), 18 decimals |
| debtToCollateral | uint256 | Debt to Collateral (WAD), 18 decimals |
| head | address | Head Address |
| next | address | Next Address |
| prev | address | Prev Address |

**When to use:** Verify auction state and timing before taking or settling. Check kick time to determine how long the auction has been running.

---

## Pool 1 Bucket Info

Get information for a specific bucket by index in the cbBTC/usBTCd pool.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| index_ | uint256 | Bucket Index |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| price | uint256 | Bucket Price (WAD), 18 decimals |
| quoteTokens | uint256 | Quote Tokens (WAD), 18 decimals |
| collateral | uint256 | Collateral (WAD), 18 decimals |
| bucketLP | uint256 | LP Amount (WAD), 18 decimals |
| scale | uint256 | Bucket Scale (WAD), 18 decimals |

**When to use:** Inspect liquidity depth at a target bucket before executing a bucket take or move operation.

---

## Pool 1 Inflator Info

Get the pool inflator and last update timestamp for the cbBTC/usBTCd pool.

**Inputs:** None

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| inflator | uint256 | Pool Inflator (WAD), 18 decimals |
| lastUpdate | uint256 | Last Update Timestamp |

**When to use:** Monitor how long since interest was last accrued. Use to decide when to call Pool 1 Update Interest.

---

## Pool 1 Kick

Kick an undercollateralized borrower to initiate a liquidation auction in the cbBTC/usBTCd pool. The caller provides a bond and earns rewards if the auction clears at or above the neutral price.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| borrower_ | address | Borrower Address |
| limitIndex_ | uint256 | Limit Bucket Index |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Start a liquidation when a borrower's threshold price exceeds the LUP. Precede with Get Borrower Info and Get Pool LUP to confirm eligibility.

---

## Pool 1 Bucket Take

Take collateral from an active liquidation auction using bucket liquidity in the cbBTC/usBTCd pool. LP holders in the target bucket receive collateral in exchange for their quote tokens.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| borrowerAddress_ | address | Borrower Address |
| depositTake_ | bool | Use Deposit Take |
| index_ | uint256 | Bucket Index |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Execute a liquidation take using existing bucket liquidity. Call after confirming an active auction via Pool 1 Auction Info or Get Auction Status.

---

## Pool 1 Settle

Settle a completed liquidation auction in the cbBTC/usBTCd pool, distributing remaining collateral and debt across buckets.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| borrowerAddress_ | address | Borrower Address |
| maxDepth_ | uint256 | Max Bucket Depth |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Finalize an auction after the auction period has ended or all debt has been covered. Settle unlocks bonded kicker funds.

---

## Pool 1 Withdraw Bonds

Withdraw claimable kicker bond from the cbBTC/usBTCd pool to a recipient address.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| recipient_ | address | Recipient Address |
| maxAmount_ | uint256 | Max Amount (WAD) |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Reclaim kicker rewards after successful liquidations. Call Pool 1 Kicker Info first to confirm the claimable balance.

---

## Pool 1 Update Interest

Accrue and update the interest rate for the cbBTC/usBTCd pool.

**Inputs:** None

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Keep pool interest up to date. Call periodically or before executing pool operations to ensure accurate debt accounting.

---

## Pool 2 Kicker Info

Get the claimable and locked bond amounts for a kicker address in the usBTCd/webmx pool.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| kicker_ | address | Kicker Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| claimable | uint256 | Claimable Bond (WAD), 18 decimals |
| locked | uint256 | Locked Bond (WAD), 18 decimals |

**When to use:** Check how much bond is available to withdraw after auctions complete in Pool 2. Use before calling Pool 2 Withdraw Bonds.

---

## Pool 2 Auction Info

Get full auction details for a specific borrower in the usBTCd/webmx pool.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| borrower_ | address | Borrower Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| kicker | address | Kicker Address |
| bondFactor | uint256 | Bond Factor (WAD), 18 decimals |
| bondSize | uint256 | Bond Size (WAD), 18 decimals |
| kickTime | uint256 | Kick Timestamp |
| referencePrice | uint256 | Reference Price (WAD), 18 decimals |
| neutralPrice | uint256 | Neutral Price (WAD), 18 decimals |
| debtToCollateral | uint256 | Debt to Collateral (WAD), 18 decimals |
| head | address | Head Address |
| next | address | Next Address |
| prev | address | Prev Address |

**When to use:** Verify auction state for Pool 2 before taking or settling. Check kick time to determine elapsed auction duration.

---

## Pool 2 Bucket Info

Get information for a specific bucket by index in the usBTCd/webmx pool.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| index_ | uint256 | Bucket Index |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| price | uint256 | Bucket Price (WAD), 18 decimals |
| quoteTokens | uint256 | Quote Tokens (WAD), 18 decimals |
| collateral | uint256 | Collateral (WAD), 18 decimals |
| bucketLP | uint256 | LP Amount (WAD), 18 decimals |
| scale | uint256 | Bucket Scale (WAD), 18 decimals |

**When to use:** Inspect liquidity at a target bucket in Pool 2 before bucket take or liquidity movement operations.

---

## Pool 2 Inflator Info

Get the pool inflator and last update timestamp for the usBTCd/webmx pool.

**Inputs:** None

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| inflator | uint256 | Pool Inflator (WAD), 18 decimals |
| lastUpdate | uint256 | Last Update Timestamp |

**When to use:** Monitor interest accrual staleness for Pool 2. Use to decide when to call Pool 2 Update Interest.

---

## Pool 2 Kick

Kick an undercollateralized borrower to initiate a liquidation auction in the usBTCd/webmx pool.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| borrower_ | address | Borrower Address |
| limitIndex_ | uint256 | Limit Bucket Index |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Start a liquidation in Pool 2 when a borrower's threshold price exceeds the LUP.

---

## Pool 2 Bucket Take

Take collateral from an active liquidation auction using bucket liquidity in the usBTCd/webmx pool.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| borrowerAddress_ | address | Borrower Address |
| depositTake_ | bool | Use Deposit Take |
| index_ | uint256 | Bucket Index |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Execute a liquidation take in Pool 2 using existing bucket liquidity.

---

## Pool 2 Settle

Settle a completed liquidation auction in the usBTCd/webmx pool.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| borrowerAddress_ | address | Borrower Address |
| maxDepth_ | uint256 | Max Bucket Depth |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Finalize an auction in Pool 2 after the auction period ends or all debt is covered.

---

## Pool 2 Withdraw Bonds

Withdraw claimable kicker bond from the usBTCd/webmx pool.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| recipient_ | address | Recipient Address |
| maxAmount_ | uint256 | Max Amount (WAD) |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Reclaim kicker rewards from Pool 2 after successful liquidations.

---

## Pool 2 Update Interest

Accrue and update the interest rate for the usBTCd/webmx pool.

**Inputs:** None

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Keep Pool 2 interest up to date. Call periodically or before pool operations.

---

## Vault 1 Is Paused

Check whether the cbBTC/usBTCd vault is currently paused.

**Inputs:** None

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| isPaused | bool | Is Vault Paused |

**When to use:** Gate vault operations on pause state. If the vault is paused, skip drain, move, and buffer operations to avoid reverts.

---

## Vault 1 Get Buckets

Get all active bucket indices currently held in the cbBTC/usBTCd vault.

**Inputs:** None

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| buckets | uint256[] | Active Bucket Indices |

**When to use:** Enumerate all buckets the vault holds positions in. Use as input to LP-to-value or drain operations when iterating over all positions.

---

## Vault 1 Total Assets

Get the total quote token assets managed by the cbBTC/usBTCd vault.

**Inputs:** None

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| assets | uint256 | Total Assets (WAD), 18 decimals |

**When to use:** Monitor the vault's total value. Use in rebalancing workflows to compare against buffer total and calculate target allocations.

---

## Vault 1 LP to Value

Convert an LP amount to its quote token value for a specific bucket in the cbBTC/usBTCd vault.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| bucket | uint256 | Bucket Index |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| value | uint256 | Value (WAD), 18 decimals |

**When to use:** Calculate the current quote token value of a bucket position before moving or draining it.

---

## Vault 1 Drain Bucket

Drain all liquidity from a specific bucket in the cbBTC/usBTCd vault, withdrawing all quote tokens and collateral.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| bucket | uint256 | Bucket Index |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Remove liquidity from an out-of-range or empty bucket to consolidate vault positions.

---

## Vault 1 Move Liquidity

Move liquidity from one bucket to another within the cbBTC/usBTCd vault.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| fromIndex_ | uint256 | Source Bucket Index |
| toIndex_ | uint256 | Destination Bucket Index |
| amt_ | uint256 | Amount (WAD) |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Rebalance vault liquidity between price buckets. Use when the LUP shifts and optimal bucket range changes.

---

## Vault 1 Move From Buffer

Move liquidity from the buffer contract into a pool bucket in the cbBTC/usBTCd vault.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| toIndex_ | uint256 | Destination Bucket Index |
| amt_ | uint256 | Amount (WAD) |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Deploy buffered capital into the pool when the buffer ratio exceeds the target. Use Vault 1 Buffer Total and Vault 1 Buffer Ratio to determine the amount to deploy.

---

## Vault 1 Move To Buffer

Move liquidity from a pool bucket into the buffer in the cbBTC/usBTCd vault.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| fromIndex_ | uint256 | Source Bucket Index |
| amt_ | uint256 | Amount (WAD) |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Pull liquidity from the pool into the buffer when the buffer ratio falls below the target. Provides dry powder for deposit redemptions.

---

## Vault 2 Is Paused

Check whether the usBTCd/webmx vault is currently paused.

**Inputs:** None

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| isPaused | bool | Is Vault Paused |

**When to use:** Gate vault operations on pause state for Vault 2.

---

## Vault 2 Get Buckets

Get all active bucket indices currently held in the usBTCd/webmx vault.

**Inputs:** None

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| buckets | uint256[] | Active Bucket Indices |

**When to use:** Enumerate all active positions in Vault 2 for iteration and value calculations.

---

## Vault 2 Total Assets

Get the total quote token assets managed by the usBTCd/webmx vault.

**Inputs:** None

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| assets | uint256 | Total Assets (WAD), 18 decimals |

**When to use:** Monitor the total value of Vault 2. Use in rebalancing comparisons against buffer total.

---

## Vault 2 LP to Value

Convert an LP amount to its quote token value for a specific bucket in the usBTCd/webmx vault.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| bucket | uint256 | Bucket Index |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| value | uint256 | Value (WAD), 18 decimals |

**When to use:** Calculate the current quote token value of a Vault 2 bucket position.

---

## Vault 2 Drain Bucket

Drain all liquidity from a specific bucket in the usBTCd/webmx vault.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| bucket | uint256 | Bucket Index |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Remove liquidity from an out-of-range bucket in Vault 2.

---

## Vault 2 Move Liquidity

Move liquidity from one bucket to another within the usBTCd/webmx vault.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| fromIndex_ | uint256 | Source Bucket Index |
| toIndex_ | uint256 | Destination Bucket Index |
| amt_ | uint256 | Amount (WAD) |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Rebalance Vault 2 liquidity when the pool's price range shifts.

---

## Vault 2 Move From Buffer

Move liquidity from the buffer into a pool bucket in the usBTCd/webmx vault.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| toIndex_ | uint256 | Destination Bucket Index |
| amt_ | uint256 | Amount (WAD) |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Deploy buffered capital in Vault 2 when buffer ratio is above target.

---

## Vault 2 Move To Buffer

Move liquidity from a pool bucket into the buffer in the usBTCd/webmx vault.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| fromIndex_ | uint256 | Source Bucket Index |
| amt_ | uint256 | Amount (WAD) |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Pull liquidity from Vault 2 into the buffer when buffer ratio falls below target.

---

## Vault 1 Buffer Ratio

Get the target buffer ratio configured for the cbBTC/usBTCd vault.

**Inputs:** None

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| ratio | uint256 | Buffer Ratio (WAD), 18 decimals |

**When to use:** Read the target ratio before deciding whether to call Move From Buffer or Move To Buffer. Compare against current buffer total divided by total assets.

---

## Vault 1 Min Bucket Index

Get the minimum allowed bucket index for the cbBTC/usBTCd vault.

**Inputs:** None

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| index | uint256 | Min Bucket Index |

**When to use:** Validate target bucket indices before move operations to ensure they are within the allowed range.

---

## Vault 2 Buffer Ratio

Get the target buffer ratio configured for the usBTCd/webmx vault.

**Inputs:** None

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| ratio | uint256 | Buffer Ratio (WAD), 18 decimals |

**When to use:** Read the target ratio for Vault 2 before buffer rebalancing decisions.

---

## Vault 2 Min Bucket Index

Get the minimum allowed bucket index for the usBTCd/webmx vault.

**Inputs:** None

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| index | uint256 | Min Bucket Index |

**When to use:** Validate target bucket indices for Vault 2 move operations.

---

## Vault 1 Buffer Total

Get the total liquidity held in the cbBTC/usBTCd buffer contract.

**Inputs:** None

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| bufferTotal | uint256 | Buffer Total (WAD), 18 decimals |

**When to use:** Read current buffer balance before rebalancing. Divide by Vault 1 Total Assets to compute the current buffer ratio and compare against the target.

---

## Vault 2 Buffer Total

Get the total liquidity held in the usBTCd/webmx buffer contract.

**Inputs:** None

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| bufferTotal | uint256 | Buffer Total (WAD), 18 decimals |

**When to use:** Read the current buffer balance for Vault 2 before deciding on buffer rebalancing operations.

---

## Example Workflows

### Automated Liquidation Keeper (Pool 1)

`Schedule (every 5 min) -> Ajna: Get Borrower Info -> Ajna: Get Pool LUP -> Condition (thresholdPrice > lup) -> Ajna: Pool 1 Kick`

Periodically check a borrower's threshold price against the pool's LUP. If the borrower is undercollateralized, kick them to start the liquidation auction.

### Liquidation Settle and Bond Withdrawal

`Webhook (auction ended) -> Ajna: Pool 1 Auction Info -> Ajna: Pool 1 Settle -> Ajna: Pool 1 Kicker Info -> Condition (claimable > 0) -> Ajna: Pool 1 Withdraw Bonds -> Discord: Send Message`

On auction completion webhook, settle the auction, check for claimable bond, withdraw it, and send a Discord notification with the transaction link.

### Vault Buffer Rebalancing (Vault 1)

`Schedule (hourly) -> Ajna: Vault 1 Total Assets -> Ajna: Vault 1 Buffer Total -> Ajna: Vault 1 Buffer Ratio -> Condition (bufferTotal / totalAssets < ratio) -> Ajna: Vault 1 Move To Buffer`

Hourly check whether the buffer has fallen below its target ratio and automatically move liquidity from a pool bucket into the buffer to restore the target.

### Vault Pause Guard

`Schedule (every 1 min) -> Ajna: Vault 1 Is Paused -> Condition (isPaused == false) -> Ajna: Vault 1 Get Buckets -> Ajna: Vault 1 LP to Value -> Ajna: Vault 1 Move Liquidity`

Check vault pause state before running any rebalancing operations. If the vault is paused, the condition gate stops the workflow without executing writes.

---

## Supported Chains

| Chain | Contracts Available |
|-------|-------------------|
| Base (8453) | Pool Info Utils, cbBTC/usBTCd Pool, usBTCd/webmx Pool, cbBTC/usBTCd Vault, usBTCd/webmx Vault, Vault Config (x2), Buffer (x2) |

All contracts are deployed on Base only. Cross-chain operation is not supported.
