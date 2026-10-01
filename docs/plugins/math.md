---
title: "Math Plugin"
description: "Aggregation, tolerance comparison and number formatting across array data or multiple upstream node outputs."
---

# Math Plugin

Perform aggregation operations on numeric values from upstream nodes. Reduces multiple values into a single result with optional post-aggregation arithmetic.

No credentials or setup required -- this is a pure computation node.

## Actions

| Action                | Description                                                                        |
| --------------------- | ---------------------------------------------------------------------------------- |
| Aggregate             | Reduce multiple values into one via sum, count, average, median, min, max, product |
| Compare With Tolerance | Compare an actual value against an expected value with a percentage or absolute tolerance |
| Treasury Runway       | Calculate reserve-adjusted runway, recovery funding and treasury status             |
| Format Number         | Turn a raw integer or decimal into a readable string                               |
| Multi-Source Consensus Tolerance | Check that N oracle or price feed readings all agree within a tolerance |

## Aggregate

Reduces multiple numeric values into a single result. When any input is written as a plain integer past the safe-integer range (e.g., a raw token balance in wei) the whole set is computed in fixed-point arithmetic, so a fractional value next to it keeps its digits.

### Aggregation Operations

| Operation | Description                          | Empty Input | Fixed-point           |
| --------- | ------------------------------------ | ----------- | --------------------- |
| sum       | Add all values together              | Returns `0` | Exact                 |
| count     | Number of values in the set          | Returns `0` | Exact                 |
| average   | Arithmetic mean (sum / count)        | Error       | 18 to 256 decimals    |
| median    | Middle value (or mean of two middle) | Error       | Exact                 |
| min       | Smallest value                       | Error       | Exact                 |
| max       | Largest value                        | Error       | Exact                 |
| product   | Multiply all values together         | Returns `1` | Exact                 |

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
| zeroDivisorBehaviour | No         | `fail` (default) or `null-result`, for a zero divide or modulo operand |

### Outputs

| Output     | Description                                                         |
| ---------- | ------------------------------------------------------------------- |
| result     | The aggregation result as a string (exact on the fixed-point path), or `null` on a zero divisor when the step opts into that (see below) |
| resultType | `"bigint"` for a whole number computed in fixed point, `"number"` otherwise |
| operation  | Description of operations performed (e.g., `"sum then divide"`)    |
| inputCount | Number of values that were aggregated                               |
| divisionByZero | `true` when divide or modulo had a zero operand and Zero Divisor is set to return a null result (see below) |
| error      | Error message if the aggregation failed                             |

### Large Values and Fractions

When any input value is written as a plain integer that exceeds JavaScript's `Number.MAX_SAFE_INTEGER` (2^53 - 1), the whole set is computed in fixed-point arithmetic: every value is carried as an integer plus a decimal scale, so a wei balance and a fractional rate can be aggregated together without either losing digits. Decimal strings keep their exact digits (`0.1` stays `0.1`); numbers written in exponent form (`1e18`, `2.5e-3`) are expanded first.

- Sum, product, min, max, median and the add, subtract, multiply, modulo, abs, round, floor, ceil and round-decimals post-operations are exact
- Average and the divide post-operation keep at least 18 decimal places and at least 18 significant digits, whichever needs more, up to the 256-place limit below, and truncate beyond that, so a dust amount divided by a raw supply keeps its digits rather than becoming zero. A quotient with no form inside that limit is computed in floating point rather than reported as an exact zero
- Power is exact for a whole-number exponent from 0 to 256 when the result stays under 4,096 digits; any other exponent, or a larger result, is computed in floating point. An exact power whose value is too small for the 256-place limit is also computed in floating point rather than reported as an exact zero
- `resultType` is `"bigint"` when the result is a whole number and `"number"` when it carries a fraction; the `result` string is exact either way
- Values are carried to at most 256 decimal places; fractional digits beyond that are dropped on each input and wherever a result scale is produced. A running product keeps every digit a later factor can still bring back into view, so a tiny factor followed by a large one does not vanish on the way and the answer does not depend on input order; digits too far below that to reach either the 256-place limit or the floating-point range are dropped while the product runs, so no number of factors pushes the work to an absurd scale
- A product or multiply whose exact result has no 256-place form is computed in floating point from that exact value rather than reported as an exact zero. Two results are still reported as a plain `0`: a product whose exact value is smaller than the smallest number floating point can hold returns `"0"` with `resultType: "number"` (for example `9007199254740993, 1e-200, 1e-200`, around 9e-385), and a `product` factor written below `1e-256` is read as zero, so the product returns `"0"` with `resultType: "bigint"`
- Inputs that only the JavaScript number parser understands (`0x...` hex, `5.`) are carried as the number's own digits

