#!/usr/bin/env node
/**
 * trace-method-probe — regenerable trace-method availability probe
 *
 * The survey answering #2247 is #2273. This is the tool that keeps that table
 * checkable: re-run it and the numbers are re-derived from live endpoints
 * rather than trusted from a one-shot run.
 *
 * Why that matters concretely: trace size scales with a block's internal call
 * depth, not its transaction count, so two probes of the same chain and the
 * same tx count can differ several-fold. #2273 measured a 5-tx plasma-mainnet
 * block at 63 KiB / 101 KiB; this tool measured a different 5-tx block on the
 * same chain at 348 KB / 562 KB. Both are correct. A single block therefore
 * under-determines the cost envelope #2241 needs, and re-running is the cheap
 * way to bound it.
 *
 * Reports, per chain in `lib/rpc/rpc-config.ts`:
 *   1. which trace methods the endpoint actually answers
 *   2. response size (raw + gzipped) for one block's traces
 *   3. fetch and parse time
 *
 * Three design rules, because the survey is only worth what it can be trusted on:
 *
 *   REGENERABLE — the chain list is parsed out of `rpc-config.ts` at run time,
 *   never hand-typed. The config drifts (it gained plasma/0g/robinhood since
 *   #2239 was written); a hand-copied table would silently go stale.
 *
 *   HONEST — we record the exact error body and classify from it. "method not
 *   found", a 401 tier gate and a timeout are three different findings and the
 *   distinction is most of the value here. Nothing is inferred from a docs page.
 *
 *   POLITE — these are free third-party endpoints. Strictly sequential, one
 *   delay between every request, tiny sample. We are surveying capability, not
 *   load-testing someone's public infrastructure.
 *
 * Usage:
 *   node scripts/trace-method-probe.mjs                        # all chains, live-fetch the config
 *   node scripts/trace-method-probe.mjs --only 1,8453          # just these chain ids
 *   node scripts/trace-method-probe.mjs --mainnets             # skip testnets
 *   node scripts/trace-method-probe.mjs --config ./rpc.ts      # use a local rpc-config.ts
 *   node scripts/trace-method-probe.mjs --dry-run              # resolve targets, make no requests
 *   node scripts/trace-method-probe.mjs --out ./results        # output directory (default ./out)
 *
 * Writes results.json (full raw record) and report.md (the table).
 * No dependencies. Node 20+.
 */

import { gzipSync } from "node:zlib";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const CONFIG_URL =
  "https://raw.githubusercontent.com/KeeperHub/keeperhub/staging/lib/rpc/rpc-config.ts";

// Politeness + safety limits.
const REQUEST_DELAY_MS = 750; // between every request, including retries
const REQUEST_TIMEOUT_MS = 45_000; // a full-block trace is legitimately slow
const LIVENESS_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 96 * 1024 * 1024; // guard; record truncation if hit
const BLOCKS_BEHIND_HEAD = 5; // avoid an unfinalised head being reorged mid-probe
const BLOCK_SCAN_LIMIT = 12; // how far back to look for a block with transactions

/** Solana chain ids in CHAIN_CONFIG. No `debug_trace*`; recorded N/A, not dropped. */
const SOLANA_CHAIN_IDS = new Set([101, 103]);

