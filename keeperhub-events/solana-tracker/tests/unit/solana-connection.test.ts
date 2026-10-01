import { beforeEach, describe, expect, it, vi } from "vitest";

interface ConnRecord {
  rpcUrl: string;
  wsEndpoint: string;
  fireSlot: (slot: number) => void;
  removed: boolean;
  /** When true, removeSlotChangeListener returns a promise that never settles. */
  hangRemoval?: boolean;
  /** Close code the tracker force-closed this connection's socket with. */
  closedWith?: number | null;
  /** Last value the tracker set on the socket's auto-reconnect switch. */
  autoReconnect?: boolean;
  /** Entries left in the fake web3.js subscription map. */
  subscriptionEntries: () => number;
}

// Records for every web3.js Connection the source constructs, plus the args the
// last read call received, so the test can assert wiring and commitment without
// any network.
const hooks = vi.hoisted(() => ({
  slot: 100,
  instances: [] as ConnRecord[],
  lastGetBlock: null as {
    slot: number;
    config: Record<string, unknown>;
  } | null,
  lastSigs: null as { address: string; commitment: string } | null,
  /** Makes the next onSlotChange registration throw. */
  subscribeThrows: false,
  /** Makes every removeSlotChangeListener hang forever. */
  hangRemoval: false,
  /** Message of the error a throwing onSlotChange raises. */
  subscribeErrorMessage: "subscribe boom",
}));

vi.mock("@solana/web3.js", async (importActual) => {
  const actual = await importActual<typeof import("@solana/web3.js")>();
  class FakeConnection {
    private cb: ((info: { slot: number }) => void) | null = null;
    private readonly record: ConnRecord;
    // The web3.js 1.98 internals the tracker reaches into when it abandons a
    // subscription.
    _subscriptionsByHash: Record<string, unknown> = { "slot:1": {} };
    _rpcWebSocket = {
      setAutoReconnect: (reconnect: boolean) => {
        this.record.autoReconnect = reconnect;
      },
      close: (code?: number) => {
        this.record.closedWith = code ?? null;
      },
    };
    constructor(rpcUrl: string, config: { wsEndpoint: string }) {
      this.record = {
        rpcUrl,
        wsEndpoint: config.wsEndpoint,
        fireSlot: (slot: number) => this.cb?.({ slot }),
        removed: false,
        subscriptionEntries: () =>
          Object.keys(this._subscriptionsByHash).length,
      };
      hooks.instances.push(this.record);
    }
    onSlotChange(cb: (info: { slot: number }) => void): number {
      if (hooks.subscribeThrows) {
        throw new Error(hooks.subscribeErrorMessage);
      }
      this.cb = cb;
      return 1;
    }
    removeSlotChangeListener(_id: number): Promise<void> {
      this.record.removed = true;
      if (this.record.hangRemoval ?? hooks.hangRemoval) {
        return new Promise<void>(() => {
          // never settles - the half-open socket from the 2026-09-09 incident
        });
      }
      return Promise.resolve();
    }
    getSlot(_commitment: string): Promise<number> {
      return Promise.resolve(hooks.slot);
    }
    getBlock(slot: number, config: Record<string, unknown>): Promise<unknown> {
      hooks.lastGetBlock = { slot, config };
      return Promise.resolve(null);
    }
    getSignaturesForAddress(
      address: { toBase58: () => string },
      _options: unknown,
      commitment: string,
    ): Promise<unknown[]> {
      hooks.lastSigs = { address: address.toBase58(), commitment };
      return Promise.resolve([]);
    }
    getTransaction(): Promise<null> {
      return Promise.resolve(null);
    }
  }
  return { ...actual, Connection: FakeConnection };
});

const { SolanaConnection } = await import("../../src/ingest/solana-connection");

const PROGRAM = "So11111111111111111111111111111111111111112";

beforeEach(() => {
  hooks.instances.length = 0;
  hooks.slot = 100;
  hooks.lastGetBlock = null;
  hooks.lastSigs = null;
  hooks.subscribeThrows = false;
  hooks.hangRemoval = false;
  hooks.subscribeErrorMessage = "subscribe boom";
});

