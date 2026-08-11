/**
 * KEEP-570 - Ethers v6 WebSocketProvider accumulated-state stress repro.
 *
 * Hypothesis: the prod failure mode where a long-running dispatcher Node
 * process stops routing newHeads to its subscribers, while a fresh Node
 * process in the same pod against the same URL works fine, is caused by
 * accumulated state inside ethers v6 (or the `ws` library) across many
 * connect-and-destroy cycles in a single process.
 *
 * This script tries to reproduce that. In a single Node process:
 *   1. Starts a healthy in-process ws mock server that pushes a newHead
 *      every 200 ms to any subscriber.
 *   2. Runs a stress loop: create a fresh `ethers.WebSocketProvider`,
 *      call getBlockNumber, attach a "block" listener, wait briefly,
 *      then tear it down. Repeat thousands of times.
 *   3. Every N cycles, runs a "probe": creates a fresh provider and
 *      counts how many `newHeads` it actually receives in a fixed window.
 *      If a probe ever receives zero newHeads from the same healthy
 *      server the bug has reproduced locally.
 *   4. Logs heap RSS, event-loop lag, and provider counts at each probe
 *      so we can correlate the failure with any resource trend.
 *
 * If the script completes thousands of cycles and every probe reads
 * newHeads correctly, the bug is below ethers (provider-side, network,
 * cluster-egress) and the fix needs to look elsewhere.
 *
 * Usage:
 *   pnpm tsx keeperhub-scheduler/debug/ethers-stress-repro.ts \
 *     [stressCycles=2000] [probeEvery=100] [probeDurationMs=5000] [port=19200]
 */

import { ethers } from "ethers";
import { type WebSocket, WebSocketServer } from "ws";

const stressCycles = Number.parseInt(process.argv[2] ?? "2000", 10);
const probeEvery = Number.parseInt(process.argv[3] ?? "100", 10);
const probeDurationMs = Number.parseInt(process.argv[4] ?? "5000", 10);
const port = Number.parseInt(process.argv[5] ?? "19200", 10);

console.log("─".repeat(72));
console.log(
  `Stress params: cycles=${stressCycles} probeEvery=${probeEvery} probeDurationMs=${probeDurationMs} port=${port}`,
);
console.log("─".repeat(72));

// Track unhandled rejections that come from the benign destroy-race.
const benignRejections: string[] = [];
process.on("unhandledRejection", (reason: unknown) => {
  if (reason instanceof Error) {
    const code = (reason as Error & { code?: string }).code;
    const operation = (reason as Error & { operation?: string }).operation;
    if (code === "UNSUPPORTED_OPERATION" && operation === "eth_unsubscribe") {
      benignRejections.push(reason.message);
      return;
    }
  }
  console.error("UNHANDLED REJECTION", reason);
});

// ---------------------------------------------------------------------------
// Mock server (healthy mode only)
// ---------------------------------------------------------------------------

