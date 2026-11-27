import { AsyncLocalStorage } from "node:async_hooks";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/sleep", () => ({ sleep: vi.fn().mockResolvedValue(undefined) }));

const logging = vi.hoisted(() => ({
  logSystemError: vi.fn(),
  logSystemWarn: vi.fn(),
  logUserError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));
vi.mock("@/lib/logging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/logging")>()),
  ...logging,
}));

import { ErrorCategory } from "@/lib/logging";
import { createRpcEngine, type RpcEngine } from "@/lib/rpc/engine/engine";
import { RpcRouteError, RpcRouteErrorCode } from "@/lib/rpc/engine/route-error";
import { orgScope, platformScope } from "@/lib/rpc/engine/scope";
import { SecretUrl } from "@/lib/rpc/engine/secret-url";
import type { OrgRpcSource } from "@/lib/rpc/engine/sources/org-source";
import type {
  PlatformChainRecord,
  PlatformRpcSource,
} from "@/lib/rpc/engine/sources/platform-source";
import {
  readRpcAttribution,
  runWithRpcAttribution,
  setRpcAttributionStorage,
} from "@/lib/rpc/engine/step-attribution";
import { RpcUsageAccumulator } from "@/lib/rpc/engine/telemetry/usage";
import {
  type OrgRpcState,
  PlatformRpcPurpose,
  RpcChainType,
  RpcEndpointRole,
  RpcOrigin,
  RpcRoutePosition,
} from "@/lib/rpc/engine/types";
import {
  clearRpcProviderManagerCache,
  type FailoverStateChangeCallback,
  type RpcMetricsCollector,
  RpcProviderManager,
} from "@/lib/rpc/providers";
import { clearSolanaProviderManagerCache } from "@/lib/rpc/providers/solana";

const url = (value: string): SecretUrl => SecretUrl.parse(value);

const records: Record<number, PlatformChainRecord> = {
  1: {
    chain: {
      chainId: 1,
      name: "Ethereum",
      chainType: RpcChainType.EVM,
      isEnabled: true,
    },
    endpoints: {
      httpPrimary: url("https://kh-primary.example.com/key"),
      httpFallback: url("https://kh-fallback.example.com/key"),
    },
  },
  101: {
    chain: {
      chainId: 101,
      name: "Solana",
      chainType: RpcChainType.SOLANA,
      isEnabled: true,
    },
    endpoints: { httpPrimary: url("https://kh-solana.example.com/key") },
  },
};

const orgWithConfig: OrgRpcState = {
  policy: { ownRpcOnly: false },
  configs: [
    {
      id: "cfg_main",
      name: "Main",
      chainId: 1,
      enabled: true,
      isDefault: true,
      httpPrimary: url("https://org-primary.example.com/key"),
      httpFallback: url("https://org-fallback.example.com/key"),
    },
  ],
};

function spyCollector(): RpcMetricsCollector {
  return {
    recordPrimaryAttempt: vi.fn(),
    recordPrimaryFailure: vi.fn(),
    recordFallbackAttempt: vi.fn(),
    recordFallbackFailure: vi.fn(),
    recordFailoverEvent: vi.fn(),
    recordRecoveryEvent: vi.fn(),
    recordBothFailed: vi.fn(),
    recordSuccess: vi.fn(),
    recordLatency: vi.fn(),
    recordErrorType: vi.fn(),
  };
}

function collectorCalls(collector: RpcMetricsCollector): number {
  return Object.values(collector).reduce(
    (sum, fn) => sum + vi.mocked(fn).mock.calls.length,
    0
  );
}

const down = (): Promise<never> => Promise.reject(new Error("down"));

