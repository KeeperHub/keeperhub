import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

vi.mock("server-only", () => ({}));

const { fakeDns, lookupCalls } = vi.hoisted(() => ({
  fakeDns: new Map<string, { address: string; family: number }[]>(),
  lookupCalls: [] as string[],
}));

vi.mock("node:dns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns")>();
  function lookup(
    hostname: string,
    _options: { all?: boolean },
    callback: (...args: unknown[]) => void
  ): void {
    lookupCalls.push(hostname);
    setImmediate(() => callback(null, fakeDns.get(hostname) ?? []));
  }
  return { ...actual, lookup };
});

vi.mock("@/lib/metrics", () => ({
  getMetricsCollector: () => ({
    incrementCounter: vi.fn(),
    recordLatency: vi.fn(),
    recordError: vi.fn(),
    setGauge: vi.fn(),
  }),
}));

vi.mock("@/lib/logging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/logging")>()),
  logSecurityEvent: vi.fn(),
}));

import { liveRpcProbe } from "@/lib/rpc/engine/org/verify";
import { RpcTransport } from "@/lib/rpc/engine/types";

const REBOUND_HOST = "rebound.example";

describe("liveRpcProbe wss dial", () => {
  let server: WebSocketServer;
  let connections: number;

  beforeEach(async () => {
    vi.stubEnv("SAFE_FETCH_SHADOW", "false");
    connections = 0;
    fakeDns.clear();
    lookupCalls.length = 0;
    server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("connection", (socket) => {
      connections += 1;
      socket.on("message", (data) => {
        const { id } = JSON.parse(String(data)) as { id: number };
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, result: "0x1" }));
      });
    });
    await new Promise((resolve) => server.once("listening", resolve));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await new Promise((resolve) => server.close(resolve));
  });

  it("refuses a host that resolves to an internal address at connect time", async () => {
    fakeDns.set(REBOUND_HOST, [{ address: "127.0.0.1", family: 4 }]);
    const { port } = server.address() as AddressInfo;

    await expect(
      liveRpcProbe.evm(
        `ws://${REBOUND_HOST}:${port}/key`,
        RpcTransport.WSS,
        1,
        false
      )
    ).rejects.toThrow();
    expect(lookupCalls).toContain(REBOUND_HOST);
    expect(connections).toBe(0);
  });

  it("answers through the checked address when the target is allowed", async () => {
    vi.stubEnv("SAFE_FETCH_SHADOW", "true");
    fakeDns.set(REBOUND_HOST, [{ address: "127.0.0.1", family: 4 }]);
    const { port } = server.address() as AddressInfo;

    await expect(
      liveRpcProbe.evm(
        `ws://${REBOUND_HOST}:${port}/key`,
        RpcTransport.WSS,
        1,
        false
      )
    ).resolves.toBe(BigInt(1));
    expect(connections).toBe(1);
  });
});
