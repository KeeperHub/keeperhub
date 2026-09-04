/**
 * QA for probe.mjs — the two pure functions.
 *
 * classify() is the piece the whole survey rests on: if it mislabels a tier
 * gate as "not supported", #2241 gets scoped against a wrong answer. Live
 * probing only exercises whatever the network happened to return today, so the
 * refusal shapes are pinned here instead.
 *
 *   node --test scripts/trace-method-probe.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { classify, parseChainConfig } from "./trace-method-probe.mjs";

// Point at the repo's own config: the parser must keep working against the
// real file, not a vendored snapshot that can silently go stale.
const CONFIG =
  process.env.RPC_CONFIG_PATH ??
  new URL("../lib/rpc/rpc-config.ts", import.meta.url).pathname;

// --- classify ---------------------------------------------------------------

// Default to a NON-empty result: `result: []` is its own classification
// (ok-empty), so using it as the generic "success" fixture would test the
// wrong branch.
const ok = (over = {}) => ({
  httpStatus: 200,
  body: { result: [{ type: "CALL" }] },
  ...over,
});
const rpcErr = (code, message, over = {}) => ({
  httpStatus: 200,
  body: { error: { code, message } },
  ...over,
});

test("ok when a result is present", () => {
  assert.equal(classify(ok()), "ok");
  assert.equal(classify(ok({ body: { result: "0x1" } })), "ok");
});

test("null result is distinct from ok", () => {
  // Some nodes answer trace_block with null for an empty/unknown block. That
  // is not the same as supporting it with data, and not the same as refusing.
  assert.equal(classify(ok({ body: { result: null } })), "null-result");
});

test("standard JSON-RPC method-not-found", () => {
  assert.equal(classify(rpcErr(-32601, "the method does not exist")), "method-not-found");
});

test("method refusals phrased as prose, not as -32601", () => {
  for (const msg of [
    "debug_traceBlockByNumber is not supported",
    "method not available on this endpoint",
    "trace_block is disabled",
    "Method not found",
    "endpoint unavailable for this method",
    "ots_getBlockTransactions not enabled",
  ]) {
    assert.equal(classify(rpcErr(-32000, msg)), "method-not-found", msg);
  }
});

test("tier gates, by status and by message", () => {
  assert.equal(classify({ httpStatus: 401 }), "tier-gated");
  assert.equal(classify({ httpStatus: 403 }), "tier-gated");
  for (const msg of [
    "This method requires a paid plan",
    "upgrade your plan to access trace methods",
    "api key required",
    "unauthorized",
    "access denied for this tier",
  ]) {
    assert.equal(classify(rpcErr(-32000, msg)), "tier-gated", msg);
  }
});

test("a tier gate outranks the not-supported wording when both appear", () => {
  // Providers commonly say "not available on your plan". Reading that as
  // "never implemented" is the single most damaging misclassification here:
  // it would tell #2241 a chain cannot do traces when in fact it can be paid for.
  assert.equal(
    classify(rpcErr(-32000, "trace_block is not available on the free plan")),
    "tier-gated",
  );
});

// Observed responses, captured 2026-09-03. Both are HTTP 403 and mean opposite
// things; the first draft of classify() got Base backwards by reading the
// status before the body. These are the regression.
test("REAL: base mainnet — 403 + -32601 is absence, not a paywall", () => {
  assert.equal(
    classify({
      httpStatus: 403,
      body: { error: { code: -32601, message: "rpc method is unsupported" } },
    }),
    "method-not-found",
  );
});

test("REAL: eth publicnode — 403 + -32602 archive token is a paywall", () => {
  assert.equal(
    classify({
      httpStatus: 403,
      body: {
        error: {
          code: -32602,
          message:
            "Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode",
        },
      },
    }),
    "tier-gated",
  );
});

test("REAL: publicnode absent-method wording", () => {
  assert.equal(
    classify({
      httpStatus: 200,
      body: {
        error: {
          code: -32601,
          message:
            "the method debug_traceBlockByNumber does not exist/is not available",
        },
      },
    }),
    "method-not-found",
  );
});

test("rate limits are not mistaken for refusals", () => {
  assert.equal(classify({ httpStatus: 429 }), "rate-limited");
  assert.equal(classify(rpcErr(-32005, "limit exceeded")), "rate-limited");
  assert.equal(classify(rpcErr(-32000, "too many requests")), "rate-limited");
});

test("transport failures keep timeout separate from everything else", () => {
  assert.equal(classify({ transportError: "timeout" }), "timeout");
  assert.equal(classify({ transportError: "ECONNREFUSED" }), "transport-error");
});

test("truncation is a size finding, not a malformed response", () => {
  // Ordering matters: truncated bodies never parse, so if this branch came
  // after the parseError check it would be reported as invalid-response and
  // the size result — scope item 3 — would be lost.
  assert.equal(
    classify({ httpStatus: 200, truncated: true, parseError: "Unexpected end of JSON input" }),
    "too-large",
  );
});

test("malformed and server errors stay distinguishable", () => {
  assert.equal(classify({ httpStatus: 200, parseError: "Unexpected token <" }), "invalid-response");
  assert.equal(classify({ httpStatus: 502, body: null }), "server-error");
  assert.equal(classify({ httpStatus: 200, body: {} }), "invalid-response");
});

test("an unrecognised RPC error is surfaced, not silently bucketed", () => {
  assert.equal(classify(rpcErr(-32000, "something we have never seen")), "error");
});

// --- parseChainConfig -------------------------------------------------------

test("parses the real rpc-config.ts", async (t) => {
  let source;
  try {
    source = await readFile(CONFIG, "utf8");
  } catch {
    t.skip(`no config at ${CONFIG} — set RPC_CONFIG_PATH`);
    return;
  }
  const chains = parseChainConfig(source);

  assert.ok(chains.length >= 20, `expected 20+ chains, got ${chains.length}`);
  assert.ok(chains.every((c) => Number.isInteger(c.chainId)));
  assert.ok(chains.every((c) => c.primary?.url?.startsWith("http")));

  const byId = new Map(chains.map((c) => [c.chainId, c]));
  assert.equal(byId.get(1)?.jsonKey, "eth-mainnet");
  assert.equal(byId.get(8453)?.jsonKey, "base-mainnet");
  assert.equal(byId.get(101)?.chainType, "solana");
  assert.equal(byId.get(1)?.chainType, "evm");
  assert.equal(byId.get(11155111)?.isTestnet, true);
  assert.equal(byId.get(1)?.isTestnet, false);

  // Buckets must partition, or the run-summary counts lie.
  const sum =
    chains.filter((c) => c.chainType === "evm" && !c.isTestnet).length +
    chains.filter((c) => c.chainType === "evm" && c.isTestnet).length +
    chains.filter((c) => c.chainType === "solana" && !c.isTestnet).length +
    chains.filter((c) => c.chainType === "solana" && c.isTestnet).length;
  assert.equal(sum, chains.length, "chain buckets must partition the set");

  assert.equal(new Set(chains.map((c) => c.chainId)).size, chains.length);
});

test("throws loudly rather than surveying a partial config", () => {
  assert.throws(() => parseChainConfig("nothing here"), /PUBLIC_RPCS block not found/);
  assert.throws(
    () => parseChainConfig('export const PUBLIC_RPCS = {\n  A: "https://x",\n};\n'),
    /CHAIN_CONFIG block not found/,
  );
});

test("throws when a chain resolves to no URL", () => {
  const src = [
    'export const PUBLIC_RPCS = {',
    '  KNOWN: "https://known.example",',
    '};',
    '',
    'export const CHAIN_CONFIG: Record<number, ChainConfigEntry> = {',
    '  1: {',
    '    jsonKey: "eth-mainnet",',
    '    publicDefault: PUBLIC_RPCS.MISSING,',
    '  },',
    '};',
  ].join("\n");
  assert.throws(() => parseChainConfig(src), /no publicDefault URL resolved/);
});

test("empty array result is supported-but-unmeasured, not a size datapoint", () => {
  // Observed on tempo-mainnet: the method answered with `result: []` on an
  // empty block — 36 bytes. Reporting that as "ok" alongside plasma's 149 KB
  // would put two incomparable numbers in the same size column.
  assert.equal(classify({ httpStatus: 200, body: { result: [] } }), "ok-empty");
  assert.equal(classify({ httpStatus: 200, body: { result: [{ x: 1 }] } }), "ok");
});

test("REAL: 1rpc.io — -32600 'not allowed' is absence, not unclassified", () => {
  // Observed on the eth-mainnet fallback. Code -32600 is "invalid request",
  // so only the wording identifies this as an absent method.
  assert.equal(
    classify({
      httpStatus: 200,
      body: { error: { code: -32600, message: "Method trace_block not allowed" } },
    }),
    "method-not-found",
  );
});

test("REAL: ankr free tier gates at the liveness check", () => {
  assert.equal(
    classify({
      httpStatus: 200,
      body: {
        error: {
          code: -32600,
          message:
            "Unauthorized: You must authenticate your request with an API key. Create an account on https://www.ankr.com/rpc/ and generate your personal API key for free.",
        },
      },
    }),
    "tier-gated",
  );
});

test("REAL: drpc free-plan chain gate", () => {
  assert.equal(
    classify({
      httpStatus: 200,
      body: {
        error: {
          code: 12,
          message: "chain is not available on free plan, please upgrade to paid plan",
        },
      },
    }),
    "tier-gated",
  );
});

test("REAL: 1rpc.io — non-JSON 401 policy refusal is a gate, not malformed", () => {
  // Observed on the eth-mainnet fallback for ots_getBlockTransactions: HTTP 401
  // with a plain-text body and no JSON at all. Checking parseError before the
  // status (the first draft) reported this as invalid-response.
  assert.equal(
    classify({
      httpStatus: 401,
      parseError: "Unexpected token O in JSON at position 0",
      rawSnippet: "Only core evm requests are allowed.",
    }),
    "tier-gated",
  );
});

test("non-JSON 200 body is still read for a verdict before giving up", () => {
  assert.equal(
    classify({
      httpStatus: 200,
      parseError: "Unexpected token <",
      rawSnippet: "<html>method not supported</html>",
    }),
    "method-not-found",
  );
  assert.equal(
    classify({ httpStatus: 200, parseError: "Unexpected token <", rawSnippet: "<html>502</html>" }),
    "invalid-response",
  );
});
