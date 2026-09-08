# TECH-5922: MKR/SKY Governance Safety Ratio Monitor

## 1. Target Analysis

**Source**: TECH-5922 -- Lambda function that monitors MKR/SKY token distribution across exchanges and protocols as an early warning system for governance attacks.

### Key Contracts (Ethereum Mainnet)

| Contract | Address | Purpose |
|----------|---------|---------|
| DSChief 1.2 (`MCD_ADM`) | `0x0a3f6849f78076aefaDf113F5BED87720274dDC0` | Governance voting -- holds locked MKR |
| MKR Token | `0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2` | Governance token |
| SKY Token | `0x56072C95FAA701256059aa122697B133aDEd9279` | New governance token (1 MKR = 24,000 SKY) |
| Uniswap V2 MKR/WETH | `0xC2aDdA861F89bBB333c90c492cB837741916A225` | Primary V2 pool |
| Uniswap V3 MKR/WETH 0.3% | `0xe8c6c9227491C0a8156A0106A0204d881BB7E531` | Primary V3 pool |

**NOTE**: Verify DSChief address against the live chainlog at `https://chainlog.sky.money/api/mainnet/active.json` (look for `MCD_ADM`) before building workflows.

### The Governance Attack Vector

If more MKR is available on DEXes than is locked in the Chief voting for the current `hat`, an attacker could accumulate enough MKR to `lift()` a malicious spell. The **Safety Ratio** is:

```
Safety Ratio = MKR in Chief / MKR available on DEXes
```

| Ratio | Status |
|-------|--------|
| > 3:1 | Healthy |
| 2:1 - 3:1 | Adequate |
| 1:1 - 2:1 | Warning |
| < 1:1 | CRITICAL -- attack theoretically possible |

### How to Read the Key Values

- **MKR in Chief**: `MKR.balanceOf(Chief)` -- no `totalDeposits()` function exists
- **Hat address**: `Chief.hat()` -- the winning proposal
- **Hat approval weight**: `Chief.approvals(hat())` -- MKR weight on winning proposal
- **MKR on DEXes**: `MKR.balanceOf(pool_address)` for each pool

### Key ABIs

**DSChief 1.2 (monitoring subset)**:
```json
[
  {"inputs":[],"name":"hat","outputs":[{"name":"","type":"address"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"name":"","type":"address"}],"name":"approvals","outputs":[{"name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"name":"","type":"address"}],"name":"deposits","outputs":[{"name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[],"name":"live","outputs":[{"name":"","type":"uint256"}],"stateMutability":"view","type":"function"}
]
```

**ERC20 (balanceOf)**:
```json
[
  {"inputs":[{"name":"","type":"address"}],"name":"balanceOf","outputs":[{"name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[],"name":"totalSupply","outputs":[{"name":"","type":"uint256"}],"stateMutability":"view","type":"function"}
]
```

### Identified Automation Gaps

1. **No ratio calculation in a single workflow** -- The Lambda does math (sum, divide, compare) that KeeperHub can't express natively in Condition nodes
2. **No cross-node arithmetic** -- `check-token-balance` returns `balance` as a string; `"100" + "200"` = `"100200"` (string concat, not 300)
3. **No state persistence between runs** -- Need to track trends over time
4. **No multicall batching** -- Reading MKR balance from 5+ addresses requires 5+ separate `read-contract` nodes
5. **No hat change detection** -- DSChief doesn't emit a `HatChanged` event; you must poll

---

## 2. Capability Source

**Source: Direct code review of the codebase** (MCP was not available).

### Confirmed Available Capabilities

**Triggers**: Schedule (cron), Event (blockchain events), Manual, Webhook

**Actions**:
- `web3/check-token-balance` -- ERC20 balance check (returns `balance` as formatted string, `balanceRaw` as wei string)
- `web3/read-contract` -- Arbitrary contract read (returns `result` with BigInt values serialized as strings)
- `web3/write-contract`, `web3/transfer-funds`, `web3/transfer-token`
- `Condition` -- Expression evaluation with `{{@nodeId:Label.field}}` template syntax
- `HTTP Request` -- External API calls
- `Database Query` -- PostgreSQL queries with template variable interpolation
- `discord/send-message`, `telegram/send-message`, `sendgrid/send-email`, `webhook/send-webhook`

