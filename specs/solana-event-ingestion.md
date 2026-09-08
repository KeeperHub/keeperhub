# Solana Event & Block Ingestion — Design Options

Status: design reference for the `keeperhub-events/solana-tracker` service (KEEP-987, absorbs KEEP-989 for
Solana). Captures every ingestion approach considered, with pros/cons, and the current EVM baseline for
contrast. All figures are measured (Alchemy mainnet/devnet, public RPC) unless noted.

## TL;DR

There is no single Solana RPC method equivalent to EVM's `eth_getLogs` (filtered **and** batched **and** returns
logs in one pull). So instead of one strategy we ship a **pluggable `BlockSource` adapter** and pick per chain:

| Approach | Filtered? | Batched? | Push/Pull | Serves block triggers | Provider needed | Best for |
|---|---|---|---|---|---|---|
| **EVM: `eth_getLogs`** (baseline) | Yes | Yes (≤500 addr) | Pull (per block) | via block-dispatcher | any EVM RPC | all EVM chains |
| **getBlock polling** | No | Yes (whole block) | Pull | **Yes** | any RPC (dedicated at scale) | low-volume chains; block triggers |
| **getSignaturesForAddress** | **Yes** | No (1/program) | Pull | No | any RPC | events, low/medium program count |
| **logsSubscribe** | Yes | No | Push | No | RPC w/ WS | low-latency events, few programs |
| **Geyser / gRPC** | **Yes** | **Yes** | **Push** | Yes | Helius/Triton (paid) | mainnet events at scale |

Recommendation: `getBlock` for low-volume chains and block triggers; `getSignaturesForAddress` for the
EVM-shape filtered event path; **Geyser for mainnet event triggers at scale**. Public RPC is unusable for any
of them.

---

## The current EVM standard (what we have today)

Two services, both EVM-only, both battle-tested.

### Event triggers — `keeperhub-events/event-tracker`
- One `ethers.WebSocketProvider` per chain subscribes to **`eth_subscribe("newHeads")`** — a block heartbeat.
- On each new block, one **`eth_getLogs`** call: `{ fromBlock, toBlock, address: [up to 500 contracts], topics: [[topic0s]] }`. The node returns **only the matching logs**; addresses are batched 500/call across all workflows on that chain.
- Match on `(address, topic0)` → decode via ABI (`iface.parseLog`) → dedup on `txHash` → phantom row + SQS → executor.
- Reconnect/backoff, ping/pong, block-staleness watchdog, primary↔fallback failover.

### Block triggers — `keeperhub-scheduler/block-dispatcher`
- Same `newHeads` subscription; fires a workflow when `blockNumber % blockInterval === 0`.
- Emits block **metadata only** (`blockNumber/blockHash/blockTimestamp/parentHash`) via `getBlock`.

### Why the EVM standard is cheap
`eth_getLogs` is the key: it is **server-side filtered** (by address + topic) **and batched** (many contracts in
one call) **and returns the logs directly** (no second fetch). Block size is irrelevant — you only ever receive
the matching logs. A full Tempo block via `eth_getLogs` is ~2 KB.

**Pros**
- Server-side filtered → tiny payloads (KB), independent of block size or chain activity.
- Batched → one call covers up to 500 contracts.
- Returns logs directly → no per-tx round-trip.
- Mature, reconnect/backfill hardened.

**Cons**
- EVM-only — there is no Solana equivalent (the entire reason this doc exists).
- Still a per-block query (not pure push), though cheap.
- Depends on the RPC honoring `eth_getLogs` ranges (some budget RPCs cap block ranges / result counts).

All 20 KeeperHub EVM chains (incl. **Tempo**, `chain_type=evm`) ride this path. Only the 2 Solana chains lack it.

---

## The Solana problem

Solana has **no `eth_getLogs`**. Measured:
- **Mainnet block:** ~1,216 txs, **~5 MB**, every ~400 ms; all txs carry `logMessages`.
- **Devnet block:** ~22–34 txs, ~50–95 KB.
- **Public RPC:** hard **429** (connection-rate limited); unusable for streaming.
- **Alchemy free tier, mainnet `getBlock`:** 429 from **CU exhaustion** (5 MB is a high-cost method; ~2.5/sec blows the per-second budget — 171 retries observed).

