---
title: "Math Plugin"
description: "Aggregation and arithmetic operations across array data or multiple upstream node outputs."
---

# Math Plugin

Perform aggregation operations on numeric values from upstream nodes. Reduces multiple values into a single result with optional post-aggregation arithmetic.

No credentials or setup required -- this is a pure computation node.

## Actions

| Action    | Description                                                                        |
| --------- | ---------------------------------------------------------------------------------- |
| Aggregate | Reduce multiple values into one via sum, count, average, median, min, max, product |

## Aggregate

Reduces multiple numeric values into a single result. Automatically detects large integers (e.g., raw token balances in wei) and uses BigInt arithmetic to preserve precision.

### Aggregation Operations

| Operation | Description                          | Empty Input | BigInt Support  |
| --------- | ------------------------------------ | ----------- | --------------- |
| sum       | Add all values together              | Returns `0` | Yes             |
| count     | Number of values in the set          | Returns `0` | Yes             |
| average   | Arithmetic mean (sum / count)        | Error       | Yes (truncated) |
| median    | Middle value (or mean of two middle) | Error       | Yes (truncated) |
| min       | Smallest value                       | Error       | Yes             |
| max       | Largest value                        | Error       | Yes             |
| product   | Multiply all values together         | Returns `1` | Yes             |

### Post-Aggregation Operations

Applied to the aggregated result. Useful for unit conversions, thresholds, and formatting.

**Binary (require an operand):**

| Operation | Description                  | Example                             |
| --------- | ---------------------------- | ----------------------------------- |
| add       | Add a constant to the result | Sum + fixed offset                  |
| subtract  | Subtract a constant          | Sum - budget threshold              |
| multiply  | Multiply by a constant       | Convert between denominations       |
| divide    | Divide by a constant         | Token conversion ratio              |
| modulo         | Remainder after division          | Cycle detection                     |
| power          | Raise to a power                  | Scale by 10^N for decimal precision |
| round-decimals | Round to N decimal places         | Round to 2 decimals for display     |

**Unary (no operand needed):**

| Operation | Description              | Example                       |
| --------- | ------------------------ | ----------------------------- |
| abs       | Absolute value           | Magnitude of a delta          |
| round     | Round to nearest integer | Clean up fractional results   |
| floor     | Round down               | Conservative integer estimate |
| ceil      | Round up                 | Ensure minimum allocation     |

### Input Modes

**Explicit Values** -- list values directly, one per line or comma-separated. Use template variables to reference upstream node outputs.

```
{{@node1:Check Token Balance.balance.balance}}
{{@node2:Check Token Balance.balance.balance}}
{{@node3:Check Token Balance.balance.balance}}
```

**Array from Upstream Node** -- reference a JSON array from an upstream node (e.g., loop output, database query rows) and optionally specify a dot-path to the numeric field within each element.

- `arrayInput`: The array data, e.g., `{{@loop:For Each.results}}`
- `fieldPath`: Property to extract from each array item (supports dot notation for nested objects). Examples:
  - `[{balance: "100"}, {balance: "200"}]` -- use `balance`
  - `[{token: {amount: 50}}]` -- use `token.amount`
  - `[{result: {value: "3"}}]` -- use `result.value`
  - `[1, 2, 3]` -- leave empty (items are plain values)

### Inputs

| Input          | Required         | Description                                                           |
| -------------- | ---------------- | --------------------------------------------------------------------- |
| operation      | Yes              | Aggregation operation: sum, count, average, median, min, max, product |
| inputMode      | Yes              | `explicit` (list values) or `array` (reference upstream array)        |
| explicitValues | If explicit mode | Comma/newline-separated values or template variables                  |
| arrayInput     | If array mode    | JSON array from upstream node                                         |
| fieldPath      | No (array mode)  | Dot-path to numeric field in each array element                       |
| postOperation  | No               | Optional arithmetic on the result (see table above)                   |
| postOperand    | If binary post-op| Number for binary post-ops and round-decimals (decimal count)         |

### Outputs

