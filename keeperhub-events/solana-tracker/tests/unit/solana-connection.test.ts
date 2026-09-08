import { beforeEach, describe, expect, it, vi } from "vitest";

interface ConnRecord {
  rpcUrl: string;
  wsEndpoint: string;
  fireSlot: (slot: number) => void;
  removed: boolean;
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
}));

vi.mock("@solana/web3.js", async (importActual) => {
  const actual = await importActual<typeof import("@solana/web3.js")>();
  class FakeConnection {
    private cb: ((info: { slot: number }) => void) | null = null;
    private readonly record: ConnRecord;
    constructor(rpcUrl: string, config: { wsEndpoint: string }) {
      this.record = {
        rpcUrl,
        wsEndpoint: config.wsEndpoint,
        fireSlot: (slot: number) => this.cb?.({ slot }),
        removed: false,
      };
      hooks.instances.push(this.record);
    }
    onSlotChange(cb: (info: { slot: number }) => void): number {
      this.cb = cb;
      return 1;
    }
    removeSlotChangeListener(_id: number): Promise<void> {
      this.record.removed = true;
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
});

describe("SolanaConnection", () => {
  it("delivers slot ticks to onSlot and reports connected", () => {
    const slots: number[] = [];
    const conn = new SolanaConnection({
      chainId: 101,
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
        endpoints: [
          { rpcUrl: "http://rpc1", wssUrl: "ws://ws1" },
          { rpcUrl: "http://rpc2", wssUrl: "ws://ws2" },
        ],
        commitment: "confirmed",
        onSlot: vi.fn(),
      });
      conn.start();
      expect(hooks.instances).toHaveLength(1);

      // No slot ticks arrive; advance past the staleness timeout so the
      // watchdog rebuilds the connection on the fallback endpoint.
      await vi.advanceTimersByTimeAsync(76_000);

      expect(hooks.instances).toHaveLength(2);
      expect(hooks.instances[0].removed).toBe(true);
      expect(hooks.instances[1].wsEndpoint).toBe("ws://ws2");
      expect(conn.getHealth().activeEndpoint).toBe("ws://ws2");

      await conn.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