So every option below is a different trade between *filtered*, *batched*, *push vs pull*, and *provider cost*.

---

## Option 1 — `getBlock` polling (block-scan)

**Mechanism:** `slotSubscribe` (tick) → process to the confirmed tip → `getBlocks(from,tip)` to enumerate
produced slots → `getBlock(slot, full)` each → scan all txs, match watched programs client-side → decode →
dedup(signature) → SQS. `getBlock(none)` (header only) for block-only chains.

**Pros**
- **Serves BOTH event and block triggers** from one fetch (the only pull source that does).
- **Batched** — one `getBlock` covers every watched program; marginal cost of another program is a hash-set lookup.
- **Replayable / gap-free backfill** — re-fetch any slot by number.
- **No special provider** — works on any RPC that serves `getBlock`.
- Deterministic, ordered, simple mental model.

**Cons**
- **Not filtered** — downloads the whole block (~5 MB on mainnet), ~99% irrelevant to any one program.
- **`getBlock` is the most CU-expensive method** → free/shared tiers 429 (measured).
- **~1 TB/day egress** on mainnet; needs a **dedicated node (~$1–3k/mo)** to sustain — but a self-hosted Solana node is unjustified at our volume, see [Managed provider vs self-hosted node](#managed-provider-vs-self-hosted-node--use-managed).
- Client-side CPU to parse 5 MB every ~400 ms (fine in Node — ~20–30 ms — but real, and worse multi-chain).

**Verdict:** great for low-volume chains (devnet) and for **block triggers** (header-only is cheap). Wasteful and
expensive for high-activity mainnet event watching.

---

## Option 2 — `getSignaturesForAddress` (filtered per-program)

**Mechanism:** `slotSubscribe` (tick, like `newHeads`) → per watched program
`getSignaturesForAddress(program, {until: cursor})` (server-side filtered) → `getTransaction` per new signature
for its `logMessages` → decode → dedup → SQS. This is the **direct `eth_getLogs` analog** (and was KEEP-987's
first implementation).

**Pros**
- **Server-side filtered** — cheap (KB), independent of block size. The closest pull-based EVM parity.
- **Cursor = gap-free backfill.**
- **No special provider** — standard RPC.
- Simple; low CU on low/medium program counts.

**Cons**
- **Not batched** — one call *per watched program* (N programs → N calls/tick); doesn't amortize at high fan-out.
- **Two round-trips** — returns *signatures*, then a `getTransaction` per sig for the logs (extra latency + calls; `eth_getLogs` returns logs in one shot).
- **Event triggers only** — no block metadata, so no block-height triggers.
- At high program × tx volume, the N sig-queries + M tx-fetches pressure rate limits.

**Verdict:** the right "run Solana the same shape as EVM" choice for **event triggers at low/medium program
counts**. Cheap and simple; scales worse than Geyser.

---

## Option 3 — `logsSubscribe` (WebSocket push)

**Mechanism:** `connection.onLogs(programId, commitment)` → the node **pushes** matching program logs in
real time → decode → SQS.

**Pros**
- **Server-side filtered + real-time push** — lowest latency, no polling.
- Direct analog of EVM `eth_subscribe("logs")`.

**Cons**
- **Per-program subscription** — hits **provider subscription caps** at scale.
- **No backfill on reconnect** — events during a WS drop are lost unless you bolt on a `getSignaturesForAddress` catch-up.
- Volume **converges on the firehose** if you subscribe to many busy programs.
- Public RPC WSS is unreliable for `logsSubscribe`.
- Event triggers only.

**Verdict:** low-latency events for a *few* programs; the no-backfill + subscription-cap limits make it a weaker
choice than getSignaturesForAddress (pull, cursored) or Geyser (batched) for our "never miss a trigger" goal.

---

## Option 4 — Geyser / Yellowstone gRPC

**Mechanism:** open a persistent **gRPC** stream to a Geyser-enabled provider (Helius LaserStream / Triton /
Shyft) and subscribe with `blocks` (or `transactions`) + `account_include: [watched programs]`. The provider
runs the block-scan **server-side** and pushes back **only the matching transactions** plus block metadata. Map
each message to `NormalizedBlock` → the same matcher/decode/enqueue.

**Pros**
- **Filtered + batched + pushed** — the true `eth_getLogs` equivalent, and better (real-time push).
- **KB/s** (only matches) instead of ~1 TB/day firehose; no `getBlock` CU cost.
- **One stream, thousands of program filters** — the provider scans once and fans out.
- **Lowest latency**; can serve **block triggers** too (`blocks` / `blocks_meta` subscriptions).
- **Wire-compatible client.** `@triton-one/yellowstone-grpc` speaks the de-facto Dragonsmouth proto, so Chainstack / QuickNode / Triton / Helius are broadly the same client — switching provider is mostly an endpoint + auth-header change (see caveats).

**Cons**
- **Requires a Geyser provider** (paid: Helius/Triton/Shyft) — not available on plain RPC.
- **Different client** (`@triton-one/yellowstone-grpc`, protobuf) + dependency.
- **Replay is NOT intrinsic — it's a provider feature, not part of the base gRPC contract.** The stream is live-push; reconnect-with-slot-resume (`from_slot`) and historical replay vary by provider and tier: Helius **LaserStream** markets slot-resume/replay but that's their enhanced layer on the ~$499 tier, while budget tiers (Chainstack/Subglow) are largely plain live streams where a disconnect can drop the offline slots. So gap-free delivery must come from **our** cursor + backfill on reconnect, not the stream (see design constraint below).
- **Backpressure handling** — a slow consumer gets dropped; needs reconnect + replay-from-cursor.
- **"Endpoint flip" is ~80% true, not 100%.** Auth conventions differ (`x-token` metadata vs key-in-endpoint vs QuickNode's token path); Helius LaserStream is compatible-plus-extensions (its replay/enhanced fields don't port back to Chainstack); minor proto drift on commitment levels and the `from_slot` field. Budget a thin per-provider auth/capability shim and keep `GeyserSource` off any single provider's extensions if portability matters.

**Verdict:** **the mainnet answer.** The only Solana option that matches EVM's filtered+batched economics at
scale. Build it against the stock Yellowstone client so the provider stays a config choice, not a rebuild.

---

## The chosen design: a pluggable `BlockSource` adapter

Rather than commit to one method, `solana-tracker` puts ingestion behind a `BlockSource` interface
(`start/stop/getHealth` + `onBlock(NormalizedBlock)`). Every source produces the same `NormalizedBlock` (slot +
block metadata + `NormalizedTx[]`, where `programIds` come from the `Program <id> invoke` log lines), so the
**matcher → Anchor decode → dedup → phantom → SQS** pipeline is entirely source-agnostic.

- `GetBlockSource` — Option 1 (events + blocks; testnet default). **Live-verified.**
- `SignaturesSource` — Option 2 (filtered; events only, emits one-tx blocks). **Live-verified.**
- `CompositeSource` — runs two of the above for one chain (see below).
- `GeyserSource` — Option 4 (seam in place; provider-gated follow-up).

Selection is per chain, derived from the chain's own shape: a **mainnet** chain with event triggers defaults to
`signatures`, everything else to `getBlock`. `SOLANA_SOURCE_MODE` (`signatures` | `getblock`) overrides the
default on every chain, for incident response and for chains the default gets wrong (e.g. so many watched
programs that per-program queries cost more than one whole-block pull).

The default is mainnet-aware because `getBlock` on mainnet is not merely expensive, it is lossy: the source caps
catch-up at `MAX_BACKFILL_SLOTS` and skips the remainder, so a source that cannot keep up silently stops firing
triggers. Enabling the first mainnet event trigger on the previously idle prod pod (2026-08-11) drove exactly
this, alerting on >2x CPU request.

Because `signatures` cannot serve block triggers, a chain needing both runs a `CompositeSource`: the signatures
source for event triggers plus a header-only `getBlock` (`transactionDetails: "none"`) for block triggers. The
members serve disjoint trigger sets, so no workflow double-fires. Reverting the whole chain to `getBlock`
instead — the earlier behaviour — would put event matching back on the full-block firehose.

`SignaturesSource` polling is floored by `SOLANA_SIGNATURES_POLL_INTERVAL_MS` (default 2000). The slot tick is
only a wake-up; honouring every tick issues one query per program roughly as fast as RPC latency allows, which
at the metering below is a large sustained bill for latency that SQS and the executor dwarf anyway.

## Recommendation matrix

| Scenario | Source |
|---|---|
| Devnet / low-volume chain, events | `getBlock` or `signatures` (both cheap) |
| Any chain, **block triggers** | `getBlock` (`transactionDetails:"none"` — header only) |
| Mainnet events, few programs | `signatures` (filtered, no special provider) |
| **Mainnet events at scale** | **Geyser** (filtered + batched + pushed) |
| Anything on public RPC | none — public RPC 429s; use a real provider |

## Cost, rate limits & when to adopt Geyser

Provider pricing snapshot, **July 2026 — verify before committing** (pricing shifts). The headline: Geyser is
**not** ~$1k/mo — its floor is ~$49–99/mo — and on mainnet `getBlock` polling is the *expensive* path, not Geyser.

### Standard RPC tiers (for `getBlock` / `getSignaturesForAddress`)

| Provider | Entry paid | Mid | High | Metering |
|---|---|---|---|---|
| **Alchemy** | $0 free (30M CU/mo, **500 CUPS**) | pay-go $0.45/1M CU | Enterprise (20K+ CUPS, 700+ RPS) | Compute Units + CUPS (throughput) |
| **QuickNode** | Build $49 (80M cr, 50 RPS) | Accelerate $249 (125 RPS) · Scale $499 (250 RPS) | Business $999 (500 RPS) | 30 cr/call, Solana ×1.5, **+10 cr / 0.1 MB response** |
| **Helius** | Developer $49 (50 RPS) | Business $499 (200 RPS) | Professional $999 (500 RPS) | credits; streaming 20 cr/MB (~$100/TB) |

### Geyser / gRPC streaming (the mainnet event answer)

| Provider | Price | Streams | Notes |
|---|---|---|---|
| **Chainstack** | **$49/mo** (2) · $149 (7) · $449 (25) | ~$18–25/stream | budget; needs a Global Node plan |
| **Subglow** | **$99/mo flat** | — | budget gRPC |
| **Solana Tracker** | ~€200/mo | — | mid |
| **Helius LaserStream** | **$499/mo** (Business; mainnet gRPC, 10 concurrent) | devnet gRPC from $49 | reputable, low-latency |
| **QuickNode** | **$499/mo** (Scale — gRPC *included*) | 5 Solana streams | or Build $49 + add-on |
| **Triton (Dragon's Mouth)** | **~$2,900/mo** dedicated | — | HFT-grade, ~100 ms |

### Cost per source for our mainnet chain (101), one stream/handful of programs

| Source | Realistic tier | ~Cost/mo | Why |
|---|---|---|---|
| `getSignaturesForAddress` | QuickNode Build $49 / Accelerate $249 | **$49–249** | small filtered responses |
| **Geyser** (1 filtered stream) | Chainstack $49 / Subglow $99 / Helius $499 | **$49–499** | filtered egress (KB/s) fits low tiers |
| `getBlock` (5 MB firehose) | QuickNode Business $999 / dedicated node ([not our path](#managed-provider-vs-self-hosted-node--use-managed)) | **$1k–3k** | see math below |

**Why `getBlock` is the expensive one (quantified):** QuickNode bills response size at +10 cr/0.1 MB, so a 5 MB
mainnet block ≈ **~500 credits**. At ~2.5 blocks/s that is ~108 M cr/day ≈ **~3.2 B/mo** → needs **Business $999**
(2 B credits) plus overage, or a dedicated node. On Alchemy it simply exhausts the 500-CUPS throughput (what we
observed). Devnet (~50–95 KB blocks) is trivial on any cheap tier.

### Managed provider vs self-hosted node — use managed

For our footprint (**one** mainnet chain + a near-idle devnet), a managed provider wins decisively; self-hosting
a Solana RPC node is the wrong tool.

- **Self-hosted RPC is heavy.** To answer `getSignaturesForAddress` / `getProgramAccounts` a node keeps the
  account + secondary indexes in RAM: **256 GB is the floor, 512 GB the realistic target**, on fast NVMe with
  high provisioned IOPS → **~$2–4k/mo on AWS** (optimistic once IOPS + egress are counted). Add snapshot
  management, crash-restarts, and version upgrades tracking cluster releases on a schedule you don't control — a
  standing part-time ops burden. And a single node is a **SPOF** unless you run two, doubling it.
- **Managed filtered Geyser is far cheaper here ($49–499/mo)** because you pay only for matched egress (KB/s),
  not the whole 5 MB firehose, and get failover from the provider. (Replay is tier-dependent — see the Geyser
  cons; do not assume it.)
- **The self-host case only turns positive at sustained high volume** where per-call metering exceeds a node's
  fixed cost and unmetered `getBlock`/`getProgramAccounts` + no vendor lock start to matter. We are nowhere near
  that and won't be for a long time.

**Adopted plan:**
- **Phase 1 (now):** a cheap paid standard RPC (~$49) — `getSignaturesForAddress` for events, `getBlock`
  (`transactionDetails:"none"`) for block triggers. No Geyser, no node.
- **Phase 2 (only if volume grows):** managed Geyser, built against the stock `@triton-one/yellowstone-grpc`
  client so provider choice (Chainstack / QuickNode / Triton / Helius) stays an endpoint + key config flip.
- Self-hosting is explicitly **not** on the path.

### Takeaways

1. **Geyser's floor (~$49–99/mo, Chainstack/Subglow) can undercut `getBlock` on mainnet** and is filtered +
   batched. "Geyser is expensive" only applies to HFT-grade providers (Triton ~$2,900) — which a trigger system
   does not need.
2. **`signatures` is the cheap default for mainnet events** ($49–249) until program fan-out pressures RPC limits.
3. **Avoid `getBlock` on mainnet for events** — it's the priciest path (5 MB responses eat credits/CU). Keep it
   for devnet/low-volume and for block triggers (`transactionDetails:"none"`, cheap).
4. **Bounded to one chain** — only mainnet (101) needs any of this; devnet (103) is trivial.
5. Budget gRPC (Chainstack/Subglow) trades some latency/reliability vs Helius/Triton — fine for triggers, not HFT.
6. **Managed, not self-hosted** — a $2–4k/mo + ops Solana node is unjustified at our volume; a managed provider is cheaper and gives failover for free.

### Design constraint — gap-free delivery is ours, not the stream's

Because replay is a provider/tier feature (not part of the gRPC contract), **`GeyserSource` must reuse the same
cursor + backfill-on-reconnect** that `GetBlockSource` and `SignaturesSource` already implement — on reconnect,
reconcile the missed slot range via `getBlocks` / `getSignaturesForAddress` rather than trusting the stream to
have replayed. This keeps "never miss a trigger" true across the budget-to-premium range, and keeps the
"endpoint flip" promise honest — a `GeyserSource` that depends on Helius replay isn't portable to Chainstack.

Because ingestion is the `BlockSource` adapter, switching source/provider is a **per-chain config flip**
(`sourceMode` / `geyserEndpoint`), not a rebuild — start on `signatures` or budget Geyser and only move up on
observed rate-limit pressure.

Sources: [Helius pricing](https://www.helius.dev/pricing) · [QuickNode pricing](https://www.quicknode.com/pricing) ·
[QuickNode gRPC on Scale/Business](https://blog.quicknode.com/solana-grpc-is-now-included-with-scale-and-business-plans/) ·
[Triton pricing](https://triton.one/pricing) · [Alchemy pricing](https://www.alchemy.com/pricing) ·
[Chainstack Yellowstone gRPC](https://chainstack.com/marketplace/yellowstone-grpc-geyser-plugin/) ·
[Subglow vs Helius](https://subglow.io/subglow-vs-helius) (all July 2026).

## Cross-cutting notes

- **Executor** is unchanged for all options — it consumes `triggerType:"event"`/`"block"` and spreads `triggerData`.
- **Busy-program floods:** watching a hot program (e.g. the Token program, ~150 tx/block on mainnet) fires on every tx regardless of source. Real workflows watch a specific program + `eventName`; add a per-workflow ingestor-side rate cap and scale executor replicas (SQS decouples producer/consumer).
- **Commitment discipline:** `slotSubscribe` delivers *processed* slots; reads run at *confirmed*. Process to the confirmed tip, not the subscribed slot, or the cursor races past unfetchable blocks.
