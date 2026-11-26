import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChainMonitor } from "../../block-dispatcher/chain-monitor.js";
import { metrics, registry } from "../../lib/metrics.js";
import type { BlockWorkflow, ChainConfig } from "../../lib/types.js";

// ---------------------------------------------------------------------------
// Mock SQS enqueue - prevent real AWS calls
// ---------------------------------------------------------------------------

vi.mock("../../block-dispatcher/sqs-enqueue.js", () => ({
  enqueueBlockTrigger: vi.fn().mockResolvedValue(undefined),
}));

// KEEP-693: stub the phantom helpers so the monitor does not call the internal
// API. Default (undefined) leaves existing tests on the legacy id-less path.
const { createPhantomExecution, failPhantomExecution } = vi.hoisted(() => ({
  createPhantomExecution: vi.fn(),
  failPhantomExecution: vi.fn(),
}));
vi.mock("../../lib/phantom.js", () => ({
  createPhantomExecution,
  failPhantomExecution,
}));

// ---------------------------------------------------------------------------
// Mock WebSocket that supports ping/pong and close events
// ---------------------------------------------------------------------------

class MockWebSocket extends EventEmitter {
  readyState = 1;
  ping(): void {
    setTimeout(() => this.emit("pong"), 0);
  }
  removeListener(event: string, cb: () => void): this {
    return super.removeListener(event, cb);
  }
  close(): void {
    this.readyState = 3;
    this.emit("close");
  }
  send(): void {}
}

// ---------------------------------------------------------------------------
// Mock ethers.WebSocketProvider
// ---------------------------------------------------------------------------

type BlockListener = (blockNumber: number) => void;

class MockProvider {
  readonly websocket: MockWebSocket;
  destroyed = false;
  private blockListeners: BlockListener[] = [];

  ready: Promise<unknown>;

  constructor(readonly url: string) {
    this.websocket = new MockWebSocket();
    this.ready = Promise.resolve(true);
  }

  async getBlockNumber(): Promise<number> {
    return 100;
  }

  async getBlock(blockNumber: number): Promise<{
    hash: string;
    timestamp: number;
    parentHash: string;
  }> {
    return {
      hash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
      timestamp: Math.floor(Date.now() / 1000),
      parentHash: `0x${(blockNumber - 1).toString(16).padStart(64, "0")}`,
    };
  }

  async on(event: string, listener: BlockListener): Promise<this> {
    if (event === "block") {
      this.blockListeners.push(listener);
    }
    return this;
  }

  async removeAllListeners(): Promise<this> {
    this.blockListeners = [];
    return this;
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.websocket.close();
  }

  emitBlock(blockNumber: number): void {
    for (const listener of this.blockListeners) {
      listener(blockNumber);
    }
  }
}

// ---------------------------------------------------------------------------
// Patch ethers.WebSocketProvider at module level
// ---------------------------------------------------------------------------

let providerInstances: MockProvider[] = [];
let providerFactory: (url: string) => MockProvider = (url) =>
  new MockProvider(url);

vi.mock("ethers", () => ({
  ethers: {
    WebSocketProvider: class {
      constructor(url: string) {
        const instance = providerFactory(url);
        providerInstances.push(instance);
        // biome-ignore lint/correctness/noConstructorReturn: intentional mock idiom -- `new` honors object returns from constructors, used here to substitute the factory-built instance
        return instance;
      }
    },
  },
}));

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeChain(overrides?: Partial<ChainConfig>): ChainConfig {
  return {
    chainId: 1,
    name: "TestChain",
    defaultPrimaryWss: "wss://primary.test",
    defaultFallbackWss: "wss://fallback.test",
    ...overrides,
  };
}