### Critical Finding: Arithmetic in Conditions

The Condition validator backend (`condition-validator.ts`) does not explicitly block arithmetic operators (`+`, `-`, `*`, `/`). The UI validator actively supports them. However, since contract outputs are serialized as strings, `__v0 + __v1` performs string concatenation, not addition.

**Workaround**: The `Database Query` node can perform arithmetic using PostgreSQL `CAST` + math operators:

```sql
SELECT
  CAST('{{@mkr-chief:MKR in Chief.balance.balanceRaw}}' AS NUMERIC) /
  NULLIF(CAST('{{@mkr-dex:MKR on DEX.balance.balanceRaw}}' AS NUMERIC), 0)
  AS safety_ratio
```

This gives us a path to build the workflow TODAY, but it requires a PostgreSQL database connection.

---

## 3. Workflow Suggestions

### Workflow 1: MKR Governance Safety Ratio Monitor

**The gap**: The Lambda function calculates MKR distribution ratios across exchanges vs Chief. No KeeperHub workflow exists for this. The Lambda is a single point of failure in AWS.

**The idea**: Fetch MKR balances from Chief and major DEX pools, calculate the safety ratio via a Database Query (PostgreSQL arithmetic), alert when unhealthy.

**Value**: Early warning for governance attacks. This is existential-risk monitoring -- a successful attack could drain the entire protocol.

**Trigger**: Schedule - `*/15 * * * *` (every 15 minutes) [EXISTING]

**Nodes**:
1. `web3/check-token-balance` - MKR balance of Chief (`0x0a3f...dDC0`) [EXISTING]
2. `web3/check-token-balance` - MKR balance of Uniswap V2 pool [EXISTING]
3. `web3/check-token-balance` - MKR balance of Uniswap V3 pool [EXISTING]
4. `web3/read-contract` - `Chief.hat()` to get current hat address [EXISTING]
5. `web3/read-contract` - `Chief.approvals(hat)` using hat from node 4 [EXISTING]
6. `Database Query` - Calculate safety ratio + store history [EXISTING]
7. `Condition` - `{{@calc:Calculate Ratio.rows[0].safety_ratio}} < 2` [EXISTING]
8. `discord/send-message` - Warning alert with ratio data [EXISTING]
9. `sendgrid/send-email` - Critical alert to ops team [EXISTING]
10. `webhook/send-webhook` - PagerDuty/OpsGenie escalation [EXISTING]

**Node 6 SQL** (the "math engine" workaround):
```sql
INSERT INTO governance_metrics (
  timestamp, mkr_in_chief, mkr_on_dex, hat_approvals, hat_address, safety_ratio
) VALUES (
  NOW(),
  CAST('{{@n1:MKR in Chief.balance.balanceRaw}}' AS NUMERIC),
  CAST('{{@n2:MKR UniV2.balance.balanceRaw}}' AS NUMERIC) +
    CAST('{{@n3:MKR UniV3.balance.balanceRaw}}' AS NUMERIC),
  CAST('{{@n5:Hat Approvals.result}}' AS NUMERIC),
  '{{@n4:Read Hat.result}}',
  CAST('{{@n1:MKR in Chief.balance.balanceRaw}}' AS NUMERIC) /
    NULLIF(
      CAST('{{@n2:MKR UniV2.balance.balanceRaw}}' AS NUMERIC) +
      CAST('{{@n3:MKR UniV3.balance.balanceRaw}}' AS NUMERIC),
    0)
)
RETURNING safety_ratio, mkr_in_chief / 1e18 as mkr_chief_formatted,
          mkr_on_dex / 1e18 as mkr_dex_formatted;
```

**Flow**:
```
Schedule (15min)
    |
    +------+------+------+
    |      |      |      |
    v      v      v      v
  MKR    MKR    MKR    Read
  Chief  UniV2  UniV3  hat()
    |      |      |      |
    |      |      |      v
    |      |      |    Read
    |      |      |    approvals(hat)
    |      |      |      |
    +------+------+------+
           |
           v
     DB: Calculate Ratio
     + Store History
           |
           v
     Condition: ratio < 2
           |
        [true]
           |
     +-----+-----+
     |     |     |
     v     v     v
   Discord Email PagerDuty
```

