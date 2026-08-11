import type { ethers } from "ethers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChainProviderManager,
  type ProviderFactory,
} from "../../src/chains/provider-manager";

type BlockHandler = (blockNumber: number) => void | Promise<void>;
type ErrorHandler = (err: Error) => void;

interface SendCall {
  method: string;
  params: unknown[];
}

class MockProvider {
  public sendCalls: SendCall[] = [];
  public sendResponses: unknown[] = [];
  public blockNumberResponses: Array<number | Error> = [];
  // When set, eth_subscribe rejects with this error - simulates an RPC
  // that does not implement subscriptions (the real-world ethers crash
  // path: -32601 "method not available").
  public subscribeFailure: Error | null = null;
  // When set, eth_unsubscribe rejects with this error - lets tests
  // exercise the non-fatal probe-cleanup path without affecting the
  // probe's success.
  public unsubscribeFailure: Error | null = null;
  public destroyed = false;
  private blockHandler: BlockHandler | null = null;
  private errorHandler: ErrorHandler | null = null;

  on(event: string, handler: BlockHandler | ErrorHandler): void {
    if (event === "block") {
      this.blockHandler = handler as BlockHandler;
    } else if (event === "error") {
      this.errorHandler = handler as ErrorHandler;
    }
  }

  off(event: string, handler: BlockHandler | ErrorHandler): void {
    if (event === "block" && this.blockHandler === handler) {
      this.blockHandler = null;
    } else if (event === "error" && this.errorHandler === handler) {
      this.errorHandler = null;
    }
  }

  async getBlockNumber(): Promise<number> {
    return (await this.send("eth_blockNumber", [])) as number;
  }

  async send(method: string, params: unknown[]): Promise<unknown> {
    this.sendCalls.push({ method, params });
    if (method === "eth_subscribe") {
      if (this.subscribeFailure) {
        throw this.subscribeFailure;
      }
      // Synthetic filterId; the manager round-trips it through
      // eth_unsubscribe but does not otherwise inspect it.
      return "0xprobe";
    }
    if (method === "eth_unsubscribe") {
      if (this.unsubscribeFailure) {
        throw this.unsubscribeFailure;
      }
      return true;
    }
    if (method === "eth_blockNumber") {
      if (this.blockNumberResponses.length === 0) {
        return 0x1234;
      }
      const next = this.blockNumberResponses.shift();
      if (next instanceof Error) {
        throw next;
      }
      return next;
    }
    if (this.sendResponses.length === 0) {
      return [];
    }
    return this.sendResponses.shift();
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
  }

  hasBlockHandler(): boolean {
    return this.blockHandler !== null;
  }

  hasErrorHandler(): boolean {
    return this.errorHandler !== null;
  }

  async emitBlock(blockNumber: number): Promise<void> {
    if (this.blockHandler) {
      await this.blockHandler(blockNumber);
    }
  }

  emitError(err: Error): void {
    this.errorHandler?.(err);
  }
}

// MockProvider implements the ethers.WebSocketProvider surface that
// ChainProviderManager actually uses. The factory casts through unknown to
// satisfy the type without pulling in the rest of ethers' provider surface.
//
// `setPersistentFailure` makes every subsequent factory call throw until
// cleared - used to exercise the exhausted-attempts path without reaching
// into the manager's private `factory` field.
function makeFactory(): {
  factory: ProviderFactory;
  created: MockProvider[];
  setPersistentFailure: (err: Error | null) => void;
  setNextSubscribeFailure: (err: Error | null) => void;
} {
  const created: MockProvider[] = [];
  let persistentFailure: Error | null = null;
  let nextSubscribeFailure: Error | null = null;
  const factory: ProviderFactory = (_wssUrl: string) => {
    if (persistentFailure) {
      throw persistentFailure;
    }
    const mock = new MockProvider();
    if (nextSubscribeFailure) {
      // One-shot: failure must be re-armed for each provider that should
      // fail, otherwise reconnect's fresh provider would inherit it.
      mock.subscribeFailure = nextSubscribeFailure;
      nextSubscribeFailure = null;
    }
    created.push(mock);
    return mock as unknown as ethers.WebSocketProvider;
  };
  return {
    factory,
    created,
    setPersistentFailure: (err: Error | null) => {
      persistentFailure = err;
    },
    setNextSubscribeFailure: (err: Error | null) => {
      nextSubscribeFailure = err;
    },
  };
}

const CHAIN_A = 31337;
const CHAIN_B = 1;
const ADDR_A = "0x1111111111111111111111111111111111111111";
const ADDR_B = "0x2222222222222222222222222222222222222222";
const TOPIC_EMITTED =
  "0x6d7747ff9aaba238de658957a12a32c8a94f6ec3aa0508441fe400ca79ed457c";
const TOPIC_OTHER =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