/** Known testnet chain ids, so --mainnets can filter without guessing from names. */
const TESTNET_CHAIN_IDS = new Set([
  11155111, 84532, 421614, 80002, 97, 11155420, 43113, 42431, 9746, 16602,
  46630, 103,
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 1. Resolve targets from rpc-config.ts
// ---------------------------------------------------------------------------

/**
 * Parse PUBLIC_RPCS and CHAIN_CONFIG out of rpc-config.ts.
 *
 * Regex over TypeScript is fragile, so this asserts on the shape it found and
 * throws rather than silently surveying half the config. A loud failure here is
 * the correct outcome if upstream restructures the file.
 */
export function parseChainConfig(source) {
  const publicBlock = source.match(
    /export const PUBLIC_RPCS\s*=\s*\{([\s\S]*?)\n\};/,
  );
  if (!publicBlock) {
    throw new Error("PUBLIC_RPCS block not found — rpc-config.ts shape changed");
  }
  const urls = new Map();
  for (const m of publicBlock[1].matchAll(
    /^\s*([A-Z0-9_]+):\s*"([^"]+)"/gm,
  )) {
    urls.set(m[1], m[2]);
  }

  const chainBlock = source.match(
    /export const CHAIN_CONFIG:[^=]*=\s*\{([\s\S]*?)\n\};/,
  );
  if (!chainBlock) {
    throw new Error("CHAIN_CONFIG block not found — rpc-config.ts shape changed");
  }

  const chains = [];
  const entryRe = /^ {2}(\d+):\s*\{([\s\S]*?)^ {2}\},/gm;
  for (const m of chainBlock[1].matchAll(entryRe)) {
    const chainId = Number(m[1]);
    const body = m[2];
    const pick = (field) => {
      const hit = body.match(
        new RegExp(`${field}:\\s*PUBLIC_RPCS\\.([A-Z0-9_]+)`),
      );
      return hit ? { key: hit[1], url: urls.get(hit[1]) } : null;
    };
    chains.push({
      chainId,
      jsonKey: body.match(/jsonKey:\s*"([^"]+)"/)?.[1] ?? `chain-${chainId}`,
      primary: pick("publicDefault"),
      fallback: pick("publicFallback"),
      chainType: SOLANA_CHAIN_IDS.has(chainId) ? "solana" : "evm",
      isTestnet: TESTNET_CHAIN_IDS.has(chainId),
    });
  }

  if (chains.length === 0) {
    throw new Error("CHAIN_CONFIG parsed to zero entries — shape changed");
  }
  const missing = chains.filter((c) => !c.primary?.url);
  if (missing.length) {
    throw new Error(
      `no publicDefault URL resolved for: ${missing.map((c) => c.jsonKey).join(", ")}`,
    );
  }

  // CHAIN_CONFIG carries no isTestnet field (it exists only in the operator
  // JSON shape), so TESTNET_CHAIN_IDS is hand-maintained — which makes it the
  // one thing here that can silently drift. Cross-check it against the naming
  // convention and warn loudly rather than quietly mislabel a new chain.
  const looksTestnet = /sepolia|testnet|devnet|fuji|amoy|galileo|goerli|holesky/i;
  for (const c of chains) {
    const byName = looksTestnet.test(c.jsonKey);
    if (byName !== c.isTestnet) {
      process.stderr.write(
        `WARN: ${c.jsonKey} (${c.chainId}) — name says ${byName ? "testnet" : "mainnet"}, ` +
          `TESTNET_CHAIN_IDS says ${c.isTestnet ? "testnet" : "mainnet"}. Update the set.\n`,
      );
    }
  }
  return chains;
}

async function loadConfig(path) {
  if (path) return readFile(path, "utf8");
  const res = await fetch(CONFIG_URL);
  if (!res.ok) {
    throw new Error(`fetching rpc-config.ts: HTTP ${res.status}`);
  }
  return res.text();
}

// ---------------------------------------------------------------------------
// 2. JSON-RPC transport
// ---------------------------------------------------------------------------

/**
 * One JSON-RPC call. Never throws for a protocol-level failure — a refusal is a
 * result, not an error, and the survey needs the exact body either way.
 */
