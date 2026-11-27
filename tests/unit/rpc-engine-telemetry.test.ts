import { describe, expect, it, type Mock, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { SecretUrl } from "@/lib/rpc/engine/secret-url";
import { createRouteSink } from "@/lib/rpc/engine/telemetry/route-sink";
import {
  RpcErrorType,
  RpcOperationType,
  RpcTelemetryEventType,
  type RpcTelemetrySink,
} from "@/lib/rpc/engine/telemetry/sink";
import {
  RpcUsageAccumulator,
  type RpcUsageKey,
} from "@/lib/rpc/engine/telemetry/usage";
import {
  RpcChainType,
  type RpcEndpoint,
  RpcEndpointRole,
  RpcOrigin,
  type RpcRoute,
  RpcRoutePosition,
  RpcTransport,
} from "@/lib/rpc/engine/types";

const READ = RpcOperationType.READ;
const { PRIMARY, FALLBACK } = RpcRoutePosition;
const ORG_ID = "org_1";
const CONFIG_ID = "cfg_main";

type SpySink = { [K in keyof RpcTelemetrySink]: Mock<RpcTelemetrySink[K]> };

function spySink(): SpySink {
  return {
    attempt: vi.fn(),
    failure: vi.fn(),
    success: vi.fn(),
    latency: vi.fn(),
    errorType: vi.fn(),
    failover: vi.fn(),
    recovery: vi.fn(),
    bothFailed: vi.fn(),
    event: vi.fn(),
  };
}

function endpoint(origin: RpcOrigin, host: string): RpcEndpoint {
  const isOrg = origin === RpcOrigin.ORG;
  return {
    origin,
    role: RpcEndpointRole.PRIMARY,
    transport: RpcTransport.HTTP,
    url: SecretUrl.parse(`https://${host}.example.com/key`),
    configId: isOrg ? CONFIG_ID : null,
    configName: isOrg ? "Main" : null,
  };
}

function route(
  primary: RpcEndpoint,
  fallback: RpcEndpoint | undefined,
  organizationId: string | null
): RpcRoute {
  return {
    key: "route-key",
    chain: {
      chainId: 1,
      name: "Ethereum",
      chainType: RpcChainType.EVM,
      isEnabled: true,
    },
    transport: RpcTransport.HTTP,
    primary,
    fallback,
    organizationId,
    ownRpcOnly: false,
    notices: [],
  };
}

function driveEveryCall(sink: RpcTelemetrySink): void {
  for (const position of [PRIMARY, FALLBACK]) {
    sink.attempt(position, READ);
    sink.failure(position, READ);
    sink.success(position, READ);
    sink.latency(position, 120, READ);
    sink.errorType(position, RpcErrorType.TIMEOUT, READ);
    sink.errorType(position, RpcErrorType.RATE_LIMIT, READ);
  }
  sink.failover();
  sink.recovery();
  sink.bothFailed();
  sink.event({ type: RpcTelemetryEventType.FALLBACK_FAILED, error: "x" });
  sink.event({ type: RpcTelemetryEventType.FAILOVER_ACTIVATED, error: "x" });
  sink.event({ type: RpcTelemetryEventType.RECOVERED });
  sink.event({ type: RpcTelemetryEventType.BOTH_FAILED, detail: "x" });
  sink.event({ type: RpcTelemetryEventType.CREATED, hasFallback: true });
}

function totalCalls(sink: SpySink): number {
  return Object.values(sink).reduce((sum, fn) => sum + fn.mock.calls.length, 0);
}

describe("createRouteSink", () => {
  it("returns the platform sink itself for KeeperHub traffic", () => {
    const platformSink = spySink();
    const sink = createRouteSink(
      route(
        endpoint(RpcOrigin.PLATFORM, "kh-a"),
        endpoint(RpcOrigin.PLATFORM, "kh-b"),
        null
      ),
      { platformSink, recorder: new RpcUsageAccumulator() }
    );
    expect(sink).toBe(platformSink);
  });

  it("sends nothing about organization endpoints to the platform sink", () => {
    const platformSink = spySink();
    const recorder = new RpcUsageAccumulator();
    const sink = createRouteSink(
      route(
        endpoint(RpcOrigin.ORG, "org-a"),
        endpoint(RpcOrigin.ORG, "org-b"),
        ORG_ID
      ),
      { platformSink, recorder }
    );

    driveEveryCall(sink);

    expect(totalCalls(platformSink)).toBe(0);
    expect(recorder.size).toBeGreaterThan(0);
  });

  it("reports only the KeeperHub side of a mixed route to the platform sink", () => {
    const platformSink = spySink();
    const sink = createRouteSink(
      route(
        endpoint(RpcOrigin.ORG, "org-a"),
        endpoint(RpcOrigin.PLATFORM, "kh-b"),
        ORG_ID
      ),
      { platformSink, recorder: new RpcUsageAccumulator() }
    );

    driveEveryCall(sink);

    for (const fn of [
      platformSink.attempt,
      platformSink.failure,
      platformSink.success,
      platformSink.latency,
    ]) {
      expect(fn).toHaveBeenCalled();
      expect(fn.mock.calls.every(([position]) => position === FALLBACK)).toBe(
        true
      );
    }
    // Failover, recovery and the both-failed outage concern the org primary.
    expect(platformSink.failover).not.toHaveBeenCalled();
    expect(platformSink.recovery).not.toHaveBeenCalled();
    expect(platformSink.bothFailed).not.toHaveBeenCalled();
    expect(platformSink.event.mock.calls.map(([event]) => event.type)).toEqual([
      RpcTelemetryEventType.FALLBACK_FAILED,
    ]);
  });

  it("counts KeeperHub endpoints in the organization's usage too", () => {
    const platformSink = spySink();
    const recorder = new RpcUsageAccumulator();
    const sink = createRouteSink(
      route(endpoint(RpcOrigin.PLATFORM, "kh-a"), undefined, ORG_ID),
      { platformSink, recorder }
    );

    sink.attempt(PRIMARY, READ);

    expect(platformSink.attempt).toHaveBeenCalledWith(PRIMARY, READ);
    const [bucket] = recorder.drain();
    expect(bucket).toMatchObject({
      organizationId: ORG_ID,
      configId: null,
      origin: RpcOrigin.PLATFORM,
      chainId: 1,
      transport: RpcTransport.HTTP,
    });
    expect(bucket.counters.requests).toBe(1);
  });

  it("turns calls into usage counters per endpoint", () => {
    const recorder = new RpcUsageAccumulator();
    const sink = createRouteSink(
      route(
        endpoint(RpcOrigin.ORG, "org-a"),
        endpoint(RpcOrigin.PLATFORM, "kh-b"),
        ORG_ID
      ),
      { platformSink: spySink(), recorder }
    );

    sink.attempt(PRIMARY, READ);
    sink.latency(PRIMARY, 100, READ);
    sink.failure(PRIMARY, READ);
    sink.errorType(PRIMARY, RpcErrorType.TIMEOUT, READ);
    sink.attempt(PRIMARY, READ);
    sink.latency(PRIMARY, 300, READ);
    sink.errorType(PRIMARY, RpcErrorType.RATE_LIMIT, READ);
    sink.failover();
    sink.attempt(FALLBACK, READ);

    const byOrigin = new Map(recorder.drain().map((b) => [b.origin, b]));
    expect(byOrigin.get(RpcOrigin.ORG)?.counters).toMatchObject({
      requests: 2,
      errors: 1,
      timeouts: 1,
      rateLimited: 1,
      failovers: 1,
      latencyMsSum: 400,
      latencyMsMax: 300,
    });
    expect(byOrigin.get(RpcOrigin.ORG)?.configId).toBe(CONFIG_ID);
    expect(byOrigin.get(RpcOrigin.PLATFORM)?.counters.requests).toBe(1);
  });
});

describe("RpcUsageAccumulator", () => {
  const key: RpcUsageKey = {
    organizationId: ORG_ID,
    configId: CONFIG_ID,
    origin: RpcOrigin.ORG,
    chainId: 1,
    transport: RpcTransport.HTTP,
  };

  it("buckets by UTC hour", () => {
    let now = Date.UTC(2026, 0, 1, 10, 59, 59);
    const acc = new RpcUsageAccumulator(() => now);
    acc.record(key, { requests: 1 });
    now = Date.UTC(2026, 0, 1, 11, 0, 0);
    acc.record(key, { requests: 1 });

    const hours = acc.drain().map((b) => b.hour.getTime());
    expect(hours).toEqual([Date.UTC(2026, 0, 1, 10), Date.UTC(2026, 0, 1, 11)]);
  });

  it("drains once and restores what a failed write handed back", () => {
    const acc = new RpcUsageAccumulator(() => Date.UTC(2026, 0, 1, 10));
    acc.record(key, { requests: 2, latencyMsMax: 50 });
    const first = acc.drain();
    expect(acc.drain()).toEqual([]);

    acc.record(key, { requests: 1, latencyMsMax: 80 });
    acc.restore(first);

    const [merged] = acc.drain();
    expect(merged.counters.requests).toBe(3);
    expect(merged.counters.latencyMsMax).toBe(80);
  });
});