Every other input set, including a large magnitude written in exponent form, uses standard floating-point arithmetic. To keep a fraction next to a large value, write the large value as a plain integer.

### Zero Divisor

The **Zero Divisor** field in the Post-Aggregation Arithmetic group selects what a zero operand on the divide or modulo post-operation does:

- **Fail the step** (the default, and what a configuration without the field does): the step fails with `Division by zero.` or `Modulo by zero.`, and the run stops there
- **Return a null result and set divisionByZero**: the step succeeds with `result: null` and `divisionByZero: true`, so a Condition node after it can branch on the case. Pick this when a zero denominator is a legitimate state, for example a ratio whose denominator is a rate of consumption that is currently zero. Any node reading `result` then receives an empty value, so route the null branch away from nodes that need a number

Zero is judged from the operand as written (`0`, `0.000`, `0e5`, `0x0`), not from what a float makes of it. An operand that is not zero as written but is too small for any precision this step carries fails with a precision message under either setting and does not set the flag; for the divide post-operation, one that is too small for fixed point but not for floating point is computed in floating point, which for a very large numerator can return `Infinity`, as the power path does; on the fixed-point path the modulo post-operation fails with the precision message on such a divisor, since a remainder by a divisor the fixed-point scale cannot represent is not an answer. A set that stays on the plain floating-point path still returns a remainder for a divisor that small, so `sum` of `9007199254740991` then `modulo 1e-300` succeeds with around 9.7e-301.

### String-Encoded Numbers

Values from upstream nodes often arrive as strings. The Aggregate node handles:

- Plain strings: `"1234.56"` -> `1234.56`
- Comma-formatted: `"1,234,567.89"` -> `1234567.89`
- Integer strings: `"1000000000000000000"` -> fixed point if above MAX_SAFE_INTEGER
- Mixed types in the same set (some string, some number)

Non-numeric values are silently skipped. Check `inputCount` to verify how many values were actually processed.

---

## Compare With Tolerance

Compares an actual value against an expected value and reports whether the difference is inside a tolerance. All arithmetic is BigInt-based, so RAD and WAD magnitude values (1e45, 1e18) compare without the precision loss a `Number` round trip introduces.

### Inputs

| Input | Required | Description |
| ----- | -------- | ----------- |
| actual | Yes | The observed value |
| expected | Yes | The reference value |
| mode | Yes | `percent` (percentage of expected, the default) or `absolute` |
| tolerance | Yes | In percent mode a percentage, so `0.5` means half a percent. In absolute mode, the same units as the values |
| precision | No | Decimal places used when formatting `percentDifference`. Default 6 |

### Outputs

| Output | Description |
| ------ | ----------- |
| withinTolerance | True when the difference is inside the tolerance |
| breached | True when it is outside -- wire this to an alert branch |
| direction | `above`, `below` or `equal`, relative to expected |
| difference | Actual minus expected, as a signed decimal string |
| absoluteDifference | The difference without its sign |
| percentDifference | Signed percentage difference from expected, or `null` when expected is zero |
| actual | The normalised actual value |
| expected | The normalised expected value |
| tolerance | The tolerance that was applied |
| mode | `percent` or `absolute` |
| error | Error message if the comparison failed |

### Notes

- A difference exactly equal to the tolerance counts as within.
- When `expected` is zero, a percentage is undefined: `percentDifference` is `null` and only an exact match counts as within tolerance.
- Decimal inputs are supported directly, so `100.4` against `100` with a `0.5` percent tolerance passes.

### Example

```
-> Read Contract (Oracle Price)
-> Database Query (Previous Price)
-> Compare With Tolerance:
     actual: {{@oracle:Oracle Price.result}}
     expected: {{@prev:Previous Price.rows.0.price}}
     mode: percent
     tolerance: 2
-> Condition: {{@check:Compare With Tolerance.breached}} == true
-> Discord: "Price moved {{@check:Compare With Tolerance.percentDifference}}%"
```

---

## Format Number

Turns a raw integer or decimal into a readable string: scales down token decimals, groups thousands, or shortens to compact K/M/B/T notation with an optional unit.

### Inputs

| Input | Required | Description |
| ----- | -------- | ----------- |
| value | Yes | The raw number, as a string or number |
| decimals | No | Divides the value by 10 to this power before formatting. Use 18 for a wei amount, 6 for USDC, 0 for a plain number. Default 0 |
| notation | No | `compact` (1.23M, the default) or `plain` (1,230,000.00) |
| precision | No | Decimal places. Default 2 |
| unit | No | Appended after the number, separated by a space |

### Outputs

| Output | Description |
| ------ | ----------- |
| formatted | The display string, e.g. `1.23M SKY` |
| value | The full scaled value as a decimal string, with no rounding applied |
| magnitude | The compact suffix used: `K`, `M`, `B`, `T` or empty |
| notation | `compact` or `plain` |
| error | Error message if formatting failed |

