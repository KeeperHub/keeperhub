import type { AddressInfo } from "node:net";
import { Registry } from "prom-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type HealthServerHandle,
  buildHealthResponse,
  buildLivenessResponse,
  startHealthServer,
} from "../../src/health/health-server";
import type {
  ConnectionHealth,
  ConnectionState,
} from "../../src/ingest/solana-connection";
import type { LivenessSnapshot } from "../../src/main";

function chain(
  chainId: number,
  connected: boolean,
  state: ConnectionState = connected ? "live" : "failed",
  activeEndpoint = "wss://lb.example.com/[redacted]",
): ConnectionHealth {
  return {
    chainId,
    source: "signatures",
    connected,
    state,
    reconnecting: state === "reconnecting",
    lastSlotAt: connected ? Date.now() : null,
    subscribedAt: Date.now(),
    activeEndpoint,
    endpointIndex: 0,
    endpointCount: 2,
    reconnects: 0,
    abandonedSubscriptions: 0,
    lastError: connected ? null : "down",
  };
}

const NOW = 1_000_000_000;

function snapshot(over: Partial<LivenessSnapshot> = {}): LivenessSnapshot {
  return {
    processStartedAt: NOW - 1_000,
    lastSyncStartedAt: NOW - 1_000,
    lastSyncCompletedAt: NOW - 900,
    ...over,
  };
}

describe("buildHealthResponse", () => {
  it("is 200 with no chains, which now means nothing is configured", () => {
    const { status, body } = buildHealthResponse([]);
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
  });

  it("is 200 when every chain is connected", () => {
    expect(
      buildHealthResponse([chain(101, true), chain(103, true)]).status,
    ).toBe(200);
  });

  it("is 503 when any single chain is disconnected", () => {
    const { status, body } = buildHealthResponse([
      chain(101, true),
      chain(103, false),
    ]);
    expect(status).toBe(503);
    expect(body.status).toBe("degraded");
  });

  it("is 503 for an unimplemented source", () => {
    // A chain routed to a source nobody wired really is not ingesting, so
    // /healthz says so. The alert excludes this state instead; do not "fix"
    // this to 200.
    expect(
      buildHealthResponse([chain(101, false, "unimplemented")]).status,
    ).toBe(503);
  });
});

describe("buildLivenessResponse", () => {
  it("is 200 and starting before the first sync has run", () => {
    const { status, body } = buildLivenessResponse(
      snapshot({ lastSyncStartedAt: null, processStartedAt: NOW - 60_000 }),
      NOW,
    );
    expect(status).toBe(200);
    expect(body.status).toBe("starting");
  });

  it("is 503 when no sync has ever started well past the startup grace", () => {
    const { status, body } = buildLivenessResponse(
      snapshot({ lastSyncStartedAt: null, processStartedAt: NOW - 900_000 }),
      NOW,
    );
    expect(status).toBe(503);
    expect(body.status).toBe("wedged");
  });

  it("is 200 while the reconcile interval keeps firing", () => {
    const { status, body } = buildLivenessResponse(
      snapshot({ lastSyncStartedAt: NOW - 119_000 }),
      NOW,
    );
    expect(status).toBe(200);
    expect(body.status).toBe("alive");
  });

  it("is 503 once the interval has stopped firing", () => {
    expect(
      buildLivenessResponse(snapshot({ lastSyncStartedAt: NOW - 121_000 }), NOW)
        .status,
    ).toBe(503);
  });

  it("keys off sync start, not completion, so a hung upstream is not a restart", () => {
    // A hung discovery call or RPC read leaves lastSyncCompletedAt far behind
    // while the interval keeps firing. Restarting there would take every
    // healthy chain down for someone else's outage.
    const { status } = buildLivenessResponse(
      snapshot({
        lastSyncStartedAt: NOW - 1_000,
        lastSyncCompletedAt: NOW - 3_600_000,
      }),
      NOW,
    );
    expect(status).toBe(200);
  });
});

describe("HTTP server", () => {
  let handle: HealthServerHandle;
  let chains: ConnectionHealth[];
  let liveness: LivenessSnapshot;
  let registry: Registry;

  beforeEach(async () => {
    chains = [chain(101, true)];
    // Real clock here: the HTTP suite runs on real timers, so the fixed NOW
    // used by the pure-function suite would read as decades of silence.
    liveness = {
      processStartedAt: Date.now() - 1_000,
      lastSyncStartedAt: Date.now() - 1_000,
      lastSyncCompletedAt: Date.now() - 900,
    };
    registry = new Registry();
    // Port 0 = let the OS assign a free one, avoiding contention in CI.
    handle = await startHealthServer(
      {
        getHealth: () => chains,
        getLiveness: () => ({
          processStartedAt: Date.now() - 1_000,
          lastSyncStartedAt: liveness.lastSyncStartedAt,
          lastSyncCompletedAt: liveness.lastSyncCompletedAt,
        }),
        refreshMetrics: () => {
          // no-op: the metric contents are covered by the metrics tests
        },
        registry,
      },
      0,
    );
  });

  afterEach(async () => {
    await handle.close();
  });

  const get = (path: string) => fetch(`http://127.0.0.1:${handle.port}${path}`);

  it("keeps /livez at 200 while every chain is down", async () => {
    // This is the regression test for the whole ticket. On 2026-09-09 a single
    // silent chain made the liveness probe fail and the kubelet restarted the
    // pod four times, taking Solana mainnet ingestion with it.
    chains = [chain(101, false), chain(103, false)];
    liveness = { ...liveness, lastSyncStartedAt: Date.now() - 1_000 };

    const livez = await get("/livez");
    const healthz = await get("/healthz");

    expect(livez.status).toBe(200);
    expect(healthz.status).toBe(503);
  });

  it("serves /healthz 200 when the chain is connected", async () => {
    const res = await get("/healthz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  it("serves the Prometheus exposition on /metrics", async () => {
    registry.setDefaultLabels({});
    const res = await get("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
  });

  it("404s unknown paths", async () => {
    expect((await get("/nope")).status).toBe(404);
  });

  it("strips query strings", async () => {
    expect((await get("/livez?verbose=1")).status).toBe(200);
    expect((await get("/healthz?verbose=1")).status).toBe(200);
  });

  it("binds a concrete port via the returned handle", () => {
    expect(handle.port).toBeGreaterThan(0);
    expect((handle.server.address() as AddressInfo).port).toBe(handle.port);
  });

  it("never leaks a credential in any response body", async () => {
    chains = [chain(101, false, "failed", "wss://lb.example.com/[redacted]")];
    const body = await (await get("/healthz")).text();
    expect(body).not.toContain("SECRET");
    expect(body).toContain("[redacted]");
  });
});
