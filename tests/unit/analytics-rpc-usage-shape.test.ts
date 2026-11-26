import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  parseRpcUsageRow,
  rpcUsageBucketInterval,
  rpcUsageWindowStart,
} from "@/lib/analytics/rpc-usage";
import {
  KEEPERHUB_ENDPOINT_LABEL,
  REMOVED_CONFIG_LABEL,
  type RpcUsageRow,
  rpcEndpointLabel,
  rpcStepEndpointLabel,
  rpcUsageBreakdown,
  rpcUsageBuckets,
  shareOf,
  summarizeRpcUsage,
} from "@/lib/analytics/rpc-usage-shape";
import { RpcOrigin } from "@/lib/rpc/engine/types";
import { DAY_MS, HOUR_MS } from "@/lib/utils/duration";

const H0 = "2026-01-01T00:00:00.000Z";
const H1 = "2026-01-01T01:00:00.000Z";

function row(overrides: Partial<RpcUsageRow>): RpcUsageRow {
  return {
    bucket: H0,
    origin: RpcOrigin.ORG,
    configId: "cfg-1",
    configName: "Main",
    chainId: 1,
    chainName: "Ethereum",
    requests: 0,
    errors: 0,
    timeouts: 0,
    rateLimited: 0,
    failovers: 0,
    latencyMsSum: 0,
    latencyMsMax: 0,
    wsConnects: 0,
    wsReconnects: 0,
    eventsReceived: 0,
    ...overrides,
  };
}

const rows: RpcUsageRow[] = [
  row({ requests: 10, errors: 1, latencyMsSum: 500, latencyMsMax: 90 }),
  row({ bucket: H1, requests: 30, latencyMsSum: 1500, latencyMsMax: 200 }),
  row({
    origin: RpcOrigin.PLATFORM,
    configId: null,
    configName: null,
    requests: 10,
    errors: 2,
    timeouts: 1,
    failovers: 1,
    latencyMsSum: 1000,
    latencyMsMax: 120,
  }),
  // A removed config: its usage stays, its name is gone.
  row({
    configId: "cfg-gone",
    configName: null,
    chainId: 8453,
    chainName: "Base",
    requests: 5,
  }),
];

describe("summarizeRpcUsage", () => {
  it("splits requests by origin and averages latency over requests", () => {
    const summary = summarizeRpcUsage(rows);
    expect(summary).toMatchObject({
      requests: 55,
      ownRequests: 45,
      platformRequests: 10,
      errors: 3,
      timeouts: 1,
      failovers: 1,
      avgLatencyMs: Math.round(3000 / 55),
      maxLatencyMs: 200,
    });
  });

  it("reports no latency when there were no requests", () => {
    const summary = summarizeRpcUsage([]);
    expect(summary.requests).toBe(0);
    expect(summary.avgLatencyMs).toBeNull();
    expect(summary.maxLatencyMs).toBeNull();
  });
});

describe("rpcUsageBreakdown", () => {
  it("groups by endpoint and chain, busiest first, keeping removed configs", () => {
    const breakdown = rpcUsageBreakdown(rows);
    expect(
      breakdown.map((r) => [r.origin, r.configId, r.chainId, r.requests])
    ).toEqual([
      [RpcOrigin.ORG, "cfg-1", 1, 40],
      [RpcOrigin.PLATFORM, null, 1, 10],
      [RpcOrigin.ORG, "cfg-gone", 8453, 5],
    ]);
    const removed = breakdown.find((r) => r.configId === "cfg-gone");
    expect(removed).toMatchObject({ configRemoved: true, configName: null });
    const platform = breakdown.find((r) => r.origin === RpcOrigin.PLATFORM);
    expect(platform?.configRemoved).toBe(false);
    expect(breakdown[0]).toMatchObject({ avgLatencyMs: 50, maxLatencyMs: 200 });
  });
});

describe("rpcUsageBuckets", () => {
  it("fills the skeleton and splits requests by origin", () => {
    const buckets = rpcUsageBuckets([H0, H1], rows);
    expect(buckets).toEqual([
      { timestamp: H0, ownRequests: 15, platformRequests: 10, errors: 3 },
      { timestamp: H1, ownRequests: 30, platformRequests: 0, errors: 0 },
    ]);
  });

  it("keeps empty skeleton buckets", () => {
    expect(rpcUsageBuckets([H0], [])).toEqual([
      { timestamp: H0, ownRequests: 0, platformRequests: 0, errors: 0 },
    ]);
  });
});

describe("labels", () => {
  it("names KeeperHub, a config, and a removed config", () => {
    expect(
      rpcEndpointLabel({ origin: RpcOrigin.PLATFORM, configName: null })
    ).toBe(KEEPERHUB_ENDPOINT_LABEL);
    expect(
      rpcEndpointLabel({ origin: RpcOrigin.ORG, configName: "Main" })
    ).toBe("Main");
    expect(rpcEndpointLabel({ origin: RpcOrigin.ORG, configName: null })).toBe(
      REMOVED_CONFIG_LABEL
    );
  });

  it("names the endpoint that served a step", () => {
    expect(
      rpcStepEndpointLabel({ rpcOrigin: RpcOrigin.ORG, rpcConfigName: "Main" })
    ).toBe("Your endpoint: Main");
    expect(
      rpcStepEndpointLabel({
        rpcOrigin: RpcOrigin.PLATFORM,
        rpcConfigName: null,
      })
    ).toBe(KEEPERHUB_ENDPOINT_LABEL);
    expect(
      rpcStepEndpointLabel({ rpcOrigin: null, rpcConfigName: null })
    ).toBeNull();
  });

  it("computes shares without dividing by zero", () => {
    expect(shareOf(1, 4)).toBe(0.25);
    expect(shareOf(0, 0)).toBeNull();
  });
});

describe("rpc usage query helpers", () => {
  it("never buckets finer than the stored hour", () => {
    expect(rpcUsageBucketInterval(HOUR_MS).intervalMs).toBe(HOUR_MS);
    expect(rpcUsageBucketInterval(30 * DAY_MS).intervalMs).toBe(DAY_MS);
  });

  it("starts the window at the stored hour it falls in", () => {
    expect(
      rpcUsageWindowStart(new Date("2026-01-01T05:42:10.000Z")).toISOString()
    ).toBe("2026-01-01T05:00:00.000Z");
  });

  it("parses Postgres sums into numbers", () => {
    const parsed = parseRpcUsageRow({
      bucket: new Date(H0),
      origin: RpcOrigin.ORG,
      configId: "cfg-1",
      configName: "Main",
      chainId: 1,
      chainName: null,
      requests: "12",
      errors: null,
      timeouts: "0",
      rateLimited: "1",
      failovers: "0",
      latencyMsSum: "300",
      latencyMsMax: 40,
      wsConnects: "0",
      wsReconnects: "0",
      eventsReceived: "0",
    });
    expect(parsed).toMatchObject({
      bucket: H0,
      requests: 12,
      errors: 0,
      rateLimited: 1,
      latencyMsSum: 300,
      latencyMsMax: 40,
    });
  });
});