function makeWorkflow(overrides?: Partial<BlockWorkflow>): BlockWorkflow {
  return {
    id: "wf-1",
    name: "Test Workflow",
    userId: "user-1",
    organizationId: null,
    network: "1",
    blockInterval: 10,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ChainMonitor", () => {
  beforeEach(() => {
    // Speed up the primary-recovery probe so tests don't wait 5 minutes.
    // The constant is read each time startPrimaryProbe() runs, so this
    // applies even though the module was already loaded.
    vi.stubEnv("PRIMARY_PROBE_INTERVAL_MS", "1000");
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.clearAllMocks();
    // Default: fresh phantom, no dedup hit. Tests override per case.
    createPhantomExecution.mockResolvedValue({ alreadyExisted: false });
    providerInstances = [];
    providerFactory = (url) => new MockProvider(url);
  });

  afterEach(() => {
    vi.useRealTimers();
    // Reset env stubs so per-test overrides (BLOCK_ADVANCE_TIMEOUT_MS,
    // SILENT_FAILOVER_THRESHOLD, SOCKET_MAX_AGE_MS) do not leak into later
    // tests and trigger timers earlier than the test under test expects.
    vi.unstubAllEnvs();
    // Metrics registry is process-global; reset between tests so per-chain
    // counters and snapshots from one test don't leak into the next.
    metrics.resetForTests();
  });

  function latestProvider(): MockProvider {
    return providerInstances[providerInstances.length - 1];
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  describe("start / stop", () => {
    it("connects, subscribes, and reports alive after start", async () => {
      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });

      await monitor.start();

      expect(monitor.isAlive()).toBe(true);
      expect(providerInstances).toHaveLength(1);
      expect(latestProvider().url).toBe("wss://primary.test");
    });

    it("reports not alive before start", () => {
      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });

      expect(monitor.isAlive()).toBe(false);
    });

    it("reports not alive after stop", async () => {
      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });

      await monitor.start();
      await monitor.stop();

      expect(monitor.isAlive()).toBe(false);
    });

    it("throws and resets isRunning if connect fails with no WSS urls", async () => {
      const monitor = new ChainMonitor({
        chain: makeChain({
          defaultPrimaryWss: null,
          defaultFallbackWss: null,
        }),
        workflows: [makeWorkflow()],
      });

      await expect(monitor.start()).rejects.toThrow("No WSS URLs configured");
      expect(monitor.isAlive()).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Block subscription
  // -------------------------------------------------------------------------

  describe("block subscription", () => {
    it("awaits provider.on and sets hasActiveSubscription", async () => {
      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });

      await monitor.start();

      expect(monitor.isAlive()).toBe(true);
      const provider = latestProvider();
      // Verify the on() was called - provider has block listeners
      // Emit a block to confirm the listener was wired up
      const { enqueueBlockTrigger } = await import(
        "../../block-dispatcher/sqs-enqueue.js"
      );
      provider.emitBlock(10);
      await vi.advanceTimersByTimeAsync(0);

      expect(enqueueBlockTrigger).toHaveBeenCalledWith(
        expect.objectContaining({
          workflowId: "wf-1",
          triggerData: expect.objectContaining({ blockNumber: 10 }),
        }),
      );
    });

    // KEEP-693: phantom pre-creation wiring.
    it("pre-creates a phantom and carries its id on the block message", async () => {
      createPhantomExecution.mockResolvedValueOnce({
        executionId: "exec_ph",
        alreadyExisted: false,
      });
      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });

      await monitor.start();

      const { enqueueBlockTrigger } = await import(
        "../../block-dispatcher/sqs-enqueue.js"
      );
      latestProvider().emitBlock(10);
      await vi.advanceTimersByTimeAsync(0);

      expect(createPhantomExecution).toHaveBeenCalledWith(
        "wf-1",
        "block",
        "user-1",
        expect.stringMatching(/^block:wf-1:\d+:10$/),
        { skipIfRunning: false },
      );
      expect(enqueueBlockTrigger).toHaveBeenCalledWith(
        expect.objectContaining({ executionId: "exec_ph" }),
      );
    });

    // An overlapping leader / re-processed block must not double-enqueue.
    it("skips the enqueue when the dispatch key already exists (dedup)", async () => {
      createPhantomExecution.mockResolvedValueOnce({
        executionId: "exec_existing",
        alreadyExisted: true,
      });
      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });

      await monitor.start();

      const { enqueueBlockTrigger } = await import(
        "../../block-dispatcher/sqs-enqueue.js"
      );
      vi.mocked(enqueueBlockTrigger).mockClear();
      latestProvider().emitBlock(10);
      await vi.advanceTimersByTimeAsync(0);

      expect(enqueueBlockTrigger).not.toHaveBeenCalled();
    });

    // A refusal is not a transport failure: it must not fall through to the
    // id-less enqueue the way a failed create does.
    it("skips the enqueue when the dispatch is refused on plan grounds", async () => {
      createPhantomExecution.mockResolvedValueOnce({
        alreadyExisted: false,
        refused: "execution_limit",
      });
      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });

      await monitor.start();

      const { enqueueBlockTrigger } = await import(
        "../../block-dispatcher/sqs-enqueue.js"
      );
      vi.mocked(enqueueBlockTrigger).mockClear();
      latestProvider().emitBlock(10);
      await vi.advanceTimersByTimeAsync(0);

      expect(enqueueBlockTrigger).not.toHaveBeenCalled();
      expect(failPhantomExecution).not.toHaveBeenCalled();
    });

    it("marks the phantom failed with BS-0001 when the enqueue fails", async () => {
      createPhantomExecution.mockResolvedValueOnce({
        executionId: "exec_ph",
        alreadyExisted: false,
      });
      const { enqueueBlockTrigger } = await import(
        "../../block-dispatcher/sqs-enqueue.js"
      );
      vi.mocked(enqueueBlockTrigger).mockRejectedValueOnce(
        new Error("SQS down"),
      );

      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });

      await monitor.start();

      latestProvider().emitBlock(10);
      await vi.advanceTimersByTimeAsync(0);

      expect(failPhantomExecution).toHaveBeenCalledWith(
        "exec_ph",
        "BS-0001",
        expect.stringContaining("SQS down"),
      );
    });

    it("only enqueues for blocks matching the interval", async () => {
      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow({ blockInterval: 12 })],
      });

      await monitor.start();

      const { enqueueBlockTrigger } = await import(
        "../../block-dispatcher/sqs-enqueue.js"
      );
      const provider = latestProvider();

      provider.emitBlock(11);
      await vi.advanceTimersByTimeAsync(0);
      expect(enqueueBlockTrigger).not.toHaveBeenCalled();

      provider.emitBlock(12);
      await vi.advanceTimersByTimeAsync(0);
      expect(enqueueBlockTrigger).toHaveBeenCalledTimes(1);

      provider.emitBlock(13);
      await vi.advanceTimersByTimeAsync(0);
      expect(enqueueBlockTrigger).toHaveBeenCalledTimes(1);

      provider.emitBlock(24);
      await vi.advanceTimersByTimeAsync(0);
      expect(enqueueBlockTrigger).toHaveBeenCalledTimes(2);
    });

    it("deduplicates blocks with the same or lower number", async () => {
      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow({ blockInterval: 1 })],
      });

      await monitor.start();

      const { enqueueBlockTrigger } = await import(
        "../../block-dispatcher/sqs-enqueue.js"
      );
      const provider = latestProvider();

      provider.emitBlock(10);
      await vi.advanceTimersByTimeAsync(0);
      expect(enqueueBlockTrigger).toHaveBeenCalledTimes(1);

      // Same block again
      provider.emitBlock(10);
      await vi.advanceTimersByTimeAsync(0);
      expect(enqueueBlockTrigger).toHaveBeenCalledTimes(1);

      // Lower block
      provider.emitBlock(9);
      await vi.advanceTimersByTimeAsync(0);
      expect(enqueueBlockTrigger).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // WebSocket close and reconnection
  // -------------------------------------------------------------------------

  describe("reconnection", () => {
    it("reconnects when WebSocket closes", async () => {
      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });

      await monitor.start();
      expect(providerInstances).toHaveLength(1);

      // Simulate WebSocket close
      latestProvider().websocket.emit("close");

      // Advance past the reconnection delay (1s for first attempt)
      await vi.advanceTimersByTimeAsync(1500);

      expect(providerInstances).toHaveLength(2);
      expect(monitor.isAlive()).toBe(true);
    });

    it("clears hasActiveSubscription on WebSocket close", async () => {
      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });

      await monitor.start();
      expect(monitor.isAlive()).toBe(true);

      // Close the WebSocket - isAlive should still be true because
      // isReconnecting becomes true
      latestProvider().websocket.emit("close");
      expect(monitor.isAlive()).toBe(true);
    });

    it("reports alive during reconnection (isReconnecting guard)", async () => {
      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });

      await monitor.start();

      // Trigger disconnect
      latestProvider().websocket.emit("close");

      // During the backoff delay, monitor should report alive
      // (isReconnecting = true)
      expect(monitor.isAlive()).toBe(true);
    });

    it("removes stale WebSocket close handler during destroyProvider", async () => {
      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });

      await monitor.start();
      const firstProvider = latestProvider();
      const closeListenerCount = firstProvider.websocket.listenerCount("close");

      // Trigger reconnection
      firstProvider.websocket.emit("close");
      await vi.advanceTimersByTimeAsync(1500);

      // Old provider's close handler should have been removed
      expect(firstProvider.websocket.listenerCount("close")).toBeLessThan(
        closeListenerCount,
      );
    });

    it("re-subscribes to blocks after reconnection", async () => {
      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow({ blockInterval: 10 })],
      });

      await monitor.start();

      const { enqueueBlockTrigger } = await import(
        "../../block-dispatcher/sqs-enqueue.js"
      );

      // First provider delivers a matching block
      latestProvider().emitBlock(10);
      await vi.advanceTimersByTimeAsync(0);
      expect(enqueueBlockTrigger).toHaveBeenCalledTimes(1);

      // Disconnect and reconnect
      latestProvider().websocket.emit("close");
      await vi.advanceTimersByTimeAsync(1500);

      // Second provider delivers a matching block
      // Use block 20 (10 blocks later, within MAX_BACKFILL but only
      // block 20 matches interval=10)
      latestProvider().emitBlock(20);
      await vi.advanceTimersByTimeAsync(0);
      expect(enqueueBlockTrigger).toHaveBeenCalledTimes(2);
    });

    it("does not double-trigger handleDisconnect when already reconnecting", async () => {
      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });

      await monitor.start();

      // Trigger disconnect
      latestProvider().websocket.emit("close");

      // Trigger another close event while reconnecting
      latestProvider().websocket.emit("close");

      // Should only create one new provider
      await vi.advanceTimersByTimeAsync(1500);
      expect(providerInstances).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // isAlive
  // -------------------------------------------------------------------------

  describe("isAlive", () => {
    it("returns false when not started", () => {
      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });
      expect(monitor.isAlive()).toBe(false);
    });

    it("returns true when running with active subscription", async () => {
      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });
      await monitor.start();
      expect(monitor.isAlive()).toBe(true);
    });

    it("returns true when reconnecting (not dead, just recovering)", async () => {
      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });
      await monitor.start();
      latestProvider().websocket.emit("close");
      // Now isReconnecting=true, hasActiveSubscription=false
      expect(monitor.isAlive()).toBe(true);
    });

    it("returns false after stop", async () => {
      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });
      await monitor.start();
      await monitor.stop();
      expect(monitor.isAlive()).toBe(false);
    });

    it("returns false when subscription has gone silent past MONITOR_RECREATE_TIMEOUT_MS", async () => {
      // Reproduces the prod zombie state: subscription is set up but the
      // upstream WSS never delivers blocks. The in-monitor no-block timer
      // failed to fire; the reconciler must catch this via isAlive() so it
      // can tear down and start a fresh monitor.
      //
      // Disable the in-monitor block-advance timer for this test so the
      // reconciler-level staleness path is exercised on its own. (In prod,
      // the in-monitor timer was demonstrably not firing — that is the
      // failure mode this fallback exists for.)
      //
      // Pin the reconciler threshold so the test stays decoupled from the
      // production default (which has been tuned tighter alongside
      // BLOCK_ADVANCE_TIMEOUT_MS to match the dashboard red threshold).
      vi.stubEnv("BLOCK_ADVANCE_TIMEOUT_MS", String(60 * 60_000));
      vi.stubEnv("MONITOR_RECREATE_TIMEOUT_MS", String(10 * 60_000));

      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });

      await monitor.start();
      expect(monitor.isAlive()).toBe(true);

      // Advance 9 minutes — still under the 10-min staleness threshold.
      await vi.advanceTimersByTimeAsync(9 * 60_000);
      expect(monitor.isAlive()).toBe(true);

      // Cross the threshold. No blocks have been received since subscribe.
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(monitor.isAlive()).toBe(false);
    });

    it("stays alive when blocks are arriving regularly", async () => {
      // Pin the windows so the 5-minute gap between blocks does not trigger
      // the in-monitor reconnect cycle. The previous version of this test
      // relied on subscribeToBlocks resetting lastBlockAdvanceAt to mask the
      // reconnect activity, which masked the very bug (KEEP-570) that broke
      // the reconciler's view of stuck monitors. The contract this test
      // intends to assert is: each real height advance refreshes the
      // staleness clock; verify it directly.
      vi.stubEnv("BLOCK_ADVANCE_TIMEOUT_MS", String(60 * 60_000));
      vi.stubEnv("MONITOR_RECREATE_TIMEOUT_MS", String(10 * 60_000));

      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow({ blockInterval: 1 })],
      });

      await monitor.start();
      const provider = latestProvider();

      // Emit a block every 5 minutes for 30 minutes — well past the 10-min
      // staleness threshold, but each height advance resets lastBlockAdvanceAt.
      for (const blockNumber of [101, 102, 103, 104, 105, 106]) {
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        provider.emitBlock(blockNumber);
        await vi.advanceTimersByTimeAsync(0);
        expect(monitor.isAlive()).toBe(true);
      }
    });

    it("does not reap a freshly-subscribed monitor that has yet to receive its first block", async () => {
      // Edge case: a monitor that just (re)connected but hasn't seen its
      // first block yet must not be reaped before the staleness window.
      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });

      await monitor.start();
      // monitorBootAt covers the cold-start warmup window: isAlive() returns
      // true even before the first real block arrives, until staleness
      // measured from boot exceeds MONITOR_RECREATE_TIMEOUT_MS.
      expect(monitor.isAlive()).toBe(true);
    });

    it("reaps a monitor stuck across silent reconnects with no real blocks", async () => {
      // KEEP-570 regression: previously, subscribeToBlocks reset
      // lastBlockAdvanceAt on every reconnect, so a monitor that kept
      // re-subscribing but never received a real block looked alive forever
      // to the reconciler. After this fix the staleness clock is measured
      // from the last real height advance (or monitorBootAt as the cold-
      // start fallback), so persistent silence across reconnects becomes
      // visible to BlockMonitorService.isAlive().
      //
      // Pin a short BLOCK_ADVANCE_TIMEOUT_MS to drive multiple silent
      // reconnects within the test window, and a short
      // MONITOR_RECREATE_TIMEOUT_MS so the reaper threshold is reachable.
      vi.stubEnv("BLOCK_ADVANCE_TIMEOUT_MS", String(60_000));
      vi.stubEnv("MONITOR_RECREATE_TIMEOUT_MS", String(120_000));

      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });

      await monitor.start();
      expect(monitor.isAlive()).toBe(true);

      // Three silent windows of 60s each plus the reconnects in between.
      // No real blocks emitted; the monitor's in-process reconnect cycle
      // keeps re-subscribing but the upstream stays silent.
      await vi.advanceTimersByTimeAsync(3 * 60_000);

      // Past the 120s staleness threshold, the reaper sees the monitor as
      // not alive even though it is happily resubscribing.
      expect(monitor.isAlive()).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Config changes
  // -------------------------------------------------------------------------

  describe("hasConfigChanged", () => {
    it("detects primary WSS change", async () => {
      const chain = makeChain();
      const monitor = new ChainMonitor({
        chain,
        workflows: [makeWorkflow()],
      });

      expect(
        monitor.hasConfigChanged({
          ...chain,
          defaultPrimaryWss: "wss://new-primary.test",
        }),
      ).toBe(true);
    });

    it("returns false when config unchanged", () => {
      const chain = makeChain();
      const monitor = new ChainMonitor({
        chain,
        workflows: [makeWorkflow()],
      });

      expect(monitor.hasConfigChanged(chain)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Fallback connection
  // -------------------------------------------------------------------------

  describe("fallback connection", () => {
    it("uses fallback WSS when primary getBlockNumber rejects", async () => {
      let callCount = 0;
      providerFactory = (url: string): MockProvider => {
        callCount++;
        const instance = new MockProvider(url);
        if (callCount === 1) {
          instance.getBlockNumber = (): Promise<number> =>
            Promise.reject(new Error("Primary down"));
        }
        return instance;
      };

      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });

      await monitor.start();

      expect(providerInstances).toHaveLength(2);
      expect(latestProvider().url).toBe("wss://fallback.test");
      expect(monitor.isAlive()).toBe(true);
    });

    it("falls over to fallback WSS when primary ws emits 'error' (HTTP 429)", async () => {
      // Simulates the failure mode where the WSS upgrade returns 429:
      // ws emits 'error' on the underlying socket and getBlockNumber would
      // hang waiting for ws ready. The connect race must reject via the
      // ws-error path so the fallback URL is tried instead of hanging or
      // crashing the dispatcher.
      let callCount = 0;
      providerFactory = (url: string): MockProvider => {
        callCount++;
        const instance = new MockProvider(url);
        if (callCount === 1) {
          // getBlockNumber hangs (mimics ws never opening due to 429)
          instance.getBlockNumber = (): Promise<number> =>
            new Promise<number>(() => {
              // never resolves
            });
          // ws emits error on next tick so the connect race is set up first
          setTimeout(() => {
            instance.websocket.emit(
              "error",
              new Error("Unexpected server response: 429"),
            );
          }, 0);
        }
        return instance;
      };

      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });

      await monitor.start();

      expect(providerInstances).toHaveLength(2);
      expect(latestProvider().url).toBe("wss://fallback.test");
      expect(monitor.isAlive()).toBe(true);
    });

    it("flips to fallback after SILENT_FAILOVER_THRESHOLD silent reconnects on primary", async () => {
      // Half-open-subscription scenario:
      //  - primary connects fine (getBlockNumber resolves)
      //  - eth_subscribe is accepted (provider.on resolves)
      //  - but newHeads is silent forever (we never call emitBlock on it)
      // After SILENT_FAILOVER_THRESHOLD BLOCK_ADVANCE_TIMEOUT_MS firings on
      // primary, the monitor flips to fallback for the next reconnect.
      vi.stubEnv("BLOCK_ADVANCE_TIMEOUT_MS", "200");
      vi.stubEnv("SILENT_FAILOVER_THRESHOLD", "2");
      // Disable the primary-recovery probe so it does not swap us back to
      // primary mid-test once we are on fallback.
      vi.stubEnv("PRIMARY_PROBE_INTERVAL_MS", "600000");

      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });

      await monitor.start();
      expect(latestProvider().url).toBe("wss://primary.test");
      expect(providerInstances).toHaveLength(1);

      // First silent window: noBlockTimer fires (silentReconnects=1),
      // reconnect waits 1s backoff, lands back on primary (below threshold).
      await vi.advanceTimersByTimeAsync(1_400);
      expect(latestProvider().url).toBe("wss://primary.test");
      expect(providerInstances.length).toBeGreaterThanOrEqual(2);

      // Second silent window: noBlockTimer fires (silentReconnects=2),
      // reconnect waits 1s backoff, maybeFlipUrlPreference() flips to
      // fallback, connect lands on fallback URL.
      await vi.advanceTimersByTimeAsync(1_400);
      expect(latestProvider().url).toBe("wss://fallback.test");
      expect(monitor.isAlive()).toBe(true);

      await monitor.stop();
    });

    it("does not flip when fallback URL is not configured", async () => {
      // If only a primary URL is configured, there is nowhere to flip to.
      // The monitor must keep reconnecting to the same URL without crashing.
      vi.stubEnv("BLOCK_ADVANCE_TIMEOUT_MS", "200");
      vi.stubEnv("SILENT_FAILOVER_THRESHOLD", "2");
      vi.stubEnv("PRIMARY_PROBE_INTERVAL_MS", "600000");

      const monitor = new ChainMonitor({
        chain: makeChain({ defaultFallbackWss: null }),
        workflows: [makeWorkflow()],
      });

      await monitor.start();
      expect(latestProvider().url).toBe("wss://primary.test");

      // Two silent windows; even past the threshold, still primary.
      await vi.advanceTimersByTimeAsync(1_400);
      await vi.advanceTimersByTimeAsync(1_400);

      const urls = providerInstances.map((p) => p.url);
      for (const url of urls) {
        expect(url).toBe("wss://primary.test");
      }

      await monitor.stop();
    });

    it("does not propagate ws 'error' as an uncaughtException", async () => {
      // Sanity check that the listener attached in connect() consumes the
      // error. Without the listener, EventEmitter would re-throw because
      // 'error' has no other subscribers.
      let callCount = 0;
      providerFactory = (url: string): MockProvider => {
        callCount++;
        const instance = new MockProvider(url);
        if (callCount === 1) {
          instance.getBlockNumber = (): Promise<number> =>
            new Promise<number>(() => {
              // never resolves
            });
          setTimeout(() => {
            instance.websocket.emit(
              "error",
              new Error("Unexpected server response: 429"),
            );
          }, 0);
        }
        return instance;
      };

      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });

      await expect(monitor.start()).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Metrics integration — verify the monitor actually drives the prom-client
  // registry at the right lifecycle points. Detailed assertions on the
  // metrics themselves live in metrics.test.ts; here we only confirm wiring.
  // -------------------------------------------------------------------------

  describe("metrics integration", () => {
    it("increments blocks_received_total and updates last_processed_block on advance", async () => {
      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow({ blockInterval: 1 })],
      });

      await monitor.start();
      latestProvider().emitBlock(123);
      await vi.advanceTimersByTimeAsync(0);

      const text = await registry.metrics();
      expect(text).toContain(
        'keeperhub_block_dispatcher_blocks_received_total{chain="TestChain"} 1',
      );
      expect(text).toContain(
        'keeperhub_block_dispatcher_last_processed_block{chain="TestChain"} 123',
      );
      expect(text).toContain(
        'keeperhub_block_dispatcher_has_active_subscription{chain="TestChain"} 1',
      );

      await monitor.stop();
    });

    it("records ws_close with reason=upstream_close on a WebSocket close event", async () => {
      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });

      await monitor.start();
      latestProvider().websocket.emit("close");
      // Let handleDisconnect run synchronously through the microtask queue
      // but don't advance long enough for reconnect-with-backoff to land.
      await vi.advanceTimersByTimeAsync(10);

      const text = await registry.metrics();
      expect(text).toContain(
        'keeperhub_block_dispatcher_ws_closes_total{chain="TestChain",reason="upstream_close"} 1',
      );

      await monitor.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Primary recovery probe
  //
  // These tests use process.env.PRIMARY_PROBE_INTERVAL_MS=1000 (set in
  // beforeAll below) so they run in ~1s instead of 5min.
  // -------------------------------------------------------------------------

  describe("primary recovery probe", () => {
    it("does not start a probe when initially connected to primary", async () => {
      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });

      await monitor.start();
      const startCount = providerInstances.length;

      // Advance well past one probe interval
      await vi.advanceTimersByTimeAsync(10_000);

      // No additional providers should have been created
      expect(providerInstances).toHaveLength(startCount);
    });

    it("probes primary when on fallback and swaps back when primary recovers", async () => {
      // First call: primary getBlockNumber rejects -> fallback used.
      // Subsequent primary calls: succeed -> probe should swap back.
      let primaryCallCount = 0;
      providerFactory = (url: string): MockProvider => {
        const instance = new MockProvider(url);
        if (url === "wss://primary.test") {
          primaryCallCount++;
          if (primaryCallCount === 1) {
            instance.getBlockNumber = (): Promise<number> =>
              Promise.reject(new Error("Unexpected server response: 429"));
          }
        }
        return instance;
      };

      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });

      await monitor.start();
      // Started on fallback (primary failed once)
      expect(latestProvider().url).toBe("wss://fallback.test");
      const startCount = providerInstances.length;

      // Advance past the probe interval; probe builds throwaway primary,
      // succeeds, triggers reconnect cycle which lands on primary again.
      await vi.advanceTimersByTimeAsync(2_000);

      // At least one new provider was created (the probe), and the active
      // provider should now be primary again.
      expect(providerInstances.length).toBeGreaterThan(startCount);
      // The monitor must have reconnected to primary, not stayed on fallback.
      // This is the assertion that catches the probePrimary bug: previously,
      // currentUrlIndex was never reset to 0, so reconnectWithBackoff always
      // landed back on the fallback URL.
      expect(latestProvider().url).toBe("wss://primary.test");
      expect(monitor.isAlive()).toBe(true);
    });

    it("recycles the socket after SOCKET_MAX_AGE_MS elapses", async () => {
      // Health-restart safety net: even when the socket appears healthy
      // (no close event, blocks still arriving), drop and re-subscribe on a
      // fixed schedule so a degraded WSS cannot accumulate undetected.
      // 30s here for the local fast-test path; staging/prod use 1h.
      vi.stubEnv("SOCKET_MAX_AGE_MS", "30000");

      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });

      await monitor.start();
      expect(providerInstances).toHaveLength(1);
      const originalProvider = latestProvider();

      // Just before the recycle window: no new provider yet.
      await vi.advanceTimersByTimeAsync(29_000);
      expect(providerInstances).toHaveLength(1);

      // Cross the window plus the first reconnect backoff (1s).
      await vi.advanceTimersByTimeAsync(2_500);

      expect(providerInstances.length).toBeGreaterThanOrEqual(2);
      expect(latestProvider()).not.toBe(originalProvider);
      expect(monitor.isAlive()).toBe(true);

      await monitor.stop();
    });

    it("keeps the fallback connection when probe fails", async () => {
      // Primary always rejects; fallback works. Probe should fail silently
      // (one warn line) and the monitor should remain alive on fallback.
      providerFactory = (url: string): MockProvider => {
        const instance = new MockProvider(url);
        if (url === "wss://primary.test") {
          instance.getBlockNumber = (): Promise<number> =>
            Promise.reject(new Error("Unexpected server response: 429"));
        }
        return instance;
      };

      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });

      await monitor.start();
      expect(latestProvider().url).toBe("wss://fallback.test");
      expect(monitor.isAlive()).toBe(true);

      // Spy on console.warn to confirm probe failure log is short
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await vi.advanceTimersByTimeAsync(2_000);

      // Still alive, still on fallback
      expect(monitor.isAlive()).toBe(true);
      // At least one warn was the probe-failure summary
      const probeWarn = warnSpy.mock.calls.find(([msg]) =>
        String(msg).includes("Primary probe failed"),
      );
      expect(probeWarn).toBeDefined();
      // The summary should be tight: contain "HTTP 429" and not run for hundreds of chars
      expect(String(probeWarn?.[0])).toContain("HTTP 429");
      expect(String(probeWarn?.[0]).length).toBeLessThan(160);

      warnSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // Liveness signals (KEEP-555)
  //
  // Each of the three liveness signals the monitor exposes must be
  // deterministically reproducible:
  //
  //   1. Transport keepalive       ping/pong       PONG_TIMEOUT_MS
  //   2. Subscription delivery     block-advance   BLOCK_ADVANCE_TIMEOUT_MS
  //   3. Reconciler backstop       RECONNECT_STUCK_TIMEOUT_MS
  //
  // Tests 1-3 exercise each signal in isolation. Test 4 reproduces the
  // observed prod incident end-to-end: WS close, reconnect succeeds, no
  // blocks arrive on the new subscription, the dispatcher recovers without
  // operator intervention.
  // -------------------------------------------------------------------------

  describe("liveness signals", () => {
    it("reconnects when no pong arrives within PONG_TIMEOUT_MS (signal 1)", async () => {
      // Tight ping/pong windows so the test runs in <1s of fake time.
      vi.stubEnv("PING_INTERVAL_MS", "500");
      vi.stubEnv("PONG_TIMEOUT_MS", "500");

      // Pin all other reconnect triggers far away so this test fails only if
      // the pong-timeout path itself fires.
      vi.stubEnv("BLOCK_ADVANCE_TIMEOUT_MS", String(60 * 60_000));
      vi.stubEnv("SOCKET_MAX_AGE_MS", String(60 * 60_000));

      // Suppress the auto-pong for the next provider built. Without a pong
      // response, the watchdog's pongTimer must fire and trigger reconnect.
      providerFactory = (url: string): MockProvider => {
        const instance = new MockProvider(url);
        // Replace ping with a no-op so no pong is ever emitted.
        instance.websocket.ping = (): void => {
          // intentionally swallow
        };
        return instance;
      };

      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });

      await monitor.start();
      expect(providerInstances).toHaveLength(1);

      // After PING_INTERVAL_MS, watchdog sends a ping; no pong arrives;
      // after PONG_TIMEOUT_MS the watchdog declares the transport dead and
      // reconnect kicks in. Allow another tick for the first reconnect
      // backoff (BASE_DELAY_MS = 1000) plus a buffer.
      await vi.advanceTimersByTimeAsync(500 + 500 + 1_500);

      expect(providerInstances.length).toBeGreaterThanOrEqual(2);

      await monitor.stop();
    });

    it("does NOT reset liveness when the same block is replayed (signal 2 - root cause)", async () => {
      // Reproduces the silent 7-hour outage: a half-open upstream replays
      // block(N) forever. The fix moves `lastBlockAdvanceAt` and the
      // no-block timer reset to AFTER the dedup check, so replayed blocks
      // cannot keep the monitor falsely alive.
      //
      // Pre-fix: this test fails (replays reset the no-block timer; no
      // reconnect fires).
      // Post-fix: reconnect fires within BLOCK_ADVANCE_TIMEOUT_MS.
      vi.stubEnv("BLOCK_ADVANCE_TIMEOUT_MS", "2000");

      // Keep other reconnect triggers parked.
      vi.stubEnv("SOCKET_MAX_AGE_MS", String(60 * 60_000));
      vi.stubEnv("PONG_TIMEOUT_MS", String(60 * 60_000));
      vi.stubEnv("PING_INTERVAL_MS", String(60 * 60_000));

      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow({ blockInterval: 1 })],
      });

      await monitor.start();
      const initialProviderCount = providerInstances.length;

      // First block — height genuinely advances. This is the only call that
      // should refresh liveness.
      latestProvider().emitBlock(100);
      await vi.advanceTimersByTimeAsync(0);

      // Spin in tight loops replaying the SAME block. With the bug present,
      // each replay resets lastBlockAdvanceAt and the no-block timer, so the
      // monitor stays alive forever and never reconnects.
      for (let elapsed = 0; elapsed < 1_900; elapsed += 100) {
        latestProvider().emitBlock(100);
        await vi.advanceTimersByTimeAsync(100);
      }

      // Cross the BLOCK_ADVANCE_TIMEOUT_MS threshold plus the 1s reconnect
      // backoff. Reconnect MUST have fired by now.
      await vi.advanceTimersByTimeAsync(1_500);

      expect(providerInstances.length).toBeGreaterThan(initialProviderCount);

      await monitor.stop();
    });

    it("isAlive() flips to false after RECONNECT_STUCK_TIMEOUT_MS (signal 3)", async () => {
      // Reconciler backstop: if a monitor is stuck in reconnectWithBackoff
      // (e.g. destroyProvider or connect hangs mid-await), isAlive() must
      // flip to false so BlockMonitorService can destroy and recreate it.
      // Previously, isReconnecting=true was a free pass and the monitor
      // would never be reaped.
      vi.stubEnv("RECONNECT_STUCK_TIMEOUT_MS", "1000");
      // Connect attempts must NOT time out within the test window — we need
      // the reconnect loop to genuinely hang, not bounce on CONNECT_TIMEOUT.
      vi.stubEnv("CONNECT_TIMEOUT_MS", String(60 * 60_000));

      // First provider connects normally. Subsequent providers (post-close
      // reconnect attempts) have a getBlockNumber that never resolves.
      let callCount = 0;
      providerFactory = (url: string): MockProvider => {
        callCount++;
        const instance = new MockProvider(url);
        if (callCount > 1) {
          instance.getBlockNumber = (): Promise<number> =>
            new Promise<number>(() => {
              // never resolves
            });
        }
        return instance;
      };

      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });

      await monitor.start();
      expect(monitor.isAlive()).toBe(true);

      // Trigger a close — reconnect cycle begins but cannot complete because
      // the second provider's getBlockNumber hangs.
      latestProvider().websocket.emit("close");

      // Just inside the stuck window — still considered alive.
      await vi.advanceTimersByTimeAsync(500);
      expect(monitor.isAlive()).toBe(true);

      // Past the stuck window — reconciler must see this as dead.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(monitor.isAlive()).toBe(false);

      await monitor.stop();
    });

    it("recovers from WS close -> reconnect -> dead subscription (incident reproduction)", async () => {
      // End-to-end reproduction of the prod incident:
      //   23:46:00  WS closed
      //   23:46:02  Reconnect succeeded
      //   ...       No block events ever arrive on the new subscription
      //
      // Pre-fix: dispatcher sits with hasActiveSubscription=true forever.
      // Post-fix: BLOCK_ADVANCE_TIMEOUT_MS fires; reconnect cycle continues.
      vi.stubEnv("BLOCK_ADVANCE_TIMEOUT_MS", "2000");
      vi.stubEnv("PING_INTERVAL_MS", String(60 * 60_000));
      vi.stubEnv("PONG_TIMEOUT_MS", String(60 * 60_000));
      vi.stubEnv("SOCKET_MAX_AGE_MS", String(60 * 60_000));

      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow()],
      });

      await monitor.start();
      expect(providerInstances).toHaveLength(1);

      // 23:46:00 - WS closes mid-stream.
      latestProvider().websocket.emit("close");
      // Walk past the 1s reconnect backoff.
      await vi.advanceTimersByTimeAsync(1_500);
      // 23:46:02 (in fake time) - reconnect succeeded.
      expect(providerInstances).toHaveLength(2);
      expect(monitor.isAlive()).toBe(true);

      // No blocks arrive on the new subscription. The monitor must self-heal.
      // Walk past BLOCK_ADVANCE_TIMEOUT_MS (2s) + reconnect backoff (1s) +
      // a buffer.
      await vi.advanceTimersByTimeAsync(4_000);

      // A further reconnect must have fired - we now have at least three
      // distinct providers (initial, post-close, post-block-advance-timeout).
      expect(providerInstances.length).toBeGreaterThanOrEqual(3);

      await monitor.stop();
    });
  });

  // -------------------------------------------------------------------------
  // KEEP-570 raw-ws diagnostic tap
  // -------------------------------------------------------------------------

  describe("ws frame diagnostic tap", () => {
    it("counts every frame, only parses JSON for eth_subscription, and surfaces both counters in the noBlockTimer warning", async () => {
      // Drive the tap with a mix of frame shapes and contents, then drive
      // the no-block timer to fire and assert the warning's diagnostic
      // counters reflect what we sent.
      vi.stubEnv("BLOCK_ADVANCE_TIMEOUT_MS", "2000");
      vi.stubEnv("SOCKET_MAX_AGE_MS", String(60 * 60_000));
      vi.stubEnv("PONG_TIMEOUT_MS", String(60 * 60_000));
      vi.stubEnv("PING_INTERVAL_MS", String(60 * 60_000));

      const warnSpy = vi.spyOn(console, "warn").mockImplementation((): void => {
        // capture only; suppress test output
      });

      try {
        const monitor = new ChainMonitor({
          chain: makeChain(),
          workflows: [makeWorkflow()],
        });
        await monitor.start();
        const provider = latestProvider();

        // 5 frames total, 3 of which are eth_subscription pushes. Mixed
        // shapes (string, Buffer, fragmented Buffer[]) to exercise
        // decodeWsFrame as part of the tap, plus one malformed frame to
        // confirm the parse-error path is silent.
        provider.websocket.emit(
          "message",
          Buffer.from('{"id":1,"result":"0x1"}', "utf8"),
        );
        provider.websocket.emit("message", "not-json");
        provider.websocket.emit(
          "message",
          Buffer.from('{"method":"eth_subscription"}', "utf8"),
        );
        provider.websocket.emit("message", [
          Buffer.from('{"method":"eth_su', "utf8"),
          Buffer.from('bscription"}', "utf8"),
        ]);
        provider.websocket.emit("message", '{"method":"eth_subscription"}');

        // Drive the no-block timer; no real blocks were emitted so it must
        // fire and emit the warning containing the counters.
        await vi.advanceTimersByTimeAsync(2_500);

        const warnings = warnSpy.mock.calls
          .map((args) => String(args[0]))
          .filter((line) => line.includes("Block height has not advanced"));
        expect(warnings.length).toBeGreaterThanOrEqual(1);
        const warning = warnings[0];
        expect(warning).toMatch(/wsFrames=5/);
        expect(warning).toMatch(/subscriptionPushes=3/);
        expect(warning).toMatch(/blocksReceived=0/);

        await monitor.stop();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("does not increment the push counter when a frame is malformed", async () => {
      // Isolates the parse-error branch: malformed JSON frames must
      // increment wsFrameCount but not subscriptionPushCount, and must
      // not throw / unhandle.
      vi.stubEnv("BLOCK_ADVANCE_TIMEOUT_MS", "2000");
      vi.stubEnv("SOCKET_MAX_AGE_MS", String(60 * 60_000));
      vi.stubEnv("PONG_TIMEOUT_MS", String(60 * 60_000));
      vi.stubEnv("PING_INTERVAL_MS", String(60 * 60_000));

      const warnSpy = vi.spyOn(console, "warn").mockImplementation((): void => {
        // capture only; suppress test output
      });

      try {
        const monitor = new ChainMonitor({
          chain: makeChain(),
          workflows: [makeWorkflow()],
        });
        await monitor.start();
        const provider = latestProvider();

        for (let i = 0; i < 4; i++) {
          provider.websocket.emit(
            "message",
            Buffer.from("not-json-at-all", "utf8"),
          );
        }

        await vi.advanceTimersByTimeAsync(2_500);

        const warning = warnSpy.mock.calls
          .map((args) => String(args[0]))
          .find((line) => line.includes("Block height has not advanced"));
        expect(warning).toBeDefined();
        expect(warning).toMatch(/wsFrames=4/);
        expect(warning).toMatch(/subscriptionPushes=0/);

        await monitor.stop();
      } finally {
        warnSpy.mockRestore();
      }
    });
  });
  // -------------------------------------------------------------------------
  // Skip if still running / missed-slot runs
  // -------------------------------------------------------------------------

  describe("skip if still running", () => {
    it("asks for the skip and does not enqueue a skipped dispatch", async () => {
      createPhantomExecution.mockResolvedValueOnce({
        executionId: "exec_skipped",
        alreadyExisted: false,
        skipped: true,
      });
      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow({ blockInterval: 1, skipIfRunning: true })],
      });
      await monitor.start();
      const { enqueueBlockTrigger } = await import(
        "../../block-dispatcher/sqs-enqueue.js"
      );
      vi.mocked(enqueueBlockTrigger).mockClear();

      latestProvider().emitBlock(10);
      await vi.advanceTimersByTimeAsync(0);

      expect(createPhantomExecution).toHaveBeenCalledWith(
        "wf-1",
        "block",
        "user-1",
        expect.stringMatching(/^block:wf-1:1:10$/),
        { skipIfRunning: true },
      );
      expect(enqueueBlockTrigger).not.toHaveBeenCalled();
      await monitor.stop();
    });

    it("does not enqueue when the skip check failed (skipped with no id)", async () => {
      createPhantomExecution.mockResolvedValueOnce({
        alreadyExisted: false,
        skipped: true,
        skipCheck: "failed",
      });
      const monitor = new ChainMonitor({
        chain: makeChain(),
        workflows: [makeWorkflow({ blockInterval: 1, skipIfRunning: true })],
      });
      await monitor.start();
      const { enqueueBlockTrigger } = await import(
        "../../block-dispatcher/sqs-enqueue.js"
      );
      vi.mocked(enqueueBlockTrigger).mockClear();

      const failedCount = async (): Promise<number> => {
        const metric = registry.getSingleMetric(
          "keeperhub_block_dispatcher_skip_check_failed_total",
        );
        const values = (await metric?.get())?.values ?? [];
        return values.reduce((sum, v) => sum + v.value, 0);
      };
      const before = await failedCount();

      latestProvider().emitBlock(10);
      await vi.advanceTimersByTimeAsync(0);

      expect(enqueueBlockTrigger).not.toHaveBeenCalled();
      // Counted, so a keeper that stopped running shows on /metrics.
      expect(await failedCount()).toBe(before + 1);
      await monitor.stop();
    });

    it.each(["workflow_gone", "workflow_inactive"] as const)(
      "does not enqueue or count a failed check when the workflow cannot run (%s)",
      async (skipCheck) => {
        createPhantomExecution.mockResolvedValueOnce({
          alreadyExisted: false,
          skipped: true,
          skipCheck,
        });
        const monitor = new ChainMonitor({
          chain: makeChain(),
          workflows: [makeWorkflow({ blockInterval: 1, skipIfRunning: true })],
        });
        await monitor.start();
        const { enqueueBlockTrigger } = await import(
          "../../block-dispatcher/sqs-enqueue.js"
        );
        vi.mocked(enqueueBlockTrigger).mockClear();
        const metric = registry.getSingleMetric(
          "keeperhub_block_dispatcher_skip_check_failed_total",
        );
        const total = async (): Promise<number> =>
          ((await metric?.get())?.values ?? []).reduce(
            (sum, v) => sum + v.value,
            0,
          );
        const before = await total();

        latestProvider().emitBlock(10);
        await vi.advanceTimersByTimeAsync(0);

        expect(enqueueBlockTrigger).not.toHaveBeenCalled();
        expect(await total()).toBe(before);
        await monitor.stop();
      },
    );
  });

  describe("missed-slot runs", () => {
    const GENESIS = 1_606_824_023;
    const S0 = 1_000_000;
    const slotStart = (slot: number): number => GENESIS + slot * 12;
    // Seconds timestamps the node reports: "latest", and any numbered block.
    let headTimestamp = 0;
    let blockTimestamp = 0;
    // Blocks the node returns by hash; an unknown hash returns null.
    let blocksByHash: Record<string, { number: number; timestamp: number }> =
      {};
    let latestMissing = false;
    let latestCalls = 0;

    class SlotProvider extends MockProvider {
      override async getBlock(tag: number | string): Promise<{
        number: number;
        hash: string;
        timestamp: number;
        parentHash: string;
      } | null> {
        if (typeof tag === "string" && tag !== "latest") {
          const byHash = blocksByHash[tag];
          return byHash
            ? { ...byHash, hash: tag, parentHash: "0xparent" }
            : null;
        }
        if (tag === "latest") {
          latestCalls++;
          if (latestMissing) {
            return null;
          }
        }
        const number = tag === "latest" ? 500 : Number(tag);
        return {
          number,
          hash: `0xhead${number}`,
          timestamp: tag === "latest" ? headTimestamp : blockTimestamp,
          parentHash: "0xparent",
        };
      }
    }

    type Sent = {
      triggerData: { missedSlot?: boolean; targetSlot?: number };
    };
    async function sent(): Promise<Sent[]> {
      const { enqueueBlockTrigger } = await import(
        "../../block-dispatcher/sqs-enqueue.js"
      );
      return vi
        .mocked(enqueueBlockTrigger)
        .mock.calls.map((call) => call[0] as unknown as Sent);
    }
    const missedSlotRuns = async (): Promise<Sent[]> =>
      (await sent()).filter((m) => m.triggerData.missedSlot === true);
    const keys = (): string[] =>
      createPhantomExecution.mock.calls.map((call) => String(call[3]));

    // A newHeads push as the socket delivers it, with the header's timestamp.
    function pushHeader(
      timestampSeconds: number,
      block?: { number: number; hash: string },
    ): void {
      latestProvider().websocket.emit(
        "message",
        JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_subscription",
          params: {
            subscription: "0x1",
            result: {
              timestamp: `0x${timestampSeconds.toString(16)}`,
              ...(block
                ? { number: `0x${block.number.toString(16)}`, hash: block.hash }
                : {}),
            },
          },
        }),
      );
    }

    // A live header 1 s after its timestamp: missed-slot checks need one since subscribing.
    const onTimeHeader = (): void =>
      pushHeader(Math.floor(Date.now() / 1000) - 1);

    async function startAt(
      ms: number,
      workflows: BlockWorkflow[],
      chain: ChainConfig = makeChain(),
      withHeader = true,
    ): Promise<ChainMonitor> {
      vi.setSystemTime(ms);
      providerFactory = (url) => new SlotProvider(url);
      const monitor = new ChainMonitor({ chain, workflows });
      await monitor.start();
      if (withHeader) {
        onTimeHeader();
      }
      return monitor;
    }

    const optedIn = makeWorkflow({ blockInterval: 1, runOnMissedSlot: true });
    // 5 s into slot S0: the next check is slot S0 + 1, 11 s later.
    const inSlotS0 = (): number => slotStart(S0) * 1000 + 5000;

    beforeEach(() => {
      // Slot maths runs on Date.now(): keep the clock fake-only so CPU load cannot shift it.
      vi.useRealTimers();
      vi.useFakeTimers();
      headTimestamp = slotStart(S0 - 1);
      blockTimestamp = slotStart(S0 + 1);
      blocksByHash = {};
      latestMissing = false;
    });

    it("fires 4 s into an empty slot, never for a slot that began before connect", async () => {
      // Connected 1 s into slot S0: its block may have come before we listened.
      const monitor = await startAt(slotStart(S0) * 1000 + 1000, [optedIn]);
      await vi.advanceTimersByTimeAsync(4000);
      expect(await missedSlotRuns()).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(12_000);
      expect(keys()).toEqual([`slot:wf-1:1:${S0 + 1}`]);
      expect((await sent())[0]).toMatchObject({
        triggerData: {
          blockNumber: 500,
          blockHash: "0xhead500",
          blockTimestamp: slotStart(S0 - 1),
          parentHash: "0xparent",
          missedSlot: true,
          slotTimestamp: slotStart(S0 + 1),
          targetSlot: S0 + 2,
          targetSlotTimestamp: slotStart(S0 + 2),
        },
      });
      await monitor.stop();
    });

    it("fires once for each of several empty slots in a row", async () => {
      const monitor = await startAt(inSlotS0(), [optedIn]);
      await vi.advanceTimersByTimeAsync(11_000 + 24_000);
      expect(keys()).toEqual([1, 2, 3].map((n) => `slot:wf-1:1:${S0 + n}`));
      await monitor.stop();
    });

    it("gives a block run the slot key and slot fields, so a late block cannot run its slot twice", async () => {
      const log = vi.spyOn(console, "log");
      const monitor = await startAt(inSlotS0(), [optedIn]);
      await vi.advanceTimersByTimeAsync(11_000); // slot S0 + 1 missed
      createPhantomExecution.mockResolvedValueOnce({
        executionId: "exec_missed",
        alreadyExisted: true,
      });
      latestProvider().emitBlock(501); // slot S0 + 1's block, 1 s late
      await vi.advanceTimersByTimeAsync(1000);

      expect(keys()).toEqual([
        `slot:wf-1:1:${S0 + 1}`,
        `slot:wf-1:1:${S0 + 1}`,
      ]);
      expect(await sent()).toHaveLength(1);
      expect(
        log.mock.calls.some((c) =>
          String(c[0]).includes(
            `Late block 501 for slot ${S0 + 1}, which already had a missed-slot run`,
          ),
        ),
      ).toBe(true);
      log.mockRestore();
      await monitor.stop();
    });

    it("runs a slot whose only block reuses an already-processed number (late-block reorg)", async () => {
      const monitor = await startAt(slotStart(S0) * 1000 + 1000, [optedIn]);
      // Block 500 lands in slot S0 and runs.
      blockTimestamp = slotStart(S0);
      pushHeader(slotStart(S0));
      latestProvider().emitBlock(500);
      await vi.advanceTimersByTimeAsync(11_000); // start of slot S0 + 1, well before its check
      // The next proposer reorgs it out: block 500 again, now in slot S0 + 1.
      blockTimestamp = slotStart(S0 + 1);
      headTimestamp = slotStart(S0 + 1);
      pushHeader(slotStart(S0 + 1));
      latestProvider().emitBlock(500);
      await vi.advanceTimersByTimeAsync(5000); // past slot S0 + 1's check
      expect(keys()).toEqual([`slot:wf-1:1:${S0}`, `slot:wf-1:1:${S0 + 1}`]);
      expect((await sent())[1].triggerData).toMatchObject({
        blockNumber: 500,
        missedSlot: false,
        targetSlot: S0 + 2,
      });
      await monitor.stop();
    });

    it("leaves a block whose header beat the check to the normal path: one run, not two", async () => {
      const monitor = await startAt(inSlotS0(), [optedIn]);
      await vi.advanceTimersByTimeAsync(10_500); // 3.5 s into slot S0 + 1
      headTimestamp = slotStart(S0 + 1);
      pushHeader(slotStart(S0 + 1), { number: 501, hash: "0xb501" });
      await vi.advanceTimersByTimeAsync(700); // 4.2 s: the check ran
      latestProvider().emitBlock(501);
      await vi.advanceTimersByTimeAsync(100);
      expect(keys()).toEqual([`slot:wf-1:1:${S0 + 1}`]);
      const messages = await sent();
      expect(messages).toHaveLength(1);
      expect(messages[0].triggerData).toMatchObject({
        blockNumber: 501,
        missedSlot: false,
      });
      await monitor.stop();
    });

    it("header 2 s into the slot, body after the check: nothing before the block event, then one block run", async () => {
      const monitor = await startAt(inSlotS0(), [optedIn]);
      await vi.advanceTimersByTimeAsync(9000); // 2 s into slot S0 + 1
      pushHeader(slotStart(S0 + 1), { number: 501, hash: "0xb501" });
      await vi.advanceTimersByTimeAsync(3000); // the 4 s check
      expect(await sent()).toHaveLength(0); // left to the block event
      latestProvider().emitBlock(501); // body lands at 5 s
      await vi.advanceTimersByTimeAsync(100);
      const messages = await sent();
      expect(messages).toHaveLength(1);
      expect(messages[0].triggerData).toMatchObject({
        blockNumber: 501,
        missedSlot: false,
        targetSlot: S0 + 2,
      });
      await monitor.stop();
    });

    it("runs a reorged slot from its header's hash when the node still serves an older latest", async () => {
      const monitor = await startAt(slotStart(S0) * 1000 + 1000, [optedIn]);
      blockTimestamp = slotStart(S0);
      latestProvider().emitBlock(500); // block 500 runs slot S0
      await vi.advanceTimersByTimeAsync(11_000); // start of slot S0 + 1, well before its check
      // The replacement block 500 lands in slot S0 + 1; "latest" still returns the old one.
      headTimestamp = slotStart(S0);
      blocksByHash = {
        "0xnew500": { number: 500, timestamp: slotStart(S0 + 1) },
      };
      pushHeader(slotStart(S0 + 1), { number: 500, hash: "0xnew500" });
      latestProvider().emitBlock(500);
      await vi.advanceTimersByTimeAsync(5000);
      expect(keys()).toEqual([`slot:wf-1:1:${S0}`, `slot:wf-1:1:${S0 + 1}`]);
      expect((await sent())[1].triggerData).toMatchObject({
        blockHash: "0xnew500",
        missedSlot: false,
      });
      await monitor.stop();
    });

    it("treats a slot whose header was seen as filled when its block cannot be fetched and latest is older", async () => {
      const warn = vi.spyOn(console, "warn");
      const monitor = await startAt(slotStart(S0) * 1000 + 1000, [optedIn]);
      blockTimestamp = slotStart(S0);
      latestProvider().emitBlock(500);
      await vi.advanceTimersByTimeAsync(11_000); // start of slot S0 + 1, well before its check
      // A lagging node answers "latest" with slot S0's block; the by-hash fetch fails.
      headTimestamp = slotStart(S0);
      latestCalls = 0;
      pushHeader(slotStart(S0 + 1), { number: 500, hash: "0xgone" });
      await vi.advanceTimersByTimeAsync(5000);
      expect(keys()).toEqual([`slot:wf-1:1:${S0}`]);
      expect(await missedSlotRuns()).toHaveLength(0);
      expect(latestCalls).toBe(1);
      // The run for that slot may be lost, so it is logged.
      expect(
        warn.mock.calls.some((c) =>
          String(c[0]).includes("from another slot: no run for this slot"),
        ),
      ).toBe(true);
      warn.mockRestore();
      await monitor.stop();
    });

    it("warns when the slot's block was seen but neither fetch of it answers", async () => {
      const warn = vi.spyOn(console, "warn");
      const monitor = await startAt(slotStart(S0) * 1000 + 1000, [optedIn]);
      blockTimestamp = slotStart(S0);
      latestProvider().emitBlock(500);
      await vi.advanceTimersByTimeAsync(11_000);
      latestMissing = true;
      pushHeader(slotStart(S0 + 1), { number: 500, hash: "0xgone" });
      await vi.advanceTimersByTimeAsync(5000);
      expect(keys()).toEqual([`slot:wf-1:1:${S0}`]);
      expect(await missedSlotRuns()).toHaveLength(0);
      expect(
        warn.mock.calls.some((c) =>
          String(c[0]).includes(
            `Slot ${S0 + 1} had block 500, but both fetches of it failed: no run for this slot`,
          ),
        ),
      ).toBe(true);
      warn.mockRestore();
      await monitor.stop();
    });

    it("treats a slot whose header was seen as filled when the block by hash is from another slot", async () => {
      const monitor = await startAt(slotStart(S0) * 1000 + 1000, [optedIn]);
      blockTimestamp = slotStart(S0);
      latestProvider().emitBlock(500);
      await vi.advanceTimersByTimeAsync(11_000);
      headTimestamp = slotStart(S0);
      blocksByHash = { "0xodd": { number: 500, timestamp: slotStart(S0) } };
      pushHeader(slotStart(S0 + 1), { number: 500, hash: "0xodd" });
      await vi.advanceTimersByTimeAsync(5000);
      expect(keys()).toEqual([`slot:wf-1:1:${S0}`]);
      expect(await missedSlotRuns()).toHaveLength(0);
      await monitor.stop();
    });

    it("logs a run for an already-processed block without naming a cause", async () => {
      const log = vi.spyOn(console, "log");
      const monitor = await startAt(slotStart(S0) * 1000 + 1000, [optedIn]);
      blockTimestamp = slotStart(S0);
      latestProvider().emitBlock(500);
      await vi.advanceTimersByTimeAsync(11_000);
      headTimestamp = slotStart(S0);
      blocksByHash = {
        "0xnew500": { number: 500, timestamp: slotStart(S0 + 1) },
      };
      pushHeader(slotStart(S0 + 1), { number: 500, hash: "0xnew500" });
      await vi.advanceTimersByTimeAsync(5000);
      const lines = log.mock.calls.map((c) => String(c[0]));
      expect(
        lines.some((l) =>
          l.includes(
            `Slot ${S0 + 1} has block 500, at or below the last processed block, and no run yet for this slot`,
          ),
        ),
      ).toBe(true);
      expect(lines.some((l) => l.includes("reorg"))).toBe(false);
      log.mockRestore();
      await monitor.stop();
    });

    it("does not run a slot from a latest block that belongs to a later slot", async () => {
      const monitor = await startAt(slotStart(S0) * 1000 + 1000, [optedIn]);
      blockTimestamp = slotStart(S0);
      latestProvider().emitBlock(500);
      await vi.advanceTimersByTimeAsync(11_000);
      headTimestamp = slotStart(S0 + 2); // latest says block 500 is in slot S0 + 2
      await vi.advanceTimersByTimeAsync(5000); // slot S0 + 1's check
      expect(keys()).toEqual([`slot:wf-1:1:${S0}`]);
      await monitor.stop();
    });

    it("runs a block with a far-future body timestamp under its block key, without moving the slot clock", async () => {
      const monitor = await startAt(inSlotS0(), [optedIn]);
      blockTimestamp = slotStart(S0 + 100);
      latestProvider().emitBlock(501);
      await vi.advanceTimersByTimeAsync(11_000); // slot S0 + 1's check
      expect(keys()).toEqual(["block:wf-1:1:501", `slot:wf-1:1:${S0 + 1}`]);
      expect((await sent())[0].triggerData.missedSlot).toBeUndefined();
      expect(await missedSlotRuns()).toHaveLength(1);
      await monitor.stop();
    });

    it("treats a slot whose header was seen as having a block when neither fetch answers", async () => {
      const monitor = await startAt(slotStart(S0) * 1000 + 1000, [optedIn]);
      blockTimestamp = slotStart(S0);
      latestProvider().emitBlock(500);
      await vi.advanceTimersByTimeAsync(11_000);
      latestMissing = true;
      latestCalls = 0;
      pushHeader(slotStart(S0 + 1), { number: 500, hash: "0xunknown" });
      await vi.advanceTimersByTimeAsync(5000);
      expect(keys()).toEqual([`slot:wf-1:1:${S0}`]);
      expect(await missedSlotRuns()).toHaveLength(0);
      expect(latestCalls).toBe(2); // one "latest" fetch (two attempts), none for the missed-slot check
      await monitor.stop();
    });

    it("ignores a header more than a slot ahead of the local clock", async () => {
      const monitor = await startAt(inSlotS0(), [optedIn], makeChain(), false);
      pushHeader(slotStart(S0)); // 5 s late: checks should pause
      pushHeader(slotStart(S0 + 3)); // bogus, far ahead: must not count as on time
      await vi.advanceTimersByTimeAsync(11_000);
      expect(await missedSlotRuns()).toHaveLength(0);
      await monitor.stop();
    });

    it("sends missedSlot false and the slot fields on an opted-in block run", async () => {
      const monitor = await startAt(slotStart(S0 + 1) * 1000 + 1000, [optedIn]);
      latestProvider().emitBlock(501);
      await vi.advanceTimersByTimeAsync(0);
      expect(keys()).toEqual([`slot:wf-1:1:${S0 + 1}`]);
      expect((await sent())[0].triggerData).toMatchObject({
        blockNumber: 501,
        missedSlot: false,
        slotTimestamp: slotStart(S0 + 1),
        targetSlot: S0 + 2,
        targetSlotTimestamp: slotStart(S0 + 2),
      });
      await monitor.stop();
    });

    it("does not fire when the slot's block arrived", async () => {
      const monitor = await startAt(inSlotS0(), [optedIn]);
      await vi.advanceTimersByTimeAsync(8000);
      latestProvider().emitBlock(501);
      await vi.advanceTimersByTimeAsync(4000);
      expect(await missedSlotRuns()).toHaveLength(0);
      await monitor.stop();
    });

    it("does not fire when the node already has a newer block", async () => {
      headTimestamp = slotStart(S0 + 1);
      const monitor = await startAt(inSlotS0(), [optedIn]);
      await vi.advanceTimersByTimeAsync(12_000);
      expect(await missedSlotRuns()).toHaveLength(0);
      await monitor.stop();
    });

    it("stops after 4 empty slots in a row: an older head means a lagging node", async () => {
      headTimestamp = slotStart(S0 - 3); // slot S0 + 1 is the 4th empty slot
      const monitor = await startAt(inSlotS0(), [optedIn]);
      await vi.advanceTimersByTimeAsync(11_000);
      expect(keys()).toEqual([`slot:wf-1:1:${S0 + 1}`]);
      await vi.advanceTimersByTimeAsync(12_000);
      expect(keys()).toHaveLength(1);
      await monitor.stop();
    });

    it("pauses while every recent header reached the socket over 4 s late, and warns once", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const monitor = await startAt(inSlotS0(), [optedIn], makeChain(), false);
      // Headers 5 s late by the local clock (the clock or the node is off).
      pushHeader(slotStart(S0));
      await vi.advanceTimersByTimeAsync(11_000 + 24_000);
      expect(await missedSlotRuns()).toHaveLength(0);
      const paused = warn.mock.calls.filter((c) =>
        String(c[0]).includes("Missed-slot checks paused"),
      );
      expect(paused).toHaveLength(1);
      warn.mockRestore();
      await monitor.stop();
    });

    it("keeps checking when only one recent header was late", async () => {
      const monitor = await startAt(inSlotS0(), [optedIn]);
      pushHeader(slotStart(S0) + 3); // 2 s late: on time
      pushHeader(slotStart(S0)); // 5 s late
      await vi.advanceTimersByTimeAsync(11_000);
      expect(await missedSlotRuns()).toHaveLength(1);
      await monitor.stop();
    });

    it("forgets header lags on resubscribe, and waits for a live header before firing", async () => {
      const monitor = await startAt(inSlotS0(), [optedIn]); // one on-time header
      latestProvider().websocket.emit("close");
      await vi.advanceTimersByTimeAsync(1500); // resubscribed in slot S0
      await vi.advanceTimersByTimeAsync(10_000); // slot S0 + 1: no header yet
      expect(await missedSlotRuns()).toHaveLength(0);
      onTimeHeader();
      await vi.advanceTimersByTimeAsync(12_000); // slot S0 + 2
      expect(await missedSlotRuns()).toHaveLength(1);
      await monitor.stop();
    });

    it("pauses on disconnect and skips slots that began before the new subscription", async () => {
      const monitor = await startAt(inSlotS0(), [optedIn]);
      await vi.advanceTimersByTimeAsync(7500);
      latestProvider().websocket.emit("close"); // 0.5 s into slot S0 + 1
      await vi.advanceTimersByTimeAsync(1500); // resubscribed ~1.5 s into S0 + 1
      onTimeHeader();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(providerInstances.length).toBeGreaterThan(1);
      expect(keys()).toEqual([`slot:wf-1:1:${S0 + 2}`]);
      await monitor.stop();
    });

    it("ignores other networks, workflows without the option and intervals above 1", async () => {
      const others = [
        makeWorkflow({ id: "wf-off", blockInterval: 1 }),
        makeWorkflow({ id: "wf-10", blockInterval: 10, runOnMissedSlot: true }),
      ];
      const a = await startAt(inSlotS0(), others);
      const b = await startAt(
        inSlotS0(),
        [optedIn],
        makeChain({ chainId: 8453 }),
      );
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await missedSlotRuns()).toHaveLength(0);
      await a.stop();
      await b.stop();
    });

    it("stops firing when the option is turned off, and after stop()", async () => {
      const monitor = await startAt(inSlotS0(), [optedIn]);
      await vi.advanceTimersByTimeAsync(11_000);
      expect(await missedSlotRuns()).toHaveLength(1);
      monitor.updateWorkflows([makeWorkflow({ blockInterval: 1 })]);
      await vi.advanceTimersByTimeAsync(24_000);
      monitor.updateWorkflows([optedIn]);
      await monitor.stop();
      await vi.advanceTimersByTimeAsync(24_000);
      expect(await missedSlotRuns()).toHaveLength(1);
    });
  });
});
