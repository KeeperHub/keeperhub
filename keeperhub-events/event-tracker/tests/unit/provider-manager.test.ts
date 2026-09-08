import type { ethers } from "ethers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BLOCK_INTERVAL_MIN_SAMPLES,
  BLOCK_INTERVAL_MIN_SPAN_MS,
  BLOCK_STALENESS_BLOCK_MULTIPLIER,
  BLOCK_STALENESS_FLOOR_MS,
  BLOCK_STALENESS_TIMEOUT_MS,
  ChainProviderManager,
  GETLOGS_ADDRESS_BATCH,
  GETLOGS_MAX_BLOCK_SPAN,
  GETLOGS_MAX_CATCHUP_BLOCKS,
  GETLOGS_MIN_INTERVAL_MS,
  GETLOGS_TIMEOUT_MS,
  GETLOGS_TIMEOUT_RECONNECT_THRESHOLD,
  type ProviderFactory,
  REORG_REWIND_MAX_BLOCKS,
  STATS_LOG_INTERVAL_MS,
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
  // Lets a test hold a request in flight to exercise overlap guards.
  public beforeSend: ((method: string) => Promise<void> | null) | null = null;
  // When set, every eth_getLogs rejects until cleared - a persistently
  // unhealthy upstream, as opposed to the one-shot queued Errors in
  // sendResponses. Same convention as subscribeFailure.
  public getLogsFailure: Error | null = null;
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
    const gate = this.beforeSend?.(method);
    if (gate) {
      await gate;
    }
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
    if (method === "eth_getLogs" && this.getLogsFailure) {
      throw this.getLogsFailure;
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
    const next = this.sendResponses.shift();
    // Same convention as blockNumberResponses: a queued Error rejects the
    // call rather than being returned as a value.
    if (next instanceof Error) {
      throw next;
    }
    return next;
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
        blockIntervalMs: null,
        blocksBehindHead: null,
        getLogsCallsTotal: 0,
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

  // One place for the dispatch-suite scaffolding. Both suites below drive the
  // same shape of scenario, and duplicating it once already let a constant
  // change make an assertion vacuous rather than fail.
  describe("getLogs dispatch", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    async function subscribe(
      mgr: ChainProviderManager = manager,
    ): Promise<MockProvider> {
      const before = factoryBundle.created.length;
      await mgr.subscribeToLogs({
        chainId: CHAIN_A,
        wssUrl: "ws://a",
        address: ADDR_A,
        topic0: TOPIC_EMITTED,
        handler: vi.fn(),
      });
      return factoryBundle.created[before];
    }

    function getLogsCalls(provider: MockProvider): SendCall[] {
      return provider.sendCalls.filter((c) => c.method === "eth_getLogs");
    }

    function ranges(
      provider: MockProvider,
    ): Array<{ from: number; to: number }> {
      return getLogsCalls(provider).map((call) => {
        const filter = call.params[0] as { fromBlock: string; toBlock: string };
        return {
          from: Number.parseInt(filter.fromBlock, 16),
          to: Number.parseInt(filter.toBlock, 16),
        };
      });
    }

    /** Deliver `count` blocks `intervalMs` apart, starting at `firstBlock`. */
    async function emitBlocks(
      provider: MockProvider,
      firstBlock: number,
      count: number,
      intervalMs: number,
    ): Promise<void> {
      for (let i = 0; i < count; i += 1) {
        await provider.emitBlock(firstBlock + i);
        await vi.advanceTimersByTimeAsync(intervalMs);
      }
    }

    function statsLines(spy: ReturnType<typeof vi.spyOn>): string[] {
      return spy.mock.calls
        .map((args) => String(args[0]))
        .filter((line) => line.includes("getlogs-stats"));
    }

    describe("rate limiting", () => {
      it("dispatches every block immediately on a chain slower than the interval", async () => {
        const provider = await subscribe();

        // Base's cadence. Each block arrives well after the previous request,
        // so the minimum interval has always already elapsed and nothing is
        // deferred. This is the property that keeps every chain supported
        // today on its current latency.
        await emitBlocks(provider, 100, 5, GETLOGS_MIN_INTERVAL_MS * 2);

        expect(ranges(provider)).toEqual([
          { from: 100, to: 100 },
          { from: 101, to: 101 },
          { from: 102, to: 102 },
          { from: 103, to: 103 },
          { from: 104, to: 104 },
        ]);
      });

      it("serves a burst of sub-interval blocks in one ranged request", async () => {
        const provider = await subscribe();

        // 100 ms cadence: the first block goes out immediately, the rest
        // accumulate against the high-water mark until the interval elapses.
        await emitBlocks(provider, 200, 6, 100);
        await vi.advanceTimersByTimeAsync(GETLOGS_MIN_INTERVAL_MS);

        expect(ranges(provider)).toEqual([
          { from: 200, to: 200 },
          { from: 201, to: 205 },
        ]);
      });

      it("issues at most one request per interval under sustained load", async () => {
        const provider = await subscribe();

        // 100 blocks at 100 ms is 10 s of chain time. Unlimited, that is 100
        // requests; the cap is one per second plus the immediate first.
        await emitBlocks(provider, 300, 100, 100);
        await vi.advanceTimersByTimeAsync(GETLOGS_MIN_INTERVAL_MS * 2);

        const calls = getLogsCalls(provider).length;
        expect(calls).toBeLessThanOrEqual(13);
        expect(calls).toBeGreaterThan(0);
      });

      it("covers blocks the subscription never pushed", async () => {
        const provider = await subscribe();

        // 401-404 are never delivered. The range is contiguous from the mark,
        // so they are queried anyway - a per-block loop dropped them.
        await provider.emitBlock(400);
        await vi.advanceTimersByTimeAsync(100);
        await provider.emitBlock(405);
        await vi.advanceTimersByTimeAsync(GETLOGS_MIN_INTERVAL_MS);

        expect(ranges(provider)).toEqual([
          { from: 400, to: 400 },
          { from: 401, to: 405 },
        ]);
      });

      it("caps the span of one request and carries the remainder", async () => {
        const provider = await subscribe();

        await provider.emitBlock(500);
        await vi.advanceTimersByTimeAsync(100);
        // A jump far past the span cap: the first catch-up request must be
        // bounded, and the rest must still be owed rather than skipped.
        await provider.emitBlock(500 + GETLOGS_MAX_BLOCK_SPAN * 2);
        await vi.advanceTimersByTimeAsync(GETLOGS_MIN_INTERVAL_MS * 3);

        const served = ranges(provider);
        expect(served[0]).toEqual({ from: 500, to: 500 });
        expect(served[1]).toEqual({
          from: 501,
          to: 500 + GETLOGS_MAX_BLOCK_SPAN,
        });
        for (const r of served) {
          expect(r.to - r.from + 1).toBeLessThanOrEqual(GETLOGS_MAX_BLOCK_SPAN);
        }
        // The remainder is walked, not dropped.
        expect(served[served.length - 1].to).toBe(
          500 + GETLOGS_MAX_BLOCK_SPAN * 2,
        );
      });

      it("abandons and logs a gap too large to walk", async () => {
        const warnSpy = vi
          .spyOn(console, "warn")
          .mockImplementation(() => undefined);
        try {
          const provider = await subscribe();
          await provider.emitBlock(1_000);
          await vi.advanceTimersByTimeAsync(100);
          await provider.emitBlock(1_000 + GETLOGS_MAX_CATCHUP_BLOCKS + 500);
          await vi.advanceTimersByTimeAsync(GETLOGS_MIN_INTERVAL_MS * 2);

          // Skipping is a loss, so it must be recorded rather than silent.
          const warned = warnSpy.mock.calls
            .map((a) => String(a[0]))
            .filter((l) => l.includes("blocks behind head"));
          expect(warned).toHaveLength(1);
          // And it must not grind through the gap one span at a time.
          expect(getLogsCalls(provider).length).toBeLessThan(5);
        } finally {
          warnSpy.mockRestore();
        }
      });

      it("does not issue overlapping requests while one is in flight", async () => {
        const provider = await subscribe();
        let release: (() => void) | null = null;
        provider.beforeSend = (method) =>
          method === "eth_getLogs"
            ? new Promise<void>((r) => {
                release = r;
              })
            : null;

        // Not awaited: this block's request is held open on purpose, so its
        // handler never settles.
        const held = provider.emitBlock(600);
        await vi.advanceTimersByTimeAsync(GETLOGS_MIN_INTERVAL_MS * 3);
        // Blocks keep arriving while the first request hangs. Each calls
        // drain; none may start a second overlapping request.
        void provider.emitBlock(601);
        void provider.emitBlock(602);
        await vi.advanceTimersByTimeAsync(GETLOGS_MIN_INTERVAL_MS * 3);

        expect(getLogsCalls(provider)).toHaveLength(1);

        provider.beforeSend = null;
        release?.();
        await held;
      });
    });

    describe("reorg re-delivery", () => {
      it("re-queries a height the subscription announces a second time", async () => {
        const provider = await subscribe();
        await emitBlocks(provider, 100, 3, GETLOGS_MIN_INTERVAL_MS * 2);
        const before = ranges(provider).length;

        // The chain reorganised and re-announced 102. The logs there may not
        // be the ones already dispatched, so serving it once and never again
        // would drop the replacement silently.
        await provider.emitBlock(102);
        await vi.advanceTimersByTimeAsync(GETLOGS_MIN_INTERVAL_MS * 2);

        const served = ranges(provider).slice(before);
        expect(served.some((r) => r.from <= 102 && r.to >= 102)).toBe(true);
      });

      it("re-covers every height from the re-announced one forward", async () => {
        const provider = await subscribe();
        await emitBlocks(provider, 200, 4, GETLOGS_MIN_INTERVAL_MS * 2);
        const before = ranges(provider).length;

        // A reorg at 201 invalidates 201-203, not 201 alone.
        await provider.emitBlock(201);
        await vi.advanceTimersByTimeAsync(GETLOGS_MIN_INTERVAL_MS * 2);

        const served = ranges(provider).slice(before);
        expect(served[0].from).toBe(201);
        expect(served[served.length - 1].to).toBeGreaterThanOrEqual(203);
      });

      it("refuses a rewind deeper than the bound", async () => {
        const warnSpy = vi
          .spyOn(console, "warn")
          .mockImplementation(() => undefined);
        try {
          const provider = await subscribe();
          await provider.emitBlock(1_000);
          await vi.advanceTimersByTimeAsync(GETLOGS_MIN_INTERVAL_MS * 2);
          await provider.emitBlock(1_000 + REORG_REWIND_MAX_BLOCKS + 10);
          await vi.advanceTimersByTimeAsync(GETLOGS_MIN_INTERVAL_MS * 2);
          const before = ranges(provider).length;

          // A stray very old height must not schedule an unbounded re-read.
          await provider.emitBlock(1_000);
          await vi.advanceTimersByTimeAsync(GETLOGS_MIN_INTERVAL_MS * 2);

          expect(ranges(provider)).toHaveLength(before);
          expect(
            warnSpy.mock.calls
              .map((a) => String(a[0]))
              .filter((l) => l.includes("below the mark")),
          ).toHaveLength(1);
        } finally {
          warnSpy.mockRestore();
        }
      });

      it("does not rewind for a height nothing has requested yet", async () => {
        const logSpy = vi
          .spyOn(console, "log")
          .mockImplementation(() => undefined);
        try {
          const provider = await subscribe();
          await provider.emitBlock(300);
          // Short of the minimum interval, so the next block only arms the
          // catch-up: 301-310 has genuinely not been requested when 305
          // arrives, rather than having been served by an awaited drain.
          await vi.advanceTimersByTimeAsync(GETLOGS_MIN_INTERVAL_MS / 10);
          await provider.emitBlock(310);
          await provider.emitBlock(305);
          await vi.advanceTimersByTimeAsync(STATS_LOG_INTERVAL_MS);

          expect(ranges(provider)).toEqual([
            { from: 300, to: 300 },
            { from: 301, to: 310 },
          ]);
          // Asserted through the counter rather than the ranges: a rewind to
          // 304 would produce the same two ranges, so only this tells the two
          // apart.
          expect(statsLines(logSpy)[0]).toContain("reorgRewinds=0");
        } finally {
          logSpy.mockRestore();
        }
      });

      it("re-queries a height re-announced while a drain is in flight", async () => {
        const provider = await subscribe();
        await emitBlocks(provider, 100, 2, GETLOGS_MIN_INTERVAL_MS * 2);

        // Served through 101. Hold the request for 102 open so the
        // re-announcement lands while that drain owns the mark - it commits
        // its own `to` when it finishes, so a mark moved backwards underneath
        // it is overwritten and 101 is never re-read.
        let release: () => void = () => undefined;
        provider.beforeSend = (method) =>
          method === "eth_getLogs"
            ? new Promise<void>((r) => {
                release = r;
              })
            : null;
        const held = provider.emitBlock(102);
        await vi.advanceTimersByTimeAsync(GETLOGS_MIN_INTERVAL_MS);
        const before = ranges(provider).length;

        void provider.emitBlock(101);
        await vi.advanceTimersByTimeAsync(10);
        provider.beforeSend = null;
        release();
        await held;
        await vi.advanceTimersByTimeAsync(GETLOGS_MIN_INTERVAL_MS * 3);

        const served = ranges(provider).slice(before);
        expect(served.some((r) => r.from <= 101 && r.to >= 101)).toBe(true);
      });

      it("re-queries a height re-announced inside the range being fetched", async () => {
        const provider = await subscribe();
        await provider.emitBlock(100);
        await vi.advanceTimersByTimeAsync(GETLOGS_MIN_INTERVAL_MS * 2);

        let release: () => void = () => undefined;
        provider.beforeSend = (method) =>
          method === "eth_getLogs"
            ? new Promise<void>((r) => {
                release = r;
              })
            : null;
        // Requests 101-105 and holds it open.
        const held = provider.emitBlock(105);
        await vi.advanceTimersByTimeAsync(GETLOGS_MIN_INTERVAL_MS);
        const before = ranges(provider).length;

        // 103 is above the mark but inside the range already in flight. That
        // request went out before the reorg, so it carries the pre-reorg logs
        // and its commit moves the mark past 103 with nothing having fetched
        // the replacement.
        void provider.emitBlock(103);
        await vi.advanceTimersByTimeAsync(10);
        provider.beforeSend = null;
        release();
        await held;
        await vi.advanceTimersByTimeAsync(GETLOGS_MIN_INTERVAL_MS * 3);

        const served = ranges(provider).slice(before);
        expect(served.some((r) => r.from <= 103 && r.to >= 103)).toBe(true);
      });

      it("counts every refused rewind and warns once per interval", async () => {
        const logSpy = vi
          .spyOn(console, "log")
          .mockImplementation(() => undefined);
        const warnSpy = vi
          .spyOn(console, "warn")
          .mockImplementation(() => undefined);
        try {
          const provider = await subscribe();
          await provider.emitBlock(1_000);
          await vi.advanceTimersByTimeAsync(GETLOGS_MIN_INTERVAL_MS * 2);
          await provider.emitBlock(1_000 + REORG_REWIND_MAX_BLOCKS + 10);
          await vi.advanceTimersByTimeAsync(GETLOGS_MIN_INTERVAL_MS * 2);

          // An upstream announcing heights far below the mark does it on
          // every block, so the warn is once per interval and the counter
          // carries the rest - refusing is the other path that drops events
          // on purpose, and it has to be countable rather than greppable.
          await provider.emitBlock(1_000);
          await provider.emitBlock(1_001);
          await vi.advanceTimersByTimeAsync(STATS_LOG_INTERVAL_MS);

          expect(
            warnSpy.mock.calls
              .map((a) => String(a[0]))
              .filter((l) => l.includes("below the mark")),
          ).toHaveLength(1);
          expect(statsLines(logSpy)[0]).toContain("reorgRewindsRefused=2");
        } finally {
          logSpy.mockRestore();
          warnSpy.mockRestore();
        }
      });
    });

    describe("failure handling", () => {
      it("re-queries a failed range instead of losing its blocks", async () => {
        const provider = await subscribe();

        await provider.emitBlock(700);
        await vi.advanceTimersByTimeAsync(100);
        // The range covering 701-705 fails once.
        provider.sendResponses = [new Error("upstream refused")];
        await emitBlocks(provider, 701, 5, 100);
        await vi.advanceTimersByTimeAsync(GETLOGS_MIN_INTERVAL_MS * 3);

        // The mark did not advance past a range that never returned, so the
        // same blocks are asked for again rather than dropped.
        const served = ranges(provider);
        const retried = served.filter((r) => r.from === 701);
        expect(retried.length).toBeGreaterThanOrEqual(2);
      });

      it("does not advance past a range whose later address chunk failed", async () => {
        // Two chunks means two requests for one range; the second fails.
        const mgr = new ChainProviderManager({
          factory: factoryBundle.factory,
          onPermanentFailure,
        });
        const provider = await subscribe(mgr);
        for (let i = 0; i < GETLOGS_ADDRESS_BATCH; i += 1) {
          await mgr.subscribeToLogs({
            chainId: CHAIN_A,
            wssUrl: "ws://a",
            address: `0x${(i + 1).toString(16).padStart(40, "0")}`,
            topic0: TOPIC_EMITTED,
            handler: vi.fn(),
          });
        }
        provider.sendResponses = [[], new Error("chunk two refused")];
        await provider.emitBlock(800);
        // Only ranges issued after the failed drain count: that drain already
        // asked for 800 once per address chunk.
        const afterFailedDrain = ranges(provider).length;
        await vi.advanceTimersByTimeAsync(GETLOGS_MIN_INTERVAL_MS * 3);

        // Block 800 is still owed, so a later drain re-queries from 800.
        await provider.emitBlock(801);
        await vi.advanceTimersByTimeAsync(GETLOGS_MIN_INTERVAL_MS * 2);
        expect(
          ranges(provider)
            .slice(afterFailedDrain)
            .some((r) => r.from === 800),
        ).toBe(true);
        await mgr.destroy();
      });

      it("times out a request that never gets a response", async () => {
        const provider = await subscribe();
        provider.beforeSend = (method) =>
          method === "eth_getLogs" ? new Promise<void>(() => undefined) : null;

        // Not awaited: the request never settles on its own, so awaiting it
        // here would hang the test rather than the chain. Only the timeout
        // inside processBlockRange unblocks it, and that needs fake time to
        // advance first.
        const stuck = provider.emitBlock(850);
        await vi.advanceTimersByTimeAsync(GETLOGS_TIMEOUT_MS);
        await stuck;

        expect(getLogsCalls(provider)).toHaveLength(1);

        // The mark stayed at 849, so the next drain re-issues 850 rather
        // than treating the timed-out range as served. Only ranges issued
        // after this point count: the timed-out call already asked for 850.
        const beforeRetry = ranges(provider).length;
        provider.beforeSend = null;
        await provider.emitBlock(851);
        await vi.advanceTimersByTimeAsync(GETLOGS_MIN_INTERVAL_MS * 2);

        expect(
          ranges(provider)
            .slice(beforeRetry)
            .some((r) => r.from === 850),
        ).toBe(true);
      });
    });

    describe("reconnect", () => {
      it("resumes from the high-water mark on the replacement connection", async () => {
        const provider = await subscribe();
        await provider.emitBlock(900);
        await vi.advanceTimersByTimeAsync(100);

        provider.emitError(new Error("socket closed"));
        await vi.advanceTimersByTimeAsync(3_000);

        const replacement = factoryBundle.created[1];
        expect(replacement).toBeDefined();
        await replacement.emitBlock(905);
        await vi.advanceTimersByTimeAsync(GETLOGS_MIN_INTERVAL_MS * 2);

        // 901-905 were owed across the drop and are served by the new
        // connection; nothing restarts from the new head and loses them.
        expect(ranges(replacement).some((r) => r.from === 901)).toBe(true);
      });

      it("issues no request against the connection that is being replaced", async () => {
        const provider = await subscribe();
        await provider.emitBlock(950);
        await vi.advanceTimersByTimeAsync(100);
        const before = getLogsCalls(provider).length;

        // A block arriving during the backoff must not start a drain on the
        // failed socket, whether by timer or by the arrival itself.
        provider.emitError(new Error("socket closed"));
        await provider.emitBlock(951);
        await vi.advanceTimersByTimeAsync(GETLOGS_MIN_INTERVAL_MS * 2);

        expect(getLogsCalls(provider)).toHaveLength(before);
      });

      it("clears isReconnecting without waiting for log dispatch", async () => {
        const provider = await subscribe();
        await provider.emitBlock(970);
        await vi.advanceTimersByTimeAsync(100);

        provider.emitError(new Error("socket closed"));
        await vi.advanceTimersByTimeAsync(3_000);

        // A drain dispatches to handlers that may sleep for seconds. If the
        // reconnect awaited it, the chain would report degraded and block
        // getOrCreateProvider long after the socket was healthy.
        expect(manager.getHealth(CHAIN_A)?.reconnecting).toBe(false);
        expect(manager.getHealth(CHAIN_A)?.connected).toBe(true);
      });

      it("recovers once a request stranded by a reconnect times out", async () => {
        const provider = await subscribe();
        // Never resolves - the same shape as ethers leaving an in-flight
        // eth_getLogs unsettled when the socket underneath it is destroyed.
        provider.beforeSend = (method) =>
          method === "eth_getLogs" ? new Promise<void>(() => undefined) : null;

        // Not awaited: this request never settles on its own, so awaiting it
        // would hang the test rather than the chain.
        void provider.emitBlock(1_000);
        await vi.advanceTimersByTimeAsync(100);

        // The reconnect replaces the connection while that request is still
        // open and never coming back.
        provider.emitError(new Error("socket closed"));
        await vi.advanceTimersByTimeAsync(3_000);

        const replacement = factoryBundle.created[1];
        expect(replacement).toBeDefined();

        // The stranded drain still owns the chain here - that is deliberate,
        // it may be dispatching - so nothing has moved yet.
        await replacement.emitBlock(1_005);
        await vi.advanceTimersByTimeAsync(GETLOGS_MIN_INTERVAL_MS * 2);

        // Its timeout is what releases the chain, and it always arrives.
        // Before this fix nothing did, and the chain never fetched again.
        await vi.advanceTimersByTimeAsync(GETLOGS_TIMEOUT_MS);
        await vi.advanceTimersByTimeAsync(GETLOGS_MIN_INTERVAL_MS * 2);

        expect(getLogsCalls(replacement).length).toBeGreaterThan(0);
      });

      it("does not dispatch a log twice when a reconnect lands mid-dispatch", async () => {
        // The drain holds the chain across dispatch as well as the request.
        // Releasing it at reconnect would let the replacement re-fetch the
        // same unadvanced range and dispatch its logs a second time, running
        // alongside the first dispatch - and the dedup store cannot absorb
        // that, because isProcessed/markProcessed is a check-then-set with
        // the listener's jitter sleep in front of the check.
        const log = {
          address: ADDR_A.toLowerCase(),
          topics: [TOPIC_EMITTED],
        };
        let releaseHandler: (() => void) | null = null;
        const handlerGate = new Promise<void>((r) => {
          releaseHandler = r;
        });
        const handler = vi.fn(() => handlerGate);

        const mgr = new ChainProviderManager({
          factory: factoryBundle.factory,
          onPermanentFailure,
        });
        const before = factoryBundle.created.length;
        await mgr.subscribeToLogs({
          chainId: CHAIN_A,
          wssUrl: "ws://a",
          address: ADDR_A,
          topic0: TOPIC_EMITTED,
          handler,
        });
        const provider = factoryBundle.created[before];
        provider.sendResponses = [[log]];

        // Not awaited: the handler holds this dispatch open.
        void provider.emitBlock(3_000);
        await vi.advanceTimersByTimeAsync(100);
        expect(handler).toHaveBeenCalledTimes(1);

        // The socket drops while that dispatch is still in flight.
        provider.emitError(new Error("socket closed"));
        await vi.advanceTimersByTimeAsync(3_000);

        const replacement = factoryBundle.created[before + 1];
        expect(replacement).toBeDefined();
        // Armed so that a replacement drain of the same range would deliver
        // the same log again - the assertion is only meaningful because this
        // is here.
        replacement.sendResponses = [[log]];
        // Not awaited: if the replacement does re-dispatch, it blocks on the
        // same held handler, and awaiting here would hang the test instead
        // of reporting the duplicate.
        void replacement.emitBlock(3_001);
        await vi.advanceTimersByTimeAsync(GETLOGS_MIN_INTERVAL_MS * 3);

        expect(handler).toHaveBeenCalledTimes(1);

        releaseHandler?.();
        await vi.advanceTimersByTimeAsync(GETLOGS_MIN_INTERVAL_MS);
        await mgr.destroy();
      });

      it("reconnects after a run of getLogs timeouts on one socket", async () => {
        const provider = await subscribe();
        const reasons: string[] = [];
        manager.onDisconnect(CHAIN_A, (ev) => {
          reasons.push(ev.reason);
        });
        // Answers the heartbeat, never answers getLogs. Every other liveness
        // check this class has keeps passing, so the timeout has to escalate
        // on its own or the chain retries into the void forever.
        provider.beforeSend = (method) =>
          method === "eth_getLogs" ? new Promise<void>(() => undefined) : null;

        for (let i = 0; i < GETLOGS_TIMEOUT_RECONNECT_THRESHOLD; i += 1) {
          void provider.emitBlock(4_000 + i);
          await vi.advanceTimersByTimeAsync(GETLOGS_TIMEOUT_MS);
          await vi.advanceTimersByTimeAsync(GETLOGS_MIN_INTERVAL_MS * 2);
        }

        expect(reasons).toContain("getlogs_timeout");
      });
    });

    describe("counters", () => {
      it("reports one range per block on a chain dispatching per block", async () => {
        const logSpy = vi
          .spyOn(console, "log")
          .mockImplementation(() => undefined);
        try {
          const provider = await subscribe();
          await emitBlocks(provider, 100, 3, GETLOGS_MIN_INTERVAL_MS * 2);
          await vi.advanceTimersByTimeAsync(STATS_LOG_INTERVAL_MS);

          const lines = statsLines(logSpy);
          expect(lines).toHaveLength(1);
          // blocksCovered/ranges is exactly 1 when every request is one block.
          expect(lines[0]).toContain("blocksCovered=3");
          expect(lines[0]).toContain("ranges=3");
        } finally {
          logSpy.mockRestore();
        }
      });

      it("reports blocks ahead of ranges once requests are rate limited", async () => {
        const logSpy = vi
          .spyOn(console, "log")
          .mockImplementation(() => undefined);
        try {
          const provider = await subscribe();
          await emitBlocks(provider, 200, 6, 100);
          await vi.advanceTimersByTimeAsync(STATS_LOG_INTERVAL_MS);

          const lines = statsLines(logSpy);
          expect(lines).toHaveLength(1);
          expect(lines[0]).toContain("blocksCovered=6");
          expect(lines[0]).toContain("ranges=2");
        } finally {
          logSpy.mockRestore();
        }
      });

      it("counts a failed request without counting the blocks it never fetched", async () => {
        const logSpy = vi
          .spyOn(console, "log")
          .mockImplementation(() => undefined);
        try {
          const provider = await subscribe();
          // Fails once, then the queue is empty and the mock answers normally,
          // so the retry succeeds.
          provider.sendResponses = [new Error("upstream refused")];
          await emitBlocks(provider, 100, 1, GETLOGS_MIN_INTERVAL_MS * 2);
          await vi.advanceTimersByTimeAsync(STATS_LOG_INTERVAL_MS);

          const lines = statsLines(logSpy);
          expect(lines).toHaveLength(1);
          // Two calls were issued and both were billed, so both are counted.
          // Only one range returned, and only its block is covered - the
          // failed attempt contributes cost, never coverage, or the
          // blocks-per-range ratio would look most efficient exactly when the
          // chain is least working.
          expect(lines[0]).toContain("getLogsCalls=2");
          expect(lines[0]).toContain("getLogsErrors=1");
          expect(lines[0]).toContain("ranges=1");
          expect(lines[0]).toContain("blocksCovered=1");
        } finally {
          logSpy.mockRestore();
        }
      });

      it("never credits coverage to a range that keeps failing", async () => {
        const logSpy = vi
          .spyOn(console, "log")
          .mockImplementation(() => undefined);
        try {
          const provider = await subscribe();
          provider.getLogsFailure = new Error("upstream down");
          await emitBlocks(provider, 100, 2, GETLOGS_MIN_INTERVAL_MS * 2);
          await vi.advanceTimersByTimeAsync(STATS_LOG_INTERVAL_MS);

          const lines = statsLines(logSpy);
          expect(lines).toHaveLength(1);
          expect(lines[0]).toContain("blocksCovered=0");
          expect(lines[0]).toContain("ranges=0");
          expect(lines[0]).not.toContain("getLogsErrors=0");
        } finally {
          logSpy.mockRestore();
        }
      });

      it("reports blocks abandoned by the catch-up bound", async () => {
        const logSpy = vi
          .spyOn(console, "log")
          .mockImplementation(() => undefined);
        const warnSpy = vi
          .spyOn(console, "warn")
          .mockImplementation(() => undefined);
        try {
          const provider = await subscribe();
          await provider.emitBlock(1_000);
          await vi.advanceTimersByTimeAsync(GETLOGS_MIN_INTERVAL_MS * 2);
          await provider.emitBlock(1_000 + GETLOGS_MAX_CATCHUP_BLOCKS + 100);
          await vi.advanceTimersByTimeAsync(STATS_LOG_INTERVAL_MS);

          // Skipping is the one path that loses events on purpose, so it has
          // to be countable, not only greppable.
          const lines = statsLines(logSpy);
          expect(lines).toHaveLength(1);
          expect(lines[0]).toMatch(/blocksSkipped=[1-9]/);
        } finally {
          logSpy.mockRestore();
          warnSpy.mockRestore();
        }
      });

      it("stays silent for a chain that issued no requests", async () => {
        const logSpy = vi
          .spyOn(console, "log")
          .mockImplementation(() => undefined);
        try {
          await subscribe();
          await vi.advanceTimersByTimeAsync(STATS_LOG_INTERVAL_MS);
          expect(statsLines(logSpy)).toHaveLength(0);
        } finally {
          logSpy.mockRestore();
        }
      });

      it("names the cumulative health counter for the quantity it holds", async () => {
        const provider = await subscribe();
        await emitBlocks(provider, 100, 2, GETLOGS_MIN_INTERVAL_MS * 2);

        // The log line's getLogsCalls is a per-interval count; the health
        // field is cumulative. Sharing a name invited reading a rate as a
        // counter, so the health field carries the source's name.
        const health = manager.getHealth(CHAIN_A);
        expect(health?.getLogsCallsTotal).toBe(2);
        expect(
          (health as unknown as Record<string, unknown>).getLogsCalls,
        ).toBeUndefined();
      });
    });
  });

  describe("derived block-staleness threshold", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    /**
     * Run a chain at `intervalMs` until its cadence estimate settles, then go
     * silent for `silenceMs` and report whether the watchdog reconnected.
     */
    async function trippedAfterSilence(
      intervalMs: number,
      silenceMs: number,
    ): Promise<boolean> {
      const bundle = makeFactory();
      const mgr = new ChainProviderManager({
        factory: bundle.factory,
        onPermanentFailure,
      });
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
      const provider = bundle.created[0];

      // Enough samples AND enough wall clock for the estimate to settle.
      const blocks =
        Math.ceil(BLOCK_INTERVAL_MIN_SPAN_MS / intervalMs) +
        BLOCK_INTERVAL_MIN_SAMPLES +
        1;
      for (let i = 0; i < blocks; i += 1) {
        await provider.emitBlock(1_000 + i);
        await vi.advanceTimersByTimeAsync(intervalMs);
      }

      await vi.advanceTimersByTimeAsync(silenceMs);
      const tripped = reasons.includes("block_staleness");
      await mgr.destroy();
      return tripped;
    }

    it("leaves a 2 s chain on the historical ceiling", async () => {
      // 2000 x 60 = 120 s, which is exactly BLOCK_STALENESS_TIMEOUT_MS. Base
      // must not gain a tighter threshold than it has always had, or this
      // change introduces reconnect churn on a chain that behaves today.
      expect(2_000 * BLOCK_STALENESS_BLOCK_MULTIPLIER).toBeGreaterThanOrEqual(
        BLOCK_STALENESS_TIMEOUT_MS,
      );
      expect(await trippedAfterSilence(2_000, 90_000)).toBe(false);
    });

    it("tightens a sub-second chain to the floor", async () => {
      // 100 ms x 60 = 6 s, below the floor, so the floor binds: 30 s rather
      // than 120 s, which on a 100 ms chain is 1.2 million blocks of slack.
      expect(100 * BLOCK_STALENESS_BLOCK_MULTIPLIER).toBeLessThan(
        BLOCK_STALENESS_FLOOR_MS,
      );
      expect(await trippedAfterSilence(100, 62_000)).toBe(true);
    });

    it("keeps the multiplier live between the bounds", () => {
      // If every reachable cadence produced a value outside the clamp, the
      // constant would be dead and the documented rule unobservable - which
      // is what a multiplier of 10 did.
      const derived = 1_000 * BLOCK_STALENESS_BLOCK_MULTIPLIER;
      expect(derived).toBeGreaterThan(BLOCK_STALENESS_FLOOR_MS);
      expect(derived).toBeLessThan(BLOCK_STALENESS_TIMEOUT_MS);
    });

    it("is not poisoned by a burst of blocks arriving together", async () => {
      const bundle = makeFactory();
      const mgr = new ChainProviderManager({
        factory: bundle.factory,
        onPermanentFailure,
      });
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
      const provider = bundle.created[0];

      // A socket buffer flushing after an event-loop stall: enough samples for
      // a count-only gate, milliseconds apart. Reading this as the chain's
      // cadence would drop a 12 s chain to the 30 s floor and reconnect it on
      // any ordinary gap.
      for (let i = 0; i <= BLOCK_INTERVAL_MIN_SAMPLES; i += 1) {
        await provider.emitBlock(2_000 + i);
        await vi.advanceTimersByTimeAsync(1);
      }
      await vi.advanceTimersByTimeAsync(90_000);

      expect(reasons).not.toContain("block_staleness");
      await mgr.destroy();
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
