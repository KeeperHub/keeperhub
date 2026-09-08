# Scan Adapters: Spark + Sky (SCAN-03 partial)

**Status:** Design approved, pre-implementation
**Date:** 2026-06-29
**Scope owner:** scan funnel (`lib/scan/`)
**Relates to:** v1.13 Scan-to-Automate milestone audit, SCAN-03 accepted-partial item

## Goal

Extend the anonymous `/scan` position scanner to natively detect two more protocols the v1.13 milestone deferred:

- **Spark** (SparkLend) lending positions on Ethereum.
- **Sky** savings positions (sUSDS) on Ethereum.

Plus two curation changes to the scan's stablecoin coverage so it favours the
current Sky/USDS ecosystem over legacy tokens.

This closes most of the SCAN-03 gap. **Compound V3 is explicitly out of scope**
(its per-market Comet model and self-computed health factor are a separate
follow-on of comparable size to the original Aave+Lido work).

## Scope

### In scope

1. **Spark lending adapter** — Ethereum only. SparkLend's Pool exposes the
   identical Aave V3 `getUserAccountData` / `getUserEMode` interface, so the
   adapter reuses the Aave V3 ABI and decode logic with `protocol: "spark"`.
2. **Sky savings adapter** — Ethereum only, **sUSDS only** (sDAI dropped).
   sUSDS is an ERC-4626 vault; read `balanceOf(account)` (share balance, for
   display) and `maxWithdraw(account)` (underlying USDS assets, for value) — two
   independent, address-keyed calls that batch in a single Multicall3 round —
   then price the underlying.
3. **Price Sky positions** so the resulting suggestion survives the engine's
   dust filter (see "Pricing decision" below).
4. **Suggestion engine routing** for the two new protocols.
5. **Factory** protocol-aware pool selection so a Spark health suggestion
   targets the Spark pool, not Aave's.
6. **DAI scan exclusion** — exclude DAI from the scan's stablecoin coverage
   (scan-scoped only; global registry untouched).

### Out of scope

- **Compound V3** — separate follow-on.
- **Write paths** — v1.13 is read-only; all suggestions remain `readOrWrite: "read"`.
- **L2 Spark / Sky** — addresses are only verified on Ethereum; per the
  registry's omit-unverified convention, other chains are simply not scanned.
- **sDAI** and **DAI** — intentionally dropped (favour USDS / sUSDS).
- **Global `supportedTokens` / `isStablecoin` changes** — the DAI exclusion is
  scan-path-local; the global token registry (workflow builder, token pickers)
  is not modified.
- **Fixing Lido position pricing** — see "Discovered issue" below; noted, not fixed.

## Resulting scan coverage

| Source | Status | Suggestion category |
|---|---|---|
| Aave V3 positions | existing | health (HF monitor) / alert (supply-only) |
| Lido staking (stETH/wstETH) | existing | claim (reward reminder) |
| Stablecoins: USDC, USDT, **USDS** | existing (DAI now excluded) | yield (idle-yield monitor) |
| **Spark positions** | new | health / alert (same paths as Aave) |
| **Sky savings (sUSDS)** | new | claim (savings balance monitor) |

The engine still emits a card only for what the scanned address actually holds,
ranked and capped at 7 (`MAX_SUGGESTIONS`).

## Pricing decision (Sky)

The scanner prices *stablecoins* but not *positions* — Lido positions carry
`usdValue: null`. The suggestion engine dust-filters on USD value
(`bal < DUST_THRESHOLD_USD`), so an unpriced position's suggestion is silently
filtered out.

**Decision:** price Sky positions in `scanOneChain` via the existing pricing
layer. `maxWithdraw(account)` yields the underlying USDS amount;
`resolveUsdPrice(chainId, USDS_address, "USDS", …)` resolves the USD price
(USDS has no Chainlink feed in the registry, so this falls through to DefiLlama).
This respects the established "never hardcode \$1 / depeg-aware" pricing
principle and makes the Sky suggestion surface correctly.

