# Sky Protocol Emergency Shutdown Monitoring Workflows

Migrated from TECH-6015. Two core use cases plus supporting workflows.

## CRITICAL: ESM Status Under Sky Migration

As of the May 15, 2025 governance vote ([MKR-to-SKY Upgrade Phase One](https://vote.makerdao.com/executive/template-executive-vote-mkr-to-sky-upgrade-phase-one-adding-protego-to-the-chainlog-spark-proxy-spell-may-15-2025)):

- The ESM was **disabled by setting `min` to infinity** -- it is functionally impossible to reach the threshold with MKR deposits
- The ESM was **not authorized in new contracts** deployed as part of the upgrade
- **Protego** (`0x5C9c3cb0490938c9234ABddeD37a191576ED8624`) was added to the chainlog as a new safety mechanism for cancelling pending governance actions
- The ESM contract code references `GemLike` (token-agnostic). The original deployment at `0x29Cf...` uses MKR (`0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2`)
- MKR is being migrated to SKY (`0x56072C95FAA701256059aa122697B133aDEd9279`) at 1:24,000 ratio
- Sky has a [new ESM repo](https://github.com/sky-ecosystem/esm) under `sky-ecosystem` -- a new ESM deployment using SKY token may be planned but **no new deployed address has been confirmed yet**

**Action required before building**: Confirm with the Sky/TechOps team:
1. Are we monitoring the **old ESM** (`0x29Cf...`) which uses MKR and is currently disabled (min = infinity)?
2. Is there a **new ESM deployment** that uses SKY token with a reachable threshold?
3. Should we also monitor **Protego** (`0x5C9c...`) as the replacement safety mechanism?

The workflows below are designed against the contract interfaces and work regardless of which ESM deployment is targeted -- just swap the address.

---

## Contracts

| Contract | Address | Chain | Token | Status |
|----------|---------|-------|-------|--------|
| ESM (original, MKR-based) | `0x29CfBd381043D00a98fD9904a431015Fef07af2f` | Ethereum Mainnet (1) | MKR | Disabled (min = infinity) |
| END | `0xBB856d1742fD182a90239D7AE85706C2FE4e5922` | Ethereum Mainnet (1) | -- | Active |
| Protego (new) | `0x5C9c3cb0490938c9234ABddeD37a191576ED8624` | Ethereum Mainnet (1) | -- | Active |
| MKR Token | `0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2` | Ethereum Mainnet (1) | -- | Being migrated to SKY |
| SKY Token | `0x56072C95FAA701256059aa122697B133aDEd9279` | Ethereum Mainnet (1) | -- | Active governance token |

## Verified Contract Interfaces (from [sky-ecosystem/esm](https://github.com/sky-ecosystem/esm) and [sky-ecosystem/dss](https://github.com/makerdao/dss))

### ESM

The ESM is token-agnostic (`GemLike` interface). The original deployment uses MKR; a future Sky deployment would use SKY.

| Name | Type | Signature | Purpose |
|------|------|-----------|---------|
| `Sum` | view (uint256) | `Sum()` | Total tokens deposited across all users |
| `min` | view (uint256) | `min()` | Threshold required to enable `fire()` |
| `live` | view (uint256) | `live()` | 1 = not fired, 0 = fired |
| `sum` | view (uint256) | `sum(address)` | Per-address tokens deposited |
| `join` | write | `join(uint256 wad)` | Deposit tokens into ESM |
| `fire` | write | `fire()` | Trigger emergency shutdown (requires Sum >= min) |
| `Join` | event | `Join(address indexed usr, uint256 wad)` | Emitted when tokens deposited |
| `Fire` | event | `Fire()` | Emitted when `fire()` called |

### END

| Name | Type | Signature | Purpose |
|------|------|-----------|---------|
| `live` | view (uint256) | `live()` | 1 = system active, 0 = shutdown |
| `when` | view (uint256) | `when()` | Timestamp when shutdown triggered |
| `wait` | view (uint256) | `wait()` | Cooldown period before settlement |
| `cage` | write (auth) | `cage()` | Initiates shutdown (called by ESM.fire()) |
| `Cage` | event | `Cage()` | Emitted when shutdown triggered |

---

## Workflow 1: ESM Sum Watcher (TECH-6015 Use Case 1)

**The gap**: No automated monitoring of token deposits into the ESM. Teams have no way to know when holders are voting for emergency shutdown.

**The idea**: Poll ESM `Sum()` on a schedule, store the previous value in a database, compare deltas, and fire critical alerts when the change exceeds a configurable threshold (>=2 tokens).

**Value**: Early warning for emergency shutdown buildup. Minutes of advance notice can be the difference between orderly wind-down and chaos.

**Trigger**: Schedule - `*/5 * * * *` (every 5 minutes) [EXISTING]

**Nodes**:
1. `web3/read-contract` - Read `Sum()` from ESM (chain 1) [EXISTING]
2. `Database Query` - `SELECT value FROM esm_state WHERE key = 'previous_sum'` [EXISTING]
3. `Database Query` - `UPDATE esm_state SET value = {{@read-sum:Read Sum.result}} WHERE key = 'previous_sum'` [EXISTING]
4. `Condition` - `{{@read-sum:Read Sum.result}} - {{@get-prev:Get Previous Sum.rows[0].value}} >= 2000000000000000000` (2 tokens in wei) [EXISTING]
5. `slack/send-message` - CRITICAL: ESM Sum increased. New total: {{@read-sum:Read Sum.result}} [EXISTING]
6. `sendgrid/send-email` - Critical alert email to ops team [EXISTING]

**Flow**:
```
Schedule (5min)
    |
    v
Read ESM Sum() -------> Get Previous Sum (DB)
    |                         |
    v                         v
Store New Sum (DB)     Condition: delta >= 2 tokens
                            |
                       [true]
                            |
                       +----+----+
                       |         |
                       v         v
                    Slack     Email
```

**Buildable today?**: Yes. Requires user-provided PostgreSQL database for state persistence.

---

## Workflow 2: Emergency Shutdown Detector (TECH-6015 Use Case 2)

**The gap**: No monitoring of the END contract `live()` state. When shutdown fires, every second counts.

**The idea**: Poll END `live()` on a high-frequency schedule. When it transitions from 1 to 0, fire maximum-severity alerts.

**Value**: Immediate notification of the most severe protocol event. This is the "building is on fire" alarm.

**Trigger**: Schedule - `* * * * *` (every minute) [EXISTING]

**Nodes**:
1. `web3/read-contract` - Read `live()` from END (`0xBB856d1742fD182a90239D7AE85706C2FE4e5922`, chain 1) [EXISTING]
2. `Condition` - `{{@read-live:Read END Live.result}} == 0` [EXISTING]
3. `slack/send-message` - EMERGENCY: Sky Protocol shutdown triggered [EXISTING]
4. `sendgrid/send-email` - Emergency alert to all stakeholders [EXISTING]
5. `discord/send-message` - Emergency broadcast [EXISTING]
6. `webhook/send-webhook` - Fire to PagerDuty/OpsGenie [EXISTING]

**Flow**:
```
Schedule (1min)
    |
    v
Read END live()
    |
    v
Condition: live == 0
    |
    [true]
    |
    +------+------+------+
    |      |      |      |
    v      v      v      v
  Slack  Email Discord  PagerDuty
```

**Buildable today?**: Yes. No database needed -- just checks current value.

---

## Workflow 3: ESM Join Event Listener (real-time complement to Workflow 1)

**The gap**: Polling has a 5-minute window. The Event trigger catches deposits in real-time.

**The idea**: Listen for `Join(address, uint256)` events on ESM. Each deposit triggers an immediate alert with depositor address, amount, and running total vs threshold.

**Value**: Real-time detection. See every individual deposit as it happens, not in 5-minute batches.

**Trigger**: Event - `Join` on ESM (chain 1) [EXISTING]

**Nodes**:
1. `web3/read-contract` - Read `Sum()` to get running total [EXISTING]
2. `web3/read-contract` - Read `min()` to calculate threshold percentage [EXISTING]
3. `Condition` - Sum >= 50% of min (escalation threshold) [EXISTING]
4. `slack/send-message` - Tokens deposited: {{@trigger:Trigger.args.wad}} by {{@trigger:Trigger.args.usr}}. Total: {{@read-sum:Read Sum.result}} / {{@read-min:Read Min.result}} [EXISTING]
5. `sendgrid/send-email` - Critical escalation email (only if above 50% threshold) [EXISTING]

**Flow**:
```
Event: ESM.Join(usr, wad)
    |
    +-------+--------+
    |                |
    v                v
Read Sum()      Read min()
    |                |
    +-------+--------+
            |
            v
    Condition: sum >= min/2
        |           |
     [true]      [false]
        |           |
        v           v
  Email + Slack   Slack only
```

**Buildable today?**: Yes.

---

## Workflow 4: ESM Fire Event Listener (real-time complement to Workflow 2)

**The gap**: Polling `live()` has up to 60-second latency. The `Fire` event catches the exact transaction.

**The idea**: Listen for `Fire()` event on ESM. Instant detection with transaction hash.

**Value**: Transaction-level precision. Catches the exact moment and TX hash for forensics.

**Trigger**: Event - `Fire` on ESM (chain 1) [EXISTING]

**Nodes**:
1. `slack/send-message` - EMERGENCY: ESM fire() called. TX: {{@trigger:Trigger.transactionHash}} Block: {{@trigger:Trigger.blockNumber}} [EXISTING]
2. `sendgrid/send-email` - Emergency with full details [EXISTING]
3. `webhook/send-webhook` - PagerDuty P1 incident [EXISTING]
4. `discord/send-message` - Public emergency broadcast [EXISTING]

**Flow**:
```
Event: ESM.Fire()
    |
    +----+----+----+
    |    |    |    |
    v    v    v    v
  Slack Email PD Discord
```

**Buildable today?**: Yes. Simplest workflow -- event in, fan-out alerts.

---

## Workflow 5: ESM Threshold Progress Tracker

**The gap**: No ongoing visibility into how close the protocol is to emergency shutdown.

**The idea**: Hourly read of `Sum()` and `min()`, calculate percentage, log to database for trend tracking, alert at configurable thresholds (25%, 50%, 75%, 90%).

**Value**: Trend visibility. The difference between "suddenly at 80%" and "we've been watching it climb for 3 weeks" is operational preparedness.

**Trigger**: Schedule - `0 * * * *` (hourly) [EXISTING]

**Nodes**:
1. `web3/read-contract` - Read `Sum()` [EXISTING]
2. `web3/read-contract` - Read `min()` [EXISTING]
3. `Database Query` - INSERT into esm_history (timestamp, sum, min, pct) [EXISTING]
4. `Condition` - pct >= 25 [EXISTING]
5. `Condition` - pct >= 75 [EXISTING]
6. `slack/send-message` - Hourly ESM status update [EXISTING]
7. `sendgrid/send-email` - Critical escalation at 75%+ [EXISTING]

**Buildable today?**: Yes. Requires user-provided database.

---

## Priority Ranking

| Rank | Workflow | Impact | Complexity | Deploy Order |
|------|---------|--------|------------|-------------|
| 1 | #4 ESM Fire Event Listener | Critical | Low | First |
| 2 | #2 Emergency Shutdown Detector | Critical | Low | Second |
| 3 | #3 ESM Join Event Listener | High | Medium | Third |
| 4 | #1 ESM Sum Watcher | High | Medium | Fourth |
| 5 | #5 ESM Threshold Progress | Medium | Medium | Fifth |

Deploy #4 and #2 first (critical severity, minimal setup). Then layer on #3 and #1 for depth. #5 is for operational maturity.

Workflows #4+#2 are the belt and suspenders: event-driven (#4) catches the exact TX, polling (#2) is the fallback if event listener misses anything. Same pattern for #3+#1 on the deposit monitoring side.

---

## Missing Feature: "Watch" Trigger

The ticket mentions wanting a "watch" feature. Workflows 1, 2, and 5 all follow the same pattern:

```
Schedule -> Read Contract -> Compare to Previous -> Alert on Change
```

This could be collapsed into a single `web3/watch-state` trigger node:
- **Input**: contract address, ABI, function, chain, poll interval, change threshold
- **Output**: previousValue, currentValue, delta, timestamp
- **Fires only when**: value changes (or changes by more than threshold)

This would reduce Workflow 1 from 6 nodes to 3 nodes, and Workflow 2 from 6 nodes to 4 nodes. Not blocking -- everything works today without it -- but would make these workflows much simpler to create.

---

## Sources

- [MKR-to-SKY Upgrade Phase One Governance Vote (May 15, 2025)](https://vote.makerdao.com/executive/template-executive-vote-mkr-to-sky-upgrade-phase-one-adding-protego-to-the-chainlog-spark-proxy-spell-may-15-2025)
- [ESM+End Module Upgrades and Disclosures - Sky Forum](https://forum.sky.money/t/esm-end-module-upgrades-and-disclosures/7569)
- [sky-ecosystem/esm GitHub](https://github.com/sky-ecosystem/esm)
- [Sky Protocol Developer Docs - Emergency Shutdown](https://developers.sky.money/archive/shutdown/emergency-shutdown/)
- [Sky Protocol - MKR to SKY Migration Guide](https://developers.sky.money/guides/upgrades/migrate-old-mkr-to-mkr/)