**Buildable today?**: Yes -- with the Database Query workaround for arithmetic. Requires user-provided PostgreSQL database.

**Value proposition**: Replaces a fragile Lambda with a monitored, observable workflow. Adds notification routing, historical tracking, and dead-man's-switch visibility (if the workflow stops running, KeeperHub shows it).

---

### Workflow 2: Hat Change Detector

**The gap**: No monitoring of when the governance `hat` (winning proposal) changes. A hat change means a new spell has won the vote -- this could be legitimate or an attack.

**The idea**: Poll `Chief.hat()` on a schedule, compare against previously stored value, alert immediately on change.

**Value**: A hat change is the moment of truth for governance security. Detecting it in minutes vs hours is the difference between responding and reacting.

**Trigger**: Schedule - `*/5 * * * *` (every 5 minutes) [EXISTING]

**Nodes**:
1. `web3/read-contract` - `Chief.hat()` [EXISTING]
2. `Database Query` - `SELECT hat_address FROM governance_state WHERE key = 'current_hat'` [EXISTING]
3. `Condition` - `{{@n1:Read Hat.result}} !== '{{@n2:Get Previous Hat.rows[0].hat_address}}'` [EXISTING]
4. `Database Query` - Update stored hat address [EXISTING]
5. `web3/read-contract` - `Chief.approvals(new_hat)` to get vote weight [EXISTING]
6. `discord/send-message` - "Hat changed to [address] with [X] MKR approval" [EXISTING]
7. `sendgrid/send-email` - Governance alert email [EXISTING]

**Flow**:
```
Schedule (5min)
    |
    +--------+
    |        |
    v        v
 Read      Get Previous
 hat()     Hat (DB)
    |        |
    +--------+
         |
         v
    Condition: hat changed?
         |
      [true]
         |
    +----+----+
    |    |    |
    v    v    v
  Update Read  Discord
  DB     approvals Email
```

**Buildable today?**: Yes. Requires database for state.

**Value proposition**: First-to-know when governance power shifts. Essential for any protocol that relies on on-chain voting.

---

### Workflow 3: MKR Migration Progress Tracker

**The gap**: No automated tracking of MKR-to-SKY migration progress. The migration ratio (1:24,000) means monitoring both tokens is critical for understanding governance dynamics.

**The idea**: Track total MKR supply, SKY supply, MKR in Chief, and calculate migration percentage. Store trends. Alert on significant migration events.

**Value**: Understanding migration velocity is crucial for governance security planning -- as MKR migrates to SKY, the governance dynamics change.

**Trigger**: Schedule - `0 */6 * * *` (every 6 hours) [EXISTING]

**Nodes**:
1. `web3/read-contract` - `MKR.totalSupply()` [EXISTING]
2. `web3/read-contract` - `SKY.totalSupply()` [EXISTING]
3. `web3/check-token-balance` - MKR in Chief [EXISTING]
4. `Database Query` - Calculate migration % and store [EXISTING]
5. `Condition` - Migration delta > 1% since last check [EXISTING]
6. `discord/send-message` - Migration progress update [EXISTING]

**Node 4 SQL**:
```sql
WITH current AS (
  SELECT
    CAST('{{@n1:MKR Supply.result}}' AS NUMERIC) / 1e18 as mkr_supply,
    CAST('{{@n2:SKY Supply.result}}' AS NUMERIC) / 1e18 as sky_supply,
    CAST('{{@n3:MKR Chief.balance.balanceRaw}}' AS NUMERIC) / 1e18 as mkr_in_chief
),
calculated AS (
  SELECT *,
    sky_supply / 24000 as mkr_equivalent_migrated,
    (sky_supply / 24000) / (mkr_supply + sky_supply / 24000) * 100 as migration_pct
  FROM current
)
INSERT INTO migration_tracking (timestamp, mkr_supply, sky_supply, mkr_in_chief, migration_pct)
SELECT NOW(), mkr_supply, sky_supply, mkr_in_chief, migration_pct FROM calculated
RETURNING migration_pct, mkr_in_chief, mkr_supply;
```