describe("createRpcEngine", () => {
  let collector: RpcMetricsCollector;
  let failoverGauge: Mock<FailoverStateChangeCallback>;
  let usage: RpcUsageAccumulator;
  let orgState: OrgRpcState;
  let orgSource: OrgRpcSource & { load: ReturnType<typeof vi.fn> };
  let engine: RpcEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    clearRpcProviderManagerCache();
    clearSolanaProviderManagerCache();
    collector = spyCollector();
    failoverGauge = vi.fn<FailoverStateChangeCallback>();
    usage = new RpcUsageAccumulator();
    orgState = orgWithConfig;
    orgSource = { load: vi.fn(() => Promise.resolve(orgState)) };
    const platformSource: PlatformRpcSource = {
      load: (chainId: number) => Promise.resolve(records[chainId] ?? null),
    };
    engine = createRpcEngine({
      platformSource,
      orgSource,
      usageRecorder: usage,
      evmCollector: () => Promise.resolve(collector),
      solanaCollector: () => Promise.resolve(collector),
      failoverCallback: () => Promise.resolve(failoverGauge),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps an organization endpoint outage out of platform telemetry", async () => {
    const client = await engine.evm(orgScope("org_1"), 1);
    expect(client.route.primary.origin).toBe(RpcOrigin.ORG);

    await expect(client.manager.executeWithFailover(down)).rejects.toThrow(
      "RPC failed on both endpoints"
    );

    expect(collectorCalls(collector)).toBe(0);
    expect(logging.logSystemError).not.toHaveBeenCalled();
    expect(logging.logSystemWarn).not.toHaveBeenCalled();
    expect(logging.logUserError).not.toHaveBeenCalled();
    expect(console.info).not.toHaveBeenCalled();
    expect(failoverGauge).not.toHaveBeenCalled();

    const buckets = usage.drain();
    expect(buckets.every((b) => b.organizationId === "org_1")).toBe(true);
    expect(buckets.reduce((n, b) => n + b.counters.errors, 0)).toBe(6);
  });

  it("reports a KeeperHub outage exactly as before", async () => {
    const client = await engine.evm(
      platformScope(PlatformRpcPurpose.BILLING),
      1
    );

    await expect(client.manager.executeWithFailover(down)).rejects.toThrow(
      "RPC failed on both endpoints"
    );

    expect(collector.recordBothFailed).toHaveBeenCalledWith("Ethereum");
    expect(collector.recordPrimaryAttempt).toHaveBeenCalledTimes(3);
    expect(logging.logSystemError).toHaveBeenCalledWith(
      ErrorCategory.NETWORK_RPC,
      "[RPC] Both primary and fallback RPC failed for Ethereum",
      expect.any(String),
      { event: "RPC_BOTH_ENDPOINTS_FAILED", chain: "Ethereum" }
    );
    expect(usage.size).toBe(0);
    expect(orgSource.load).not.toHaveBeenCalled();
  });

  it("names the endpoint that served the call after a failover", async () => {
    const client = await engine.evm(orgScope("org_1"), 1);
    let calls = 0;
    await client.manager.executeWithFailover(() => {
      calls += 1;
      return calls <= 3 ? down() : Promise.resolve("ok");
    });

    expect(client.activeEndpoint()).toMatchObject({
      origin: RpcOrigin.ORG,
      role: RpcEndpointRole.FALLBACK,
      configId: "cfg_main",
    });
  });

  it("gives each organization its own manager over the same endpoints", async () => {
    const a = await engine.evm(orgScope("org_1"), 1);
    const again = await engine.evm(orgScope("org_1"), 1);
    const b = await engine.evm(orgScope("org_2"), 1);

    expect(again.manager).toBe(a.manager);
    expect(b.manager).not.toBe(a.manager);
  });

  it("shares KeeperHub's manager across organizations and keeps their usage apart", async () => {
    orgState = { policy: { ownRpcOnly: false }, configs: [] };
    const first = await engine.evm(orgScope("org_1"), 1);
    const second = await engine.evm(orgScope("org_2"), 1);
    let calls = 0;
    await first.manager.executeWithFailover(() => {
      calls += 1;
      return calls <= 3 ? down() : Promise.resolve("ok");
    });
    calls = 0;
    await second.manager.executeWithFailover(() => {
      calls += 1;
      return Promise.resolve("ok");
    });

    // The second organization starts on the fallback the first one found.
    expect(calls).toBe(1);
    expect(second.manager.isCurrentlyUsingFallback()).toBe(true);
    const organizations = new Set(
      usage.drain().map((bucket) => bucket.organizationId)
    );
    expect(organizations).toEqual(new Set(["org_1", "org_2"]));
  });

  it("counts a shared manager's own internal calls to the calling organization", async () => {
    orgState = { policy: { ownRpcOnly: false }, configs: [] };
    vi.spyOn(
      RpcProviderManager.prototype,
      "resolveActiveRpcUrl"
    ).mockImplementation(async function (
      this: RpcProviderManager
    ): Promise<string> {
      await this.executeWithFailover(() => Promise.resolve(1));
      return "probed";
    });
    await engine.evm(orgScope("org_1"), 1);
    const second = await engine.evm(orgScope("org_2"), 1);

    await second.manager.resolveActiveRpcUrl();

    expect(usage.drain().map((bucket) => bucket.organizationId)).toEqual([
      "org_2",
    ]);
  });

  it("never hands an organization manager to platform traffic", async () => {
    orgState = { policy: { ownRpcOnly: false }, configs: [] };
    const tenant = await engine.evm(orgScope("org_1"), 1);
    const platform = await engine.evm(
      platformScope(PlatformRpcPurpose.BILLING),
      1
    );

    expect(tenant.route.primary.url.hostname).toBe("kh-primary.example.com");
    expect(platform.manager).not.toBe(tenant.manager);
  });

  it("drives the per-chain fallback gauge only for KeeperHub endpoints", async () => {
    orgState = { policy: { ownRpcOnly: false }, configs: [] };
    const client = await engine.evm(orgScope("org_1"), 1);
    let calls = 0;
    await client.manager.executeWithFailover(() => {
      calls += 1;
      return calls <= 3 ? down() : Promise.resolve("ok");
    });

    expect(failoverGauge).toHaveBeenCalledWith("Ethereum", true, "failover");
  });

  it("raises a route error the caller can show", async () => {
    orgState = { policy: { ownRpcOnly: true }, configs: [] };
    const attempt = engine.evm(orgScope("org_1"), 1);

    await expect(attempt).rejects.toBeInstanceOf(RpcRouteError);
    await expect(attempt).rejects.toMatchObject({
      code: RpcRouteErrorCode.NOT_COVERED,
    });
  });

  it("refuses a client for the wrong chain family", async () => {
    await expect(
      engine.evm(platformScope(PlatformRpcPurpose.BILLING), 101)
    ).rejects.toMatchObject({ code: RpcRouteErrorCode.WRONG_CHAIN_FAMILY });
    await expect(
      engine.solana(platformScope(PlatformRpcPurpose.BILLING), 1)
    ).rejects.toMatchObject({ code: RpcRouteErrorCode.WRONG_CHAIN_FAMILY });
  });

  it("builds Solana clients on the same route rules", async () => {
    const client = await engine.solana(
      platformScope(PlatformRpcPurpose.BILLING),
      101
    );
    expect(client.route.primary.url.hostname).toBe("kh-solana.example.com");
    expect(client.activeEndpoint().origin).toBe(RpcOrigin.PLATFORM);
  });

  it("notes every client it hands out for the step running it", async () => {
    setRpcAttributionStorage(new AsyncLocalStorage());
    const attribution = await runWithRpcAttribution(async () => {
      await engine.evm(platformScope(PlatformRpcPurpose.BILLING), 1);
      await engine.evm(orgScope("org_1"), 1);
      return readRpcAttribution();
    });
    expect(attribution).toEqual({
      rpcOrigin: RpcOrigin.ORG,
      rpcConfigId: "cfg_main",
      rpcFailedOver: false,
      rpcEndpoints: [],
    });
  });

  it("leaves KeeperHub's own reads during a step out of its record", async () => {
    setRpcAttributionStorage(new AsyncLocalStorage());
    const attribution = await runWithRpcAttribution(async () => {
      const billing = await engine.evm(
        platformScope(PlatformRpcPurpose.BILLING),
        1
      );
      await billing.manager.executeWithFailover(() => Promise.resolve("ok"));
      return readRpcAttribution();
    });
    expect(attribution).toBeNull();
  });

  it("leaves an unattributed client out of the step's record", async () => {
    setRpcAttributionStorage(new AsyncLocalStorage());
    const attribution = await runWithRpcAttribution(async () => {
      await engine.evm(platformScope(PlatformRpcPurpose.NO_ORGANIZATION), 1);
      await engine.evm(orgScope("org_1"), 1, { unattributed: true });
      return readRpcAttribution();
    });
    expect(attribution).toEqual({
      rpcOrigin: RpcOrigin.PLATFORM,
      rpcConfigId: null,
      rpcFailedOver: false,
      rpcEndpoints: [],
    });
  });

  it("marks only the step whose call failed over on a shared manager", async () => {
    setRpcAttributionStorage(new AsyncLocalStorage());
    const failedOver = await runWithRpcAttribution(async () => {
      const client = await engine.evm(orgScope("org_1"), 1);
      let calls = 0;
      await client.manager.executeWithFailover(() => {
        calls += 1;
        return calls <= 3 ? down() : Promise.resolve("ok");
      });
      return readRpcAttribution();
    });
    const later = await runWithRpcAttribution(async () => {
      const client = await engine.evm(orgScope("org_1"), 1);
      await client.manager.executeWithFailover(() => Promise.resolve("ok"));
      return readRpcAttribution();
    });
    expect(failedOver?.rpcFailedOver).toBe(true);
    expect(later?.rpcFailedOver).toBe(false);
    // Each endpoint the failed-over step reached, with its own counts.
    const positions = failedOver?.rpcEndpoints.map((usage) => usage.position);
    expect(positions).toEqual(
      expect.arrayContaining([
        RpcRoutePosition.PRIMARY,
        RpcRoutePosition.FALLBACK,
      ])
    );
    const primary = failedOver?.rpcEndpoints.find(
      (usage) => usage.position === RpcRoutePosition.PRIMARY
    );
    expect(primary?.errors).toBeGreaterThan(0);
    expect(primary?.requests).toBeGreaterThanOrEqual(primary?.errors ?? 0);
    // The manager stays on its fallback, so the next step reads there,
    // once and without an error.
    expect(later?.rpcEndpoints).toEqual([
      expect.objectContaining({
        position: RpcRoutePosition.FALLBACK,
        requests: 1,
        errors: 0,
      }),
    ]);
  });

  it("fails for an unknown chain", async () => {
    await expect(
      engine.route(platformScope(PlatformRpcPurpose.BILLING), 999)
    ).rejects.toMatchObject({ code: RpcRouteErrorCode.CHAIN_UNAVAILABLE });
  });
});
