/**
 * A socket that closes while a getBlock request is in flight must not stall
 * the monitor.
 *
 * ethers v6 never settles a request that was already written to the socket
 * when the provider is destroyed. If the monitor awaits such a request while
 * processing a block, `isProcessing` stays true and every later block is
 * parked in `pendingBlock`, so the height never advances on any later socket.
 *
 * These tests run the real ChainMonitor and the real ethers WebSocketProvider
 * against a local `ws` server. On the first connection the server answers a
 * few eth_getBlockByNumber requests and then leaves every later one
 * unanswered, so a request is always in flight when that socket goes away.
 * Later connections answer normally.
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
import { enqueueBlockTrigger } from "../../block-dispatcher/sqs-enqueue.js";

vi.mock("../../block-dispatcher/sqs-enqueue.js", () => ({
  enqueueBlockTrigger: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../lib/phantom.js", () => ({
  createPhantomExecution: vi
    .fn()
    .mockResolvedValue({ executionId: "exec", alreadyExisted: false }),
  failPhantomExecution: vi.fn().mockResolvedValue(undefined),
}));

const PUSH_INTERVAL_MS = 150;
// Half a push interval off a multiple of it, so the recycle never races a push
// that the server counts as delivered but the closing socket drops.
const SOCKET_MAX_AGE_MS = 1575;
const GET_BLOCK_TIMEOUT_MS = 300;
const GET_BLOCK_RETRY_DELAY_MS = 100;
// Answered getBlock requests on the first connection before it starts
// withholding them.
const ANSWERED_ON_FIRST_CONNECTION = 3;
// How far behind the server head the monitor may be once it has recovered.
const MAX_LAG_BLOCKS = 3;

type ServerOptions = {
  // When false, newHeads pushes carry only number and timestamp, so the
  // monitor has no usable header and must fall back to getBlock.
  fullHeaders: boolean;
  // Close the first connection shortly after it withholds a request, the way
  // an upstream provider drops a socket.
  closeFirstConnectionOnHang: boolean;
};

type ServerStats = {
  connections: number;
  getBlockRequests: number;
  withheld: number;
  // Blocks sent to at least one live subscription.
  pushed: Set<number>;
  // Every eth_getBlockByNumber request as (connection, block).
  requested: Array<{ connection: number; block: number }>;
};

type MockServer = {
  server: WebSocketServer;
  port: Promise<number>;
  head: () => number;
  stats: ServerStats;
  stop: () => Promise<void>;
};

const toHex = (n: number): string => `0x${n.toString(16)}`;
const hashOf = (n: number): string => `0x${n.toString(16).padStart(64, "a")}`;

function startMockServer(options: ServerOptions): MockServer {
  let blockNumber = 0x1000;
  const stats: ServerStats = {
    connections: 0,
    getBlockRequests: 0,
    withheld: 0,
    pushed: new Set(),
    requested: [],
  };
  const subscriptions = new Map<WebSocket, string>();
  // Loopback only, OS-assigned port.
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });

  const port = new Promise<number>((resolve, reject) => {
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
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(payload));
    }
  }

  function header(n: number): Record<string, string> {
    const base = {
      number: toHex(n),
      timestamp: toHex(Math.floor(Date.now() / 1000)),
    };
    if (!options.fullHeaders) {
      return base;
    }
    return { ...base, hash: hashOf(n), parentHash: hashOf(n - 1) };
  }

  function block(n: number): Record<string, unknown> {
    return {
      number: toHex(n),
      hash: hashOf(n),
      parentHash: hashOf(n - 1),
      timestamp: toHex(Math.floor(Date.now() / 1000)),
      nonce: "0x0000000000000000",
      difficulty: "0x0",
      gasLimit: "0x1c9c380",
      gasUsed: "0x0",
      miner: "0x0000000000000000000000000000000000000000",
      extraData: "0x",
      baseFeePerGas: "0x1",
      mixHash: hashOf(0),
      stateRoot: hashOf(0),
      receiptsRoot: hashOf(0),
      transactions: [],
    };
  }

  // One chain for all connections: the head advances on a fixed tick and is
  // pushed to every live subscription.
  const ticker = setInterval(() => {
    blockNumber++;
    for (const [ws, subId] of subscriptions) {
      stats.pushed.add(blockNumber);
      send(ws, {
        jsonrpc: "2.0",
        method: "eth_subscription",
        params: { subscription: subId, result: header(blockNumber) },
      });
    }
  }, PUSH_INTERVAL_MS);

  server.on("connection", (ws) => {
    stats.connections++;
    const connection = stats.connections;
    let answeredGetBlocks = 0;

    ws.on("message", (raw) => {
      let msg: { id?: number; method?: string; params?: unknown[] };
      try {
        msg = JSON.parse(raw.toString()) as typeof msg;
      } catch {
        return;
      }
      switch (msg.method) {
        case "eth_chainId":
          send(ws, { jsonrpc: "2.0", id: msg.id, result: "0x1" });
          return;
        case "net_version":
          send(ws, { jsonrpc: "2.0", id: msg.id, result: "1" });
          return;
        case "eth_blockNumber":
          send(ws, { jsonrpc: "2.0", id: msg.id, result: toHex(blockNumber) });
          return;
        case "eth_subscribe": {
          const subId = `0x${connection.toString(16).padStart(32, "0")}`;
          subscriptions.set(ws, subId);
          send(ws, { jsonrpc: "2.0", id: msg.id, result: subId });
          return;
        }
        case "eth_unsubscribe":
          subscriptions.delete(ws);
          send(ws, { jsonrpc: "2.0", id: msg.id, result: true });
          return;
        case "eth_getBlockByNumber": {
          const requested = Number.parseInt(String(msg.params?.[0]), 16);
          stats.getBlockRequests++;
          stats.requested.push({ connection, block: requested });
          if (
            connection === 1 &&
            answeredGetBlocks >= ANSWERED_ON_FIRST_CONNECTION
          ) {
            stats.withheld++;
            if (options.closeFirstConnectionOnHang && stats.withheld === 1) {
              setTimeout(() => ws.close(), 100);
            }
            return;
          }
          answeredGetBlocks++;
          send(ws, { jsonrpc: "2.0", id: msg.id, result: block(requested) });
          return;
        }
        default:
          send(ws, {
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32601, message: `method ${msg.method} not found` },
          });
      }
    });

    ws.on("close", () => {
      subscriptions.delete(ws);
    });
  });

  return {
    server,
    port,
    head: () => blockNumber,
    stats,
    stop: async () => {
      clearInterval(ticker);
      for (const client of server.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for: ${label}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// Teardown of an ethers provider rejects the in-flight eth_unsubscribe with
// "provider destroyed; cancelled request". This is known, benign noise.
function isBenignDestroyRace(reason: unknown): boolean {
  if (!(reason instanceof Error)) {
    return false;
  }
  const code = (reason as Error & { code?: string }).code;
  const operation = (reason as Error & { operation?: string }).operation;
  return code === "UNSUPPORTED_OPERATION" && operation === "eth_unsubscribe";
}

describe("ChainMonitor: socket closes while getBlock is in flight", () => {
  let mock: MockServer | null = null;
  let monitor: ChainMonitor | null = null;
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
    vi.mocked(enqueueBlockTrigger).mockClear();
    // Keep the other liveness paths out of the way so only the behaviour
    // under test decides whether the monitor recovers.
    vi.stubEnv("BLOCK_ADVANCE_TIMEOUT_MS", "60000");
    vi.stubEnv("MONITOR_RECREATE_TIMEOUT_MS", "120000");
    vi.stubEnv("PRIMARY_PROBE_INTERVAL_MS", "600000");
    vi.stubEnv("GET_BLOCK_TIMEOUT_MS", String(GET_BLOCK_TIMEOUT_MS));
    vi.stubEnv("GET_BLOCK_RETRY_DELAY_MS", String(GET_BLOCK_RETRY_DELAY_MS));
    const silence = (): void => {
      // keep test output readable; assertions do not depend on logs
    };
    vi.spyOn(console, "log").mockImplementation(silence);
    vi.spyOn(console, "warn").mockImplementation(silence);
  });

  afterEach(async () => {
    if (monitor) {
      await monitor.stop().catch(() => {
        // teardown only
      });
      monitor = null;
    }
    if (mock) {
      await mock.stop();
      mock = null;
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  async function startMonitor(options: ServerOptions): Promise<MockServer> {
    mock = startMockServer(options);
    const port = await mock.port;
    monitor = new ChainMonitor({
      chain: {
        chainId: 1,
        name: "TestChain",
        defaultPrimaryWss: `ws://127.0.0.1:${port}`,
        defaultFallbackWss: null,
      },
      workflows: [
        {
          id: "wf1",
          name: "every block",
          userId: "u1",
          organizationId: null,
          network: "1",
          blockInterval: 1,
        },
      ],
    });
    await monitor.start();
    return mock;
  }

  function lag(server: MockServer): number {
    const lastBlock = monitor?.getStatus().lastBlock ?? 0;
    return server.head() - lastBlock;
  }

  function dispatchedBlocks(): number[] {
    return vi
      .mocked(enqueueBlockTrigger)
      .mock.calls.map(([message]) => message.triggerData.blockNumber);
  }

  it("socket recycle: takes block data from the push and calls getBlock only for blocks that were never pushed", async () => {
    vi.stubEnv("SOCKET_MAX_AGE_MS", String(SOCKET_MAX_AGE_MS));
    const server = await startMonitor({
      fullHeaders: true,
      closeFirstConnectionOnHang: false,
    });

    await waitFor(
      () => server.stats.connections >= 2,
      SOCKET_MAX_AGE_MS * 3,
      "socket recycle",
    );
    await sleep(SOCKET_MAX_AGE_MS);

    expect(lag(server)).toBeLessThanOrEqual(MAX_LAG_BLOCKS);
    // Every block on the first connection arrived as a push, so none needed
    // a fetch, and nothing was left unanswered.
    expect(server.stats.requested.filter((r) => r.connection === 1)).toEqual(
      [],
    );
    expect(server.stats.withheld).toBe(0);
    // Later fetches are the backfill of blocks mined during the reconnect
    // pause, when no subscription existed.
    expect(
      server.stats.requested.filter((r) => server.stats.pushed.has(r.block)),
    ).toEqual([]);
    const [first] = vi.mocked(enqueueBlockTrigger).mock.calls[0];
    expect(first.triggerData.blockHash).toBe(
      hashOf(first.triggerData.blockNumber),
    );
  }, 15_000);

  it("socket recycle: an unanswered getBlock fallback times out and the monitor keeps dispatching", async () => {
    vi.stubEnv("SOCKET_MAX_AGE_MS", String(SOCKET_MAX_AGE_MS));
    const server = await startMonitor({
      fullHeaders: false,
      closeFirstConnectionOnHang: false,
    });

    await waitFor(
      () => server.stats.withheld >= 1,
      SOCKET_MAX_AGE_MS,
      "first withheld getBlock",
    );
    const stuckAt = monitor?.getStatus().lastBlock ?? 0;
    await waitFor(
      () => server.stats.connections >= 2,
      SOCKET_MAX_AGE_MS * 3,
      "socket recycle",
    );
    await sleep(SOCKET_MAX_AGE_MS);

    expect(lag(server)).toBeLessThanOrEqual(MAX_LAG_BLOCKS);
    // The withheld block itself is retried and dispatched, not skipped.
    expect(dispatchedBlocks()).toContain(stuckAt + 1);
  }, 15_000);

  it("upstream close: an unanswered getBlock fallback times out and the monitor keeps dispatching", async () => {
    vi.stubEnv("SOCKET_MAX_AGE_MS", String(60 * 60_000));
    const server = await startMonitor({
      fullHeaders: false,
      closeFirstConnectionOnHang: true,
    });

    await waitFor(
      () => server.stats.withheld >= 1,
      SOCKET_MAX_AGE_MS,
      "first withheld getBlock",
    );
    const stuckAt = monitor?.getStatus().lastBlock ?? 0;
    await waitFor(
      () => server.stats.connections >= 2,
      SOCKET_MAX_AGE_MS * 3,
      "reconnect after upstream close",
    );
    await sleep(SOCKET_MAX_AGE_MS);

    expect(lag(server)).toBeLessThanOrEqual(MAX_LAG_BLOCKS);
    // The withheld block itself is retried and dispatched, not skipped.
    expect(dispatchedBlocks()).toContain(stuckAt + 1);
  }, 15_000);
});