**Buildable today?**: Yes.

**Value proposition**: Migration progress affects governance security directly. If migration accelerates but Chief deposits don't adjust, the safety ratio changes.

---

### Workflow 4: DEX Liquidity Shift Alarm

**The gap**: No detection of large MKR movements in/out of DEX pools. A sudden increase in DEX liquidity could signal an accumulation event.

**The idea**: Track MKR balances on DEX pools, store deltas, alert when a large shift occurs (e.g., >5% change in a single interval).

**Value**: Detecting unusual MKR pool movements before they impact the safety ratio.

**Trigger**: Schedule - `*/30 * * * *` (every 30 minutes) [EXISTING]

**Nodes**:
1. `web3/check-token-balance` - MKR on Uniswap V2 [EXISTING]
2. `web3/check-token-balance` - MKR on Uniswap V3 [EXISTING]
3. `Database Query` - Calculate delta from previous values + store [EXISTING]
4. `Condition` - `{{@n3:Calculate Delta.rows[0].pct_change}} > 5` [EXISTING]
5. `discord/send-message` - Large liquidity shift detected [EXISTING]
6. `webhook/send-webhook` - Alert ops [EXISTING]

**Buildable today?**: Yes. Requires database.

---

### Workflow 5: Governance Participation Rate Monitor

**The gap**: No trending of governance participation. Low participation makes attacks cheaper.

**The idea**: Track MKR in Chief as a percentage of circulating supply. Alert when participation drops below historical averages.

**Value**: Governance participation is a leading indicator of attack risk. Declining participation = increasing vulnerability.

**Trigger**: Schedule - `0 0 * * *` (daily) [EXISTING]

**Nodes**:
1. `web3/check-token-balance` - MKR in Chief [EXISTING]
2. `web3/read-contract` - `MKR.totalSupply()` [EXISTING]
3. `Database Query` - Calculate participation rate + 30-day average + store [EXISTING]
4. `Condition` - Current rate < 80% of 30-day average [EXISTING]
5. `discord/send-message` - Participation declining [EXISTING]
6. `sendgrid/send-email` - Governance health report [EXISTING]

**Buildable today?**: Yes. Requires database.

---

### Workflow 6: Hat Approval Strength Monitor

**The gap**: Even if the hat exists, its approval weight matters. If the hat's MKR support is thin, it's easier to replace.

**The idea**: Monitor `Chief.approvals(hat())` relative to total MKR on DEXes. Alert when the hat's backing could theoretically be overcome.

**Value**: More precise than the raw safety ratio. The actual attack threshold is `approvals(hat)`, not total MKR in Chief.

**Trigger**: Schedule - `*/15 * * * *` (every 15 minutes) [EXISTING]

**Nodes**:
1. `web3/read-contract` - `Chief.hat()` [EXISTING]
2. `web3/read-contract` - `Chief.approvals(hat)` [EXISTING]
3. `web3/check-token-balance` - MKR on Uniswap V2 [EXISTING]
4. `web3/check-token-balance` - MKR on Uniswap V3 [EXISTING]
5. `Database Query` - Calculate hat strength ratio [EXISTING]
6. `Condition` - Hat strength ratio < 1.5 [EXISTING]
7. `discord/send-message` - "Hat backing is thin" [EXISTING]
8. `webhook/send-webhook` - PagerDuty [EXISTING]

**Buildable today?**: Yes. Requires database for arithmetic.

---

### Workflow 7: Comprehensive Governance Dashboard Updater

**The gap**: No single source of truth that captures all governance metrics in one run and stores them for dashboarding.

**The idea**: Hourly comprehensive snapshot of all governance metrics -- Chief balance, hat address, hat approvals, DEX liquidity, migration status -- written to a database for Grafana/Metabase dashboarding.

**Value**: Operational intelligence. Replaces the Lambda's data collection with a workflow that also alerts.

**Trigger**: Schedule - `0 * * * *` (hourly) [EXISTING]

