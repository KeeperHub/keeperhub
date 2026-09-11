import { describe, expect, it, vi } from "vitest";
import type {
  BlockSource,
  ConnectionHealth,
  ConnectionState,
  Endpoint,
} from "../../src/ingest/block-source";
import { CompositeSource } from "../../src/ingest/composite-source";

const ENDPOINTS: Endpoint[] = [{ rpcUrl: "https://rpc", wssUrl: "wss://ws" }];

function health(
  connected: boolean,
  endpoint = "wss://ws",
  state: ConnectionState = connected ? "live" : "failed",
): ConnectionHealth {
  return {
    chainId: 101,
    source: "signatures",
    connected,
    state,
    reconnecting: false,
    lastSlotAt: null,
    subscribedAt: null,
    activeEndpoint: endpoint,
    endpointIndex: 0,
    endpointCount: 1,
    reconnects: 0,
    abandonedSubscriptions: 0,
    lastError: connected ? null : "down",
  };
}

function member(overrides: Partial<BlockSource> = {}): BlockSource {
  return {
    start: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()),
    getHealth: () => health(true),
    ...overrides,
  };
}

describe("CompositeSource", () => {
  it("starts and stops every member", async () => {
    const a = member();
    const b = member();
    const composite = new CompositeSource(101, ENDPOINTS, [a, b]);

    await composite.start();
    expect(a.start).toHaveBeenCalledTimes(1);
    expect(b.start).toHaveBeenCalledTimes(1);

    await composite.stop();
    expect(a.stop).toHaveBeenCalledTimes(1);
    expect(b.stop).toHaveBeenCalledTimes(1);
  });

  it("unwinds already-started members when a later member fails to start", async () => {
    // A half-started composite would serve one trigger type and silently drop
    // the other, which is the failure mode this guards.
    const started = member();
    const failing = member({
      start: vi.fn(() => Promise.reject(new Error("geyser down"))),
    });
    const composite = new CompositeSource(101, ENDPOINTS, [started, failing]);

    await expect(composite.start()).rejects.toThrow("geyser down");
    expect(started.stop).toHaveBeenCalledTimes(1);
  });

  it("keeps stopping the remaining members when one stop throws", async () => {
    const throwing = member({
      stop: vi.fn(() => Promise.reject(new Error("stop boom"))),
    });
    const other = member();
    const composite = new CompositeSource(101, ENDPOINTS, [throwing, other]);

    await expect(composite.stop()).resolves.toBeUndefined();
    expect(other.stop).toHaveBeenCalledTimes(1);
  });

  it("reports unhealthy when any member is disconnected", async () => {
    const composite = new CompositeSource(101, ENDPOINTS, [
      member(),
      member({ getHealth: () => health(false) }),
    ]);

    expect(composite.getHealth().connected).toBe(false);
    await composite.stop();
  });

  it("reports the first member's health when every member is connected", () => {
    const composite = new CompositeSource(101, ENDPOINTS, [
      member({ getHealth: () => health(true, "wss://primary") }),
      member({ getHealth: () => health(true, "wss://secondary") }),
    ]);

    const result = composite.getHealth();
    expect(result.connected).toBe(true);
    expect(result.activeEndpoint).toBe("wss://primary");
  });

  it("reports disconnected when it has no members", () => {
    const composite = new CompositeSource(101, ENDPOINTS, []);
    expect(composite.getHealth().connected).toBe(false);
  });

  it("sums counters across members instead of taking the worst member's", () => {
    // Which member ranks worst changes over time; its own totals would make the
    // chain's counters jump between two unrelated histories.
    const composite = new CompositeSource(101, ENDPOINTS, [
      member({
        getHealth: () => ({
          ...health(true),
          reconnects: 2,
          abandonedSubscriptions: 1,
        }),
      }),
      member({ getHealth: () => ({ ...health(false), reconnects: 3 }) }),
    ]);

    const reported = composite.getHealth();
    expect(reported.connected).toBe(false);
    expect(reported.reconnects).toBe(5);
    expect(reported.abandonedSubscriptions).toBe(1);
  });
});
