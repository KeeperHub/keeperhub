# Sky Protocol Surplus Distributor (Flap Kicker) Workflows

Migrated from transaction analysis of [0xbdf6a9...](https://etherscan.io/tx/0xbdf6a94718db472bc34f0a4cac5cc4dcef7eb3dd44f5d1db0de39125ba910543). Currently automated by Gelato Network. Goal: replicate and improve in KeeperHub.

---

## 1. Target Analysis

### Transaction Breakdown

**TX**: `0xbdf6a94718db472bc34f0a4cac5cc4dcef7eb3dd44f5d1db0de39125ba910543`
**Block**: 23536930 | **Date**: Oct 9, 2025 | **Gas**: 397,394 (0.000117 ETH / $0.24)

**Execution flow**:
1. Gelato Bundler (`0x417B...0d8`) calls Gelato Network `execWithSig()`
2. Gelato Automate service dispatches to Sky Protocol
3. `Vow.flap()` is triggered, which internally calls `Splitter.kick(bump, 0)`
4. Splitter distributes 10,000 USDS from the Vat surplus:
   - **25% burn** (2,500 USDS) -> FlapperUniV2SwapOnly -> swaps for 36,531 SKY on Uniswap V2 -> SKY sent to MCD Pause Proxy
   - **75% farm** (7,500 USDS) -> StakingRewards as staking rewards

### Contracts Involved

| Contract | Address | Role |
|----------|---------|------|
| Vow | Look up `MCD_VOW` in [chainlog](https://etherscan.io/address/0xdA0Ab1e0017DEbCd72Be8599041a2aa3bA7e740F) | Surplus buffer manager, entry point |
| Splitter | `0xbf7111f13386d23cb2fba5a538107a73f6872bcf` | Revenue distribution (burn/farm split) |
| FlapperUniV2SwapOnly | `0x374D9c3d5134052Bc558F432Afa1df6575f07407` | Swaps USDS for SKY on UniV2 |
| StakingRewards | `0x38E4254bD82ED5Ee97CD1C4278FAae748d998865` | USDS staking rewards (lsSKY) |
| Vat | `0x35d1b3f3d7966a1dfe207aa4514c12a259a0492b` | Core accounting engine |
| USDS | `0xdc035d45d973e3ec169d2276ddab16f1e407384f` | Stablecoin |
| SKY | `0x56072c95faa701256059aa122697b133aded9279` | Governance token |
| Uniswap V2 SKY-USDS | `0x2621cc0b3f3c079c1db0e80794aa24976f0b9e3c` | Liquidity pool |
| MCD Pause Proxy | `0xbe8e3e3618f7474f8cb1d074a26affef007e98fb` | Receives bought SKY |
| Gelato Network | `0x3CACa7b48D0573D793d3b0279b5F0029180E83b6` | Current automation provider |
| Gelato Automate | `0x2a6c106ae13b558bb9e2ec64bd2f1f7beff3a5e0` | Task execution service |

### How Surplus Distribution Works

```
    Stability fees accumulate
              |
              v
        Vat surplus grows
              |
              v
     Anyone calls Vow.flap()
     (permissionless keeper function)
              |
              v
     Vow checks: surplus - debt >= hump + bump
              |
           [true]
              |
              v
     Vow calls Splitter.kick(bump, 0)
              |
       +------+------+
       |             |
       v             v
   25% burn      75% farm
       |             |
       v             v
   Flapper        StakingRewards
   swaps USDS     .notifyRewardAmount()
   for SKY on     distributes 7,500 USDS
   Uniswap V2    to stakers
       |
       v
   36,531 SKY
   sent to MCD
   Pause Proxy
```

### Splitter `kick()` Function (source verified on Etherscan)

```solidity
function kick(uint256 tot, uint256) external auth returns (uint256) {
    require(live == 1, "Splitter/not-live");
    require(block.timestamp >= zzz + hop, "Splitter/kicked-too-soon");
    zzz = block.timestamp;

    vat.move(msg.sender, address(this), tot);

    uint256 lot = tot * burn / RAD;
    if (lot > 0) {
        UsdsJoinLike(usdsJoin).exit(address(flapper), lot);
        flapper.exec(lot);
    }

    uint256 pay = (tot / RAY - lot);
    if (pay > 0) {
        UsdsJoinLike(usdsJoin).exit(address(farm), pay);
        farm.notifyRewardAmount(pay);
    }

    emit Kick(tot, lot, pay);
    return 0;
}
```

**Key parameters**:
- `hop` = 3600 (1 hour cooldown between kicks)
- `burn` = 25% (to FlapperUniV2)
- `farm` = 75% (to StakingRewards)
- `auth` modifier = only authorized callers (Vow is authorized)

### Conditions for Successful `Vow.flap()`

The Vow's `flap()` function is **permissionless** -- any address can call it. It checks:
1. `live == 1` -- system is active
2. `vat.dai(address(this)) - vat.sin(address(this)) - Ash >= bump + hump` -- surplus exceeds buffer + auction lot
3. `Sin == 0` -- no queued debt (all debt has been processed)
4. Internally the Splitter checks: `block.timestamp >= zzz + hop` -- cooldown elapsed

### Vow ABI (for flap)

```json
[
  {"inputs":[],"name":"flap","outputs":[{"name":"id","type":"uint256"}],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[],"name":"live","outputs":[{"name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[],"name":"hump","outputs":[{"name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[],"name":"bump","outputs":[{"name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[],"name":"Ash","outputs":[{"name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[],"name":"Sin","outputs":[{"name":"","type":"uint256"}],"stateMutability":"view","type":"function"}
]
```

### Vat ABI (for surplus check)

```json
[
  {"inputs":[{"name":"","type":"address"}],"name":"dai","outputs":[{"name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"name":"","type":"address"}],"name":"sin","outputs":[{"name":"","type":"uint256"}],"stateMutability":"view","type":"function"}
]
```

### Splitter ABI (for cooldown check)

```json
[
  {"inputs":[],"name":"zzz","outputs":[{"name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[],"name":"hop","outputs":[{"name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[],"name":"live","outputs":[{"name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[],"name":"burn","outputs":[{"name":"","type":"uint256"}],"stateMutability":"view","type":"function"}
]
```

### Identified Automation Gaps

1. **Single vendor dependency**: Currently Gelato is the sole automation provider. If Gelato goes down, surplus doesn't distribute.
2. **No gas optimization**: Gelato executes as soon as conditions are met without waiting for low-gas windows.
3. **No pre-execution verification**: No check on Uniswap pool liquidity/slippage before swapping.
4. **No post-execution tracking**: No notification when surplus is distributed, how much SKY was acquired, or the effective swap rate.
5. **No surplus forecasting**: No monitoring of when the next flap will be available based on fee accrual rate.
6. **No competitive awareness**: No detection of whether other keepers are also trying to call `flap()`.

---

## 2. Capability Source

**Source: Direct code review of the KeeperHub codebase** (MCP unavailable).

Available actions confirmed from code review:
- `web3/read-contract` -- Can read Vow, Vat, Splitter state
- `web3/write-contract` -- Can call `Vow.flap()`
- `web3/check-token-balance` -- Can check USDS/SKY balances
- `Condition` -- Can gate execution
- `Database Query` -- Can do math (PostgreSQL) and store history
- `HTTP Request` -- Can call external APIs (gas price, etc.)
- `discord/send-message`, `telegram/send-message`, `sendgrid/send-email`, `webhook/send-webhook`

---

## 3. Workflow Suggestions

### Workflow 1: Surplus Flap Kicker (Direct TX Replication)

**The gap**: Currently relies solely on Gelato. Single point of failure for a critical protocol operation that distributes surplus revenue.

**The idea**: KeeperHub workflow that checks flap conditions and calls `Vow.flap()` on a schedule, with pre-execution validation and post-execution notification.

**Value**: Redundant automation for surplus distribution. If Gelato misses a window, KeeperHub catches it. Also provides visibility into each execution.

**Trigger**: Schedule - `0 * * * *` (every hour, matching the `hop` cooldown) [EXISTING]

**Nodes**:
1. `web3/read-contract` - Read `Splitter.zzz()` (last kick timestamp) [EXISTING]
2. `web3/read-contract` - Read `Splitter.hop()` (cooldown period) [EXISTING]
3. `web3/read-contract` - Read `Vow.Sin()` (queued debt -- must be 0) [EXISTING]
4. `web3/read-contract` - Read `Vat.dai(vow)` (current surplus) [EXISTING]
5. `web3/read-contract` - Read `Vat.sin(vow)` (current debt) [EXISTING]
6. `web3/read-contract` - Read `Vow.hump()` (surplus buffer) [EXISTING]
7. `web3/read-contract` - Read `Vow.bump()` (lot size) [EXISTING]
8. `Database Query` - Calculate if conditions met: `surplus - debt - Ash >= bump + hump AND timestamp >= zzz + hop AND Sin == 0` [EXISTING]
9. `Condition` - `{{@n8:Check Conditions.rows[0].can_flap}} == true` [EXISTING]
10. `web3/write-contract` - Call `Vow.flap()` [EXISTING]
11. `discord/send-message` - "Surplus distributed: [bump] USDS split 25/75 burn/farm" [EXISTING]
12. `webhook/send-webhook` - Post to ops dashboard [EXISTING]

**Node 8 SQL** (condition calculation):
```sql
SELECT
  CAST('{{@n4:Vat Surplus.result}}' AS NUMERIC) -
  CAST('{{@n5:Vat Debt.result}}' AS NUMERIC) >=
  CAST('{{@n6:Hump.result}}' AS NUMERIC) +
  CAST('{{@n7:Bump.result}}' AS NUMERIC)
  AND CAST('{{@n3:Sin.result}}' AS NUMERIC) = 0
  AND EXTRACT(EPOCH FROM NOW()) >= CAST('{{@n1:Last Kick.result}}' AS NUMERIC) + CAST('{{@n2:Hop.result}}' AS NUMERIC)
  AS can_flap,
  CAST('{{@n4:Vat Surplus.result}}' AS NUMERIC) / 1e45 AS surplus_usds,
  CAST('{{@n7:Bump.result}}' AS NUMERIC) / 1e45 AS bump_usds
```

**Flow**:
```
Schedule (hourly)
    |
    +---+---+---+---+---+---+
    |   |   |   |   |   |   |
    v   v   v   v   v   v   v
   zzz hop Sin dai sin hump bump
    |   |   |   |   |   |   |
    +---+---+---+---+---+---+
            |
            v
    DB: Calculate conditions
            |
            v
    Condition: can_flap?
            |
         [true]
            |
            v
    Write: Vow.flap()
            |
       +----+----+
       |         |
       v         v
    Discord   Webhook
```

**Buildable today?**: YES. Classic Poker pattern with pre-condition checks.

**Value proposition**: Backup automation for critical protocol revenue distribution. Observable execution with audit trail. Gas cost: ~$0.24 per execution (same as Gelato). KeeperHub provides visibility that Gelato doesn't -- every check and execution is logged in the workflow UI.

---

### Workflow 2: Surplus Readiness Monitor

**The gap**: No visibility into WHEN the next flap will be available. Operations teams can't predict surplus distribution timing.

**The idea**: Monitor Vat surplus growth rate and estimate time until next flap is possible. Alert when flap becomes available.

**Value**: Operational forecasting. Know hours in advance when surplus will be distributable.

**Trigger**: Schedule - `*/15 * * * *` (every 15 minutes) [EXISTING]

**Nodes**:
1. `web3/read-contract` - Read `Vat.dai(vow)` [EXISTING]
2. `web3/read-contract` - Read `Vat.sin(vow)` [EXISTING]
3. `web3/read-contract` - Read `Vow.hump()` + `Vow.bump()` [EXISTING]
4. `web3/read-contract` - Read `Splitter.zzz()` + `Splitter.hop()` [EXISTING]
5. `Database Query` - Calculate surplus gap, growth rate from history, ETA [EXISTING]
6. `Condition` - Just became available (wasn't available last check) [EXISTING]
7. `discord/send-message` - "Flap available NOW" or "ETA: ~2h based on fee accrual rate" [EXISTING]

**Node 5 SQL**:
```sql
WITH current AS (
  SELECT
    CAST('{{@n1:Surplus.result}}' AS NUMERIC) / 1e45 AS surplus,
    CAST('{{@n2:Debt.result}}' AS NUMERIC) / 1e45 AS debt,
    (CAST('{{@n3:Hump.result}}' AS NUMERIC) + CAST('{{@n3:Bump.result}}' AS NUMERIC)) / 1e45 AS threshold
),
previous AS (
  SELECT surplus, debt, timestamp FROM surplus_tracking ORDER BY timestamp DESC LIMIT 1
),
rate AS (
  SELECT
    c.surplus - c.debt AS net_surplus,
    c.threshold,
    c.surplus - c.debt >= c.threshold AS can_flap,
    CASE WHEN p.surplus IS NOT NULL AND c.surplus > p.surplus
      THEN (c.threshold - (c.surplus - c.debt)) /
           ((c.surplus - p.surplus) / EXTRACT(EPOCH FROM NOW() - p.timestamp) * 3600)
      ELSE NULL
    END AS hours_until_flap
  FROM current c LEFT JOIN previous p ON true
)
INSERT INTO surplus_tracking (timestamp, surplus, debt, net_surplus, threshold, can_flap, eta_hours)
SELECT NOW(), c.surplus, c.debt, r.net_surplus, c.threshold, r.can_flap, r.hours_until_flap
FROM current c, rate r
RETURNING can_flap, net_surplus, threshold, eta_hours;
```

**Buildable today?**: Yes. Requires database.

---

### Workflow 3: Flap Swap Rate Monitor

**The gap**: No tracking of the SKY/USDS swap rate achieved by the FlapperUniV2. If the UniV2 pool has low liquidity, flaps get worse rates. No one monitors this.

**The idea**: After each flap, read the Uniswap pool reserves and the actual SKY received to calculate effective rate vs spot rate. Alert on significant slippage.

**Value**: Detects when surplus distribution is getting bad swap rates. Could save the protocol thousands if liquidity conditions deteriorate.

**Trigger**: Event - `Kick(uint256, uint256, uint256)` on Splitter [EXISTING]

**Nodes**:
1. `web3/read-contract` - Read UniV2 pool reserves (getReserves) [EXISTING]
2. `web3/check-token-balance` - SKY balance of MCD Pause Proxy [EXISTING]
3. `Database Query` - Calculate effective rate vs last known rate, store history [EXISTING]
4. `Condition` - Slippage > 2% vs previous flap [EXISTING]
5. `discord/send-message` - "Flap executed: 2,500 USDS -> 36,531 SKY (rate: X). Slippage: Y%" [EXISTING]
6. `sendgrid/send-email` - Alert if slippage exceeds threshold [EXISTING]

**Buildable today?**: Yes.

**Value proposition**: The FlapperUniV2SwapOnly has built-in oracle protection via the Spotter, but it doesn't alert anyone when rates are suboptimal. This workflow adds human oversight to automated swaps.

---

### Workflow 4: Staking Rewards Distribution Tracker

**The gap**: No monitoring of how much USDS flows to StakingRewards. Stakers have no automated notification when new rewards arrive.

**The idea**: Listen for `notifyRewardAmount` calls on StakingRewards and track reward distribution history.

**Value**: Transparency for stakers. Data for APY calculations. Alerts for anomalous distribution amounts.

**Trigger**: Event - StakingRewards `RewardAdded(uint256)` [EXISTING]

**Nodes**:
1. `web3/read-contract` - Read StakingRewards `rewardRate()`, `totalSupply()` [EXISTING]
2. `Database Query` - Calculate implied APY, store history [EXISTING]
3. `discord/send-message` - "7,500 USDS distributed to stakers. Current APY: X%" [EXISTING]

**Buildable today?**: Yes.

---

### Workflow 5: Gas-Optimized Flap Kicker

**The gap**: Gelato kicks immediately when conditions are met. During high-gas periods, this wastes ETH. The `hop` = 1 hour gives a window to optimize.

**The idea**: When flap conditions are met, check gas prices via an external API. Only execute if gas is below a threshold. Re-check every 5 minutes within the window.

**Value**: Gas savings. If gas is 10 gwei vs 0.3 gwei (33x), waiting for a low-gas window saves ~$7 per execution. Over hundreds of executions per year, this adds up.

**Trigger**: Schedule - `*/5 * * * *` (every 5 minutes) [EXISTING]

**Nodes**:
1. `web3/read-contract` - Check if flap conditions are met [EXISTING]
2. `Condition` - Can flap? [EXISTING]
3. `HTTP Request` - GET gas price from `https://api.etherscan.io/api?module=gastracker&action=gasoracle` [EXISTING]
4. `Condition` - `{{@n3:Gas Price.data.result.SafeGasPrice}} < 5` (gwei threshold) [EXISTING]
5. `web3/write-contract` - Call `Vow.flap()` [EXISTING]
6. `discord/send-message` - "Flap executed at X gwei (saved Y ETH vs peak)" [EXISTING]

**Flow**:
```
Schedule (5min)
    |
    v
Check flap conditions
    |
    v
Condition: can flap?
    |
 [true]
    |
    v
HTTP: Get gas price
    |
    v
Condition: gas < threshold?
    |
 [true]
    |
    v
Write: Vow.flap()
    |
    v
Discord: notify
```

**Buildable today?**: Yes. The HTTP Request node can call any gas price API.

**Value proposition**: Smart execution timing. This is where KeeperHub can differentiate from Gelato -- Gelato executes ASAP, KeeperHub can be smarter.

---

### Workflow 6: Gelato Failover Monitor

**The gap**: If Gelato stops executing flaps, surplus accumulates without distribution. No one notices until staking rewards dry up.

**The idea**: Monitor the Splitter's `zzz` (last kick timestamp). If it's been more than 2x the `hop` period since the last kick AND conditions are met, fire an alert and optionally kick directly.

**Value**: Safety net for automation failure. Detects when the primary keeper (Gelato) is down.

**Trigger**: Schedule - `0 * * * *` (hourly) [EXISTING]

**Nodes**:
1. `web3/read-contract` - Read `Splitter.zzz()` [EXISTING]
2. `web3/read-contract` - Read `Splitter.hop()` [EXISTING]
3. `Condition` - `NOW() - zzz > 2 * hop` (overdue by 2x) [EXISTING]
4. `web3/write-contract` - Call `Vow.flap()` (backup execution) [EXISTING]
5. `discord/send-message` - "ALERT: Gelato missed flap window. KeeperHub executed backup." [EXISTING]
6. `sendgrid/send-email` - Alert ops team about automation gap [EXISTING]

**Buildable today?**: Yes.

**Value proposition**: Redundancy. This is the core KeeperHub value prop -- being the reliable backup when primary automation fails.

---

### Workflow 7: Full Surplus Lifecycle Dashboard

**The gap**: No unified view of surplus generation, distribution, and impact over time.

**The idea**: Hourly comprehensive snapshot: surplus level, last kick time, SKY acquired, USDS distributed, pool liquidity, staking APY. All written to a database for dashboarding.

**Value**: Operational intelligence. Answers "how is the protocol's revenue distribution working?" at a glance.

**Trigger**: Schedule - `0 * * * *` (hourly) [EXISTING]

**Nodes**:
1. `web3/read-contract` - Vat surplus, Vow params [EXISTING]
2. `web3/read-contract` - Splitter zzz, hop [EXISTING]
3. `web3/read-contract` - UniV2 reserves [EXISTING]
4. `web3/read-contract` - StakingRewards rewardRate, totalSupply [EXISTING]
5. `web3/check-token-balance` - SKY in MCD Pause Proxy [EXISTING]
6. `Database Query` - Store comprehensive snapshot [EXISTING]
7. `HTTP Request` - POST to Grafana/Prometheus [EXISTING]

**Buildable today?**: Yes. Requires database and optional metrics endpoint.

---

## 4. Buildable Today

All 7 workflows are buildable with existing KeeperHub capabilities:

| # | Workflow | Complexity | DB Required |
|---|---------|-----------|-------------|
| 1 | Surplus Flap Kicker | Medium (12 nodes) | Yes (for condition math) |
| 2 | Surplus Readiness Monitor | Medium (7 nodes) | Yes |
| 3 | Flap Swap Rate Monitor | Low (6 nodes) | Yes |
| 4 | Staking Rewards Tracker | Low (3 nodes) | Yes |
| 5 | Gas-Optimized Flap Kicker | Medium (6 nodes) | No |
| 6 | Gelato Failover Monitor | Low (6 nodes) | No |
| 7 | Full Surplus Dashboard | High (7 nodes) | Yes |

The **Database Query as math engine** pattern (from the governance ratio analysis) is used again here. PostgreSQL handles the BigInt arithmetic that Condition nodes can't.

**Workflow 5 (Gas-Optimized) and Workflow 6 (Gelato Failover) are the simplest to build** -- they don't require a database and use straightforward condition logic.

---

## 5. New Plugin / Node Type Proposals

### Plugin 1: `math/calculate` (Same as governance analysis -- HIGHEST LEVERAGE)

Same proposal as `mkr-governance-safety-ratio-workflows.md`. Would eliminate the Database Query workaround in Workflows 1, 2, 3, and 7.

### Plugin 2: `web3/multicall` (Same as governance analysis)

Would collapse the 7 parallel read-contract nodes in Workflow 1 into a single Multicall3 call. Significant node count and RPC reduction.

### Plugin 3: `web3/gas-oracle` (NEW)

**What it does**: Fetches current gas prices from multiple sources (Etherscan, Blocknative, node RPC `eth_gasPrice`) and returns structured gas data.

**Why first-class**: Workflow 5 uses HTTP Request to call a gas API, but gas optimization is needed in EVERY write-contract workflow. A native gas oracle node would:
- Aggregate multiple gas sources for reliability
- Return `fast`, `standard`, `slow` prices
- Include EIP-1559 base fee and priority fee
- Be reusable across all workflows without manual API config

**Input**: `{ "network": "ethereum" }`
**Output**: `{ "fast": 5, "standard": 3, "slow": 1, "baseFee": 0.12, "unit": "gwei" }`

**Workflows it unlocks**: Gas-optimized version of every write-contract workflow. Universal applicability.

### Plugin 4: `web3/uniswap-quote` (NEW - for swap monitoring)

**What it does**: Gets a swap quote from Uniswap V2/V3 without executing. Returns expected output amount, price impact, and slippage.

**Why first-class**: Workflow 3 manually reads pool reserves. A Uniswap quote node would handle the math natively and support both V2 and V3.

**Input**: `{ "pair": "0x2621...", "tokenIn": "USDS", "amountIn": "2500000000000000000000", "version": "v2" }`
**Output**: `{ "amountOut": "36531000000000000000000", "priceImpact": 0.15, "rate": 14.61 }`

**Workflows it unlocks**: Pre-swap validation for any Flapper. Swap rate monitoring. MEV protection analysis.

---

## 6. Priority Ranking

| Rank | Workflow | Impact | Difficulty | Deploy First |
|------|---------|--------|-----------|-------------|
| 1 | **#6 Gelato Failover** | Critical | Low | YES -- immediate safety net |
| 2 | **#1 Surplus Flap Kicker** | Critical | Medium | YES -- primary TX replication |
| 3 | **#5 Gas-Optimized Kicker** | High | Low | YES -- saves gas on every execution |
| 4 | **#2 Surplus Readiness** | High | Medium | After #1 |
| 5 | **#3 Swap Rate Monitor** | Medium | Low | After #1 |
| 6 | **#4 Staking Rewards Tracker** | Medium | Low | After #1 |
| 7 | **#7 Full Dashboard** | Medium | High | Last |

### Recommended deployment order:
1. **First**: Workflow 6 (Gelato Failover) -- immediate value, catches missed flaps
2. **Second**: Workflow 1 (Surplus Flap Kicker) -- full TX replication, runs alongside Gelato
3. **Third**: Workflow 5 (Gas-Optimized) -- replace Workflow 1 with gas-aware version
4. **Then**: Layer on monitoring (2, 3, 4) for operational intelligence
5. **Finally**: Workflow 7 (Dashboard) for comprehensive visibility

---

## 7. Competitive Moat

**Why KeeperHub beats Gelato for this use case**:

1. **Observability**: Gelato is a black box. KeeperHub shows every read, every condition check, every execution in a workflow UI. Operations teams can see WHY a flap didn't execute (conditions not met vs automation failure).

2. **Gas optimization**: Gelato executes immediately. KeeperHub Workflow 5 waits for optimal gas. Over 365 flaps/year, gas savings compound.

3. **Multi-condition logic**: The Condition + Database Query pattern lets KeeperHub check conditions Gelato can't express: slippage limits, gas thresholds, custom timing windows.

4. **Notification routing**: Every execution (or non-execution) can trigger alerts via Discord, Telegram, Email, PagerDuty. Gelato has limited notification options.

5. **Redundancy story**: KeeperHub as a backup to Gelato is immediately valuable. If it proves more reliable, it becomes the primary.

6. **Composability**: The surplus readiness monitor, swap rate monitor, and staking tracker are workflows that Gelato simply cannot do. They require reading state, doing math, storing history, and comparing over time.

---

## Sources

- [Transaction on Etherscan](https://etherscan.io/tx/0xbdf6a94718db472bc34f0a4cac5cc4dcef7eb3dd44f5d1db0de39125ba910543)
- [Splitter contract (verified source)](https://etherscan.io/address/0xbf7111f13386d23cb2fba5a538107a73f6872bcf#code)
- [FlapperUniV2SwapOnly contract](https://etherscan.io/address/0x374D9c3d5134052Bc558F432Afa1df6575f07407)
- [StakingRewards contract](https://etherscan.io/address/0x38E4254bD82ED5Ee97CD1C4278FAae748d998865)
- [Vow documentation](https://developers.sky.money/protocol/core/vow/)
- [Sky Chainlog](https://etherscan.io/address/0xdA0Ab1e0017DEbCd72Be8599041a2aa3bA7e740F)
- [Sky Protocol Level 1 Analysis](https://medium.com/@Scoper/sky-protocol-level-1-analysis-governance-vaults-accounting-the-atlas-the-vat-the-vow-d9fdc7368cf6)
- [Flapper documentation](https://docs.makerdao.com/smart-contract-modules/system-stabilizer-module/flap-detailed-documentation)
- [auction-keeper source](https://github.com/sky-ecosystem/auction-keeper/blob/master/auction_keeper/main.py)