**Nodes**:
1-5. Multiple `read-contract` and `check-token-balance` nodes [EXISTING]
6. `Database Query` - Insert comprehensive snapshot [EXISTING]
7. `HTTP Request` - POST metrics to Grafana Cloud / Prometheus pushgateway [EXISTING]

**Buildable today?**: Yes. The most node-heavy workflow but all existing capabilities.

---

## 4. Buildable Today

All 7 workflows are buildable today using the Database Query workaround for arithmetic. The pattern is:

1. Fetch on-chain data via `web3/read-contract` and `web3/check-token-balance`
2. Pipe values into a `Database Query` that uses PostgreSQL `CAST(... AS NUMERIC)` for math
3. Use the DB query's `RETURNING` clause to expose calculated values
4. Feed those values into `Condition` nodes for alerting logic

**Requirement**: User must provide a PostgreSQL database connection (via KeeperHub Integrations).

**Trade-off**: The Database Query workaround is verbose. Each workflow needs 5-10+ nodes. A native `math/calculate` plugin would reduce node count by 30-40%.

---

## 5. New Plugin / Node Type Proposals

### Plugin 1: `math/calculate` (HIGHEST LEVERAGE)

**What it does**: Accepts an arithmetic expression with template variable references, evaluates it, and outputs the result.

**Why it needs to be first-class**: The Database Query workaround is the most common complaint in the ticket -- "Mathematical equations with outputs (sum, comparison of sum with another output, percentage ratio of several integers)". Every non-trivial monitoring workflow needs this.

**Input**:
```json
{
  "expression": "{{@n1:MKR Chief.balance.balanceRaw}} / ({{@n2:MKR UniV2.balance.balanceRaw}} + {{@n3:MKR UniV3.balance.balanceRaw}})",
  "decimals": 18,
  "outputFormat": "number"
}
```

**Output**:
```json
{
  "success": true,
  "result": 2.45,
  "resultRaw": "2450000000000000000",
  "expression": "resolved expression for logging"
}
```

**Why not just a webhook workaround**: Because it's needed in every monitoring workflow. Making users deploy an external math service defeats the purpose of no-code automation.

**Workflows it unlocks**: All 7 workflows above become simpler. Also unlocks: gas cost tracking, APY calculations, collateralization ratio monitoring, and every future metric-comparison workflow.

**Spec**:
- Supports: `+`, `-`, `*`, `/`, `%`, `()`, `min()`, `max()`, `abs()`
- Handles BigInt arithmetic natively (no precision loss on wei values)
- `decimals` parameter for automatic wei-to-token conversion
- Template variables are resolved and cast to BigInt before evaluation

### Plugin 2: `web3/multicall` (HIGH VALUE)

**What it does**: Batch multiple `balanceOf()` / `read-contract` calls into a single Multicall3 RPC request.

**Why it needs to be first-class**: Workflow 1 requires 3-5 separate `check-token-balance` nodes to read MKR from different addresses. Multicall would collapse these into 1 node with 1 RPC call.

**Input**:
```json
{
  "network": "ethereum",
  "calls": [
    { "target": "0x9f8F...A2", "function": "balanceOf", "args": ["0x0a3f...C0"] },
    { "target": "0x9f8F...A2", "function": "balanceOf", "args": ["0xC2aD...25"] },
    { "target": "0x9f8F...A2", "function": "balanceOf", "args": ["0xe8c6...31"] }
  ]
}
```

**Output**:
```json
{
  "success": true,
  "results": [
    { "label": "mkr_chief", "value": "123000000000000000000000" },
    { "label": "mkr_univ2", "value": "45000000000000000000000" },
    { "label": "mkr_univ3", "value": "67000000000000000000000" }
  ]
}
```

**Multicall3 address** (deployed on all EVM chains): `0xcA11bde05977b3631167028862bE2a173976CA11`

**Workflows it unlocks**: Any workflow that reads data from multiple contracts/addresses. Reduces node count and RPC calls.

### Plugin 3: `web3/watch-state` (TRIGGER)

**What it does**: A new trigger type that polls a contract view function and fires only when the return value changes (or changes beyond a threshold).

