#!/usr/bin/env tsx

/**
 * debug-rpc-ids.ts
 *
 * Sends raw JSON-RPC requests to an RPC endpoint and checks whether the
 * response preserves the request `id`. Helps diagnose proxies that re-number
 * JSON-RPC IDs, which causes ethers v6 "missing response for request" errors.
 *
 * Runs two phases:
 *   1. Sequential -- one request at a time (baseline)
 *   2. Concurrent -- multiple requests in flight simultaneously (reproduces
 *      proxy multiplexing issues)
 *
 * Usage:
 *   pnpm tsx scripts/debug-rpc-ids.ts <RPC_URL> [iterations]
 *
 * Examples:
 *   pnpm tsx scripts/debug-rpc-ids.ts https://rpc.example.com
 *   pnpm tsx scripts/debug-rpc-ids.ts https://rpc.example.com 20
 */

type RpcResult = {
  sentId: number;
  receivedId: unknown;
  isArray: boolean;
  match: boolean;
};

async function sendRpcRequest(
  url: string,
  id: number,
  method: string,
  params: unknown[] = []
): Promise<RpcResult> {
  const body = JSON.stringify({ id, jsonrpc: "2.0", method, params });

  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

  const json: unknown = await resp.json();
  const isArray = Array.isArray(json);
  const firstResult = isArray ? (json as Record<string, unknown>[])[0] : json;
  const receivedId = (firstResult as Record<string, unknown>)?.id;

  return { sentId: id, receivedId, isArray, match: id === receivedId };
}

function printResult(result: RpcResult, index: number, total: number): void {
  console.log(
    `  [${index + 1}/${total}] sent id=${result.sentId} -> got id=${String(result.receivedId)}` +
      ` | match=${result.match} | array=${result.isArray}`
  );
}

async function runSequential(url: string, iterations: number): Promise<RpcResult[]> {
  console.log(`\n--- Phase 1: Sequential (${iterations} requests) ---`);
  const results: RpcResult[] = [];

  for (let i = 0; i < iterations; i++) {
    const result = await sendRpcRequest(url, 100 + i, "eth_blockNumber");
    results.push(result);
    printResult(result, i, iterations);
  }

  return results;
}

async function runConcurrent(url: string, iterations: number): Promise<RpcResult[]> {
  console.log(`\n--- Phase 2: Concurrent (${iterations} requests in flight) ---`);

  const promises: Promise<RpcResult>[] = [];
  for (let i = 0; i < iterations; i++) {
    promises.push(sendRpcRequest(url, 200 + i, "eth_blockNumber"));
  }

  const results = await Promise.all(promises);
  for (let i = 0; i < results.length; i++) {
    printResult(results[i], i, iterations);
  }

  return results;
}

function printSummary(label: string, results: RpcResult[]): void {
  const mismatches = results.filter((r) => !r.match).length;
  const arrayResponses = results.filter((r) => r.isArray).length;

  console.log(`\n  ${label}:`);
  console.log(`    Total requests:  ${results.length}`);
  console.log(`    ID mismatches:   ${mismatches}`);
  console.log(`    Array responses: ${arrayResponses}`);
}

async function debugRpcIds(): Promise<void> {
  const url = process.argv[2];
  if (!url) {
    console.error("Usage: pnpm tsx scripts/debug-rpc-ids.ts <RPC_URL> [iterations]");
    process.exit(1);
  }

  const iterations = Number.parseInt(process.argv[3] ?? "5", 10);

  console.log(`Testing RPC ID preservation: ${url}`);

  const sequential = await runSequential(url, iterations);
  const concurrent = await runConcurrent(url, iterations);

  console.log("\n=== Summary ===");
  printSummary("Sequential", sequential);
  printSummary("Concurrent", concurrent);

  const totalMismatches =
    sequential.filter((r) => !r.match).length + concurrent.filter((r) => !r.match).length;

  if (totalMismatches > 0) {
    console.log(
      "\nThe RPC proxy is re-numbering JSON-RPC IDs. This causes ethers v6 " +
        '"missing response for request" errors even with batchMaxCount:1.'
    );
  } else {
    console.log("\nAll IDs preserved. Proxy looks correct.");
  }
}

debugRpcIds();
