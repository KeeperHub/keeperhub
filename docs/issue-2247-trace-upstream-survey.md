# Issue 2247: Trace-method availability across chain upstreams

Research survey for [#2247](https://github.com/KeeperHub/keeperhub/issues/2247). No trigger implementation. No Aetherlay changes. No secrets.

**Tree:** `CHAIN_CONFIG` / `PUBLIC_RPCS` at `staging` (`lib/rpc/rpc-config.ts`). 24 entries: 12 mainnets (11 EVM + Solana) and 12 testnets.

**What this can and cannot see.** Production primary/fallback URLs live in `CHAIN_RPC_CONFIG` (AWS Parameter Store / Helm), which is not in this repository. `rpc-config.ts` resolves `JSON config → env var → PUBLIC_RPCS`. `scripts/seed/seed-chains.ts` writes `PUBLIC_RPCS` into the chains table and re-seeds on every deploy, so the public defaults are what a self-hosted or unconfigured install actually runs. This survey measures those defaults live, and records commercial-provider tiers from public docs for whoever production is actually pointed at. Filling the production-plan cells needs a maintainer with Parameter Store and billing access.

**Probe window:** 2026-09-03, ~11:12–11:20 ICT. Unauthenticated POST only. Sequential, one recent block per endpoint (typically ~8 blocks behind `latest`, then a block with ≥1 tx on endpoints that answered). No API keys. If a request required a key, the cell is **unverified** and filled from docs.

**Methods, in order:** `debug_traceBlockByNumber` with `{"tracer":"callTracer","timeout":"15s"}`, `trace_block`, `ots_getBlockTransactions` / `ots_getInternalOperations`. `eth_chainId` (or Solana `getHealth`) as liveness control.

---

## Aetherlay method allowlist

Issue #2247 cites `aetherlay/internal/server/server.go:410` and expects Aetherlay **not** to allowlist JSON-RPC methods.

That path is **not in this repository**. Evidence:

- `GET /repos/KeeperHub/keeperhub/contents/aetherlay?ref=staging` → **404**
- `GET .../contents/aetherlay/internal/server/server.go?ref=staging` → **404**
- Recursive git tree of `staging` contains **zero** paths matching `aetherlay/` or `server.go`

The only in-tree mention is a comment in `keeperhub-events/event-tracker/src/chains/provider-manager.ts` (Aetherlay Prometheus counters vs WebSocket tunnelling). That does not confirm or deny a JSON-RPC method allowlist.

**Conclusion from public evidence:** the no-allowlist claim is **maintainer-asserted**, not verified here. Whether production Aetherlay would pass `debug_*` / `trace_*` / `ots_*` through is out of scope of this tree.

---

## Recommendation (which chains are viable for trace triggers)

A negative result on the established EVM mainnets is the useful result.

**Viable on the tree-configured public defaults today**

| Chain | Why |
|---|---|
| Plasma mainnet (`9745`) | Official `https://rpc.plasma.to` served `debug_traceBlockByNumber`, `trace_block`, **and** `ots_*` without a key. 5-tx block: 63 KiB / 101 KiB / 7.5 KiB, 172–325 ms fetch. |
| Tempo mainnet (`4217`) | Official `https://rpc.tempo.xyz` served `debug_traceBlockByNumber` and `trace_block`. 1-tx block: 6.2 KiB / 3.7 KiB, ~70 ms. `ots_*` is `method not allowed`. |
| Plasma testnet, Tempo testnet | Same methods as their mainnets, small payloads. |
| Base Sepolia, BNB testnet, ETH Sepolia (`trace_block` on PublicNode), OP Sepolia (`trace_block` on PublicNode), Robinhood testnet (`debug_*` on dRPC) | Useful for developing a trigger, not a production coverage story. |

**Not viable on public defaults (the chains #2241 actually cares about)**

Ethereum, Base, Arbitrum, Polygon, BNB mainnet, OP mainnet, Avalanche, Robinhood mainnet, 0G official RPC, and both Solana networks. Exact refusal bodies differ (`method not found`, `rpc method is not whitelisted`, `rpc method is unsupported`, PublicNode archive-token gate, Ankr/1RPC key-or-quota gate, Robinhood 429) but the outcome is the same: **the last-resort upstreams do not give a keeper a full-block trace.**

0G's **fallback** `https://0g.drpc.org` did answer `debug_traceBlockByNumber` (15 KiB, 153 ms) without a key, while dRPC's Ethereum docs say debug/trace are paid-only. Treat that as chain-specific leakage, not a plan we can design around. `trace_block` on the same host failed to route.

**If production is Alchemy / Infura / QuickNode / Ankr** (unverified against `CHAIN_RPC_CONFIG`):

| Provider | Free / current public plan includes debug+trace? | Paid tier that does |
|---|---|---|
| Alchemy | **No.** Debug API and Trace API are ✗ on Free, ✓ on PAYG / Enterprise. | PAYG. `debug_traceBlockByNumber` = 40 CU; `trace_block` = 20 CU. |
| Infura | **No.** Trace API is "available to paying Infura customers." Core Free does not list Debug/Trace; Developer ($50/mo) does. | Developer+. `debug_traceBlockByNumber` = 1000 credits; `trace_block` = 300 credits. |
| QuickNode | **No, per 2026 comparison.** Trace and debug "accessible on all paid plans" at 2× credit rate. | Paid plans. |
| Ankr | **No.** Trace and Debug are ✗ on Public and Freemium, ✓ on Premium. | Premium PAYG (min $10) or Deal. |
| dRPC | **No** on Ethereum docs ("Available only on the paid tier"). Per-chain: Robinhood mainnet dRPC returned `method is not available on free plan`; Plasma dRPC `chain is not available on free plan`. | Paid. |

**Implication for #2241:** do not implement full-block trace triggers against `PUBLIC_RPCS` for ETH / Base / Arb / Polygon / BSC / OP / Avax. Scope is either (a) Plasma and Tempo, whose official public RPCs already trace, or (b) production keyed upstreams **after** a maintainer confirms the live `CHAIN_RPC_CONFIG` provider and that the billed plan includes Debug/Trace. Polling `callTracer` once per block is cheap in CU/credits where the method exists; the blocker is **access**, not unit price.

---

## Size and time bounds (only sourced numbers)

Measured `callTracer` / `trace_block` payloads in this survey ranged from **2 KiB to 3.6 MiB**, with fetch **53–325 ms**. `json.loads` of those bodies was **<1 ms** on the probe host; fetch dominates.

Provider-agnostic upper bounds, **not** measured here:

- Tatum: default (opcode) tracer on a busy BSC block can exceed **160 MiB** (their default cap) and they raised BSC mainnet to **512 MiB** because some blocks legitimately produce traces that large. `callTracer` "typically drop[s] by one to two orders of magnitude." Source: <https://docs.tatum.io/docs/evm-handling-response-is-too-big-32008-on-debug-trace-methods>
- Dwellir: "A full trace of a dense block can be hundreds of megabytes in size." Source: <https://www.dwellir.com/docs/ethereum/debug_traceBlockByNumber>

A keeper that used the default opcode tracer would hit those caps. `callTracer` is the method this survey used and the one #2241 should assume.

---

## Mainnets

| chain | primary upstream | fallback | trace methods exposed | pricing tier + free/public plan includes it? | typical / worst-case full-block trace size | approx fetch+parse | source URL |
|---|---|---|---|---|---|---|---|
| eth-mainnet `1` | `ethereum-rpc.publicnode.com` | `1rpc.io/eth` | **none** on public defaults. Primary: `debug_*` / `ots_*` → `-32601` method does not exist; `trace_block` → `-32602` "Archive requests require a personal token" (Allnodes). Fallback: `eth_chainId` already quota-limited (`-32001` upgrade at 1rpc.io). | PublicNode free RPC: no debug; `trace_block` is archive/token-gated. 1RPC public: quota-gated, trace **unverified** (could not live-probe). Alchemy/Infura/QuickNode/Ankr free plans: **no** (see provider table). | Not measured here (method refused). Cross-chain bound: Tatum 160 MiB opcode / `callTracer` 10–100× smaller. Closest live analogue: ETH Sepolia PublicNode `trace_block` **1.91 MiB** for a 185-tx block. | n/a on mainnet public defaults. Sepolia analogue: 155 ms fetch, parse <1 ms. | Probe error bodies; <https://www.allnodes.com/publicnode>; 1RPC `-32001`; <https://www.alchemy.com/docs/reference/pricing-plans.md>; <https://docs.infura.io/reference/ethereum/json-rpc-methods/trace-methods.md>; <https://www.ankr.com/docs/rpc-service/service-plans/>; Tatum size doc above |
| base-mainnet `8453` | `mainnet.base.org` | *(none in `CHAIN_CONFIG`)* | **none.** All four methods → `rpc method is unsupported` (`-32601`). | Official public RPC does not expose debug/trace/ots. Commercial free plans: **no**. | Not measured (refused). | n/a (refusal in 36–47 ms). | Probe; <https://www.alchemy.com/docs/reference/debug-api-quickstart> |
| arbitrum-mainnet `42161` | `arb1.arbitrum.io/rpc` | `rpc.ankr.com/arbitrum` | **none.** Primary: `-32601` method does not exist/is not available for all four. Fallback: `eth_chainId` → Ankr `-32000` "You must authenticate your request with an API key" — **unverified** without a key. Ankr docs: Trace/Debug are Premium-only. | Official public: no. Ankr public/Freemium: **no**. Ankr Premium: yes. | Not measured (refused). | n/a (primary refusal ~50–64 ms). | Probe; <https://www.ankr.com/docs/rpc-service/service-plans/> |
| polygon-mainnet `137` | `polygon-bor-rpc.publicnode.com` | `rpc.ankr.com/polygon` | **none.** Same shape as Arbitrum: PublicNode `-32601` for all four; Ankr fallback requires an API key. | PublicNode free: no. Ankr public: key required, Trace/Debug still Premium. | Not measured (refused). | n/a (~39–47 ms refusals). | Probe; Ankr service-plans |
| bsc-mainnet `56` | `bsc-dataseed.binance.org` | `rpc.ankr.com/bsc` | **none.** Primary: `-32002` "the resource debug_traceBlockByNumber / trace_block is not available"; `ots_*` `-32601`. Ankr fallback requires API key. | Official dataseed: no. Ankr public: no. | Not measured on mainnet. Tatum: BSC opcode traces can exceed **512 MiB**; `callTracer` 10–100× smaller. BNB **testnet** analogue: 778 KiB `callTracer` for 6 txs. | n/a on mainnet (~210–237 ms resource-unavailable). | Probe; <https://docs.tatum.io/docs/evm-handling-response-is-too-big-32008-on-debug-trace-methods> |
| op-mainnet `10` | `mainnet.optimism.io` | `optimism-rpc.publicnode.com` | **none.** Primary: `rpc method is not whitelisted` for all four. Fallback: `debug_*`/`ots_*` `-32601`; `trace_block` PublicNode archive-token gate (same Allnodes message as ETH mainnet). | Official public: allowlist excludes debug/trace. PublicNode: no debug; archive token for `trace_block`. | Not measured (refused). OP Sepolia PublicNode analogue: `trace_block` **1.7 KiB** for a 1-tx block. | n/a (primary ~256–279 ms whitelist refusal). | Probe; Allnodes token URL in error |
| avax-mainnet `43114` | `api.avax.network/ext/bc/C/rpc` | `avalanche-c-chain-rpc.publicnode.com` | **none.** Both: `-32601` method does not exist for all four. | Official + PublicNode: no. Commercial free: no. | Not measured (refused). | n/a (~37–89 ms). | Probe |
| tempo-mainnet `4217` | `rpc.tempo.xyz` | *(none)* | **`debug_traceBlockByNumber` and `trace_block`.** `ots_*` → `method not allowed`. | Official public RPC includes debug+trace. No API key. | Typical (1-tx block `0x240048a`): debug **6 237 B**, `trace_block` **3 705 B**. Empty blocks return `[]` (36 B). Worst-case not measured; Tatum/Dwellir bounds apply if Tempo ever carries dense blocks. | debug 74 ms; `trace_block` 72 ms; parse <1 ms. | Probe of `https://rpc.tempo.xyz` |
| plasma-mainnet `9745` | `rpc.plasma.to` | `plasma.drpc.org` | **Primary: `debug_traceBlockByNumber`, `trace_block`, and `ots_*`.** Fallback dRPC: `eth_chainId` → code 35 "chain is not available on free plan". | Official public RPC includes all three families. dRPC free: **no** (chain not on free plan). | Typical (5-tx block `0x1e02bde`): debug **62 749 B**, `trace_block` **101 311 B** (139 traces), `ots_getBlockTransactions` **7 572 B**. First sample (same order of magnitude): debug 60 763 B / trace 102 308 B. | debug 212 ms; `trace_block` 325 ms; ots 172 ms; parse <1 ms. | Probe of `https://rpc.plasma.to`; dRPC error body; <https://drpc.org/docs/ethereum-api/debugandtrace> |
| 0g-mainnet `16661` | `evmrpc.0g.ai` | `0g.drpc.org` | Official: **none** (`-32601` all four). Fallback dRPC: **`debug_traceBlockByNumber` yes**; `trace_block` "Can't route your request to suitable provider" (code 12); `ots_*` "method is not available". | Official public: no. dRPC Ethereum docs say paid-only; this unauthenticated `0g.drpc.org` call still returned a trace — **do not treat as a documented free plan.** | dRPC `callTracer` on 2-tx block `0x295d4c7`: **15 385 B**. | 153 ms fetch; parse <1 ms. Official refusals 537–686 ms. | Probe; <https://drpc.org/docs/ethereum-api/debugandtrace> |
| robinhood-mainnet `4663` | `rpc.mainnet.chain.robinhood.com` | `robinhood.drpc.org` | **none confirmed.** Primary: `debug_*`/`ots_getBlockTransactions` → HTTP 429; `trace_block`/`ots_getInternalOperations` `-32601`. Fallback dRPC: `debug_*`/`trace_block` → code 35 "method is not available on free plan"; `ots_*` "method is not available". (`rpc-config.ts` already warns both public endpoints rate-limit by empty results rather than errors.) | Official public: not a usable trace source (429 / method missing). dRPC free: **no**. | Not measured (429 / gated). Robinhood **testnet** dRPC analogue: 4 748 B `callTracer` for 3 txs. | n/a. Testnet analogue 60 ms. | Probe; `lib/rpc/rpc-config.ts` Robinhood comment; dRPC error body |
| solana-mainnet `101` | `api.mainnet-beta.solana.com` | *(none)* | **n/a.** Solana JSON-RPC has no `debug_trace*` / `trace_block` / `ots_*`. `getHealth` succeeded. | n/a | n/a | n/a | Probe; Solana JSON-RPC (not EVM) |

---

## Testnets

| chain | primary upstream | fallback | trace methods exposed | pricing tier + free/public plan includes it? | typical / worst-case full-block trace size | approx fetch+parse | source URL |
|---|---|---|---|---|---|---|---|
| eth-sepolia `11155111` | `ethereum-sepolia-rpc.publicnode.com` | *(none)* | **`trace_block` yes.** `debug_*` / `ots_*` `-32601`. Unlike ETH mainnet, Sepolia PublicNode did **not** demand an archive token for `trace_block`. | PublicNode free Sepolia: `trace_block` included in this probe; debug not. | 185-tx block `0xb15efb`: `trace_block` **1 905 937 B** (1 888 traces). | 155 ms fetch; parse <1 ms. | Probe of `https://ethereum-sepolia-rpc.publicnode.com` |
| base-testnet `84532` | `sepolia.base.org` | *(none)* | **`debug_traceBlockByNumber` yes.** `trace_block` / `ots_*` → `rpc method is unsupported`. Opposite of Base mainnet, which refused debug too. | Official public Sepolia RPC includes `callTracer`. | Typical (29-tx `0x2c2cb07`): **161 957 B**. Larger sample (first probe, `0x2c2ca9e`): **3 635 528 B**. | 61 ms / 302 ms fetch; parse <1 ms. | Probe of `https://sepolia.base.org` |
| tempo-testnet `42431` | `rpc.testnet.tempo.xyz` | *(none)* | **`debug_*` and `trace_block`.** `ots_*` `method not allowed`. | Official public, no key. | 4-tx `0x2015cd1`: debug **2 320 B**, `trace_block` **3 134 B**. | 55 / 53 ms. | Probe of `https://rpc.testnet.tempo.xyz` |
| bsc-testnet `97` | `bsc-testnet-rpc.publicnode.com` | `data-seed-prebsc-1-s1.bnbchain.org:8545` | **Split.** PublicNode: `trace_block` yes, debug/ots no. BNB seed: **`debug_traceBlockByNumber` yes**, `trace_block`/ots no. | Both public, no key. | PublicNode `trace_block` 4-tx: **556 331 B** (525 traces). BNB seed `callTracer` 6-tx: **778 302 B** (earlier 6-tx-class sample 785 743 B). | 166 ms / 191 ms (earlier debug sample 96 ms). | Probe of both URLs |
| polygon-amoy `80002` | `rpc-amoy.polygon.technology` | `polygon-amoy-bor-rpc.publicnode.com` | **none.** Primary: DNS NXDOMAIN (`No address associated with hostname`) — endpoint in the tree is currently unresolvable. Fallback PublicNode: `-32601` all four. | Primary dead. Fallback free: no traces. | n/a | n/a | Probe |
| arbitrum-sepolia `421614` | `sepolia-rollup.arbitrum.io/rpc` | `arbitrum-sepolia-rpc.publicnode.com` | **none.** `-32601` all four on both. | Official + PublicNode: no. | n/a | n/a (~35–56 ms). | Probe |
| op-sepolia `11155420` | `sepolia.optimism.io` | `optimism-sepolia-rpc.publicnode.com` | Official: **none** (`rpc method is not whitelisted`). PublicNode: **`trace_block` yes**; debug/ots no. | Official allowlisted against debug/trace. PublicNode free Sepolia: `trace_block` included here (no archive-token message, unlike OP mainnet). | 1-tx `0x2e10ca5`: `trace_block` **1 718 B**. Earlier sample 12 931 B. | 141 ms / 66 ms. | Probe |
| avax-fuji `43113` | `api.avax-test.network/ext/bc/C/rpc` | `avalanche-fuji-c-chain-rpc.publicnode.com` | **none.** `-32601` all four on both. | Official + PublicNode: no. | n/a | n/a | Probe |
| plasma-testnet `9746` | `testnet-rpc.plasma.to` | `9746.rpc.thirdweb.com` | **Primary: `debug_*`, `trace_block`, `ots_*`.** thirdweb fallback: debug/trace "Invalid method"; `ots_getBlockTransactions` answered (4 030 B). | Official public includes traces. thirdweb public: ots only, not a full-block debug/trace source. | 1-tx `0x1f1238b`: debug **6 485 B**, `trace_block` **3 959 B**, ots **2 924 B**. Empty-block samples returned 36 B `[]`. | 169–228 ms. | Probe |
| 0g-galileo `16602` | `evmrpc-testnet.0g.ai` | `16602.rpc.thirdweb.com` | **none.** Official `-32601` all four. thirdweb: "Invalid method" for debug/trace; ots `-32601`. | Official + thirdweb public: no. | n/a | n/a | Probe |
| robinhood-testnet `46630` | `rpc.testnet.chain.robinhood.com` | `robinhood-testnet.drpc.org` | Official: **none** (`-32601` all four). dRPC fallback: **`debug_traceBlockByNumber` yes**; `trace_block` temporary internal error (code 19) this run; ots "method is not available". | Official public: no. dRPC unauthenticated testnet served debug in this probe (unlike Robinhood mainnet dRPC, which gated it). | 3-tx `0x6ae66ae`: **4 748 B**. Earlier sample 2 515 B. | 60 ms. | Probe of `https://robinhood-testnet.drpc.org` |
| solana-devnet `103` | `api.devnet.solana.com` | *(none)* | **n/a** (Solana JSON-RPC). `getHealth` succeeded. | n/a | n/a | n/a | Probe |

---

## Commercial provider matrix (docs only, unverified against production)

Production may already be on one of these via `CHAIN_RPC_CONFIG`. None of these rows were live-probed: every hosted URL embeds an API key, which this survey does not use.

| Provider | Debug / Trace on free or current public plan? | Paid access | Per-call cost (docs) | Source |
|---|---|---|---|---|
| Alchemy | **No.** Feature table: Debug API ✗ Free, ✓ PAYG / Enterprise. Quickstart: "your Alchemy plan must be set to the pay as you go or enterprise tiers." | PAYG | `debug_traceBlockByNumber` 40 CU; `trace_block` 20 CU. Free pool 30M CU/mo does not unlock the API. | <https://www.alchemy.com/docs/reference/pricing-plans.md>, <https://www.alchemy.com/docs/reference/debug-api-quickstart>, <https://www.alchemy.com/docs/reference/compute-unit-costs> |
| Infura | **No.** "Trace API is an open beta feature, available to paying Infura customers." Pricing page: Debug/Trace listed under Developer ($50/mo), not Core Free. | Developer $50/mo, Team, Enterprise | `debug_traceBlockByNumber` 1000 credits; `trace_block` 300 credits. Core Free quota 3M credits/day would be plenty if the API were unlocked; it is not. | <https://docs.infura.io/reference/ethereum/json-rpc-methods/trace-methods.md>, <https://www.infura.io/pricing>, <https://docs.infura.io/get-started/pricing/credit-cost.md> |
| QuickNode | **No, per 2026 comparison.** "Trace and debug APIs … are accessible on all paid plans at 2× the standard credit rate." (A 2022 QuickNode blog said add-ons were removed and features sit on every plan, including Free; the 2026 source is the one used here.) | Paid plans | 2× credit multiplier for Trace & Debug. | <https://www.quicknode.com/blog/best-ethereum-rpc-providers-2026-a-full-comparison> |
| Ankr | **No.** Service-plans table: Trace ✗ / Debug ✗ on Public and Freemium; ✓ Premium. Freemium is free 200M credits/mo and still does not include Trace/Debug. | Premium PAYG (min $10) or Deal | 200 credits per EVM method on HTTPS (~$0.00002). | <https://www.ankr.com/docs/rpc-service/service-plans/> |
| dRPC | **No** on Ethereum docs. Live: mixed per chain (see tables). | Paid tier | Not used (no key). | <https://drpc.org/docs/ethereum-api/debugandtrace> |
| PublicNode / Allnodes | Free RPC: debug namespace not served on the endpoints in this tree. `trace_block` on ETH/OP **mainnet** demands a personal token; the same host on some **testnets** served `trace_block` without one. | Personal token / Allnodes plan | n/a | Probe error: "Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode" |
| 1RPC | Public ETH endpoint quota-limited this run (`-32001`). 1RPC is a privacy relay, not documented here as an archive/debug node. Trace **unverified**. | Keyed plans exist (error links `#pricing`) | n/a | Probe of `https://1rpc.io/eth`; <https://www.1rpc.io/> |

---

## Cells only a maintainer can fill

1. The live `CHAIN_RPC_CONFIG` JSON: provider + whether each chain's primary/fallback is keyed Alchemy, Infura, QuickNode, Ankr, dRPC, or something else.
2. Whether the billed plan on that provider is Free (no debug/trace at Alchemy/Infura/Ankr) or PAYG/Developer/Premium.
3. Whether Aetherlay in production allowlists JSON-RPC methods (`aetherlay/internal/server/server.go:410` is not in this repo).
4. Production WSS vs HTTP: this survey is HTTP POST only.

Until (1) and (2) are filled, #2241 should treat "works on all EVM mainnets" as **false** for public defaults and **unknown** for production.

---

## Method notes for #2241

- Prefer `debug_traceBlockByNumber` + `callTracer`. It is the method Alchemy documents for "traces executed in the block," it is what we measured, and it is 10–100× smaller than the opcode tracer (Tatum).
- `trace_block` (Parity/Erigon style) is a viable alternative where Geth debug is disabled but OpenEthereum-style tracing is on (ETH Sepolia PublicNode, BNB testnet PublicNode, OP Sepolia PublicNode, Plasma, Tempo). Response shape differs (`action`/`result` vs `callTracer` trees); a trigger would need both parsers or a single adapter.
- Otterscan `ots_*` was only a real full-block source on Plasma (`rpc.plasma.to` / `testnet-rpc.plasma.to`). Everywhere else it was `-32601` or `method not allowed`. Do not design the trigger around `ots_*` unless Plasma is the only target.
- Solana stays out of this design.
- Empty blocks return `[]` (36-byte JSON-RPC wrapper). A trigger must tolerate that; Tempo produces them often.

---

## Reproducing a cell

Unauthenticated, no key:

```bash
curl -sS -X POST "$RPC_URL" \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"debug_traceBlockByNumber","params":["0xLATEST_MINUS_8",{"tracer":"callTracer","timeout":"15s"}]}'
```

Replace the method with `trace_block` (single block-hex param) or `ots_getBlockTransactions` (`[blockHex, 0, 10]`).