**Why it needs to be first-class**: The Schedule -> Read Contract -> DB (get previous) -> Condition (compare) -> DB (update) pattern is 5 nodes. A watch-state trigger collapses it to 1.

**Config**:
```json
{
  "contractAddress": "0x0a3f...",
  "network": "ethereum",
  "abi": "[...]",
  "function": "hat",
  "pollInterval": "*/5 * * * *",
  "changeThreshold": 0
}
```

**Output** (when triggered):
```json
{
  "previousValue": "0x1234...",
  "currentValue": "0x5678...",
  "changedAt": "2026-02-10T05:00:00Z"
}
```

**Workflows it unlocks**: Hat Change Detector (Workflow 2) becomes 3 nodes instead of 7. ESM Sum Watcher becomes trivial. Any "alert when X changes" pattern.

---

## 6. Priority Ranking

| Rank | Workflow | Impact | Buildable | Node Count | Notes |
|------|---------|--------|-----------|------------|-------|
| 1 | #1 Safety Ratio Monitor | Critical | Today (DB workaround) | 10 | The primary TECH-5922 requirement |
| 2 | #6 Hat Approval Strength | Critical | Today (DB workaround) | 8 | More precise attack risk metric |
| 3 | #2 Hat Change Detector | High | Today (DB for state) | 7 | Moment-of-truth governance event |
| 4 | #4 DEX Liquidity Shift | High | Today (DB workaround) | 6 | Leading indicator of accumulation |
| 5 | #7 Dashboard Updater | High | Today | 7 | Replaces Lambda data collection |
| 6 | #5 Participation Rate | Medium | Today (DB workaround) | 6 | Trend monitoring, daily cadence |
| 7 | #3 Migration Tracker | Medium | Today (DB workaround) | 6 | Important for long-term planning |

### New Plugin Priority

| Rank | Plugin | Impact | Effort | Unlocks |
|------|--------|--------|--------|---------|
| 1 | `math/calculate` | Eliminates DB workaround for ALL monitoring workflows | Medium | Every metric/ratio workflow |
| 2 | `web3/multicall` | 3-5x node reduction for multi-address reads | Medium | Compact monitoring workflows |
| 3 | `web3/watch-state` | New trigger type, 5x reduction in state-change workflows | High | All "alert on change" patterns |

The `math/calculate` plugin is the single highest-leverage investment. It addresses the exact missing feature called out in TECH-5922 and would be used by nearly every monitoring workflow.

---

## 7. Competitive Moat

**Why these workflows are hard to replicate**:

1. **Domain expertise baked in**: The Safety Ratio, hat strength analysis, and migration tracking encode Sky-specific governance security knowledge. A generic monitoring tool wouldn't know to check `approvals(hat())` vs DEX liquidity.

2. **Database Query as math engine**: The PostgreSQL workaround is non-obvious. Competing no-code platforms that lack SQL capabilities cannot express these calculations at all.

3. **Operational context**: These workflows don't just alert -- they store historical data, track trends, and provide operational intelligence. The Dashboard Updater (Workflow 7) replaces an entire Lambda + data pipeline.

4. **Notification routing**: Multi-channel alerting (Discord for the team, Email for stakeholders, PagerDuty for on-call) with severity-based routing is table stakes for production operations but absent from most blockchain monitoring tools.

5. **The math/calculate plugin opportunity**: Building native BigInt arithmetic for workflow conditions would be a unique capability among no-code blockchain automation platforms. It unlocks not just governance monitoring but the entire class of "compare on-chain metrics" workflows that DeFi operations teams need.

**Who would pay for this**: Every DeFi protocol with on-chain governance (Aave, Compound, Uniswap, ENS, Arbitrum DAO) faces the same governance attack vector. The Safety Ratio pattern is directly transferable -- swap the token and governance contract addresses.

---

## Sources

- Existing ESM analysis: `keeperhub/analysis/esm-emergency-shutdown-workflows.md`
- Platform capabilities: Direct code review of `lib/steps/`, `lib/condition-validator.ts`, `lib/workflow-executor.workflow.ts`, `keeperhub/plugins/web3/steps/`
- DSChief address from training knowledge -- verify against live chainlog before building
- MKR and SKY token addresses confirmed from ESM analysis file