describe("ChainProviderManager", () => {
  let factoryBundle: ReturnType<typeof makeFactory>;
  let manager: ChainProviderManager;
  let onPermanentFailure: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    factoryBundle = makeFactory();
    onPermanentFailure = vi.fn();
    manager = new ChainProviderManager({
      factory: factoryBundle.factory,
      onPermanentFailure,
    });
  });

  afterEach(async () => {
    // Each test's manager starts a heartbeat on every provider it creates.
    // destroy() clears those intervals; without this, timers leak between
    // tests (harmless in CI but noisy when debugging with --ui).
    await manager.destroy();
  });

  describe("getOrCreateProvider", () => {
    it("returns the same provider instance for the same chainId", async () => {
      const a = await manager.getOrCreateProvider(CHAIN_A, "ws://a");
      const b = await manager.getOrCreateProvider(CHAIN_A, "ws://a");
      expect(a).toBe(b);
      expect(factoryBundle.created).toHaveLength(1);
    });

    it("does not double-create under concurrent callers", async () => {
      const [a, b, c] = await Promise.all([
        manager.getOrCreateProvider(CHAIN_A, "ws://a"),
        manager.getOrCreateProvider(CHAIN_A, "ws://a"),
        manager.getOrCreateProvider(CHAIN_A, "ws://a"),
      ]);
      expect(a).toBe(b);
      expect(b).toBe(c);
      expect(factoryBundle.created).toHaveLength(1);
    });

    it("creates separate providers for different chainIds", async () => {
      const a = await manager.getOrCreateProvider(CHAIN_A, "ws://a");
      const b = await manager.getOrCreateProvider(CHAIN_B, "ws://b");
      expect(a).not.toBe(b);
      expect(factoryBundle.created).toHaveLength(2);
    });

    it("rejects a mismatched wssUrl for a known chainId", async () => {
      await manager.getOrCreateProvider(CHAIN_A, "ws://a");
      await expect(
        manager.getOrCreateProvider(CHAIN_A, "ws://different"),
      ).rejects.toThrow(/already registered/);
    });

    // Probe is the gate that prevents ethers' uncaught eth_subscribe
    // rejection from reaching process.unhandledRejection and crashing
    // the pod. These tests lock in the contract.
    describe("eth_subscribe probe", () => {
      it("sends eth_subscribe([newHeads]) and unsubscribes immediately", async () => {
        await manager.getOrCreateProvider(CHAIN_A, "ws://a");
        const provider = factoryBundle.created[0];
        const subscribe = provider.sendCalls.find(
          (c) => c.method === "eth_subscribe",
        );
        const unsubscribe = provider.sendCalls.find(
          (c) => c.method === "eth_unsubscribe",
        );
        expect(subscribe?.params).toEqual(["newHeads"]);
        expect(unsubscribe?.params).toEqual(["0xprobe"]);
      });

      it("throws when eth_subscribe is not supported", async () => {
        const err = new Error(
          'unsupported operation (operation="eth_subscribe", code=-32601)',
        );
        factoryBundle.setNextSubscribeFailure(err);
        await expect(
          manager.getOrCreateProvider(CHAIN_A, "ws://a"),
        ).rejects.toThrow(/RPC does not support eth_subscribe/);
      });

      it("destroys the provider when the probe fails", async () => {
        factoryBundle.setNextSubscribeFailure(new Error("boom"));
        await expect(
          manager.getOrCreateProvider(CHAIN_A, "ws://a"),
        ).rejects.toThrow();
        expect(factoryBundle.created[0].destroyed).toBe(true);
      });

      it("retries createProvider on the next call after a probe failure", async () => {
        // The reconciler runs synchronizeData every 30s. A transient
        // probe failure must NOT permanently disable the chain - the
        // next call to getOrCreateProvider must kick off a fresh
        // factory call rather than re-returning the cached rejected
        // promise.
        factoryBundle.setNextSubscribeFailure(new Error("transient"));
        await expect(
          manager.getOrCreateProvider(CHAIN_A, "ws://a"),
        ).rejects.toThrow();
        expect(factoryBundle.created).toHaveLength(1);

        // Second attempt: probe failure no longer armed; the call
        // should produce a fresh factory invocation and succeed.
        await expect(
          manager.getOrCreateProvider(CHAIN_A, "ws://a"),
        ).resolves.toBeDefined();
        expect(factoryBundle.created).toHaveLength(2);
        expect(manager.isHealthy(CHAIN_A)).toBe(true);
      });

      it("records lastCreateError after a probe failure and clears it on success", async () => {
        factoryBundle.setNextSubscribeFailure(
          new Error('unsupported operation (operation="eth_subscribe")'),
        );
        await expect(
          manager.getOrCreateProvider(CHAIN_A, "ws://a"),
        ).rejects.toThrow();
        // Failure is observable through health surface so /healthz can
        // report *why* a chain is degraded.
        expect(manager.getHealth(CHAIN_A)?.lastCreateError).toMatch(
          /eth_subscribe/,
        );

        // Subsequent successful retry clears the marker.
        await manager.getOrCreateProvider(CHAIN_A, "ws://a");
        expect(manager.getHealth(CHAIN_A)?.lastCreateError).toBeNull();
      });

      it("survives an eth_unsubscribe failure (probe succeeded)", async () => {
        // Plant the unsubscribe failure synchronously after the factory
        // returns the mock but before createProvider awaits the probe.
        // The factory exposes a hook for subscribe failures only, so we
        // wrap the factory to set unsubscribeFailure on the new mock.
        const inner = factoryBundle.factory;
        const wrapped: ProviderFactory = (wssUrl: string) => {
          const p = inner(wssUrl) as unknown as MockProvider;
          p.unsubscribeFailure = new Error("rpc unstable");
          return p as unknown as ethers.WebSocketProvider;
        };
        const localManager = new ChainProviderManager({
          factory: wrapped,
          onPermanentFailure,
        });
        await expect(
          localManager.getOrCreateProvider(CHAIN_A, "ws://a"),
        ).resolves.toBeDefined();
        await localManager.destroy();
      });
    });

    // Fallback URL is opt-in via the optional third parameter on
    // getOrCreateProvider / SubscribeOptions. When the primary fails at
    // factory + ready + probe, the manager walks to the fallback before
    // surfacing failure. Reconnect uses the same walk, so a primary that
    // recovers is preferred on the next reconnect.
    describe("fallback wssUrl", () => {
      it("uses the primary when it works and never invokes the fallback", async () => {
        await manager.getOrCreateProvider(CHAIN_A, "ws://primary", "ws://fb");
        expect(factoryBundle.created).toHaveLength(1);
        expect(manager.getHealth(CHAIN_A)?.wssUrl).toBe("ws://primary");
        expect(manager.getHealth(CHAIN_A)?.fallbackWssUrl).toBe("ws://fb");
      });

      it("falls through to the fallback when the primary probe fails", async () => {
        // One-shot: only the first provider created (i.e. the one for the
        // primary URL) gets the subscribe failure. The fallback's fresh
        // provider has no failure armed, so its probe succeeds.
        factoryBundle.setNextSubscribeFailure(
          new Error('unsupported operation (operation="eth_subscribe")'),
        );
        await manager.getOrCreateProvider(CHAIN_A, "ws://primary", "ws://fb");
        expect(factoryBundle.created).toHaveLength(2);
        // Failed primary provider is destroyed before we move on so the
        // socket does not leak across the failover.
        expect(factoryBundle.created[0].destroyed).toBe(true);
        expect(factoryBundle.created[1].destroyed).toBe(false);
        // Health surface reflects the active URL, not the configured
        // primary, so operators can see failover at a glance.
        expect(manager.getHealth(CHAIN_A)?.wssUrl).toBe("ws://fb");
      });

      it("aggregates errors from both URLs when both fail", async () => {
        // Persistent failure makes every factory call throw. Both primary
        // and fallback fail before the call resolves, and the surfaced
        // error must mention both URLs so operators can debug.
        factoryBundle.setPersistentFailure(new Error("connect refused"));
        await expect(
          manager.getOrCreateProvider(CHAIN_A, "ws://primary", "ws://fb"),
        ).rejects.toThrow(/ws:\/\/primary.*ws:\/\/fb/s);
      });

      it("rejects a mismatched fallback for a known chainId", async () => {
        // The primary+fallback tuple is the entry's identity. A second
        // caller with a different fallback would silently inherit the
        // first caller's failover URL, so we throw instead.
        await manager.getOrCreateProvider(CHAIN_A, "ws://primary", "ws://fb");
        await expect(
          manager.getOrCreateProvider(CHAIN_A, "ws://primary", "ws://other"),
        ).rejects.toThrow(/already registered/);
      });

      it("works without a fallback (single-URL backwards compatibility)", async () => {
        // Existing call sites that pass no fallback still work and report
        // null in the fallback health field.
        await manager.getOrCreateProvider(CHAIN_A, "ws://primary");
        expect(manager.getHealth(CHAIN_A)?.fallbackWssUrl).toBeNull();
      });
    });
  });

  describe("subscribeToLogs block listener lifecycle", () => {
    it("attaches a block listener on first subscriber", async () => {
      await manager.subscribeToLogs({
        chainId: CHAIN_A,
        wssUrl: "ws://a",
        address: ADDR_A,
        topic0: TOPIC_EMITTED,
        handler: vi.fn(),
      });
      expect(factoryBundle.created[0].hasBlockHandler()).toBe(true);
    });

    it("does not re-attach a block listener for a second subscriber", async () => {
      await manager.subscribeToLogs({
        chainId: CHAIN_A,
        wssUrl: "ws://a",
        address: ADDR_A,
        topic0: TOPIC_EMITTED,
        handler: vi.fn(),
      });
      const spyOn = vi.spyOn(factoryBundle.created[0], "on");
      await manager.subscribeToLogs({
        chainId: CHAIN_A,
        wssUrl: "ws://a",
        address: ADDR_B,
        topic0: TOPIC_EMITTED,
        handler: vi.fn(),
      });
      expect(spyOn).not.toHaveBeenCalledWith("block", expect.anything());
    });

    it("detaches the block listener when the last subscriber unsubscribes", async () => {
      const unsubA = await manager.subscribeToLogs({
        chainId: CHAIN_A,
        wssUrl: "ws://a",
        address: ADDR_A,
        topic0: TOPIC_EMITTED,
        handler: vi.fn(),
      });
      const unsubB = await manager.subscribeToLogs({
        chainId: CHAIN_A,
        wssUrl: "ws://a",
        address: ADDR_B,
        topic0: TOPIC_EMITTED,
        handler: vi.fn(),
      });
      unsubA();
      expect(factoryBundle.created[0].hasBlockHandler()).toBe(true);
      unsubB();
      expect(factoryBundle.created[0].hasBlockHandler()).toBe(false);
    });
  });

  describe("log demux", () => {
    it("requests eth_getLogs with the union of addresses and topic0s", async () => {
      await manager.subscribeToLogs({
        chainId: CHAIN_A,
        wssUrl: "ws://a",
        address: ADDR_A,
        topic0: TOPIC_EMITTED,
        handler: vi.fn(),
      });
      await manager.subscribeToLogs({
        chainId: CHAIN_A,
        wssUrl: "ws://a",
        address: ADDR_B,
        topic0: TOPIC_OTHER,
        handler: vi.fn(),
      });

      const provider = factoryBundle.created[0];
      provider.sendResponses = [[]];
      await provider.emitBlock(100);

      // createProvider runs an eth_subscribe / eth_unsubscribe probe
      // before any block dispatch; filter to the demux path under test.
      const getLogsCalls = provider.sendCalls.filter(
        (c) => c.method === "eth_getLogs",
      );
      expect(getLogsCalls).toHaveLength(1);
      const filter = getLogsCalls[0].params[0] as {
        address: string[];
        topics: string[][];
        fromBlock: string;
        toBlock: string;
      };
      expect(filter.address.sort()).toEqual(
        [ADDR_A.toLowerCase(), ADDR_B.toLowerCase()].sort(),
      );
      expect(filter.topics[0].sort()).toEqual(
        [TOPIC_EMITTED, TOPIC_OTHER].sort(),
      );
      expect(filter.fromBlock).toBe("0x64");
      expect(filter.toBlock).toBe("0x64");
    });

    it("dispatches a log only to subscribers whose (address, topic0) matches", async () => {
      const handlerA = vi.fn();
      const handlerB = vi.fn();
      await manager.subscribeToLogs({
        chainId: CHAIN_A,
        wssUrl: "ws://a",
        address: ADDR_A,
        topic0: TOPIC_EMITTED,
        handler: handlerA,
      });
      await manager.subscribeToLogs({
        chainId: CHAIN_A,
        wssUrl: "ws://a",
        address: ADDR_B,
        topic0: TOPIC_OTHER,
        handler: handlerB,
      });

      const provider = factoryBundle.created[0];
      // One log matching A; one log matching B; one log matching neither.
      const logA = {
        address: ADDR_A.toLowerCase(),
        topics: [TOPIC_EMITTED],
      };
      const logB = {
        address: ADDR_B.toLowerCase(),
        topics: [TOPIC_OTHER],
      };
      const logNeither = {
        address: ADDR_A.toLowerCase(),
        topics: [TOPIC_OTHER],
      };
      provider.sendResponses = [[logA, logB, logNeither]];
      await provider.emitBlock(101);

      expect(handlerA).toHaveBeenCalledTimes(1);
      expect(handlerA).toHaveBeenCalledWith(logA);
      expect(handlerB).toHaveBeenCalledTimes(1);
      expect(handlerB).toHaveBeenCalledWith(logB);
    });

    it("dispatches one log to multiple subscribers when they share (address, topic0)", async () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      await manager.subscribeToLogs({
        chainId: CHAIN_A,
        wssUrl: "ws://a",
        address: ADDR_A,
        topic0: TOPIC_EMITTED,
        handler: h1,
      });
      await manager.subscribeToLogs({
        chainId: CHAIN_A,
        wssUrl: "ws://a",
        address: ADDR_A,
        topic0: TOPIC_EMITTED,
        handler: h2,
      });

      const provider = factoryBundle.created[0];
      const log = {
        address: ADDR_A.toLowerCase(),
        topics: [TOPIC_EMITTED],
      };
      provider.sendResponses = [[log]];
      await provider.emitBlock(102);

      expect(h1).toHaveBeenCalledTimes(1);
      expect(h2).toHaveBeenCalledTimes(1);
    });

    it("dispatches matching subscribers in parallel, not serially", async () => {
      // Two handlers on the same (address, topic0). h1 sleeps; h2 should
      // start before h1 resolves. With sequential await the h2 start time
      // would be >= 50ms; in parallel it should be ~0ms.
      let h1Started = 0;
      let h2Started = 0;
      let start = 0;
      const h1 = vi.fn(async () => {
        h1Started = Date.now() - start;
        await new Promise((r) => setTimeout(r, 50));
      });
      const h2 = vi.fn(async () => {
        h2Started = Date.now() - start;
      });
      await manager.subscribeToLogs({
        chainId: CHAIN_A,
        wssUrl: "ws://a",
        address: ADDR_A,
        topic0: TOPIC_EMITTED,
        handler: h1,
      });
      await manager.subscribeToLogs({
        chainId: CHAIN_A,
        wssUrl: "ws://a",
        address: ADDR_A,
        topic0: TOPIC_EMITTED,
        handler: h2,
      });

      const provider = factoryBundle.created[0];
      const log = {
        address: ADDR_A.toLowerCase(),
        topics: [TOPIC_EMITTED],
      };
      provider.sendResponses = [[log]];
      start = Date.now();
      await provider.emitBlock(500);

      expect(h1).toHaveBeenCalledTimes(1);
      expect(h2).toHaveBeenCalledTimes(1);
      // h2 starts well before h1's 50ms sleep completes.
      expect(h2Started).toBeLessThan(40);
      expect(h1Started).toBeLessThan(10);
    });

    it("one handler throwing does not block or abort the others", async () => {
      const thrower = vi.fn(async () => {
        throw new Error("boom");
      });
      const later = vi.fn();
      await manager.subscribeToLogs({
        chainId: CHAIN_A,
        wssUrl: "ws://a",
        address: ADDR_A,
        topic0: TOPIC_EMITTED,
        handler: thrower,
      });
      await manager.subscribeToLogs({
        chainId: CHAIN_A,
        wssUrl: "ws://a",
        address: ADDR_A,
        topic0: TOPIC_EMITTED,
        handler: later,
      });

      const provider = factoryBundle.created[0];
      const log = {
        address: ADDR_A.toLowerCase(),
        topics: [TOPIC_EMITTED],
      };
      provider.sendResponses = [[log]];
      await provider.emitBlock(501);

      expect(thrower).toHaveBeenCalledTimes(1);
      expect(later).toHaveBeenCalledTimes(1);
    });

    it("does not call a handler after its subscription is cancelled", async () => {
      const handler = vi.fn();
      const unsubscribe = await manager.subscribeToLogs({
        chainId: CHAIN_A,
        wssUrl: "ws://a",
        address: ADDR_A,
        topic0: TOPIC_EMITTED,
        handler,
      });
      // Need a second subscriber so the block listener stays attached.
      await manager.subscribeToLogs({
        chainId: CHAIN_A,
        wssUrl: "ws://a",
        address: ADDR_B,
        topic0: TOPIC_OTHER,
        handler: vi.fn(),
      });

      unsubscribe();

      const provider = factoryBundle.created[0];
      const log = {
        address: ADDR_A.toLowerCase(),
        topics: [TOPIC_EMITTED],
      };
      provider.sendResponses = [[log]];
      await provider.emitBlock(103);

      expect(handler).not.toHaveBeenCalled();
    });

    it("isolates handler errors: one throwing handler does not skip later handlers", async () => {
      const throwing = vi.fn(() => {
        throw new Error("boom");
      });
      const later = vi.fn();
      await manager.subscribeToLogs({
        chainId: CHAIN_A,
        wssUrl: "ws://a",
        address: ADDR_A,
        topic0: TOPIC_EMITTED,
        handler: throwing,
      });
      await manager.subscribeToLogs({
        chainId: CHAIN_A,
        wssUrl: "ws://a",
        address: ADDR_A,
        topic0: TOPIC_EMITTED,
        handler: later,
      });

      const provider = factoryBundle.created[0];
      const log = {
        address: ADDR_A.toLowerCase(),
        topics: [TOPIC_EMITTED],
      };
      provider.sendResponses = [[log]];
      await provider.emitBlock(104);

      expect(throwing).toHaveBeenCalledTimes(1);
      expect(later).toHaveBeenCalledTimes(1);
    });
  });

  describe("introspection accessors", () => {
    it("hasProvider returns false for unknown chain", () => {
      expect(manager.hasProvider(CHAIN_A)).toBe(false);
    });

    it("hasProvider returns true after a provider has been created", async () => {
      await manager.subscribeToLogs({
        chainId: CHAIN_A,
        wssUrl: "ws://a",
        address: ADDR_A,
        topic0: TOPIC_EMITTED,
        handler: vi.fn(),
      });
      expect(manager.hasProvider(CHAIN_A)).toBe(true);
      expect(manager.hasProvider(CHAIN_B)).toBe(false);
    });

    it("subscriberCount reflects the shared-provider invariant", async () => {
      expect(manager.subscriberCount(CHAIN_A)).toBe(0);

      const unsubA = await manager.subscribeToLogs({
        chainId: CHAIN_A,
        wssUrl: "ws://a",
        address: ADDR_A,
        topic0: TOPIC_EMITTED,
        handler: vi.fn(),
      });
      expect(manager.subscriberCount(CHAIN_A)).toBe(1);

      await manager.subscribeToLogs({
        chainId: CHAIN_A,
        wssUrl: "ws://a",
        address: ADDR_B,
        topic0: TOPIC_EMITTED,
        handler: vi.fn(),
      });
      expect(manager.subscriberCount(CHAIN_A)).toBe(2);
      expect(factoryBundle.created).toHaveLength(1);

      unsubA();
      expect(manager.subscriberCount(CHAIN_A)).toBe(1);
    });
  });

  describe("health accessors", () => {
    it("isHealthy returns false for unknown chain", () => {
      expect(manager.isHealthy(CHAIN_A)).toBe(false);
    });

    it("isHealthy returns true after a provider is created", async () => {
      await manager.getOrCreateProvider(CHAIN_A, "ws://a");
      expect(manager.isHealthy(CHAIN_A)).toBe(true);
    });

    it("getHealth returns null for unknown chain", () => {
      expect(manager.getHealth(CHAIN_A)).toBeNull();
    });

    it("getHealth reports connected/reconnecting/subscriberCount", async () => {
      await manager.subscribeToLogs({
        chainId: CHAIN_A,
        wssUrl: "ws://a",
        address: ADDR_A,
        topic0: TOPIC_EMITTED,
        handler: vi.fn(),
      });
      const h = manager.getHealth(CHAIN_A);
      expect(h).toEqual({
        chainId: CHAIN_A,
        wssUrl: "ws://a",
        fallbackWssUrl: null,
        connected: true,
        reconnecting: false,
        lastBlockAt: null,
        subscriberCount: 1,
        lastCreateError: null,
      });
    });

    it("getHealth.lastBlockAt updates after a block arrives", async () => {
      await manager.subscribeToLogs({
        chainId: CHAIN_A,
        wssUrl: "ws://a",
        address: ADDR_A,
        topic0: TOPIC_EMITTED,
        handler: vi.fn(),
      });
      expect(manager.getHealth(CHAIN_A)?.lastBlockAt).toBeNull();
      await factoryBundle.created[0].emitBlock(123);
      const after = manager.getHealth(CHAIN_A)?.lastBlockAt;
      expect(after).not.toBeNull();
      expect(typeof after).toBe("number");
    });

    it("getAllHealth returns an entry per known chain", async () => {
      await manager.getOrCreateProvider(CHAIN_A, "ws://a");
      await manager.getOrCreateProvider(CHAIN_B, "ws://b");
      const all = manager.getAllHealth();
      expect(all).toHaveLength(2);
      expect(all.map((h) => h.chainId).sort()).toEqual([CHAIN_B, CHAIN_A]);
    });

    it("getAllHealth returns empty when no chains are registered", () => {
      expect(manager.getAllHealth()).toEqual([]);
    });
  });

  describe("onDisconnect", () => {
    it("throws when no entry exists for the chain", () => {
      expect(() => manager.onDisconnect(CHAIN_A, vi.fn())).toThrow(
        /no entry for chainId/,
      );
    });

    it("fires with chainId and reason when the provider emits an error", async () => {
      await manager.getOrCreateProvider(CHAIN_A, "ws://a");
      const handler = vi.fn();
      manager.onDisconnect(CHAIN_A, handler);

      factoryBundle.created[0].emitError(new Error("boom"));
      // Allow the reconnect microtask queue to start so the disconnect
      // handler fires; reconnect itself is delayed (INITIAL_RECONNECT_DELAY_MS).
      await Promise.resolve();
      await Promise.resolve();

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({
        chainId: CHAIN_A,
        reason: "provider_error",
        message: "boom",
      });
    });

    it("unsubscribe removes the handler", async () => {
      await manager.getOrCreateProvider(CHAIN_A, "ws://a");
      const handler = vi.fn();
      const unsub = manager.onDisconnect(CHAIN_A, handler);
      unsub();

      factoryBundle.created[0].emitError(new Error("boom"));
      await Promise.resolve();

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("reconnect cycle", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("re-creates provider, preserves subscribers, reattaches block listener", async () => {
      const handler = vi.fn();
      await manager.subscribeToLogs({
        chainId: CHAIN_A,
        wssUrl: "ws://a",
        address: ADDR_A,
        topic0: TOPIC_EMITTED,
        handler,
      });
      expect(factoryBundle.created).toHaveLength(1);
      const first = factoryBundle.created[0];

      first.emitError(new Error("wss dropped"));
      // Let disconnect handlers run, then fast-forward past the reconnect
      // delay so the first attempt completes.
      await vi.advanceTimersByTimeAsync(1_500);

      expect(factoryBundle.created).toHaveLength(2);
      const second = factoryBundle.created[1];
      // The subscription must survive, and the new provider must be wired
      // up for both block events and future errors.
      expect(manager.subscriberCount(CHAIN_A)).toBe(1);
      expect(second.hasBlockHandler()).toBe(true);
      expect(second.hasErrorHandler()).toBe(true);
      // Old provider was torn down.
      expect(first.destroyed).toBe(true);
      // isHealthy true again after successful reconnect.
      expect(manager.isHealthy(CHAIN_A)).toBe(true);
      expect(manager.getHealth(CHAIN_A)?.reconnecting).toBe(false);
    });

    it("does not re-attach block listener if all subscribers unsubscribed during reconnect", async () => {
      const handler = vi.fn();
      const unsub = await manager.subscribeToLogs({
        chainId: CHAIN_A,
        wssUrl: "ws://a",
        address: ADDR_A,
        topic0: TOPIC_EMITTED,
        handler,
      });
      factoryBundle.created[0].emitError(new Error("drop"));
      // Unsubscribe while reconnect is in flight (before the delay).
      unsub();
      await vi.advanceTimersByTimeAsync(1_500);

      const second = factoryBundle.created[1];
      expect(second.hasBlockHandler()).toBe(false);
      // Error listener is still attached; it is chain-scoped, not sub-scoped.
      expect(second.hasErrorHandler()).toBe(true);
    });

    it("onDisconnect fires before the first reconnect attempt completes", async () => {
      await manager.getOrCreateProvider(CHAIN_A, "ws://a");
      const order: string[] = [];
      manager.onDisconnect(CHAIN_A, () => {
        order.push("disconnect");
      });
      // Spy the factory call count - reconnect creates a new provider.
      const createdBefore = factoryBundle.created.length;

      factoryBundle.created[0].emitError(new Error("drop"));
      await Promise.resolve();
      order.push(
        `after_microtasks(created=${factoryBundle.created.length - createdBefore})`,
      );

      await vi.advanceTimersByTimeAsync(1_500);
      order.push(
        `after_delay(created=${factoryBundle.created.length - createdBefore})`,
      );

      expect(order[0]).toBe("disconnect");
      expect(order[1]).toBe("after_microtasks(created=0)");
      expect(order[2]).toBe("after_delay(created=1)");
    });

    it("isHealthy is false while reconnecting", async () => {
      await manager.getOrCreateProvider(CHAIN_A, "ws://a");
      factoryBundle.created[0].emitError(new Error("drop"));
      // Give the disconnect handler loop a chance to set isReconnecting,
      // but do NOT advance past the reconnect delay.
      await Promise.resolve();
      await Promise.resolve();
      expect(manager.getHealth(CHAIN_A)?.reconnecting).toBe(true);
      expect(manager.isHealthy(CHAIN_A)).toBe(false);

      await vi.advanceTimersByTimeAsync(1_500);
      expect(manager.isHealthy(CHAIN_A)).toBe(true);
    });

    it("exhausted attempts call onPermanentFailure (injected)", async () => {
      await manager.subscribeToLogs({
        chainId: CHAIN_A,
        wssUrl: "ws://a",
        address: ADDR_A,
        topic0: TOPIC_EMITTED,
        handler: vi.fn(),
      });
      // Make every subsequent factory call throw so the reconnect loop
      // burns through all 10 attempts.
      factoryBundle.setPersistentFailure(new Error("upstream down"));

      factoryBundle.created[0].emitError(new Error("drop"));
      // Fast-forward through all reconnect attempts (1s + 2s + 4s + ...,
      // capped at 60s per attempt; 10 attempts total).
      await vi.advanceTimersByTimeAsync(10 * 60_000);

      expect(onPermanentFailure).toHaveBeenCalledTimes(1);
      expect(onPermanentFailure).toHaveBeenCalledWith(CHAIN_A);
    });

    it("subscribe after exhaustion re-wires block listener and heartbeat on the new provider", async () => {
      // This covers a test-only edge case: when onPermanentFailure is a
      // no-op (prod would exit the process), the manager is left with
      // entry.provider=null and subscribers intact. A fresh subscribe
      // must still produce a working provider (block listener attached,
      // heartbeat running). Keying off `!entry.blockListener` rather
      // than "was the subscriber set empty" is what makes this work.
      await manager.subscribeToLogs({
        chainId: CHAIN_A,
        wssUrl: "ws://a",
        address: ADDR_A,
        topic0: TOPIC_EMITTED,
        handler: vi.fn(),
      });
      factoryBundle.setPersistentFailure(new Error("upstream down"));
      factoryBundle.created[0].emitError(new Error("drop"));
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(onPermanentFailure).toHaveBeenCalledTimes(1);

      // Upstream is healthy again. Clear the persistent failure and add
      // another subscriber for the same chain.
      factoryBundle.setPersistentFailure(null);
      await manager.subscribeToLogs({
        chainId: CHAIN_A,
        wssUrl: "ws://a",
        address: ADDR_B,
        topic0: TOPIC_EMITTED,
        handler: vi.fn(),
      });

      // A fresh provider must exist AND have its block listener and
      // heartbeat active; otherwise the new subscriber would silently
      // never receive events.
      expect(manager.isHealthy(CHAIN_A)).toBe(true);
      const latest = factoryBundle.created.at(-1);
      expect(latest?.hasBlockHandler()).toBe(true);
      expect(latest?.hasErrorHandler()).toBe(true);
      // Heartbeat fires periodically on the new provider.
      await vi.advanceTimersByTimeAsync(30_100);
      const pings = latest?.sendCalls.filter(
        (c) => c.method === "eth_blockNumber",
      ).length;
      expect(pings ?? 0).toBeGreaterThan(0);
    });

    it("concurrent subscribe during reconnect does not fire a second factory call (race fix)", async () => {
      // Without the reconnectPromise guard, a new subscribe arriving
      // while reconnect has torn down the old provider (entry.provider
      // null, entry.readyPromise null) would call createProvider and
      // produce a second factory call. The race was this test's reason
      // to exist.
      await manager.subscribeToLogs({
        chainId: CHAIN_A,
        wssUrl: "ws://a",
        address: ADDR_A,
        topic0: TOPIC_EMITTED,
        handler: vi.fn(),
      });
      expect(factoryBundle.created).toHaveLength(1);

      factoryBundle.created[0].emitError(new Error("drop"));
      // Start a second subscription mid-reconnect. The call should
      // block on entry.reconnectPromise and resolve only once the
      // reconnect has assigned the new provider.
      const subscribePromise = manager.subscribeToLogs({
        chainId: CHAIN_A,
        wssUrl: "ws://a",
        address: ADDR_B,
        topic0: TOPIC_EMITTED,
        handler: vi.fn(),
      });

      // Before the delay elapses, no reconnect has completed.
      await Promise.resolve();
      expect(factoryBundle.created).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1_500);
      await subscribePromise;

      // Exactly one reconnect-time factory call, not two.
      expect(factoryBundle.created).toHaveLength(2);
      expect(manager.subscriberCount(CHAIN_A)).toBe(2);
    });

    it("destroy during reconnect: no orphan providers, no pending loops, chains cleared", async () => {
      await manager.subscribeToLogs({
        chainId: CHAIN_A,
        wssUrl: "ws://a",
        address: ADDR_A,
        topic0: TOPIC_EMITTED,
        handler: vi.fn(),
      });

      factoryBundle.created[0].emitError(new Error("drop"));
      // Pause just before the reconnect attempt would fire.
      await vi.advanceTimersByTimeAsync(999);

      // Destroy while the reconnect is sleeping. The destroy signal
      // wakes the sleep via Promise.race so this resolves in finite
      // time even with fake timers still paused.
      await manager.destroy();

      // Every provider that was created must have been destroyed. No
      // more than one additional provider should exist (the one
      // initial provider and at most one reconnect attempt before
      // destroy won the race).
      expect(factoryBundle.created.length).toBeLessThanOrEqual(2);
      for (const p of factoryBundle.created) {
        expect(p.destroyed).toBe(true);
      }

      // No dangling per-chain state.
      expect(manager.getAllHealth()).toEqual([]);
      expect(manager.isHealthy(CHAIN_A)).toBe(false);
      expect(manager.hasProvider(CHAIN_A)).toBe(false);
    });

    it("destroy awaits an in-flight reconnect rather than racing it", async () => {
      await manager.subscribeToLogs({
        chainId: CHAIN_A,
        wssUrl: "ws://a",
        address: ADDR_A,
        topic0: TOPIC_EMITTED,
        handler: vi.fn(),
      });
      // Make every reconnect attempt throw so the loop spends its full
      // life in the backoff sleeps rather than completing.
      factoryBundle.setPersistentFailure(new Error("upstream down"));

      factoryBundle.created[0].emitError(new Error("drop"));
      // Give the loop a tick to enter its first sleep.
      await Promise.resolve();

      const destroyDone = vi.fn();
      const destroyPromise = manager.destroy().then(destroyDone);

      // Before destroy resolves, there must have been no completion
      // callback. destroyedPromise wakes the loop immediately; loop
      // sees isDestroyed, runs its finally, reconnectPromise becomes
      // null, destroy's own await unblocks, and only then does
      // destroyDone fire.
      await Promise.resolve();
      // Under fake timers the above microtasks flush synchronously; by
      // this point destroy's `await entry.reconnectPromise` has had
      // enough turns to resolve if it was going to.
      await destroyPromise;
      expect(destroyDone).toHaveBeenCalledTimes(1);
    });

    it("a second drop after successful reconnect triggers another reconnect cycle", async () => {
      await manager.subscribeToLogs({
        chainId: CHAIN_A,
        wssUrl: "ws://a",
        address: ADDR_A,
        topic0: TOPIC_EMITTED,
        handler: vi.fn(),
      });

      factoryBundle.created[0].emitError(new Error("drop 1"));
      await vi.advanceTimersByTimeAsync(1_500);
      expect(factoryBundle.created).toHaveLength(2);
      expect(manager.isHealthy(CHAIN_A)).toBe(true);

      // Drop again on the new provider.
      factoryBundle.created[1].emitError(new Error("drop 2"));
      await vi.advanceTimersByTimeAsync(1_500);

      expect(factoryBundle.created).toHaveLength(3);
      expect(manager.isHealthy(CHAIN_A)).toBe(true);
      expect(manager.subscriberCount(CHAIN_A)).toBe(1);
    });

    it("treats a probe failure on reconnect as a failed attempt and retries", async () => {
      // The probe runs on every fresh provider, including those built
      // by reconnect. If the new provider's RPC stops supporting
      // eth_subscribe (transient or persistent), the probe failure
      // must surface to reconnectLoop so backoff and the
      // permanent-failure guardrail still fire.
      await manager.subscribeToLogs({
        chainId: CHAIN_A,
        wssUrl: "ws://a",
        address: ADDR_A,
        topic0: TOPIC_EMITTED,
        handler: vi.fn(),
      });

      // Drop the connection. The next factory call returns a new
      // mock whose probe fails - reconnect should treat that as a
      // failed attempt rather than installing a half-working provider.
      factoryBundle.setNextSubscribeFailure(
        new Error('unsupported operation (operation="eth_subscribe")'),
      );
      factoryBundle.created[0].emitError(new Error("drop"));

      await vi.advanceTimersByTimeAsync(1_500);
      expect(factoryBundle.created).toHaveLength(2);
      // Probe failed, so the new provider was not installed.
      expect(manager.isHealthy(CHAIN_A)).toBe(false);
      // Subsequent reconnect attempt (probe re-armed false by default,
      // so factory returns a healthy mock) recovers.
      await vi.advanceTimersByTimeAsync(2_500);
      expect(manager.isHealthy(CHAIN_A)).toBe(true);
    });

    it("walks to the fallback URL when the primary fails on reconnect", async () => {
      // Reconnect runs the same primary-then-fallback walk as the
      // initial createProvider. With one armed probe failure, the
      // reconnect's primary attempt fails and openProvider falls
      // through to the fallback. The active URL surfaces through
      // getHealth so operators can see failover via /healthz mid-incident.
      await manager.subscribeToLogs({
        chainId: CHAIN_A,
        wssUrl: "ws://primary",
        fallbackWssUrl: "ws://fb",
        address: ADDR_A,
        topic0: TOPIC_EMITTED,
        handler: vi.fn(),
      });
      expect(factoryBundle.created).toHaveLength(1);
      expect(manager.getHealth(CHAIN_A)?.wssUrl).toBe("ws://primary");

      // Arm a one-shot probe failure. The reconnect's primary attempt
      // gets it; the fallback attempt that follows has no failure armed.
      factoryBundle.setNextSubscribeFailure(
        new Error('unsupported operation (operation="eth_subscribe")'),
      );
      factoryBundle.created[0].emitError(new Error("wss dropped"));
      await vi.advanceTimersByTimeAsync(1_500);

      // openProvider tore down the failed primary attempt before
      // moving on, then created a fresh mock for the fallback.
      // Initial + primary attempt + fallback attempt = 3 providers.
      expect(factoryBundle.created).toHaveLength(3);
      expect(factoryBundle.created[1].destroyed).toBe(true);
      expect(factoryBundle.created[2].destroyed).toBe(false);
      expect(manager.isHealthy(CHAIN_A)).toBe(true);
      expect(manager.getHealth(CHAIN_A)?.wssUrl).toBe("ws://fb");
      // Block listener and heartbeat must be re-attached on the
      // fallback provider; otherwise events would be silently dropped
      // after failover.
      expect(factoryBundle.created[2].hasBlockHandler()).toBe(true);
      expect(factoryBundle.created[2].hasErrorHandler()).toBe(true);
    });

    it("flips back to the primary on the next reconnect once the primary recovers", async () => {
      // Running on the fallback is a degraded state, not a sticky one.
      // When the primary recovers, the next reconnect's primary-first
      // walk picks it up. Without this, a transient primary blip would
      // strand the chain on the fallback until process restart.
      await manager.subscribeToLogs({
        chainId: CHAIN_A,
        wssUrl: "ws://primary",
        fallbackWssUrl: "ws://fb",
        address: ADDR_A,
        topic0: TOPIC_EMITTED,
        handler: vi.fn(),
      });

      // First reconnect: primary fails, manager runs on fallback.
      factoryBundle.setNextSubscribeFailure(new Error("transient"));
      factoryBundle.created[0].emitError(new Error("drop"));
      await vi.advanceTimersByTimeAsync(1_500);
      expect(manager.getHealth(CHAIN_A)?.wssUrl).toBe("ws://fb");
      const fallbackProvider = factoryBundle.created.at(-1);
      const createdBeforeSecond = factoryBundle.created.length;

      // Second reconnect: nothing armed, so the primary attempt
      // succeeds and openProvider returns on the first URL it tries.
      // The fallback URL is never even hit.
      fallbackProvider?.emitError(new Error("drop 2"));
      await vi.advanceTimersByTimeAsync(1_500);

      // Exactly one new provider for the recovered primary - no
      // wasted fallback factory call.
      expect(factoryBundle.created.length - createdBeforeSecond).toBe(1);
      expect(manager.isHealthy(CHAIN_A)).toBe(true);
      expect(manager.getHealth(CHAIN_A)?.wssUrl).toBe("ws://primary");
    });
  });

  describe("heartbeat", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("does not ping when no subscribers are registered", async () => {
      // Heartbeat is subscriber-scoped: creating a provider without
      // subscribing leaves it silent. Previously the heartbeat started
      // on provider creation, wasting RPC calls on idle providers.
      // Baseline after connect so the initial connect probe (a single
      // getBlockNumber call inside openProvider) is not counted as a ping.
      await manager.getOrCreateProvider(CHAIN_A, "ws://a");
      const provider = factoryBundle.created[0];
      const pingsBefore = provider.sendCalls.filter(
        (c) => c.method === "eth_blockNumber",
      ).length;

      await vi.advanceTimersByTimeAsync(60_000);

      const pingsAfter = provider.sendCalls.filter(
        (c) => c.method === "eth_blockNumber",
      ).length;
      expect(pingsAfter).toBe(pingsBefore);
    });

    it("pings eth_blockNumber periodically once a subscriber is added", async () => {
      await manager.subscribeToLogs({
        chainId: CHAIN_A,
        wssUrl: "ws://a",
        address: ADDR_A,
        topic0: TOPIC_EMITTED,
        handler: vi.fn(),
      });
      const provider = factoryBundle.created[0];
      const pingsBefore = provider.sendCalls.filter(
        (c) => c.method === "eth_blockNumber",
      ).length;

      await vi.advanceTimersByTimeAsync(30_000);

      const pingsAfter = provider.sendCalls.filter(
        (c) => c.method === "eth_blockNumber",
      ).length;
      expect(pingsAfter).toBeGreaterThan(pingsBefore);
    });

    it("stops when the last subscriber unsubscribes", async () => {
      const unsub = await manager.subscribeToLogs({
        chainId: CHAIN_A,
        wssUrl: "ws://a",
        address: ADDR_A,
        topic0: TOPIC_EMITTED,
        handler: vi.fn(),
      });
      const provider = factoryBundle.created[0];
      unsub();

      const pingsBefore = provider.sendCalls.filter(
        (c) => c.method === "eth_blockNumber",
      ).length;
      await vi.advanceTimersByTimeAsync(60_000);
      const pingsAfter = provider.sendCalls.filter(
        (c) => c.method === "eth_blockNumber",
      ).length;
      expect(pingsAfter).toBe(pingsBefore);
    });

    it("thrown eth_blockNumber triggers reconnect with heartbeat_failure reason", async () => {
      await manager.subscribeToLogs({
        chainId: CHAIN_A,
        wssUrl: "ws://a",
        address: ADDR_A,
        topic0: TOPIC_EMITTED,
        handler: vi.fn(),
      });
      const provider = factoryBundle.created[0];
      const reasons: string[] = [];
      manager.onDisconnect(CHAIN_A, (ev) => {
        reasons.push(ev.reason);
      });

      provider.blockNumberResponses.push(new Error("rpc dead"));
      await vi.advanceTimersByTimeAsync(30_100);

      expect(reasons).toEqual(["heartbeat_failure"]);
    });

    it("timeout triggers reconnect with heartbeat_timeout reason", async () => {
      await manager.subscribeToLogs({
        chainId: CHAIN_A,
        wssUrl: "ws://a",
        address: ADDR_A,
        topic0: TOPIC_EMITTED,
        handler: vi.fn(),
      });
      const provider = factoryBundle.created[0];
      const reasons: string[] = [];
      manager.onDisconnect(CHAIN_A, (ev) => {
        reasons.push(ev.reason);
      });

      // Make eth_blockNumber hang indefinitely. The 10s timeout inside
      // runHeartbeat should fire and surface as heartbeat_timeout.
      provider.send = ((): Promise<unknown> => {
        return new Promise<unknown>(() => {
          // never resolves
        });
      }) as unknown as typeof provider.send;

      await vi.advanceTimersByTimeAsync(30_000); // schedule first heartbeat
      await vi.advanceTimersByTimeAsync(10_000); // let timeout race win

      expect(reasons).toEqual(["heartbeat_timeout"]);
    });
  });

  describe("block-staleness watchdog", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    // A short staleness ceiling so the watchdog trips within a couple of
    // heartbeat ticks under fake timers, without advancing past the
    // production threshold.
    function makeStalenessManager(
      timeoutMs: number,
    ): ReturnType<typeof makeFactory> & { mgr: ChainProviderManager } {
      const bundle = makeFactory();
      const mgr = new ChainProviderManager({
        factory: bundle.factory,
        onPermanentFailure,
        blockStalenessTimeoutMs: timeoutMs,
      });
      return { ...bundle, mgr };
    }

    it("reconnects when the heartbeat passes but no block arrives (silent subscription drop)", async () => {
      const { created, mgr } = makeStalenessManager(60_000);
      await mgr.subscribeToLogs({
        chainId: CHAIN_A,
        wssUrl: "ws://a",
        address: ADDR_A,
        topic0: TOPIC_EMITTED,
        handler: vi.fn(),
      });
      const reasons: string[] = [];
      mgr.onDisconnect(CHAIN_A, (ev) => {
        reasons.push(ev.reason);
      });

      // Deliver one block, then go silent while the heartbeat keeps
      // answering (MockProvider.eth_blockNumber returns a value by default).
      await created[0].emitBlock(1000);

      // Advance past the 60s ceiling (trips at the 90s heartbeat) plus the
      // reconnect backoff so the replacement provider is created.
      await vi.advanceTimersByTimeAsync(92_100);

      expect(reasons).toContain("block_staleness");
      // A fresh provider was created by the reconnect.
      expect(created.length).toBeGreaterThanOrEqual(2);
      await mgr.destroy();
    });

    it("does not reconnect while blocks keep arriving within the ceiling", async () => {
      const { created, mgr } = makeStalenessManager(60_000);
      await mgr.subscribeToLogs({
        chainId: CHAIN_A,
        wssUrl: "ws://a",
        address: ADDR_A,
        topic0: TOPIC_EMITTED,
        handler: vi.fn(),
      });
      const reasons: string[] = [];
      mgr.onDisconnect(CHAIN_A, (ev) => {
        reasons.push(ev.reason);
      });

      // Emit a block every 30s for 2 minutes - each within the 60s ceiling.
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(30_000);
        await created[0].emitBlock(2000 + i);
      }

      expect(reasons).not.toContain("block_staleness");
      expect(created).toHaveLength(1);
      await mgr.destroy();
    });

    it("does not run the staleness check when there are no subscribers", async () => {
      const { created, mgr } = makeStalenessManager(60_000);
      // Provider created but never subscribed: no block listener, so the
      // provider is legitimately silent and must not be reconnected.
      await mgr.getOrCreateProvider(CHAIN_A, "ws://a");
      const reasons: string[] = [];
      mgr.onDisconnect(CHAIN_A, (ev) => {
        reasons.push(ev.reason);
      });

      await vi.advanceTimersByTimeAsync(120_000);

      expect(reasons).toEqual([]);
      expect(created).toHaveLength(1);
      await mgr.destroy();
    });

    it("gives a reconnected provider a fresh window instead of tripping immediately", async () => {
      const { created, mgr } = makeStalenessManager(60_000);
      await mgr.subscribeToLogs({
        chainId: CHAIN_A,
        wssUrl: "ws://a",
        address: ADDR_A,
        topic0: TOPIC_EMITTED,
        handler: vi.fn(),
      });

      await created[0].emitBlock(3000);
      // Trip the watchdog: silence past the ceiling plus reconnect backoff
      // forces a reconnect and a fresh provider.
      await vi.advanceTimersByTimeAsync(92_100);
      expect(created.length).toBeGreaterThanOrEqual(2);

      const afterReconnect = created.length;
      // The new provider has not delivered a block yet, but its attach time
      // is fresh. One more heartbeat tick within the ceiling must NOT spawn
      // yet another reconnect.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(created).toHaveLength(afterReconnect);
      await mgr.destroy();
    });
  });

  describe("destroy", () => {
    it("tears down every chain's provider and clears subscriber state", async () => {
      await manager.subscribeToLogs({
        chainId: CHAIN_A,
        wssUrl: "ws://a",
        address: ADDR_A,
        topic0: TOPIC_EMITTED,
        handler: vi.fn(),
      });
      await manager.subscribeToLogs({
        chainId: CHAIN_B,
        wssUrl: "ws://b",
        address: ADDR_B,
        topic0: TOPIC_EMITTED,
        handler: vi.fn(),
      });

      await manager.destroy();

      expect(factoryBundle.created).toHaveLength(2);
      expect(factoryBundle.created[0].destroyed).toBe(true);
      expect(factoryBundle.created[1].destroyed).toBe(true);
      expect(factoryBundle.created[0].hasBlockHandler()).toBe(false);
    });
  });
});
