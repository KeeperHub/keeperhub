# Design Spec: APY-Aware Stablecoin Yield Suggestions

**Status:** Draft (Phase 57)
**Requirements:** YIELD-01, YIELD-02, YIELD-03, YIELD-04
**Read-only:** Yes. No deposit/approve/write node is produced. The auto-deposit
write path is the deferred Phase 999.1 backlog item and is out of scope here.

## Summary

Upgrade the read-only stablecoin idle-yield suggestion from generic
"consider deploying to a yield protocol" copy into an APY-aware,
destination-specific recommendation:

- Idle **USDS** above dust -> names **Sky Savings (sUSDS)** and the current Sky
  Savings Rate (the live sUSDS pool APY).
- Idle **USDC / USDT** above dust -> names the **best-available supply venue**
  ranked by live APY across an allowlist of reputable stablecoin supply pools,
  and shows that venue's supply APY for the asset on that chain.
- Every APY comes from a **live source** (DefiLlama yields). On lookup failure
  the suggestion **degrades gracefully** to the existing generic monitor copy.
  An `apy <= 0` or missing value is treated as a lookup failure (no stale, no $0).

The change is additive and backward compatible: `buildSuggestions` gains an
optional second argument; all existing scan unit tests continue to pass without
modification because the argument defaults to absent (generic copy path).

## Data Source

`GET https://yields.llama.fi/pools` — a public endpoint returning ~15,800 pools
(~4MB JSON), one snapshot for all chains and projects (no per-token filter).
Outbound request goes through `safeFetch` (SSRF-guarded). The URL is a fixed
public-host constant; no user input reaches the URL.

## Module Layout

New file: `lib/scan/price/defillama-yields.ts` (server-only). Mirrors
`lib/scan/price/defillama.ts` (safeFetch + null/empty-degrade) plus the
module-level cache pattern from `lib/safe/price-oracle.ts`.

Exports:

- `DEFILLAMA_YIELDS_CHAIN_SLUGS: Record<number, string>` — yields-API chain
  names. **Distinct from** the coins-API `DEFILLAMA_CHAIN_SLUGS`.
- `type DefillamaYieldsPool` — pool schema (see below).
- `fetchDefillamaYieldPools(): Promise<DefillamaYieldsPool[]>` — cached fetch
  with a ~15 min module-level TTL and a ~4s `AbortController` timeout. Returns
  `[]` on any failure/timeout (degrade path). Never throws.
- `buildApyContext(pools, stablecoins): ApyContext` — pure, synchronous filter +
  rank transform. Precomputes a `Map<"symbol:chainId", ApyEntry>` and returns a
  closure-backed `ApyContext`. Never throws on malformed pool data.
- `projectSlugToLabel(slug, chainId): string` — centralised human-readable label.
- `clearApyCache(): void` — test-only cache reset.

Types `ApyEntry` and `ApyContext` live in `lib/scan/suggestions/engine.ts`
(exported), so the engine never imports a server-only module and the client
build is never poisoned. `defillama-yields.ts` imports them type-only.

```
ApyEntry  = { apy: number; projectLabel: string; destinationAddress: string | null }
ApyContext = { getBestYield(symbol: string, chainId: number): ApyEntry | null }
```

## Verified Project Slugs (live yields.llama.fi/pools, 2026-06-30)