function startHealthyMockServer(serverPort: number): WebSocketServer {
  let blockNumber = 0x1000;
  // Bind to loopback only; this is a debug-only mock that does not need
  // to be reachable externally.
  const server = new WebSocketServer({ port: serverPort, host: "127.0.0.1" });
  let connectionCount = 0;
  let liveConnections = 0;

  function send(ws: WebSocket, payload: unknown): void {
    if (ws.readyState !== 1) {
      return;
    }
    ws.send(JSON.stringify(payload));
  }

  function pushNewHead(ws: WebSocket, subId: string): void {
    blockNumber++;
    const num = `0x${blockNumber.toString(16)}`;
    send(ws, {
      jsonrpc: "2.0",
      method: "eth_subscription",
      params: {
        subscription: subId,
        result: {
          number: num,
          hash: `0x${blockNumber.toString(16).padStart(64, "a")}`,
          parentHash: `0x${(blockNumber - 1).toString(16).padStart(64, "b")}`,
          timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`,
          gasLimit: "0x1c9c380",
          gasUsed: "0x0",
          baseFeePerGas: "0x1",
          miner: "0x0000000000000000000000000000000000000000",
          difficulty: "0x0",
        },
      },
    });
  }

  server.on("connection", (ws) => {
    connectionCount++;
    liveConnections++;
    const timers: NodeJS.Timeout[] = [];

    ws.on("message", (raw) => {
      let msg: { id?: number; method?: string };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.method === "eth_chainId") {
        send(ws, { jsonrpc: "2.0", id: msg.id, result: "0x1" });
        return;
      }
      if (msg.method === "net_version") {
        send(ws, { jsonrpc: "2.0", id: msg.id, result: "1" });
        return;
      }
      if (msg.method === "eth_blockNumber") {
        send(ws, {
          jsonrpc: "2.0",
          id: msg.id,
          result: `0x${blockNumber.toString(16)}`,
        });
        return;
      }
      if (msg.method === "eth_subscribe") {
        const subId = `0x${Math.random()
          .toString(16)
          .slice(2)
          .padEnd(32, "0")}`;
        send(ws, { jsonrpc: "2.0", id: msg.id, result: subId });
        const t = setInterval(() => pushNewHead(ws, subId), 200);
        timers.push(t);
        return;
      }
      if (msg.method === "eth_unsubscribe") {
        send(ws, { jsonrpc: "2.0", id: msg.id, result: true });
        return;
      }
      send(ws, {
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: `method ${msg.method} not found` },
      });
    });

    ws.on("close", () => {
      liveConnections--;
      for (const t of timers) {
        clearInterval(t);
      }
    });
  });

  Object.defineProperty(server, "stats", {
    get: () => ({ total: connectionCount, live: liveConnections }),
  });

  return server;
}

// ---------------------------------------------------------------------------
// Single provider cycle: create, connect, subscribe, tear down.
// ---------------------------------------------------------------------------

async function runStressCycle(url: string, lifetimeMs: number): Promise<void> {
  const provider = new ethers.WebSocketProvider(url);
  try {
    await provider.getBlockNumber();
  } catch {
    // ignore; the tear-down still has to happen
  }
  try {
    await provider.on("block", () => {
      // discard
    });
  } catch {
    // ignore
  }
  await new Promise((r) => setTimeout(r, lifetimeMs));
  try {
    await provider.removeAllListeners();
  } catch {
    // ignore
  }
  try {
    await provider.destroy();
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Probe: how many newHeads does a fresh provider see in `durationMs`?
// ---------------------------------------------------------------------------

async function runProbe(url: string, durationMs: number): Promise<number> {
  const provider = new ethers.WebSocketProvider(url);
  let blocks = 0;
  try {
    await provider.getBlockNumber();
    await provider.on("block", () => {
      blocks++;
    });
    await new Promise((r) => setTimeout(r, durationMs));
  } finally {
    try {
      await provider.removeAllListeners();
    } catch {
      // ignore
    }
    try {
      await provider.destroy();
    } catch {
      // ignore
    }
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function fmtBytes(b: number): string {
  return `${(b / 1024 / 1024).toFixed(1)}MB`;
}

async function eventLoopLagMs(): Promise<number> {
  const start = Date.now();
  await new Promise((r) => setImmediate(r));
  return Date.now() - start;
}

async function main(): Promise<void> {
  const server = startHealthyMockServer(port);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  const url = `ws://localhost:${port}`;
  console.log(`Mock server listening on ${url}`);

  // Sanity probe first
  const sanity = await runProbe(url, 2_000);
  console.log(`Sanity probe (cycle 0): newHeads=${sanity}`);
  if (sanity === 0) {
    console.error(
      "FATAL: sanity probe failed - mock server or ethers not working",
    );
    process.exit(1);
  }

  const probeHistory: Array<{
    cycle: number;
    blocks: number;
    heapRss: number;
    heapUsed: number;
    eventLoopLag: number;
    liveConnections: number;
    totalConnections: number;
    benignRejectionCount: number;
  }> = [];

  const stressStart = Date.now();
  let stressBudgetMs = 0;

  for (let cycle = 1; cycle <= stressCycles; cycle++) {
    const cycleStart = Date.now();
    await runStressCycle(url, 200);
    stressBudgetMs += Date.now() - cycleStart;

    if (cycle % probeEvery === 0) {
      const lag = await eventLoopLagMs();
      const mem = process.memoryUsage();
      const stats = (
        server as unknown as {
          stats: { total: number; live: number };
        }
      ).stats;
      const blocks = await runProbe(url, probeDurationMs);
      const sample = {
        cycle,
        blocks,
        heapRss: mem.rss,
        heapUsed: mem.heapUsed,
        eventLoopLag: lag,
        liveConnections: stats.live,
        totalConnections: stats.total,
        benignRejectionCount: benignRejections.length,
      };
      probeHistory.push(sample);
      const tag = blocks === 0 ? " <<< FAILURE" : "";
      console.log(
        `cycle=${cycle.toString().padStart(5)} ` +
          `probe newHeads=${blocks.toString().padStart(3)} ` +
          `rss=${fmtBytes(mem.rss).padStart(7)} ` +
          `heap=${fmtBytes(mem.heapUsed).padStart(7)} ` +
          `lag=${lag}ms ` +
          `live=${stats.live} ` +
          `total=${stats.total} ` +
          `benignRejects=${benignRejections.length}${tag}`,
      );
      if (blocks === 0) {
        console.log(
          `REPRO HIT: a fresh ethers WebSocketProvider in this process received zero newHeads from the same server that delivered ${sanity} blocks at process start.`,
        );
        console.log(
          "Letting the loop continue so we can see whether subsequent " +
            "probes also fail or whether this was a transient hiccup.",
        );
      }
    }
  }

  const totalElapsedMs = Date.now() - stressStart;
  console.log("─".repeat(72));
  console.log(
    `Done. ${stressCycles} stress cycles in ${(totalElapsedMs / 1000).toFixed(1)}s ` +
      `(avg ${Math.round(stressBudgetMs / stressCycles)}ms/cycle).`,
  );
  const failures = probeHistory.filter((p) => p.blocks === 0);
  if (failures.length === 0) {
    console.log(
      `All ${probeHistory.length} probes received newHeads. Hypothesis REFUTED: in-process accumulated state in ethers/ws does not explain the prod failure mode (within this many cycles).`,
    );
  } else {
    console.log(
      `REPRODUCED on ${failures.length}/${probeHistory.length} probes: ` +
        `cycles ${failures.map((f) => f.cycle).join(", ")}`,
    );
  }
  console.log(
    `Benign destroy-race rejections: ${benignRejections.length}. (These mirror the 53/5000 lines we saw in prod logs.)`,
  );

  server.close();
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error("FATAL:", err);
  process.exit(1);
});
