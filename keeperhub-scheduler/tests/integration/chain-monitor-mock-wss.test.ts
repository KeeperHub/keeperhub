/**
 * KEEP-570 - End-to-end validation of the diagnostic warning AND the reaper
 * behavior, against the real ChainMonitor and real ethers v6.
 *
 * Unlike tests/unit/chain-monitor.test.ts which mocks ethers, this test
 * runs ChainMonitor against a real `ws` server we control. The server
 * implements each candidate failure mode and the assertions cover:
 *
 *   1. The noBlockTimer warning's (wsFrames, subscriptionPushes,
 *      blocksReceived) triple correctly distinguishes the three modes.
 *   2. isAlive() flips to false once MONITOR_RECREATE_TIMEOUT_MS elapses
 *      without a real block height advance, even while subscribe re-fires
 *      on reconnect attempts (the reaper backstop). isAlive() returns true
 *      transiently while isReconnecting, so the assertion polls.
 *
 * This is a synthetic stuck state, not a reproduction of the actual prod
 * bug. It validates the discrimination + reaper logic end-to-end.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { ChainMonitor } from "../../block-dispatcher/chain-monitor.js";

vi.mock("../../block-dispatcher/sqs-enqueue.js", () => ({
  enqueueBlockTrigger: vi.fn().mockResolvedValue(undefined),
}));

const BLOCK_ADVANCE_MS = 2_000;
const MONITOR_RECREATE_MS = 6_000;
const PRIMARY_PROBE_INTERVAL_MS = 60_000;
const STUCK_WINDOW_MS = MONITOR_RECREATE_MS + 2_000;

type Scenario = "healthy" | "zombie" | "subscribe-no-response";

function startMockServer(scenario: Scenario): {
  server: WebSocketServer;
  serverStarted: Promise<number>;
} {
  let blockNumber = 0x1000;
  // Port 0 => OS picks a free port. Read the actual port back from
  // server.address() once listening fires. Removes flake from a
  // static-counter scheme racing against anything else on the host.
  // Loopback-only for the reasons in the previous commit.
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  const subscriptions = new Map<string, NodeJS.Timeout>();

  const serverStarted = new Promise<number>((resolve, reject) => {
    server.once("listening", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("server.address() did not return an AddressInfo"));
        return;
      }
      resolve(address.port);
    });
    server.once("error", reject);
  });

  function send(ws: WebSocket, payload: unknown): void {
    if (ws.readyState !== 1) {
      return;
    }
    ws.send(JSON.stringify(payload));
  }

  function pushNewHead(ws: WebSocket, subId: string): void {
    blockNumber++;
    const number = `0x${blockNumber.toString(16)}`;
    send(ws, {
      jsonrpc: "2.0",
      method: "eth_subscription",
      params: {
        subscription: subId,
        result: {
          number,
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
    ws.on("message", (raw) => {
      let msg: { id?: number; method?: string; params?: unknown };
      try {
        msg = JSON.parse(raw.toString()) as typeof msg;
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

        if (scenario === "subscribe-no-response") {
          const timer = setInterval(() => {
            pushNewHead(ws, subId);
          }, 200);
          subscriptions.set(subId, timer);
          return;
        }

        send(ws, { jsonrpc: "2.0", id: msg.id, result: subId });

        if (scenario === "zombie") {
          return;
        }

        const timer = setInterval(() => {
          pushNewHead(ws, subId);
        }, 200);
        subscriptions.set(subId, timer);
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
      for (const timer of subscriptions.values()) {
        clearInterval(timer);
      }
      subscriptions.clear();
    });
  });

  return { server, serverStarted };
}

// Poll isAlive() because it returns true transiently while isReconnecting is
// set during the reconnect-with-backoff loop. The reaper-relevant moments are
// the windows between reconnect attempts where staleness exceeds
// MONITOR_RECREATE_TIMEOUT_MS and the monitor is not reconnecting; the
// reconciler runs every 30s in prod and only needs one such reading.
async function waitForReap(
  monitor: ChainMonitor,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!monitor.isAlive()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

function captureWarnings(): { warnings: string[]; restore: () => void } {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]): void => {
    warnings.push(args.map((a) => String(a)).join(" "));
  };
  return {
    warnings,
    restore: () => {
      console.warn = original;
    },
  };
}

function makeChain(port: number): {
  chainId: number;
  name: string;
  defaultPrimaryWss: string;
  defaultFallbackWss: null;
} {
  return {
    chainId: 1,
    name: "TestChain",
    defaultPrimaryWss: `ws://localhost:${port}`,
    defaultFallbackWss: null,
  };
}

// The benign destroy-race in chain-monitor.ts:
// subscriber.stop()'s .then microtask races provider.destroy(); the in-flight
// eth_unsubscribe rejects with "provider destroyed; cancelled request". This
// happens in prod on every teardown (53 in 5000 log lines, documented on
// KEEP-570) and propagates as an unhandled rejection. Swallow it here so
// vitest does not fail the run on what is documented benign noise.
function isBenignDestroyRace(reason: unknown): boolean {
  if (!(reason instanceof Error)) {
    return false;
  }
  const code = (reason as Error & { code?: string }).code;
  const operation = (reason as Error & { operation?: string }).operation;
  return code === "UNSUPPORTED_OPERATION" && operation === "eth_unsubscribe";
}

describe("KEEP-570 integration: ChainMonitor warning patterns against a real ws mock", () => {
  let serverHandle: {
    server: WebSocketServer;
    serverStarted: Promise<number>;
  } | null = null;
  let monitor: ChainMonitor | null = null;
  let warningCapture: { warnings: string[]; restore: () => void } | null = null;
  // process.on/off is a global side effect. Install once for the file and
  // tear down once at the end, so a crash in afterEach cannot leave a
  // dangling handler or accumulate duplicates across iterations.
  const rejectionHandler = (reason: unknown): void => {
    if (!isBenignDestroyRace(reason)) {
      throw reason;
    }
  };

  beforeAll(() => {
    process.on("unhandledRejection", rejectionHandler);
  });

  afterAll(() => {
    process.off("unhandledRejection", rejectionHandler);
  });

  beforeEach(() => {
    vi.stubEnv("BLOCK_ADVANCE_TIMEOUT_MS", String(BLOCK_ADVANCE_MS));
    vi.stubEnv("MONITOR_RECREATE_TIMEOUT_MS", String(MONITOR_RECREATE_MS));
    vi.stubEnv("PRIMARY_PROBE_INTERVAL_MS", String(PRIMARY_PROBE_INTERVAL_MS));
    warningCapture = captureWarnings();
  });

  afterEach(async () => {
    if (monitor) {
      await monitor.stop().catch(() => {
        // ignore teardown errors; we have process-level handler
      });
      monitor = null;
    }
    if (serverHandle) {
      await new Promise<void>((resolve) => {
        serverHandle?.server.close(() => resolve());
      });
      serverHandle = null;
    }
    if (warningCapture) {
      warningCapture.restore();
      warningCapture = null;
    }
    vi.unstubAllEnvs();
  });

  it("zombie mode -> warning shows subscriptionPushes=0, blocksReceived=0", async () => {
    serverHandle = startMockServer("zombie");
    const port = await serverHandle.serverStarted;

    monitor = new ChainMonitor({
      chain: makeChain(port),
      workflows: [{ id: "wf1", userId: "u1", blockInterval: 1 }],
    });

    await monitor.start();

    // Wait through at least one noBlockTimer firing plus reconnect.
    await new Promise((r) => setTimeout(r, STUCK_WINDOW_MS));

    const warning = warningCapture?.warnings.find((w) =>
      w.includes("Block height has not advanced"),
    );
    expect(warning, "expected at least one noBlockTimer warning").toBeDefined();
    // wsFrames > 0 because chainId/blockNumber/subscribe round-trips
    // produce non-subscription frames. subscriptionPushes is 0 because
    // the server never sends pushes in zombie mode.
    expect(warning).toMatch(/subscriptionPushes=0/);
    expect(warning).toMatch(/blocksReceived=0/);

    // Reaper backstop: staleness from monitorBootAt has exceeded
    // MONITOR_RECREATE_TIMEOUT_MS and no real block ever arrived, so
    // isAlive() must report false between reconnect attempts. The
    // reconciler relies on this signal to tear the monitor down.
    const reaped = await waitForReap(monitor, MONITOR_RECREATE_MS);
    expect(
      reaped,
      "monitor should report isAlive=false once MONITOR_RECREATE_TIMEOUT_MS has elapsed without a real block",
    ).toBe(true);
  }, 30_000);

  it("subscribe-no-response mode -> warning shows subscriptionPushes>0, blocksReceived=0 (ethers routing bug)", async () => {
    serverHandle = startMockServer("subscribe-no-response");
    const port = await serverHandle.serverStarted;

    monitor = new ChainMonitor({
      chain: makeChain(port),
      workflows: [{ id: "wf1", userId: "u1", blockInterval: 1 }],
    });

    await monitor.start();
    await new Promise((r) => setTimeout(r, STUCK_WINDOW_MS));

    const warning = warningCapture?.warnings.find((w) =>
      w.includes("Block height has not advanced"),
    );
    expect(warning, "expected at least one noBlockTimer warning").toBeDefined();
    // Pushes are arriving (server sends eth_subscription messages with
    // the server-side known subId), but ethers never registered the
    // subscriber in #subs because the response was dropped. Frames show
    // in our raw-ws tap counter even though they never reach onBlock.
    expect(warning).toMatch(/subscriptionPushes=[1-9]/);
    expect(warning).toMatch(/blocksReceived=0/);

    // Reaper backstop: even though subscription pushes are being received
    // at the socket, no real block ever advances height, so the staleness
    // baseline (monitorBootAt) exceeds MONITOR_RECREATE_TIMEOUT_MS and the
    // monitor must report isAlive=false to the reconciler.
    const reaped = await waitForReap(monitor, MONITOR_RECREATE_MS);
    expect(
      reaped,
      "monitor should report isAlive=false once MONITOR_RECREATE_TIMEOUT_MS has elapsed without a real block",
    ).toBe(true);
  }, 30_000);

  it("healthy mode -> blocks arrive, no stuck warning, isAlive stays true", async () => {
    serverHandle = startMockServer("healthy");
    const port = await serverHandle.serverStarted;

    monitor = new ChainMonitor({
      chain: makeChain(port),
      workflows: [{ id: "wf1", userId: "u1", blockInterval: 1 }],
    });

    await monitor.start();
    await new Promise((r) => setTimeout(r, STUCK_WINDOW_MS));

    const stuckWarning = warningCapture?.warnings.find((w) =>
      w.includes("Block height has not advanced"),
    );
    expect(
      stuckWarning,
      "should not see a stuck warning in healthy mode",
    ).toBeUndefined();
    expect(monitor.isAlive()).toBe(true);
  }, 30_000);
});