Rejected alternatives:
- Approximate underlying as exactly \$1 in the adapter — violates the
  never-hardcode-\$1 principle, no depeg awareness.
- Detect + display only, no pricing — the Sky suggestion would be dust-filtered
  out (the Lido status quo).

## Components

### New files

- `lib/scan/adapters/spark.ts`
  - `buildSparkCalls(userAddress, chainId): AdapterCallDescriptor[]` — returns
    `[]` when `SPARK_POOLS[chainId]` is absent; otherwise encodes
    `getUserAccountData` + `getUserEMode` against the Spark pool (reuses the
    Aave V3 pool ABI / `Interface`).
  - `decodeSparkResults(results, address, chainId): ProtocolPosition[]` — reuses
    the Aave decode path (`normalizeHealthFactor`, MAX_UINT256 guard, eMode
    soft-miss) and emits `protocol: "spark"`. Implemented either by
    parameterising a shared Aave decode helper on the protocol tag or a thin
    wrapper that maps the result.
- `lib/scan/adapters/sky.ts`
  - `buildSkyCalls(userAddress, chainId): AdapterCallDescriptor[]` — returns `[]`
    when `SKY_SAVINGS[chainId]` is absent; otherwise encodes two independent,
    address-keyed reads against the sUSDS vault: `balanceOf(account)` (shares,
    for the displayed amount) and `maxWithdraw(account)` (underlying USDS assets
    withdrawable for that owner, for value). Both take the address directly, so
    they batch in one Multicall3 round — no output-chaining required. (If the
    live sUSDS ABI proves `maxWithdraw` unsuitable, the fallback is to price the
    `balanceOf` shares directly via DefiLlama's sUSDS feed; the plan confirms
    against the live ABI / DefiLlama coverage.)
  - `decodeSkyResults(results, address, chainId): ProtocolPosition[]` — emits a
    single `ProtocolPosition` with `protocol: "sky"`, `healthFactor: null`,
    `noActiveLoan: true`, `suppliedAssets: [{ symbol: "sUSDS", tokenAddress,
    amount: <shares from balanceOf>, decimals: 18, usdValue: <priced underlying
    from maxWithdraw> }]`. Zero `maxWithdraw` (or both calls failed) → `[]`.
- `lib/scan/abis/erc4626-savings.json` — minimal `balanceOf` + `maxWithdraw`
  fragment for the sUSDS vault reads.

### Registry — `lib/scan/adapters/protocol-registry.ts`

```ts
export const SPARK_POOLS: Record<number, string> = {
  1: "0xC13e21B648A5Ee794902342038FF3aDAB66BE987", // [VERIFIED <source> <date>]
};

export interface SkySavingsTokens { sUSDS: string }
export const SKY_SAVINGS: Record<number, SkySavingsTokens> = {
  1: { sUSDS: "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD" }, // [VERIFIED <source> <date>]
};
```

`scannableChainIds` extends its registered-chain set to also union
`SPARK_POOLS` and `SKY_SAVINGS` keys.

Addresses are sourced from the execution-side `lib/safe/protocol-targets.ts`
(Spark pool, sUSDS) but must be re-verified against an authoritative source and
annotated `[VERIFIED <source> <date>]` per the registry's existing convention.

### Types — `lib/scan/types.ts`

Widen the protocol union in two places:

```ts
protocol: "aave-v3" | "lido" | "spark" | "sky";
```

(`ProtocolPosition.protocol` and `ProtocolAdapter.protocol`.)
`SuggestionDescriptor.protocol` is already `string` — no change.

### Scanner — `lib/scan/scanner.ts` (`scanOneChain`)

- Build Spark and Sky calls alongside the existing adapters; concatenate into
  the single `aggregate3` batch and slice results back in the same order (the
  existing offset-tracking pattern).