async function rpc(url, method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const started = performance.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ac.signal,
    });

    // Read through the stream with a hard cap rather than res.arrayBuffer():
    // a full-block trace can be enormous, and buffering it whole before
    // checking the size would let one pathological chain OOM the survey.
    // `bytesSeen` counts everything that arrived, including the chunk that
    // tripped the cap, so the size finding stays truthful when truncated.
    const chunks = [];
    let bytesSeen = 0;
    let truncated = false;
    for await (const chunk of res.body ?? []) {
      bytesSeen += chunk.length;
      if (bytesSeen > MAX_RESPONSE_BYTES) {
        truncated = true;
        break;
      }
      chunks.push(chunk);
    }
    // Cancel rather than abort: aborting the controller mid-read surfaces as an
    // AbortError in the catch below and would be misreported as a timeout.
    if (truncated) await res.body?.cancel().catch(() => {});

    const buf = Buffer.concat(chunks);
    const fetchMs = performance.now() - started;
    const text = buf.toString("utf8");

    // A truncated body cannot be parsed, and reporting that as a malformed
    // response would be wrong — the endpoint answered, the answer was just
    // bigger than we are willing to hold. Size is scope item 3, so this is a
    // result, not a failure.
    const parseStarted = performance.now();
    let body = null;
    let parseError = null;
    if (!truncated) {
      try {
        body = JSON.parse(text);
      } catch (err) {
        parseError = err.message;
      }
    }
    const parseMs = performance.now() - parseStarted;

    return {
      httpStatus: res.status,
      bytesRaw: bytesSeen,
      bytesGzip: buf.length ? gzipSync(buf).length : 0,
      fetchMs: Math.round(fetchMs),
      parseMs: Math.round(parseMs),
      truncated,
      body,
      parseError,
      // Kept verbatim and short: this is the evidence, not a summary of it.
      rawSnippet: text.slice(0, 400),
    };
  } catch (err) {
    return {
      transportError: err.name === "AbortError" ? "timeout" : err.message,
      fetchMs: Math.round(performance.now() - started),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** A refusal that payment or credentials would lift. */
const TIER_PATTERNS = [
  /api[ -]?key/,
  /upgrade/,
  /\bpaid\b/,
  /\bplan\b/,
  /\btier\b/,
  /subscription/,
  /not authori[sz]ed|unauthori[sz]ed/,
  /forbidden/,
  /access denied/,
  /sign ?up|register/,
  // "Archive requests require a personal token" (publicnode/allnodes) — the
  // word "token" only reads as auth in a "requires ..." construction, which is
  // why this is a phrase pattern and not a bare /token/.
  /requires? (a |an )?[\w ]*\b(token|key|account|credential)/,
];

/** A refusal no amount of money lifts on this endpoint. */
const NOT_SUPPORTED_PATTERNS = [
  /does not exist/,
  /not found/,
  /unsupported|not supported/,
  /not available|unavailable/,
  /disabled|not enabled/,
  // 1rpc.io answers `-32600 "Method trace_block not allowed"` — code -32600 is
  // "invalid request", so without this the verdict falls through to the
  // catch-all `error` and a plain absence looks unclassified. Observed on the
  // eth-mainnet fallback; tempo says the same thing but with -32601.
  /not allowed|not permitted/,
];

/**
 * Failures that say "ask again" rather than "no". A survey that records a
 * transient blip as a capability finding is simply wrong, so these get one
 * retry before being believed.
 */
const RETRYABLE = new Set([
  "timeout",
  "transport-error",
  "server-error",
  "rate-limited",
]);
const RETRYABLE_MESSAGE = /temporary|please retry|try again|internal error/i;

function shouldRetry(status, message) {
  return (
    RETRYABLE.has(status) ||
    (status === "error" && RETRYABLE_MESSAGE.test(String(message ?? "")))
  );
}

/**
 * Classify one probe result into the categories the issue actually cares about.
 *
 * PRECEDENCE: a structured JSON-RPC error outranks the HTTP status.
 *
 * That ordering is load-bearing and was wrong in the first draft. Base's public
 * endpoint answers an unsupported method with **HTTP 403** and a body of
 * `-32601 "rpc method is unsupported"` — reading the 403 first labels it
 * `tier-gated`, i.e. "traces are purchasable on Base", when in fact the method
 * is simply absent. Ethereum's publicnode endpoint answers `trace_block` with
 * HTTP 403 too, but a body of `-32602 "Archive requests require a personal
 * token"` — a real gate. Same status, opposite findings; only the body
 * separates them.
 *
 * Both httpStatus and errorCode are kept in results.json so a reader can
 * re-judge any call this makes.
 */
export function classify(r) {
  if (r.transportError) {
    return r.transportError === "timeout" ? "timeout" : "transport-error";
  }
  // Before the HTTP branches: the endpoint did answer, and "the answer exceeded
  // our cap" is a finding about size, not about availability.
  if (r.truncated) return "too-large";

  const err = r.body?.error;
  if (err) {
    const msg = String(err.message ?? "").toLowerCase();
    // Tier first: "not available on the free plan" matches both vocabularies,
    // and calling that "never implemented" is the costliest error here.
    if (TIER_PATTERNS.some((p) => p.test(msg))) return "tier-gated";
    if (err.code === -32601) return "method-not-found";
    if (err.code === -32005 || /rate limit|too many/.test(msg)) {
      return "rate-limited";
    }
    if (NOT_SUPPORTED_PATTERNS.some((p) => p.test(msg))) {
      return "method-not-found";
    }
    // No structured signal in the body; fall back to the status.
    if (r.httpStatus === 401 || r.httpStatus === 403) return "tier-gated";
    if (r.httpStatus === 429) return "rate-limited";
    return "error";
  }

  if (r.httpStatus === 401 || r.httpStatus === 403) return "tier-gated";
  if (r.httpStatus === 429) return "rate-limited";
  if (r.httpStatus >= 500) return "server-error";

  // A body that would not parse is still evidence. 1rpc.io refuses non-core
  // methods with HTTP 401 and the plain-text line "Only core evm requests are
  // allowed." — no JSON at all. Bailing to invalid-response on the parse
  // failure alone (as the first draft did, before the status checks above)
  // reported a clear policy refusal as a malformed response. The status is
  // consulted first; the raw text is the last resort.
  if (r.parseError) {
    const raw = String(r.rawSnippet ?? "").toLowerCase();
    if (TIER_PATTERNS.some((p) => p.test(raw))) return "tier-gated";
    if (NOT_SUPPORTED_PATTERNS.some((p) => p.test(raw))) return "method-not-found";
    return "invalid-response";
  }

  if (r.body && "result" in r.body) {
    if (r.body.result === null) return "null-result";
    // An empty array means the method is supported but this block had nothing
    // to trace. Worth separating: it answers "is it available?" but carries no
    // usable size or timing data, and reporting it as a 36-byte trace would
    // understate cost by orders of magnitude.
    if (Array.isArray(r.body.result) && r.body.result.length === 0) {
      return "ok-empty";
    }
    return "ok";
  }
  return "invalid-response";
}

// ---------------------------------------------------------------------------
// 3. Probe one endpoint
// ---------------------------------------------------------------------------

const TRACE_METHODS = [
  {
    name: "debug_traceBlockByNumber",
    params: (hex) => [hex, { tracer: "callTracer" }],
  },
  { name: "trace_block", params: (hex) => [hex] },
  // Otterscan takes a decimal block number, a page index and a page size.
  { name: "ots_getBlockTransactions", params: (hex, n) => [n, 0, 25] },
];

async function probeEvmEndpoint(label, url, expectedChainId) {
  const record = { label, url, methods: {} };

  // Liveness control. Distinguishes "this method is refused" from "this
  // endpoint is dead", which is the whole reason the control exists.
  const live = await rpc(url, "eth_chainId", [], LIVENESS_TIMEOUT_MS);
  const liveClass = classify(live);
  record.liveness = {
    status: liveClass,
    httpStatus: live.httpStatus,
    fetchMs: live.fetchMs,
    error: live.transportError ?? live.body?.error?.message ?? null,
  };

  if (liveClass !== "ok") {
    record.skipped = `endpoint not live (${liveClass})`;
    return record;
  }

  // Verifying the endpoint is the chain the config claims. A mismatch here is
  // a finding in its own right, independent of trace support.
  const actualChainId = Number(live.body.result);
  record.chainIdReported = actualChainId;
  record.chainIdMatches = actualChainId === expectedChainId;

  await sleep(REQUEST_DELAY_MS);

  const head = await rpc(url, "eth_blockNumber", [], LIVENESS_TIMEOUT_MS);
  if (classify(head) !== "ok") {
    record.skipped = "eth_blockNumber failed; no block to trace";
    return record;
  }
  // Trace an block that actually has transactions in it. A quiet chain serves
  // empty blocks, and "148 KB on plasma vs 36 bytes on tempo" would compare a
  // real block against an empty one — the size column is scope item 3, so the
  // sample has to be comparable or the whole table misleads.
  let blockNum = Number(head.body.result) - BLOCKS_BEHIND_HEAD;
  let txCount = 0;
  let scanned = 0;
  for (; scanned < BLOCK_SCAN_LIMIT; scanned++) {
    await sleep(REQUEST_DELAY_MS);
    const b = await rpc(
      url,
      "eth_getBlockByNumber",
      [`0x${blockNum.toString(16)}`, false],
      LIVENESS_TIMEOUT_MS,
    );
    if (classify(b) !== "ok") break;
    txCount = b.body.result?.transactions?.length ?? 0;
    if (txCount > 0) break;
    blockNum -= 1;
  }
  const blockHex = `0x${blockNum.toString(16)}`;
  record.block = {
    number: blockNum,
    hex: blockHex,
    txCount,
    blocksScanned: scanned + 1,
    empty: txCount === 0,
  };
  if (txCount === 0) {
    process.stderr.write(
      `    (no non-empty block within ${BLOCK_SCAN_LIMIT}; sizes will not be comparable)\n`,
    );
  }

  for (const m of TRACE_METHODS) {
    await sleep(REQUEST_DELAY_MS);
    let r = await rpc(url, m.name, m.params(blockHex, blockNum));
    let status = classify(r);
    let retried = false;

    // One retry, only for failures that describe themselves as transient.
    // Observed: robinhood-testnet's fallback answered `code 19 "Temporary
    // internal error. Please retry"` — recording that as a capability verdict
    // would put a blip in the survey and make the run irreproducible.
    if (shouldRetry(status, r.body?.error?.message ?? r.transportError)) {
      await sleep(REQUEST_DELAY_MS * 4);
      const again = await rpc(url, m.name, m.params(blockHex, blockNum));
      retried = true;
      process.stderr.write(`    ${m.name}: ${status} → retry\n`);
      r = again;
      status = classify(again);
    }

    record.methods[m.name] = {
      retried,
      status,
      httpStatus: r.httpStatus ?? null,
      bytesRaw: r.bytesRaw ?? null,
      bytesGzip: r.bytesGzip ?? null,
      fetchMs: r.fetchMs ?? null,
      parseMs: r.parseMs ?? null,
      truncated: r.truncated ?? false,
      resultCount: Array.isArray(r.body?.result) ? r.body.result.length : null,
      errorCode: r.body?.error?.code ?? null,
      errorMessage: r.body?.error?.message ?? r.transportError ?? null,
      rawSnippet: status === "ok" ? null : (r.rawSnippet ?? null),
    };
    process.stderr.write(`    ${m.name}: ${status}\n`);
  }
  return record;
}

async function probeSolanaEndpoint(label, url) {
  const record = { label, url, methods: {}, note: "solana: no debug_trace*" };
  const live = await rpc(url, "getVersion", [], LIVENESS_TIMEOUT_MS);
  const liveClass = classify(live);
  record.liveness = {
    status: liveClass,
    httpStatus: live.httpStatus,
    fetchMs: live.fetchMs,
    error: live.transportError ?? live.body?.error?.message ?? null,
  };
  for (const m of TRACE_METHODS) {
    record.methods[m.name] = { status: "n/a", note: "non-EVM chain" };
  }
  return record;
}

// ---------------------------------------------------------------------------
// 4. Report
// ---------------------------------------------------------------------------

const kb = (n) =>
  n == null ? "—" : n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
const ms = (n) => (n == null ? "—" : `${n} ms`);

const MARK = {
  ok: "✅",
  "ok-empty": "☑️",
  "too-large": "📦",
  "method-not-found": "❌",
  "tier-gated": "🔒",
  "rate-limited": "⏳",
  timeout: "⌛",
  "transport-error": "💥",
  "server-error": "💥",
  "invalid-response": "⚠️",
  "null-result": "∅",
  error: "⚠️",
  "n/a": "—",
};
const mark = (s) => `${MARK[s] ?? "?"} ${s}`;

/**
 * The headline the issue actually asks for: which chains are trace triggers
 * viable on. Computed, not written by hand, so it cannot drift from the table.
 */
function summarise(results) {
  const supported = new Set();
  const gated = new Set();
  for (const c of results) {
    for (const p of c.endpoints) {
      for (const m of Object.values(p.methods ?? {})) {
        if (m.status === "ok" || m.status === "ok-empty") supported.add(c.jsonKey);
        if (m.status === "tier-gated") gated.add(c.jsonKey);
      }
      if (p.skipped && p.liveness?.status === "tier-gated") gated.add(c.jsonKey);
    }
  }
  const evmMainnets = results.filter(
    (c) => c.chainType === "evm" && !c.isTestnet,
  );
  const okMainnets = evmMainnets.filter((c) => supported.has(c.jsonKey));
  const L = ["## Headline", ""];
  L.push(
    `**${okMainnets.length} of ${evmMainnets.length} EVM mainnets** serve any trace method on their \`PUBLIC_RPCS\` endpoints: ` +
      (okMainnets.length
        ? okMainnets.map((c) => `\`${c.jsonKey}\``).join(", ")
        : "none") +
      ".",
  );
  L.push("");
  L.push(
    `Chains where at least one endpoint refused for credentials or plan (i.e. potentially purchasable): ` +
      (gated.size ? [...gated].map((k) => `\`${k}\``).join(", ") : "none") +
      ".",
  );
  L.push("");
  L.push(
    "**Read this as a lower bound on production, not a verdict on it.** These are the last-resort public defaults, which is what a self-hosted install runs on; the production `CHAIN_RPC_CONFIG` upstreams are not reachable from here and may be paid tiers that do serve traces.",
  );
  return L.join("\n");
}

function buildReport(results, meta) {
  const L = [];
  L.push("# Trace-method availability across configured chain upstreams");
  L.push("");
  L.push(`Survey for #2247. Generated by \`scripts/trace-probe/probe.mjs\`.`);
  L.push("");
  L.push(`- **Run at:** ${meta.startedAt}`);
  L.push(`- **Config source:** ${meta.configSource}`);
  L.push(
    `- **Chains probed:** ${results.length} of ${meta.totalChains} in \`CHAIN_CONFIG\``,
  );
  L.push(
    `- **Endpoints:** \`PUBLIC_RPCS\` defaults only — production \`CHAIN_RPC_CONFIG\` upstreams are in AWS Parameter Store and not reachable from here.`,
  );
  L.push(
    `- **Sampling:** one block per endpoint, walked back up to ${meta.limits.BLOCK_SCAN_LIMIT} blocks to find one with transactions. Sizes scale with transaction count, so compare the Txs column alongside them. A quiet testnet can yield an empty block even after the walk-back; those are marked *(empty)* and are not size datapoints.`,
  );
  L.push(
    `- **Reproducibility:** public endpoints are load-balanced across heterogeneous backends, so a single run is a snapshot, not a guarantee. Transient failures are retried once; re-run to confirm anything surprising.`,
  );
  L.push("");
  L.push("## Legend");
  L.push("");
  L.push("| | Meaning |");
  L.push("|---|---|");
  L.push("| ✅ `ok` | method answered with trace data |");
  L.push("| ☑️ `ok-empty` | method answered, but the sampled block was empty — supported, size not measurable |");
  L.push("| ❌ `method-not-found` | method absent on this endpoint; no plan lifts it |");
  L.push("| 🔒 `tier-gated` | refused for credentials or plan — purchasable |");
  L.push("| 📦 `too-large` | answered, but exceeded the response cap |");
  L.push("| ⚠️ `error` | answered with something we decline to bucket — see verbatim below |");
  L.push("| — | endpoint skipped; the reason is in parentheses |");
  L.push("");
  L.push(summarise(results));
  L.push("");
  L.push("## Summary");
  L.push("");
  L.push("| Chain | id | Role | Endpoint | `debug_traceBlockByNumber` | `trace_block` | `ots_getBlockTransactions` |");
  L.push("|---|---|---|---|---|---|---|");
  for (const c of results) {
    for (const p of c.endpoints) {
      // A skipped endpoint is not necessarily a dead one: ankr and drpc
      // refuse at the liveness check with a credential/plan error, which is a
      // finding about access, not availability.
      const cell = (m) =>
        p?.skipped
          ? `— *(${p.liveness?.status ?? "skipped"})*`
          : mark(p?.methods?.[m]?.status ?? "n/a");
      L.push(
        `| ${c.jsonKey}${c.isTestnet ? " *(testnet)*" : ""} | ${c.chainId} | ${p.label} | \`${new URL(p.url).host}\` | ${cell("debug_traceBlockByNumber")} | ${cell("trace_block")} | ${cell("ots_getBlockTransactions")} |`,
      );
    }
  }
  L.push("");
  L.push("## Cost and size, where a method answered");
  L.push("");
  L.push("| Chain | Method | Block | Txs | Raw | Gzip | Fetch | Parse |");
  L.push("|---|---|---|---|---|---|---|---|");
  let any = false;
  for (const c of results) {
    for (const p of c.endpoints) {
      for (const [name, m] of Object.entries(p.methods ?? {})) {
        if (m.status !== "ok" && m.status !== "ok-empty") continue;
        any = true;
        L.push(
          `| ${c.jsonKey} (${p.label}) | \`${name}\` | ${p.block?.number ?? "—"} | ${p.block?.txCount ?? "—"}${p.block?.empty ? " *(empty)*" : ""} | ${kb(m.bytesRaw)} | ${kb(m.bytesGzip)} | ${ms(m.fetchMs)} | ${ms(m.parseMs)} |`,
        );
      }
    }
  }
  if (!any) L.push("| — | — | — | — | — | — | — | — |");
  L.push("");
  L.push("## Refusals, verbatim");
  L.push("");
  L.push(
    "The distinction between these is the point of the survey: a method that was never implemented, one gated behind a plan, and one that timed out imply different things for #2241.",
  );
  L.push("");
  for (const c of results) {
    for (const p of c.endpoints) {
      const bad = Object.entries(p.methods ?? {}).filter(
        ([, m]) => !["ok", "ok-empty", "n/a"].includes(m.status),
      );
      if (!bad.length && !p.skipped) continue;
      L.push(`**${c.jsonKey}** — ${p.label} (\`${new URL(p.url).host}\`)`);
      L.push("");
      if (p.skipped) L.push(`- endpoint skipped: ${p.skipped}`);
      for (const [name, m] of bad) {
        const detail = m.errorMessage ? ` — \`${m.errorMessage}\`` : "";
        const code = m.errorCode != null ? ` (code ${m.errorCode})` : "";
        L.push(`- \`${name}\`: ${m.status}${code}${detail}`);
      }
      L.push("");
    }
  }
  const mismatches = results.flatMap((c) =>
    c.endpoints
      .filter((p) => p.chainIdMatches === false)
      .map((p) => ({ chain: c, endpoint: p })),
  );
  if (mismatches.length) {
    L.push("## ⚠️ chainId mismatches");
    L.push("");
    L.push("The endpoint did not report the chain id `CHAIN_CONFIG` maps it to:");
    L.push("");
    for (const { chain, endpoint } of mismatches) {
      L.push(
        `- **${chain.jsonKey}** (${endpoint.label}, \`${new URL(endpoint.url).host}\`): config says ${chain.chainId}, endpoint reported ${endpoint.chainIdReported}`,
      );
    }
    L.push("");
  }
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// 5. Main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const a = {
    only: null,
    mainnets: false,
    config: null,
    dryRun: false,
    out: "./out",
  };
  const value = (i, k) => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--")) {
      throw new Error(`${k} needs a value`);
    }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--only") {
      const ids = value(++i, k)
        .split(",")
        .map((s) => Number(s.trim()));
      if (ids.some((n) => !Number.isInteger(n))) {
        throw new Error("--only takes a comma-separated list of chain ids");
      }
      a.only = new Set(ids);
    } else if (k === "--mainnets") a.mainnets = true;
    else if (k === "--config") a.config = value(++i, k);
    else if (k === "--dry-run") a.dryRun = true;
    else if (k === "--out") a.out = value(++i, k);
    else throw new Error(`unknown argument: ${k}`);
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();

  const source = await loadConfig(args.config);
  const all = parseChainConfig(source);

  let targets = all;
  if (args.only) targets = targets.filter((c) => args.only.has(c.chainId));
  if (args.mainnets) targets = targets.filter((c) => !c.isTestnet);

  // Non-overlapping buckets: solana-devnet is both non-EVM and a testnet, so
  // reporting "EVM mainnets / testnets / solana" as three counts double-counts
  // it and the total does not add up.
  const n = (fn) => all.filter(fn).length;
  process.stderr.write(
    `CHAIN_CONFIG: ${all.length} entries = ` +
      `${n((c) => c.chainType === "evm" && !c.isTestnet)} EVM mainnet + ` +
      `${n((c) => c.chainType === "evm" && c.isTestnet)} EVM testnet + ` +
      `${n((c) => c.chainType === "solana" && !c.isTestnet)} solana mainnet + ` +
      `${n((c) => c.chainType === "solana" && c.isTestnet)} solana devnet\n` +
      `probing ${targets.length}\n\n`,
  );
  if (targets.length === 0) {
    throw new Error("no chains matched the given filters");
  }

  if (args.dryRun) {
    for (const c of targets) {
      process.stderr.write(
        `  ${String(c.chainId).padStart(9)} ${c.jsonKey.padEnd(20)} ${c.primary.url}\n`,
      );
    }
    return;
  }

  const results = [];
  for (const c of targets) {
    process.stderr.write(`[${c.chainId}] ${c.jsonKey}\n`);
    const endpoints = [];
    const probe =
      c.chainType === "solana" ? probeSolanaEndpoint : probeEvmEndpoint;
    endpoints.push(await probe("primary", c.primary.url, c.chainId));

    // Scope item 1 asks about the primary AND fallback upstreams. 17 of 24
    // chains fall back to a different provider entirely (drpc, ankr, thirdweb,
    // 1rpc), so trace support genuinely differs between them — surveying only
    // the primary would answer half the question.
    if (c.fallback?.url && c.fallback.url !== c.primary.url) {
      await sleep(REQUEST_DELAY_MS);
      process.stderr.write(`  fallback:\n`);
      endpoints.push(await probe("fallback", c.fallback.url, c.chainId));
    }
    results.push({ ...c, endpoints });
    await sleep(REQUEST_DELAY_MS);
  }

  const meta = {
    startedAt,
    finishedAt: new Date().toISOString(),
    configSource: args.config ?? CONFIG_URL,
    totalChains: all.length,
    limits: {
      REQUEST_DELAY_MS,
      REQUEST_TIMEOUT_MS,
      MAX_RESPONSE_BYTES,
      BLOCKS_BEHIND_HEAD,
    },
  };

  const outDir = resolve(args.out);
  await mkdir(outDir, { recursive: true });
  await writeFile(
    `${outDir}/results.json`,
    JSON.stringify({ meta, results }, null, 2),
  );
  await writeFile(`${outDir}/report.md`, buildReport(results, meta));
  process.stderr.write(`\nwrote ${outDir}/results.json and report.md\n`);
}

// Only run when invoked directly, so the pure functions above stay testable.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`\nfatal: ${err.message}\n`);
    process.exit(1);
  });
}
