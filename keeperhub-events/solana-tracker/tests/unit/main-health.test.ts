import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildHealthResponse } from "../../src/health/health-server";

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
    start(): Promise<void> {
      if (hooks.startFails.has(this.chainId)) {
        return Promise.reject(new Error(`start boom ${this.chainId}`));
      }
      this.started = true;
      return Promise.resolve();
    }
    stop(): Promise<void> {
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