- Decode Spark and Sky positions into the `positions[]` array.
- **Price Sky positions:** for each Sky position, resolve the underlying USDS
  price via `resolveUsdPrice` and set `suppliedAssets[].usdValue` +
  `totalCollateralUsd`.
- **DAI exclusion:** filter `chainStablecoins` to drop DAI before building
  stablecoin calls, e.g. `SCAN_EXCLUDED_STABLECOINS = new Set(["DAI"])`. This
  removes both the scanned balance and its yield card without touching the
  global registry.

### Suggestion engine — `lib/scan/suggestions/engine.ts`

- `protocolLabel`: add `spark → "Spark"`, `sky → "Sky"`.
- `const SAVINGS_PROTOCOLS = new Set(["lido", "sky"])`.
  - Null-HF positions whose protocol is in `SAVINGS_PROTOCOLS` skip the
    supply-only price-alert path and route to the claim/reminder builder
    (replaces the current `protocol !== "lido"` / `=== "lido"` checks).
  - Sky's claim card uses savings-appropriate copy (e.g. "Sky Savings Balance
    Monitor") rather than "Staking Reward Reminder".
- Spark (lending) needs no special branch: an active-loan Spark position flows
  through `buildHealthSuggestion`; a supply-only Spark position flows through
  `buildAlertSuggestion`, exactly like Aave.

### Factory — `lib/scan/factory/shapes/hf-monitor.ts`

- Add `SPARK_POOL_ADDRESSES = { 1: "0xC13e21…987" }` (inline, mirroring the
  existing `AAVE_V3_POOL_ADDRESSES` copy).
- Select the pool address by `descriptor.protocol` (`"spark"` → Spark pool;
  default → Aave pool). Update the read node label/description to reflect the
  protocol.
- Sky uses the existing `reward-reminder` shape (category `"claim"`) via
  `confirmInputs.stakingTokenAddress`; no dispatcher change. The dispatcher in
  `factory/index.ts` is unchanged. Because detection already knows the token,
  the Sky claim suggestion prefills `confirmInputs.stakingTokenAddress` with the
  actual sUSDS address (improving on Lido's placeholder prompt), so the
  monitored token is correct without user entry.

## Discovered issue (noted, not fixed)

Lido positions are emitted with `usdValue: null` and `totalCollateralUsd: null`
because the scanner never prices positions. The engine's reward loop dust-filters
on USD value, so **Lido reward suggestions are silently filtered out today**.
Approach A fixes this mechanism for Sky, but pricing wstETH requires a
wstETH→ETH→USD path heavier than a \$1-pegged stablecoin. Tracked as a follow-up,
not addressed here.

## Testing (TDD / RED-first, per phase convention)

- `spark.test.ts` — decode reuses Aave fixtures: active-loan position (HF
  normalised), supply-only position (`healthFactor: null`, `noActiveLoan: true`),
  no-position (`[]`), eMode soft-miss.
- `sky.test.ts` — sUSDS non-zero balance → single priced `sky` position;
  zero balance → `[]`; price-miss → `usdValue: null` but position still emitted.
- engine routing tests — Spark active loan → health; Spark supply-only → alert;
  Sky → claim (NOT alert); `protocolLabel` mappings.
- factory test — a Spark health descriptor produces a read node targeting the
  Spark pool address, not the Aave pool.
- scanner / integration — USDS still surfaces as a stablecoin; DAI no longer
  surfaces as a scanned balance or yield card.

## Success criteria

1. An Ethereum address with a Spark loan yields a Spark health-factor suggestion
   whose prefilled workflow reads the **Spark** pool.
2. An Ethereum address holding sUSDS yields a priced Sky savings-monitor
   suggestion (survives the dust filter).
3. USDS continues to surface as a stablecoin idle-yield suggestion; DAI does not
   appear in scan results.
4. No write-type suggestions are produced; all new suggestions are read-only.
5. Native Spark/Sky positions take precedence over the (dormant) Zerion fallback
   for the same `(protocol, chainId)`.
6. New unit tests pass; existing scan suite stays green.
