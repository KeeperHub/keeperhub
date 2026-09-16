import type { ethers } from "ethers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../lib/utils/logger";
import {
  ChainProviderManager,
  type ProviderFactory,
  type TraceCallFrame,
} from "../../src/chains/provider-manager";

/**
 * Trace matching on the shared block subscription (issue #2464).
 *
 * Each case here pins one of the defects the review found, so reverting the
 * corresponding fix fails a test rather than only changing behaviour nothing
 * observes.
 */

const CHAIN_ID = 31_337;
const WSS_URL = "ws://localhost:8546";
const WATCHED = "0x1111111111111111111111111111111111111111";
const CALLER = "0x2222222222222222222222222222222222222222";
const OTHER = "0x3333333333333333333333333333333333333333";
const PAUSE_SELECTOR = "0x8456cb59";

interface SendCall {
  method: string;
  params: unknown[];
}

type TraceEntry = { result?: unknown; txHash?: string };

class MockProvider {
  public sendCalls: SendCall[] = [];
  /** Queued `debug_traceBlockByNumber` responses, one per call. */
  public traceResponses: TraceEntry[][] = [];
  /** When set, every `debug_traceBlockByNumber` rejects with this. */
  public traceFailure: unknown = null;
  private blockHandler: ((n: number) => void | Promise<void>) | null = null;

  on(event: string, handler: (n: number) => void | Promise<void>): void {
    if (event === "block") {
      this.blockHandler = handler;
    }
  }

  off(event: string, handler: (n: number) => void | Promise<void>): void {
    if (event === "block" && this.blockHandler === handler) {
      this.blockHandler = null;
    }
  }

  async getBlockNumber(): Promise<number> {
    return 0x1234;
  }

  async send(method: string, params: unknown[]): Promise<unknown> {
    this.sendCalls.push({ method, params });
    if (method === "eth_subscribe") {
      return "0xprobe";
    }
    if (method === "eth_unsubscribe") {
      return true;
    }
    if (method === "eth_blockNumber") {
      return 0x1234;
    }
    if (method === "eth_getLogs") {
      return [];
    }
    if (method === "debug_traceBlockByNumber") {
      if (this.traceFailure) {
        throw this.traceFailure;
      }
      return this.traceResponses.shift() ?? [];
    }
    return [];
  }

  async destroy(): Promise<void> {}

  async emitBlock(blockNumber: number): Promise<void> {
    await this.blockHandler?.(blockNumber);
  }
}

function makeFactory(): { factory: ProviderFactory; created: MockProvider[] } {
  const created: MockProvider[] = [];
  const factory: ProviderFactory = () => {
    const mock = new MockProvider();
    created.push(mock);
    return mock as unknown as ethers.WebSocketProvider;
  };
  return { factory, created };
}

function callsTo(provider: MockProvider, method: string): SendCall[] {
  return provider.sendCalls.filter((call) => call.method === method);
}

/** A single top-level CALL into the watched contract. */
function pauseCall(to = WATCHED, from = CALLER) {
  return {
    type: "CALL",
    from,
    to,
    value: "0x0",
    input: `${PAUSE_SELECTOR}`,
  };
}

