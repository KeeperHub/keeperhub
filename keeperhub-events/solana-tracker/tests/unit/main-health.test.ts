import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildHealthResponse } from "../../src/health/health-server";
import { STARTUP_GRACE_MS } from "../../src/startup-grace";

/**
 * Health reporting in the reconciler.
 *
 * The property under test is that a chain discovery expects always appears in
 * health, whatever happened to it. Before this, a chain whose ingestor threw on
 * start was deleted from the registry, so it vanished from `/healthz` entirely
 * and the endpoint answered 200 while nothing was ingesting.
 */

const hooks = vi.hoisted(() => ({
  discovery: null as unknown,
  registrations: [] as unknown[],
  startFails: new Set<number>(),
  connected: new Set<number>(),
  /** Error message a failing start raises, per chain. */
  startErrors: new Map<number, string>(),
  /** A start for this chain waits on the promise, to hold it mid-start. */
  blockers: new Map<number, Promise<void>>(),
  /** Chains whose ingestor throws on stop() and so keeps running. */
  stopFails: new Set<number>(),
}));

vi.mock("../../src/discovery", () => ({
  fetchSolanaTriggers: () => Promise.resolve(hooks.discovery),
}));

vi.mock("../../src/mapper", () => ({
  buildRegistrations: () => hooks.registrations,
}));

vi.mock("../../src/ingest/block-ingestor", () => ({
  BlockIngestor: class {
    private started = false;
    private readonly chainId: number;
    constructor(opts: { registration: { chainId: number } }) {
      this.chainId = opts.registration.chainId;
    }
    async start(): Promise<void> {
      const blocker = hooks.blockers.get(this.chainId);
      if (blocker) {
        await blocker;
      }
      if (hooks.startFails.has(this.chainId)) {
        throw new Error(
          hooks.startErrors.get(this.chainId) ?? `start boom ${this.chainId}`,
        );
      }
      this.started = true;
    }
    stop(): Promise<void> {
      if (hooks.stopFails.has(this.chainId)) {
        return Promise.reject(new Error(`stop boom ${this.chainId}`));
      }
      this.started = false;
      return Promise.resolve();
    }
    isStarted(): boolean {
      return this.started;
    }
    hasConfigChanged(): boolean {
      return false;
    }
    canUpdateInPlace(): boolean {
      return true;
    }
    updateRegistration(): void {
      // no-op
    }
    getHealth() {
      return {
        chainId: this.chainId,
        source: "signatures" as const,
        connected: hooks.connected.has(this.chainId),
        state: hooks.connected.has(this.chainId)
          ? ("live" as const)
          : ("subscribing" as const),
        reconnecting: false,
        lastSlotAt: hooks.connected.has(this.chainId) ? Date.now() : null,
        subscribedAt: Date.now(),
        activeEndpoint: "wss://lb.example.com/[redacted]",
        endpointIndex: 0,
        endpointCount: 1,
        reconnects: 0,
        abandonedSubscriptions: 0,
        lastError: null,
      };
    }
  },
}));

function registration(chainId: number) {
  return {
    chainId,
    isTestnet: chainId !== 101,
    rpcUrl: "https://rpc",
    wssUrl: "wss://ws",
    commitment: "confirmed",
    eventTriggers: [],
    blockTriggers: [],
    configHash: `hash-${chainId}`,
  };
}

// main.ts keeps its registry, desired and failures maps at module scope, so
// each case needs a fresh module rather than a shared top-level import.
let main: typeof import("../../src/main");

beforeEach(async () => {
  hooks.discovery = { eventWorkflows: [], blockWorkflows: [], networks: {} };
  hooks.registrations = [];
  hooks.startFails = new Set();
  hooks.connected = new Set();
  hooks.startErrors = new Map();
  hooks.blockers = new Map();
  hooks.stopFails = new Set();
  vi.resetModules();
  main = await import("../../src/main");
});

describe("getAllHealth", () => {
  it("keeps a chain that failed to start, as disconnected", async () => {
    hooks.registrations = [registration(101), registration(103)];
    hooks.connected.add(101);
    hooks.startFails.add(103);

    await main.synchronizeData();
    const health = main.getAllHealth();

    expect(health.map((h) => h.chainId).sort()).toEqual([101, 103]);
    const failed = health.find((h) => h.chainId === 103);
    expect(failed?.connected).toBe(false);
    expect(failed?.lastError).toContain("start boom");
    expect(failed?.state).toBe("failed");
    // Nothing is running, so no source is named rather than a guessed one.
    expect(failed?.source).toBe("none");
    // And the endpoint says so, instead of answering 200 over an empty list.
    expect(buildHealthResponse(health).status).toBe(503);
  });

  it("reports nothing and stays healthy when no Solana chains are configured", async () => {
    hooks.registrations = [];

    await main.synchronizeData();

    expect(main.getAllHealth()).toEqual([]);
    expect(buildHealthResponse(main.getAllHealth()).status).toBe(200);
  });

  it("drops a chain once discovery stops returning it", async () => {
    hooks.registrations = [registration(101)];
    hooks.connected.add(101);
    await main.synchronizeData();
    expect(main.getAllHealth()).toHaveLength(1);

    hooks.registrations = [];
    await main.synchronizeData();

    expect(main.getAllHealth()).toEqual([]);
  });

  it("clears a recorded failure once the chain recovers", async () => {
    hooks.registrations = [registration(103)];
    hooks.startFails.add(103);
    await main.synchronizeData();
    expect(main.getAllHealth()[0]?.lastError).toContain("start boom");

    hooks.startFails.delete(103);
    hooks.connected.add(103);
    await main.synchronizeData();

    expect(main.getAllHealth()[0]?.connected).toBe(true);
    expect(main.getAllHealth()[0]?.lastError).toBeNull();
  });
});