The CONTEXT.md placeholder slug names are wrong; these verified values are
authoritative (slug verification was explicitly Claude's Discretion).

| Purpose | Slug(s) |
|---------|---------|
| USDS -> sUSDS pin (YIELD-01) | `sky-lending` with `symbol === "SUSDS"` |
| USDC/USDT ranking allowlist (YIELD-02) | `aave-v3`, `aave-v4`, `sparklend`, `spark-savings`, `morpho-blue` |

- `sparklend` (NOT `spark`) is the SparkLend lending protocol.
- `spark-savings` is the additional Spark PSM savings slug (USDC/USDT pools).
- `sky-lending` (NOT `sky`) has **no USDC/USDT supply pools** -> exclude it from
  the USDC/USDT allowlist; use it only for the pinned USDS -> sUSDS lookup.

## Verified Chain Slugs

```
DEFILLAMA_YIELDS_CHAIN_SLUGS = {
  1: "Ethereum", 10: "OP Mainnet", 137: "Polygon", 8453: "Base", 42161: "Arbitrum"
}
```

`10` is `"OP Mainnet"`, NOT `"Optimism"`. Chains outside this map degrade to the
generic copy (no fetch attempt for that asset).

## Pool Filtering and Ranking (buildApyContext)

For each stablecoin `(symbol, tokenAddress, chainId)`:

1. Resolve chain slug; if `chainId` is absent from the map -> no entry (degrade).
2. Candidate filter (all conditions must hold):
   - `pool.chain === chainSlug`
   - `pool.stablecoin === true`
   - `pool.ilRisk === "no"`
   - `pool.exposure === "single"`
   - numeric guard: `typeof pool.tvlUsd === "number"`, finite, `>= 10_000_000`
   - numeric guard: `typeof pool.apy === "number"`, finite, `> 0`
   - USDS: `pool.project === "sky-lending" && pool.symbol === "SUSDS"`.
     USDC/USDT: `USDC_USDT_ALLOWLIST.has(pool.project)`.
   - underlying match (ALL projects, incl. Morpho/Aave):
     `pool.underlyingTokens.some(t => t.toLowerCase() === tokenAddress.toLowerCase())`.
     Never filter Morpho/Aave by `symbol` (vault names mismatch the asset).
3. Rank: max `pool.apy` (total field — never `apyBase` alone; some pools have
   `apyBase: null` with valid `apyReward`). Tie-break: higher `pool.tvlUsd`.
4. Resolve destination address from the existing protocol registry (NOT the
   `pool` UUID, which is a DefiLlama internal id):
   - `sky-lending` -> `SKY_SAVINGS[chainId]?.sUSDS ?? null`
   - `aave-v3` -> `AAVE_V3_POOLS[chainId] ?? null`
   - `sparklend` / `spark-savings` -> `SPARK_POOLS[chainId] ?? null`
   - `aave-v4` / `morpho-blue` -> `null` (not in registry; label-only is fine)
5. Emit `ApyEntry { apy, projectLabel: projectSlugToLabel(slug, chainId),
   destinationAddress }`. No candidate -> no entry (degrade).

Malformed pool entries (missing fields, NaN, negative, over-large) are skipped,
never thrown — one bad entry must not break the 200 scan response.

## Engine Change (buildYieldSuggestion)

Optional `apyContext` argument. When `apyContext?.getBestYield(symbol, chainId)`
returns an entry with `apy > 0`:

- Description contains the load-bearing substring
  `~${apy.toFixed(1)}% APY via ${projectLabel}` (1 decimal place).
- `confirmInputs.destinationAddress` is set **only** when the entry's
  `destinationAddress` is a non-null `0x` address.

Otherwise (no context, no entry, `apy <= 0`): the existing generic copy and
`confirmInputs` are emitted unchanged.

`readOrWrite` stays `"read"` in all branches. `category` stays `"yield"`. Slug
(`id`) and ranking inputs (`usdValue`) are unchanged, so dedup and
`MAX_SUGGESTIONS` cap behaviour are preserved.

## Route Wiring

In `app/api/scan/[address]/route.ts`, after `scanAddress` resolves and before the
existing `buildSuggestions` inner try:

```
const yieldPools = await fetchDefillamaYieldPools();   // [] on failure
const apyContext = buildApyContext(yieldPools, result.stablecoins);
```

Wrapped in its own try that degrades `apyContext` to `undefined` on any error.
Then `buildSuggestions(result, apyContext)` runs inside the existing inner try.
The 15-min module cache means most scans never hit the network.

## Factory Change (read-only destination reference)

`lib/scan/factory/shapes/stablecoin-yield.ts` surfaces
`descriptor.confirmInputs.destinationAddress` in the HTTP alert `bodyTemplate`
when present. **No new node is added** — topology stays Schedule -> Read ->
Condition -> Alert. This preserves YIELD-04: `validateNoApproveTokenNode` and
`validateNoMaxUint256Approval` continue to pass.

## Degradation Contract (YIELD-03)

| Condition | Result |
|-----------|--------|
| DefiLlama timeout / network error / non-200 | `fetchDefillamaYieldPools` -> `[]` -> all stablecoins generic copy |
| Chain not in `DEFILLAMA_YIELDS_CHAIN_SLUGS` | no entry -> generic copy |
| No qualifying pool (TVL/allowlist/underlying) | no entry -> generic copy |
| `apy <= 0` or non-numeric | no entry -> generic copy |
| Engine throws | route returns `suggestions: []` (existing T-52-12 guard) |

## Security

- Outbound HTTP only to the fixed `yields.llama.fi/pools` host via `safeFetch`;
  no user-controlled URL segment.
- DefiLlama APY/TVL values are untrusted: numeric-validate before use; ignore
  NaN/negative/over-large; never throw on a malformed entry (degrade).
- Read-only invariant (YIELD-04, HIGH): the suggestion/factory path emits no
  approve/deposit/write node. Enforced by the existing factory guards plus new
  unit assertions.
- Project label is a plain string rendered through React (auto-escaped); no
  `innerHTML`, no on-chain action taken from the displayed value.

## Test Strategy

- `tests/unit/scan-defillama-yields.test.ts` (new): fetch cache hit/miss,
  timeout/parse/non-200 -> `[]`, `buildApyContext` filter + USDS pin + allowlist
  + underlying match + max-APY pick + TVL tie-break + chain-not-in-map.
- `tests/unit/scan-suggestions.test.ts` (extended): APY-aware copy, degrade
  paths, `readOrWrite: "read"` invariant, backward compat (no arg).
- `tests/unit/scan-factory.test.ts` (extended): destination reference appears in
  workflow output when present; `validateNoApproveTokenNode` /
  `validateNoMaxUint256Approval` still pass (YIELD-04).
- `tests/unit/scan-route-suggestions.test.ts` (extended): route mocks the yields
  client; APY surfaces end-to-end; a rejecting client still returns 200 generic.
- Regression gate: the full existing scan unit suite stays green; `pnpm type-check` clean.

## No New Packages

Zero new npm packages. Reuses `safeFetch`, `AbortController`, and the existing
protocol registry.