### Notes

- Scaling is BigInt-based, so a wei amount larger than `Number.MAX_SAFE_INTEGER` keeps every digit in the `value` output.
- `formatted` is for display; use `value` when a downstream node needs the number.

### Example

```
-> Read Contract (Locked Tokens)
-> Format Number:
     value: {{@locked:Locked Tokens.result}}
     decimals: 18
     notation: compact
     precision: 2
     unit: SKY
-> Discord: "Locked: {{@fmt:Format Number.formatted}}"
```

---

## Multi-Source Consensus Tolerance

Checks that several oracle or price feed readings agree. Every pair of sources is compared against the tolerance, so a single divergent feed breaks consensus wherever it sits in the list. All arithmetic is BigInt based, so WAD and RAD magnitude readings compare without float precision loss.

### Inputs

| Input | Required | Description |
| ----- | -------- | ----------- |
| values | Yes | One source value per line, or a JSON array. A comma inside a value is read as a thousands separator, so keep each source on its own line |
| mode | Yes | `percent` (the default) or `absolute` |
| tolerance | Yes | In percent mode a percentage, so `1` means one percent between any two sources. In absolute mode, the same units as the values |
| minSources | No | How many sources the check requires. Two is the floor, so a lower value is treated as 2. Default 2 |
| precision | No | Decimal places used when formatting `maxPercentDeviation`. Default 6 |

### Outputs

| Output | Description |
| ------ | ----------- |
| inConsensus | True when every pair of sources is inside the tolerance |
| sourceCount | Number of sources evaluated |
| maxDeviation | Largest difference found between any two sources |
| maxPercentDeviation | Largest percentage difference between any pair, relative to the larger absolute value of that pair. Rounded up at the configured precision, so `0` means every source agreed exactly |
| median | Median across all sources, including any that broke consensus |
| values | The source values as they were read, in input order |
| tolerance | The tolerance that was applied |
| mode | `percent` or `absolute` |
| error | Error message if the consensus check failed |

### Notes

- A pair is measured against the larger of its two absolute values, so for `-300` and `100` the base is 300. The verdict and `maxPercentDeviation` stay the same when the sources are reordered.
- `maxPercentDeviation` is the largest ratio across every pair, which is not always the pair with the largest `maxDeviation` once the sources have mixed signs.
- A difference exactly equal to the tolerance counts as in consensus.
- Fewer sources than `minSources` is an error rather than a `false` verdict, so a feed that returned nothing fails the step instead of passing a one source check. Read `success` alongside `inConsensus` when a missing feed needs its own alert branch.
- `median` covers every source, including ones outside the tolerance. Check `inConsensus` before you act on it.
- An even number of sources returns the exact midpoint of the two middle readings, negative values included.

### Example

```
Trigger (Schedule, every 5m)
-> Read Contract (Chronicle): read the price
-> Read Contract (Chainlink): latestAnswer
-> Read Contract (Pyth): read the price

-> Multi-Source Consensus Tolerance:
     values:
       {{@chronicle:Read Contract.result}}
       {{@chainlink:Read Contract.result}}
       {{@pyth:Read Contract.result}}
     mode: percent
     tolerance: 1
     minSources: 3

-> Condition: {{@consensus:Multi-Source Consensus Tolerance.inConsensus}} == false
-> Discord: "Oracles diverged by {{@consensus:Multi-Source Consensus Tolerance.maxPercentDeviation}}% (median {{@consensus:Multi-Source Consensus Tolerance.median}})"
```

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

Take the median of several on-chain price feeds, and only use it when the feeds agree. Multi-Source Consensus Tolerance does both in one node: it checks every pair against the tolerance and returns the median of the readings.

```
Trigger (Event: PriceUpdated)
-> Read Contract (Oracle 1): latestAnswer
-> Read Contract (Oracle 2): latestAnswer
-> Read Contract (Oracle 3): latestAnswer
-> Read Contract (Oracle 4): latestAnswer
-> Read Contract (Oracle 5): latestAnswer

-> Multi-Source Consensus Tolerance:
     values:
       {{@o1:Read Contract.result}}
       {{@o2:Read Contract.result}}
       {{@o3:Read Contract.result}}
       {{@o4:Read Contract.result}}
       {{@o5:Read Contract.result}}
     mode: percent
     tolerance: 1
     minSources: 5

-> Condition: {{@consensus:Multi-Source Consensus Tolerance.inConsensus}} == true
-> Discord: "Median oracle price: {{@consensus:Multi-Source Consensus Tolerance.median}} (from {{@consensus:Multi-Source Consensus Tolerance.sourceCount}} oracles)"
```

Aggregate with `operation: median` is still the simpler choice when you only want the middle value and do not need to know whether the feeds agree.

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
