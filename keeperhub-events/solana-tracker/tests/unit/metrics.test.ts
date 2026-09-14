import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  forgetChain,
  registry,
  resetMetrics,
  syncMetrics,
} from "../../lib/metrics";
import type { ConnectionHealth } from "../../src/ingest/solana-connection";

/**
 * The metrics module is the replacement for the paging signal the probe split
 * removes, so its failure modes are alert failure modes. Each case here is one
 * way a series used to go stale, or a counter used to stop moving.
 */

const T0 = 1_800_000_000_000;

function health(
  chainId: number,
  over: Partial<ConnectionHealth> = {},
): ConnectionHealth {
  return {
    chainId,
    source: "signatures",
    connected: false,
    state: "subscribing",
    reconnecting: false,
    lastSlotAt: null,
    subscribedAt: T0,
    activeEndpoint: "wss://lb.example.com/[redacted]",
    endpointIndex: 0,
    endpointCount: 2,
    reconnects: 0,
    abandonedSubscriptions: 0,
    lastError: null,
    ...over,
  };
}

const mainnet = (h: ConnectionHealth) => ({ health: h, isTestnet: false });
const counts = { running: 1, expected: 1 };

/** Series values of one metric, keyed by the chain label. */
async function valuesOf(name: string): Promise<Map<string, number[]>> {
  const metric = registry.getSingleMetric(`keeperhub_solana_tracker_${name}`);
  const out = new Map<string, number[]>();
  for (const v of (await metric?.get())?.values ?? []) {
    const chain = String(v.labels.chain ?? "");
    out.set(chain, [...(out.get(chain) ?? []), v.value]);
  }
  return out;
}

beforeEach(() => {
  resetMetrics();
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("syncMetrics", () => {
  it("labels series by chain and testnet only", async () => {
    syncMetrics([mainnet(health(101))], counts);

    const text = await registry.metrics();
    expect(text).toContain('chain="101"');
    expect(text).toContain('testnet="false"');
    expect(text).not.toContain("source=");
  });

  it("counts silence from when the source came up when no slot ever arrives", async () => {
    // The 2026-09-09 endpoint delivered nothing at all. Reporting 0 for "no
    // slot yet" would have kept the alert quiet for the whole outage.
    syncMetrics([mainnet(health(101))], counts);
    vi.advanceTimersByTime(100_000);

    expect((await valuesOf("seconds_since_last_slot")).get("101")).toEqual([
      100,
    ]);
  });

  it("measures from the last real slot once one has arrived", async () => {
    syncMetrics(
      [mainnet(health(101, { state: "live", lastSlotAt: T0 - 5_000 }))],
      counts,
    );

    expect((await valuesOf("seconds_since_last_slot")).get("101")).toEqual([5]);
  });

  it("emits no silence series while a chain is still queued", async () => {
    syncMetrics([mainnet(health(101, { state: "idle" }))], counts);
    expect((await valuesOf("seconds_since_last_slot")).has("101")).toBe(false);

    // The clock starts when the source comes up, not when the chain was queued.
    vi.advanceTimersByTime(50_000);
    syncMetrics([mainnet(health(101))], counts);
    vi.advanceTimersByTime(10_000);

    expect((await valuesOf("seconds_since_last_slot")).get("101")).toEqual([
      10,
    ]);
  });

  it("drops every series of a chain that is no longer in health", async () => {
    syncMetrics([mainnet(health(101)), mainnet(health(103))], counts);
    syncMetrics([mainnet(health(101))], counts);

    expect((await valuesOf("seconds_since_last_slot")).has("103")).toBe(false);
    expect((await valuesOf("is_connected")).has("103")).toBe(false);
    expect((await valuesOf("seconds_since_last_slot")).has("101")).toBe(true);
  });

  it("keeps one series per chain when the reported source changes", async () => {
    // A composite chain reports whichever member ranks worst. Keying on source
    // used to strand the previous member's series, climbing forever.
    syncMetrics([mainnet(health(101, { source: "signatures" }))], counts);
    syncMetrics([mainnet(health(101, { source: "getblock" }))], counts);

    expect((await valuesOf("seconds_since_last_slot")).get("101")).toHaveLength(
      1,
    );
    expect((await valuesOf("is_connected")).get("101")).toHaveLength(1);
  });

  it("keeps counting after the source is rebuilt instead of swallowing increments", async () => {
    syncMetrics([mainnet(health(101, { abandonedSubscriptions: 3 }))], counts);
    // A rebuilt source starts again from zero.
    syncMetrics([mainnet(health(101, { abandonedSubscriptions: 1 }))], counts);
    syncMetrics([mainnet(health(101, { abandonedSubscriptions: 2 }))], counts);

    expect(
      (await valuesOf("abandoned_subscriptions_total")).get("101"),
    ).toEqual([5]);
  });

  it("starts a fresh baseline after forgetChain", async () => {
    syncMetrics([mainnet(health(101, { reconnects: 4 }))], counts);
    forgetChain(101);
    syncMetrics([mainnet(health(101, { reconnects: 4 }))], counts);

    // 4 before the restart plus 4 counted from scratch after it.
    expect((await valuesOf("reconnects_total")).get("101")).toEqual([8]);
  });

  it("reports expected and running chains separately", async () => {
    syncMetrics([mainnet(health(101)), mainnet(health(103))], {
      running: 1,
      expected: 2,
    });

    expect((await valuesOf("chains_expected")).get("")).toEqual([2]);
    expect((await valuesOf("chains_running")).get("")).toEqual([1]);
  });

  it("never exposes an endpoint URL", async () => {
    syncMetrics([mainnet(health(101))], counts);

    const text = await registry.metrics();
    expect(text).not.toContain("wss://");
    expect(text).not.toContain("https://");
  });
});