describe("reconciler health and metrics", () => {
  it("reports a chain queued on a cold start as idle, not failed", async () => {
    let release: () => void = () => undefined;
    hooks.blockers.set(
      101,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    hooks.registrations = [registration(101), registration(103)];

    const pass = main.synchronizeData();
    await vi.waitFor(() => expect(main.getAllHealth()).toHaveLength(2));

    for (const entry of main.getAllHealth()) {
      expect(entry.state).toBe("idle");
      expect(entry.source).toBe("none");
      expect(entry.connected).toBe(false);
    }

    release();
    await pass;
  });

  it("redacts a provider URL in a start failure before serving it", async () => {
    hooks.registrations = [registration(103)];
    hooks.startFails.add(103);
    hooks.startErrors.set(
      103,
      "request to https://lb.example.com/solana-devnet/SECRETKEY failed, reason: timeout",
    );

    await main.synchronizeData();

    const reported = main.getAllHealth()[0]?.lastError ?? "";
    expect(reported).not.toContain("SECRETKEY");
    expect(reported).toContain("https://lb.example.com/[redacted]");
  });

  it("forgets the series of a failed chain once discovery drops it", async () => {
    // A chain that never started is not in the registry, so dropping it from
    // the registry never forgot its metrics, and its series climbed forever.
    const metricsModule = await import("../../lib/metrics");
    const silence = () =>
      metricsModule.registry.getSingleMetricAsString(
        "keeperhub_solana_tracker_seconds_since_last_slot",
      );
    hooks.registrations = [registration(103)];
    hooks.startFails.add(103);
    await main.synchronizeData();
    main.refreshMetrics();
    expect(await silence()).toContain('chain="103"');

    hooks.registrations = [];
    await main.synchronizeData();
    main.refreshMetrics();
    expect(await silence()).not.toContain('chain="103"');
  });
});

describe("startup grace and stop failures", () => {
  it("reports a chain still not started after the startup grace as failed", async () => {
    // One start that never finishes. Every chain queued behind it would stay
    // idle - and emit no silence series - for as long as the start hangs.
    hooks.blockers.set(
      101,
      new Promise<void>(() => {
        // never settles: the hung RPC call
      }),
    );
    hooks.registrations = [registration(101), registration(103)];
    void main.synchronizeData();
    await vi.waitFor(() => expect(main.getAllHealth()).toHaveLength(2));
    expect(main.getAllHealth().every((h) => h.state === "idle")).toBe(true);

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + STARTUP_GRACE_MS + 1_000);

      for (const entry of main.getAllHealth()) {
        expect(entry.state).toBe("failed");
        expect(entry.lastError).toContain("startup grace");
      }
      // And the alert now has a series to fire on, for both chains.
      const metricsModule = await import("../../lib/metrics");
      main.refreshMetrics();
      const silence = await metricsModule.registry.getSingleMetricAsString(
        "keeperhub_solana_tracker_seconds_since_last_slot",
      );
      expect(silence).toContain('chain="101"');
      expect(silence).toContain('chain="103"');
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps reconciling other chains when an ingestor fails to stop", async () => {
    hooks.registrations = [registration(101), registration(103)];
    hooks.connected.add(101);
    hooks.connected.add(103);
    await main.synchronizeData();

    // 101 leaves discovery and its stop() throws; 104 arrives in the same pass.
    // The throw used to end the pass before 104 was ever started.
    hooks.stopFails.add(101);
    hooks.connected.add(104);
    hooks.registrations = [registration(103), registration(104)];
    await main.synchronizeData();

    const started = main.getAllHealth().find((h) => h.chainId === 104);
    expect(started?.connected).toBe(true);

    // The ingestor that failed to stop is still running, so it stays in the
    // registry and the next pass retries it.
    hooks.stopFails.delete(101);
    await main.synchronizeData();
    const metricsModule = await import("../../lib/metrics");
    main.refreshMetrics();
    const running = await metricsModule.registry.getSingleMetricAsString(
      "keeperhub_solana_tracker_chains_running",
    );
    expect(running).toContain("keeperhub_solana_tracker_chains_running 2");
  });
});

describe("getLiveness", () => {
  it("stamps a sync start even when discovery returns nothing", async () => {
    // The early return when discovery yields null must still count as alive,
    // or a discovery outage becomes a liveness restart.
    hooks.discovery = null;

    await main.synchronizeData();

    const snap = main.getLiveness();
    expect(snap.lastSyncStartedAt).not.toBeNull();
    expect(snap.lastSyncCompletedAt).not.toBeNull();
  });

  it("stamps a sync start even when the pass throws", async () => {
    hooks.discovery = { eventWorkflows: [], blockWorkflows: [], networks: {} };
    hooks.registrations = [registration(101)];
    hooks.startFails.add(101);

    await main.synchronizeData();

    expect(main.getLiveness().lastSyncStartedAt).not.toBeNull();
  });
});