| Output     | Description                                                         |
| ---------- | ------------------------------------------------------------------- |
| result     | The aggregation result as a string (preserves precision for BigInt) |
| resultType | `"number"` for standard values or `"bigint"` for large integers    |
| operation  | Description of operations performed (e.g., `"sum then divide"`)    |
| inputCount | Number of values that were aggregated                               |
| error      | Error message if the aggregation failed                             |

### BigInt Handling

When any input value is an integer that exceeds JavaScript's `Number.MAX_SAFE_INTEGER` (2^53 - 1), the node automatically switches to BigInt arithmetic. This prevents silent precision loss when working with raw token balances in their smallest denomination (e.g., wei).

- The `resultType` output indicates which mode was used
- BigInt average and median use integer division (truncated, not rounded)
- Post-operations always use Number arithmetic. If you need full BigInt precision through a post-operation, chain two Aggregate nodes

### String-Encoded Numbers

Values from upstream nodes often arrive as strings. The Aggregate node handles:

- Plain strings: `"1234.56"` -> `1234.56`
- Comma-formatted: `"1,234,567.89"` -> `1234567.89`
- Integer strings: `"1000000000000000000"` -> BigInt if above MAX_SAFE_INTEGER
- Mixed types in the same set (some string, some number)

Non-numeric values are silently skipped. Check `inputCount` to verify how many values were actually processed.

---

## Example Workflows

### Sum Token Balances Across Liquidity Pools (Explicit Mode)

Sum a token's balance from multiple parallel Check Token Balance nodes monitoring different DEX pools.

```
Trigger (Schedule, every 1h)
-> Check Token Balance (Pool 1): token on DEX A
-> Check Token Balance (Pool 2): token on DEX B
-> Check Token Balance (Pool 3): token on DEX C
-> Check Token Balance (Pool 4): token on DEX D
-> Aggregate:
     operation: sum
     inputMode: explicit
     explicitValues:
       {{@pool1:Check Token Balance.balance.balance}}
       {{@pool2:Check Token Balance.balance.balance}}
       {{@pool3:Check Token Balance.balance.balance}}
       {{@pool4:Check Token Balance.balance.balance}}
-> Discord: "Total across {{@agg:Aggregate.inputCount}} pools: {{@agg:Aggregate.result}}"
```

### Multi-Token Ratio with Unit Conversion (Chained Aggregates)

Sum balances for two different tokens across pools, convert Token B to Token A equivalent using a known ratio, then divide by a governance parameter to compute a risk ratio.

```
Trigger (Schedule, every 1h)
-> Check Token Balance (Token A, Pool 1-4): balances across pools
-> Check Token Balance (Token B, Pool 1-3): balances across pools
-> Read Contract (Governance Param): read on-chain threshold value

-> Aggregate (Token A Total):
     operation: sum
     inputMode: explicit
     explicitValues:
       {{@a1:Check Token Balance.balance.balance}}
       {{@a2:Check Token Balance.balance.balance}}
       {{@a3:Check Token Balance.balance.balance}}
       {{@a4:Check Token Balance.balance.balance}}

-> Aggregate (Token B Converted):
     operation: sum
     inputMode: explicit
     explicitValues:
       {{@b1:Check Token Balance.balance.balance}}
       {{@b2:Check Token Balance.balance.balance}}
       {{@b3:Check Token Balance.balance.balance}}
     postOperation: divide
     postOperand: 24000

-> Aggregate (Combined Ratio):
     operation: sum
     inputMode: explicit
     explicitValues:
       {{@tokenA:Aggregate.result}}
       {{@tokenB:Aggregate.result}}
     postOperation: divide
     postOperand: {{@param:Read Contract.result}}

-> Condition: {{@ratio:Aggregate.result}} < 3.0
-> Discord: "Risk ratio dropped to {{@ratio:Aggregate.result}} -- below threshold"
```

### Daily Event Volume (Count + Sum with Array Mode)

Aggregate on-chain event data from a Query Events node to compute daily volume and event count.

```
Trigger (Schedule, daily)
-> Query Events: Transfer events from a contract, last 24h

-> Aggregate (Total Volume):
     operation: sum
     inputMode: array
     arrayInput: {{@events:Query Events.events}}
     fieldPath: args.value

-> Aggregate (Event Count):
     operation: count
     inputMode: array
     arrayInput: {{@events:Query Events.events}}

-> Discord: "Daily volume: {{@volume:Aggregate.result}} across {{@count:Aggregate.inputCount}} transfers"
```