describe("SolanaConnection", () => {
  it("delivers slot ticks to onSlot and reports connected", () => {
    const slots: number[] = [];
    const conn = new SolanaConnection({
      chainId: 101,
      source: "signatures",
      endpoints: [{ rpcUrl: "http://rpc1", wssUrl: "ws://ws1" }],
      commitment: "confirmed",
      onSlot: (slot) => slots.push(slot),
    });
    conn.start();

    expect(hooks.instances).toHaveLength(1);
    hooks.instances[0].fireSlot(42);
    expect(slots).toEqual([42]);

    const health = conn.getHealth();
    expect(health.connected).toBe(true);
    expect(health.activeEndpoint).toBe("ws://ws1");

    void conn.stop();
  });

  it("passes the resolved finality through to reads", async () => {
    hooks.slot = 555;
    const conn = new SolanaConnection({
      chainId: 101,
      source: "signatures",
      endpoints: [{ rpcUrl: "http://rpc1", wssUrl: "ws://ws1" }],
      commitment: "confirmed",
      onSlot: vi.fn(),
    });
    conn.start();

    expect(await conn.getCurrentSlot()).toBe(555);

    await conn.getBlock(7, "full");
    expect(hooks.lastGetBlock?.slot).toBe(7);
    expect(hooks.lastGetBlock?.config).toMatchObject({
      commitment: "confirmed",
      transactionDetails: "full",
      maxSupportedTransactionVersion: 0,
    });

    await conn.getSignaturesForAddress(PROGRAM, { limit: 1 });
    expect(hooks.lastSigs).toEqual({
      address: PROGRAM,
      commitment: "confirmed",
    });

    void conn.stop();
  });

  it("rotates to the fallback endpoint when the slot stream goes stale", async () => {
    vi.useFakeTimers();
    try {
      const conn = new SolanaConnection({
        chainId: 101,
        source: "signatures",
        endpoints: [
          { rpcUrl: "http://rpc1", wssUrl: "ws://ws1" },
          { rpcUrl: "http://rpc2", wssUrl: "ws://ws2" },
        ],
        commitment: "confirmed",
        onSlot: vi.fn(),
      });
      conn.start();
      expect(hooks.instances).toHaveLength(1);

      // No slot ticks arrive. A subscription that has never delivered rotates
      // on the first-slot grace (~30s once watchdog sampling is accounted for),
      // not on the 60s staleness timeout, so 76s covers two rotations: ws1 ->
      // ws2 at ~30s, and ws2 -> ws1 at ~60s. Three connections in total. Under
      // the old code this window produced exactly one rotation.
      await vi.advanceTimersByTimeAsync(76_000);

      expect(hooks.instances).toHaveLength(3);
      expect(hooks.instances[0].removed).toBe(true);
      expect(hooks.instances[1].wsEndpoint).toBe("ws://ws2");
      // Never delivered a slot, so it is not connected on any endpoint.
      expect(conn.getHealth().connected).toBe(false);
      expect(conn.getHealth().state).toBe("subscribing");

      await conn.stop();
    } finally {
      vi.useRealTimers();
    }
  });
  it("stays disconnected until a real slot arrives", () => {
    // The 2026-09-09 fault in one assertion. onSlotChange returns a
    // subscription id before the socket has opened, so the old code reported
    // connected immediately and a dead endpoint looked healthy for a full
    // staleness window.
    const conn = new SolanaConnection({
      chainId: 101,
      source: "signatures",
      endpoints: [{ rpcUrl: "http://rpc1", wssUrl: "ws://ws1" }],
      commitment: "confirmed",
      onSlot: vi.fn(),
    });
    conn.start();

    expect(conn.getHealth().connected).toBe(false);
    expect(conn.getHealth().state).toBe("subscribing");
    expect(conn.getHealth().lastSlotAt).toBeNull();

    hooks.instances[0].fireSlot(7);

    expect(conn.getHealth().connected).toBe(true);
    expect(conn.getHealth().state).toBe("live");
    expect(conn.getHealth().lastSlotAt).not.toBeNull();
  });

  it("rotates a never-delivering subscription well before the staleness timeout", async () => {
    vi.useFakeTimers();
    try {
      const conn = new SolanaConnection({
        chainId: 101,
        source: "signatures",
        endpoints: [
          { rpcUrl: "http://rpc1", wssUrl: "ws://ws1" },
          { rpcUrl: "http://rpc2", wssUrl: "ws://ws2" },
        ],
        commitment: "confirmed",
        onSlot: vi.fn(),
      });
      conn.start();

      // One watchdog tick inside the grace: nothing yet.
      await vi.advanceTimersByTimeAsync(15_000);
      expect(hooks.instances).toHaveLength(1);

      // Second tick is past the 20s grace, so it rotates - at ~30s, half the
      // 60s the old code would have waited.
      await vi.advanceTimersByTimeAsync(15_000);
      expect(hooks.instances).toHaveLength(2);
      expect(hooks.instances[1].wsEndpoint).toBe("ws://ws2");

      await conn.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not wedge when removeSlotChangeListener never settles", async () => {
    // PD #33473: the unsubscribe hung for 88s against a 3x30s liveness budget,
    // so the re-subscribe never happened and the connection reported
    // reconnecting until the kubelet killed the pod.
    vi.useFakeTimers();
    try {
      hooks.hangRemoval = true;
      const conn = new SolanaConnection({
        chainId: 101,
        source: "signatures",
        endpoints: [
          { rpcUrl: "http://rpc1", wssUrl: "ws://ws1" },
          { rpcUrl: "http://rpc2", wssUrl: "ws://ws2" },
        ],
        commitment: "confirmed",
        onSlot: vi.fn(),
      });
      conn.start();
      hooks.instances[0].fireSlot(1);

      // Go stale, which starts a reconnect that hangs in the teardown.
      await vi.advanceTimersByTimeAsync(76_000);
      // Past the 5s abandon timeout the re-subscribe happens anyway.
      await vi.advanceTimersByTimeAsync(6_000);

      expect(hooks.instances.length).toBeGreaterThanOrEqual(2);
      expect(conn.getHealth().reconnecting).toBe(false);
      expect(conn.getHealth().abandonedSubscriptions).toBeGreaterThan(0);

      // Let the teardown settle normally; otherwise stop()'s own abandon timer
      // would need the fake clock advanced from outside the await.
      hooks.hangRemoval = false;
      await conn.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a slot from an abandoned subscription", async () => {
    // Bounding the unsubscribe leaves the old socket holding its listener, so
    // without the epoch guard a zombie that revives would mark us live on an
    // endpoint we already rotated away from.
    vi.useFakeTimers();
    try {
      hooks.hangRemoval = true;
      const onSlot = vi.fn();
      const conn = new SolanaConnection({
        chainId: 101,
        source: "signatures",
        endpoints: [
          { rpcUrl: "http://rpc1", wssUrl: "ws://ws1" },
          { rpcUrl: "http://rpc2", wssUrl: "ws://ws2" },
        ],
        commitment: "confirmed",
        onSlot,
      });
      conn.start();
      hooks.instances[0].fireSlot(1);
      await vi.advanceTimersByTimeAsync(76_000);
      await vi.advanceTimersByTimeAsync(6_000);
      onSlot.mockClear();

      hooks.instances[0].fireSlot(999);

      expect(onSlot).not.toHaveBeenCalled();
      expect(conn.getHealth().connected).toBe(false);

      hooks.hangRemoval = false;
      await conn.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a subscribe that threw instead of wedging on it", async () => {
    // The old catch left `reconnecting` true and checkStaleness skipped any
    // chain in that state, so a throwing subscribe was never retried for the
    // life of the pod.
    vi.useFakeTimers();
    try {
      hooks.subscribeThrows = true;
      const conn = new SolanaConnection({
        chainId: 101,
        source: "signatures",
        endpoints: [
          { rpcUrl: "http://rpc1", wssUrl: "ws://ws1" },
          { rpcUrl: "http://rpc2", wssUrl: "ws://ws2" },
        ],
        commitment: "confirmed",
        onSlot: vi.fn(),
      });
      conn.start();

      expect(conn.getHealth().state).toBe("failed");
      expect(conn.getHealth().connected).toBe(false);
      expect(conn.getHealth().lastError).toContain("subscribe boom");

      hooks.subscribeThrows = false;
      await vi.advanceTimersByTimeAsync(16_000);

      expect(hooks.instances.length).toBeGreaterThanOrEqual(2);

      await conn.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails cleanly with no endpoints configured", () => {
    const conn = new SolanaConnection({
      chainId: 101,
      source: "signatures",
      endpoints: [],
      commitment: "confirmed",
      onSlot: vi.fn(),
    });

    expect(() => conn.start()).not.toThrow();
    expect(conn.getHealth().state).toBe("failed");
    expect(conn.getHealth().lastError).toBe("no endpoints configured");
    expect(conn.getHealth().activeEndpoint).toBe("");
  });

  it("stop() resets state and nothing resubscribes afterwards", async () => {
    // reconnect() is fired with `void`, so stop() can land mid-teardown. It
    // used to resume afterwards and build a fresh connection on a stopped
    // object that had no watchdog left to tear it down.
    vi.useFakeTimers();
    try {
      hooks.hangRemoval = true;
      const conn = new SolanaConnection({
        chainId: 101,
        source: "signatures",
        endpoints: [
          { rpcUrl: "http://rpc1", wssUrl: "ws://ws1" },
          { rpcUrl: "http://rpc2", wssUrl: "ws://ws2" },
        ],
        commitment: "confirmed",
        onSlot: vi.fn(),
      });
      conn.start();
      hooks.instances[0].fireSlot(1);
      await vi.advanceTimersByTimeAsync(76_000);

      const before = hooks.instances.length;
      const stopping = conn.stop();
      await vi.advanceTimersByTimeAsync(10_000);
      await stopping;
      await vi.advanceTimersByTimeAsync(300_000);

      expect(hooks.instances).toHaveLength(before);
      const health = conn.getHealth();
      expect(health.state).toBe("idle");
      expect(health.connected).toBe(false);
      expect(health.reconnecting).toBe(false);
      expect(health.lastSlotAt).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("redacts the credential out of the reported endpoint", () => {
    // chain-config carries the provider key in the URL path and this value is
    // served on /healthz, which any pod in the namespace can reach.
    const conn = new SolanaConnection({
      chainId: 101,
      source: "signatures",
      endpoints: [
        {
          rpcUrl: "https://lb.example.com/solana/SECRET",
          wssUrl: "wss://lb.example.com/solana/SECRET",
        },
      ],
      commitment: "confirmed",
      onSlot: vi.fn(),
    });
    conn.start();

    expect(conn.getHealth().activeEndpoint).not.toContain("SECRET");
    expect(conn.getHealth().activeEndpoint).toBe(
      "wss://lb.example.com/[redacted]",
    );
  });

  it("closes the socket of a subscription it had to abandon", async () => {
    // web3.js keeps an abandoned subscription's socket open, and reopens a
    // socket closed under it while any subscription entry remains. So the
    // entries must be gone and auto-reconnect off before the close.
    vi.useFakeTimers();
    try {
      hooks.hangRemoval = true;
      const conn = new SolanaConnection({
        chainId: 101,
        source: "signatures",
        endpoints: [
          { rpcUrl: "http://rpc1", wssUrl: "ws://ws1" },
          { rpcUrl: "http://rpc2", wssUrl: "ws://ws2" },
        ],
        commitment: "confirmed",
        onSlot: vi.fn(),
      });
      conn.start();
      hooks.instances[0].fireSlot(1);
      await vi.advanceTimersByTimeAsync(76_000);
      await vi.advanceTimersByTimeAsync(6_000);

      const abandoned = hooks.instances[0];
      expect(abandoned.subscriptionEntries()).toBe(0);
      expect(abandoned.autoReconnect).toBe(false);
      expect(abandoned.closedWith).toBe(1000);

      hooks.hangRemoval = false;
      await conn.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the provider key and the stack out of the reported error", () => {
    // node-fetch puts the full request URL in its error messages, and
    // chain-config carries the provider key in that URL.
    hooks.subscribeThrows = true;
    hooks.subscribeErrorMessage =
      "request to https://lb.example.com/solana-devnet/SECRETKEY failed, reason: socket hang up";
    const conn = new SolanaConnection({
      chainId: 101,
      source: "signatures",
      endpoints: [{ rpcUrl: "http://rpc1", wssUrl: "ws://ws1" }],
      commitment: "confirmed",
      onSlot: vi.fn(),
    });
    conn.start();

    const reported = conn.getHealth().lastError ?? "";
    expect(reported).not.toContain("SECRETKEY");
    expect(reported).toContain("https://lb.example.com/[redacted]");
    expect(reported).not.toContain("    at ");
  });
});