describe("ChainProviderManager trace matching", () => {
  let manager: ChainProviderManager;
  let created: MockProvider[];
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    const f = makeFactory();
    created = f.created;
    manager = new ChainProviderManager({
      factory: f.factory,
      onPermanentFailure: () => undefined,
    });
    warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    vi.spyOn(logger, "log").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await manager.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Subscribe, deliver one block, let the scheduled trace work settle. */
  async function runBlock(
    traces: TraceEntry[],
    opts: Partial<Parameters<typeof manager.subscribeToTrace>[0]> = {},
  ): Promise<TraceCallFrame[]> {
    const received: TraceCallFrame[] = [];
    await manager.subscribeToTrace({
      chainId: CHAIN_ID,
      wssUrl: WSS_URL,
      contractAddress: WATCHED,
      handler: async (matches) => {
        received.push(...matches);
      },
      ...opts,
    });
    created[0].traceResponses.push(traces);
    await created[0].emitBlock(1000);
    // processTraces is scheduled rather than awaited, so give the
    // fire-and-forget chain its turns.
    await vi.advanceTimersByTimeAsync(2000);
    return received;
  }

  it("dispatches the hash the tracer returned, not one indexed from the block", async () => {
    // The trace array deliberately does not line up with any block
    // transaction list: entry 0 is a system transaction with no match, and
    // the matching frame is entry 1. Indexing a block's transactions by the
    // trace position would attribute the match to the wrong hash.
    const received = await runBlock([
      { txHash: "0xsystem", result: pauseCall(OTHER) },
      { txHash: "0xreal", result: pauseCall() },
    ]);

    expect(received).toHaveLength(1);
    expect(received[0].transactionHash).toBe("0xreal");
  });

  it("never calls eth_getBlockByNumber", async () => {
    await runBlock([{ txHash: "0xabc", result: pauseCall() }]);
    // The block fetch existed only to index transactions by trace position.
    // Dropping it also halves the RPC cost of the trace path.
    expect(callsTo(created[0], "eth_getBlockByNumber")).toHaveLength(0);
    expect(callsTo(created[0], "debug_traceBlockByNumber")).toHaveLength(1);
  });

  it("skips a trace entry that carries no txHash instead of dispatching undefined", async () => {
    // A frame with no hash cannot be deduped. The dispatch key used to become
    // "<wf>:<chain>:undefined:<frameIndex>", and the unique index then made
    // every later match at that frame index look like a duplicate.
    const received = await runBlock([
      { result: pauseCall() },
      { txHash: "0xgood", result: pauseCall() },
    ]);

    expect(received).toHaveLength(1);
    expect(received[0].transactionHash).toBe("0xgood");
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes("carried no txHash")),
    ).toBe(true);
  });

  it("sends the tracer timeout so geth does not apply its 5s default", async () => {
    await runBlock([{ txHash: "0xabc", result: pauseCall() }]);
    const [call] = callsTo(created[0], "debug_traceBlockByNumber");
    expect(call.params[1]).toMatchObject({
      tracer: "callTracer",
      timeout: "15s",
    });
  });

  it("filters by selector and by caller", async () => {
    const received = await runBlock(
      [
        { txHash: "0x1", result: pauseCall(WATCHED, OTHER) },
        { txHash: "0x2", result: pauseCall(WATCHED, CALLER) },
      ],
      { selector: PAUSE_SELECTOR, caller: CALLER },
    );

    expect(received).toHaveLength(1);
    expect(received[0].transactionHash).toBe("0x2");
    expect(received[0].from).toBe(CALLER.toLowerCase());
    expect(received[0].selector).toBe(PAUSE_SELECTOR);
  });

  it("matches a nested frame and records its depth and index", async () => {
    const received = await runBlock([
      {
        txHash: "0xnested",
        result: {
          type: "CALL",
          from: CALLER,
          to: OTHER,
          value: "0x0",
          input: "0xaabbccdd",
          calls: [pauseCall()],
        },
      },
    ]);

    expect(received).toHaveLength(1);
    expect(received[0].depth).toBe(1);
    expect(received[0].frameIndex).toBe(1);
  });

  it("marks a reverted frame and can filter to it", async () => {
    const received = await runBlock(
      [
        {
          txHash: "0xrev",
          result: { ...pauseCall(), error: "execution reverted" },
        },
      ],
      { status: "reverted" },
    );

    expect(received).toHaveLength(1);
    expect(received[0].reverted).toBe(true);
  });

  it("caps dispatch at 25 frames per subscription per block and says so", async () => {
    const calls = Array.from({ length: 40 }, () => pauseCall());
    const received = await runBlock([
      {
        txHash: "0xmany",
        result: { ...pauseCall(OTHER), calls },
      },
    ]);

    expect(received).toHaveLength(25);
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes("capping trace")),
    ).toBe(true);
  });

  describe("learned capability on refusal", () => {
    function refusal(code: number, message: string): Error & { code: number } {
      const err = new Error(message) as Error & { code: number };
      err.code = code;
      return err;
    }

    it("stops asking after -32601, logs once, and keeps the subscriptions", async () => {
      const received: TraceCallFrame[] = [];
      await manager.subscribeToTrace({
        chainId: CHAIN_ID,
        wssUrl: WSS_URL,
        contractAddress: WATCHED,
        handler: async (matches) => {
          received.push(...matches);
        },
      });
      created[0].traceFailure = refusal(
        -32601,
        "the method debug_traceBlockByNumber does not exist/is not available",
      );

      for (let i = 0; i < 4; i++) {
        await created[0].emitBlock(1000 + i);
        await vi.advanceTimersByTimeAsync(2000);
      }

      // Asked once, then never again on this connection.
      expect(callsTo(created[0], "debug_traceBlockByNumber")).toHaveLength(1);
      const refusalWarnings = warn.mock.calls.filter((c) =>
        String(c[0]).includes("refused"),
      );
      expect(refusalWarnings).toHaveLength(1);
      // The subscription itself survives. Dropping it would take the trigger
      // away with no path back, and the unsubscribe closure would then be
      // deleting from a set that no longer holds it.
      expect(manager.traceSubscriberCount(CHAIN_ID)).toBe(1);
    });

    it("keeps asking after a rate limit, which is retryable", async () => {
      await manager.subscribeToTrace({
        chainId: CHAIN_ID,
        wssUrl: WSS_URL,
        contractAddress: WATCHED,
        handler: async () => undefined,
      });
      created[0].traceFailure = refusal(-32005, "rate limit exceeded");

      for (let i = 0; i < 3; i++) {
        await created[0].emitBlock(1000 + i);
        await vi.advanceTimersByTimeAsync(2000);
      }

      expect(
        callsTo(created[0], "debug_traceBlockByNumber").length,
      ).toBeGreaterThan(1);
    });

    it("keeps asking when the block is missing rather than the method", async () => {
      await manager.subscribeToTrace({
        chainId: CHAIN_ID,
        wssUrl: WSS_URL,
        contractAddress: WATCHED,
        handler: async () => undefined,
      });
      // "block does not exist" contains the not-supported vocabulary, so the
      // block check has to be settled before the capability verdict.
      created[0].traceFailure = new Error("requested block does not exist");

      for (let i = 0; i < 3; i++) {
        await created[0].emitBlock(1000 + i);
        await vi.advanceTimersByTimeAsync(2000);
      }

      expect(
        callsTo(created[0], "debug_traceBlockByNumber").length,
      ).toBeGreaterThan(1);
    });

    it("treats a plan gate as permanent for the connection", async () => {
      await manager.subscribeToTrace({
        chainId: CHAIN_ID,
        wssUrl: WSS_URL,
        contractAddress: WATCHED,
        handler: async () => undefined,
      });
      created[0].traceFailure = new Error(
        "debug_traceBlockByNumber is not available on the free plan, please upgrade",
      );

      for (let i = 0; i < 3; i++) {
        await created[0].emitBlock(1000 + i);
        await vi.advanceTimersByTimeAsync(2000);
      }

      expect(callsTo(created[0], "debug_traceBlockByNumber")).toHaveLength(1);
    });
  });

  it("reports trace subscribers in health", async () => {
    await manager.subscribeToTrace({
      chainId: CHAIN_ID,
      wssUrl: WSS_URL,
      contractAddress: WATCHED,
      handler: async () => undefined,
    });

    const health = manager.getAllHealth().find((h) => h.chainId === CHAIN_ID);
    // A trace-only chain used to report zero subscribers while issuing a
    // debug_traceBlockByNumber per block.
    expect(health?.traceSubscriberCount).toBe(1);
    expect(health?.subscriberCount).toBe(0);
  });
});