### Gas Budget Alert (Sum + Subtract Threshold)

Sum gas costs from a database of transactions and alert if the budget is exceeded.

```
Trigger (Schedule, daily)
-> Database Query: get today's transactions with gas costs

-> Aggregate (Total Gas):
     operation: sum
     inputMode: array
     arrayInput: {{@txns:Database Query.rows}}
     fieldPath: gasCostEth
     postOperation: round

-> Aggregate (Over Budget):
     operation: sum
     inputMode: explicit
     explicitValues: {{@gas:Aggregate.result}}
     postOperation: subtract
     postOperand: 0.5

-> Condition: {{@over:Aggregate.result}} > 0
-> Discord: "Gas budget exceeded by {{@over:Aggregate.result}} ETH (total: {{@gas:Aggregate.result}} ETH)"
```

### Median Price from Multiple Oracles

Use median instead of average to filter outlier values from multiple on-chain price feeds.

```
Trigger (Event: PriceUpdated)
-> Read Contract (Oracle 1): latestAnswer
-> Read Contract (Oracle 2): latestAnswer
-> Read Contract (Oracle 3): latestAnswer
-> Read Contract (Oracle 4): latestAnswer
-> Read Contract (Oracle 5): latestAnswer

-> Aggregate:
     operation: median
     inputMode: explicit
     explicitValues:
       {{@o1:Read Contract.result}}
       {{@o2:Read Contract.result}}
       {{@o3:Read Contract.result}}
       {{@o4:Read Contract.result}}
       {{@o5:Read Contract.result}}

-> Condition: |{{@med:Aggregate.result}} - {{@prev:State Recall.value}}| > threshold
-> Discord: "Median oracle price: {{@med:Aggregate.result}} (from {{@med:Aggregate.inputCount}} oracles)"
```

### Product for Compound Growth Factors

Multiply periodic growth rates together to compute cumulative performance.

```
Trigger (Schedule, weekly)
-> Database Query: get weekly growth multipliers (e.g., 1.02, 0.98, 1.05)

-> Aggregate:
     operation: product
     inputMode: array
     arrayInput: {{@rates:Database Query.rows}}
     fieldPath: growthMultiplier

-> Discord: "Cumulative growth: {{@prod:Aggregate.result}} over {{@prod:Aggregate.inputCount}} periods"
```

### Loop Results Aggregation (Array Mode)

Sum token balances from a dynamic list of addresses using the For Each loop node.

```
Trigger (Schedule)
-> Database Query: get list of monitored wallet addresses
-> For Each: iterate addresses
   -> Check Token Balance: balance for each address
-> Aggregate:
     operation: sum
     inputMode: array
     arrayInput: {{@loop:For Each.results}}
     fieldPath: balance.balance
-> Discord: "Total across {{@agg:Aggregate.inputCount}} wallets: {{@agg:Aggregate.result}}"
```

### Absolute Delta Detection

Detect significant value changes in either direction by computing the absolute difference.

```
Trigger (Schedule, every 5m)
-> Read Contract: current on-chain value
-> State Recall: previous value from last run

-> Aggregate (Delta):
     operation: sum
     inputMode: explicit
     explicitValues: {{@current:Read Contract.result}}
     postOperation: subtract
     postOperand: {{@prev:State Recall.value}}

-> Aggregate (Abs Delta):
     operation: sum
     inputMode: explicit
     explicitValues: {{@delta:Aggregate.result}}
     postOperation: abs

-> Condition: {{@absDelta:Aggregate.result}} > 100
-> Discord: "Value changed by {{@absDelta:Aggregate.result}} (current: {{@current:Read Contract.result}})"
-> State Store: save current value for next run
```

### Floor/Ceil for Integer Rounding

Round fractional values to whole numbers for display or downstream computation.

```
Trigger (Schedule)
-> Read Contract: get a fractional on-chain value

-> Aggregate:
     operation: sum
     inputMode: explicit
     explicitValues: {{@value:Read Contract.result}}
     postOperation: ceil

-> Discord: "Rounded up value: {{@rounded:Aggregate.result}}"
```
