import { ethers, type ethers as ethersTypes } from "ethers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../lib/utils/logger";
import { type FlatCall, frameMatches } from "../../lib/web3/trace-decode";
import {
  ChainProviderManager,
  type ProviderFactory,
  TRACE_MAX_BLOCK_SPAN,
  type TraceCallFrame,
} from "../../src/chains/provider-manager";
import { buildHealthResponse } from "../../src/health/health-server";

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
  private errorHandler: ((err: Error) => void) | null = null;

  on(event: string, handler: (n: number) => void | Promise<void>): void {
    if (event === "block") {
      this.blockHandler = handler;
    } else if (event === "error") {
      this.errorHandler = handler as unknown as (err: Error) => void;
    }
  }

  off(event: string, handler: (n: number) => void | Promise<void>): void {
    if (event === "block" && this.blockHandler === handler) {
      this.blockHandler = null;
    } else if (
      event === "error" &&
      this.errorHandler === (handler as unknown as (err: Error) => void)
    ) {
      this.errorHandler = null;
    }
  }

  /** Whether this provider is wired for block events. */
  hasBlockHandler(): boolean {
    return this.blockHandler !== null;
  }

  /** Drop the transport, which is what drives `reconnect()`. */
  emitError(err: Error): void {
    this.errorHandler?.(err);
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
    return mock as unknown as ethersTypes.WebSocketProvider;
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
    /**
     * The object `provider.send()` actually rejects with.
     *
     * Built through ethers' own `makeError`, which is what `JsonRpcProvider`
     * calls on the error path, rather than hand-assigning a numeric `.code`.
     * Under ethers 6 that field carries a *string* `ErrorCode` and the
     * upstream's numeric code is nested under `.error`, so the previous
     * `new Error(msg)` with `err.code = -32601` asserted a branch production
     * could never reach: `errorCode()` returned undefined for every real
     * error, and classification fell through to the message patterns alone.
     */
    function refusal(code: number, message: string): unknown {
      return ethers.makeError("could not coalesce error", "UNKNOWN_ERROR", {
        error: { code, message },
        payload: {
          id: 1,
          jsonrpc: "2.0",
          method: "debug_traceBlockByNumber",
          params: [],
        },
      });
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

    // The three below isolate the numeric JSON-RPC code from the message
    // patterns. Every earlier case in this block carries wording that one of
    // the regexes matches, so each would pass whether or not `errorCode()`
    // can reach the code at all - which is how the unreachable branch
    // survived a green suite.

    it("reads -32601 out of a real ethers error even when the message matches nothing", async () => {
      await manager.subscribeToTrace({
        chainId: CHAIN_ID,
        wssUrl: WSS_URL,
        contractAddress: WATCHED,
        handler: async () => undefined,
      });
      // Deliberately bland: no "does not exist", no plan vocabulary. The
      // only signal that this is permanent is the code, and under ethers 6
      // that code is nested under `.error` rather than on `.code`.
      created[0].traceFailure = refusal(-32601, "method not found");

      for (let i = 0; i < 4; i++) {
        await created[0].emitBlock(1000 + i);
        await vi.advanceTimersByTimeAsync(2000);
      }

      expect(callsTo(created[0], "debug_traceBlockByNumber")).toHaveLength(1);
    });

    it("lets a -32005 stay retryable even when its message reads as a capability verdict", async () => {
      await manager.subscribeToTrace({
        chainId: CHAIN_ID,
        wssUrl: WSS_URL,
        contractAddress: WATCHED,
        handler: async () => undefined,
      });
      // "disabled" is in TRACE_NOT_SUPPORTED, so on the message alone this
      // reads as permanent. The code says throttled, and the code wins,
      // because calling a throttle a permanent absence is the expensive
      // direction to be wrong in.
      created[0].traceFailure = refusal(
        -32005,
        "debug_traceBlockByNumber is temporarily disabled",
      );

      for (let i = 0; i < 3; i++) {
        await created[0].emitBlock(1000 + i);
        await vi.advanceTimersByTimeAsync(2000);
      }

      expect(
        callsTo(created[0], "debug_traceBlockByNumber").length,
      ).toBeGreaterThan(1);
    });

    it("stops asking BSC dataseed, which refuses without geth's wording", async () => {
      await manager.subscribeToTrace({
        chainId: CHAIN_ID,
        wssUrl: WSS_URL,
        contractAddress: WATCHED,
        handler: async () => undefined,
      });
      // Verbatim from the survey in
      // .planning/issue-2247-trace-upstream-survey.md. It carries neither
      // "does not exist" nor a plan word, and the only "block" in it is
      // inside the method name, so TRACE_BLOCK_UNAVAILABLE's word boundary
      // correctly declines it. Before "is not available" was a
      // not-supported alternative, this upstream was re-asked every block
      // forever.
      created[0].traceFailure = refusal(
        -32002,
        "the resource debug_traceBlockByNumber is not available",
      );

      for (let i = 0; i < 4; i++) {
        await created[0].emitBlock(1000 + i);
        await vi.advanceTimersByTimeAsync(2000);
      }

      expect(callsTo(created[0], "debug_traceBlockByNumber")).toHaveLength(1);
    });

    it("still treats a genuinely missing block as retryable now that 'is not available' is a verdict", async () => {
      await manager.subscribeToTrace({
        chainId: CHAIN_ID,
        wssUrl: WSS_URL,
        contractAddress: WATCHED,
        handler: async () => undefined,
      });
      // The counterpart to the case above: same two words, but a
      // word-boundary "block" in front of them, so the block check settles it
      // before the capability verdict is reachable.
      created[0].traceFailure = new Error("block 1000 is not available");

      for (let i = 0; i < 3; i++) {
        await created[0].emitBlock(1000 + i);
        await vi.advanceTimersByTimeAsync(2000);
      }

      expect(
        callsTo(created[0], "debug_traceBlockByNumber").length,
      ).toBeGreaterThan(1);
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

  it("surfaces the paused flag in health once a refusal is learned", async () => {
    await manager.subscribeToTrace({
      chainId: CHAIN_ID,
      wssUrl: WSS_URL,
      contractAddress: WATCHED,
      handler: async () => undefined,
    });

    const before = manager.getAllHealth().find((h) => h.chainId === CHAIN_ID);
    expect(before?.traceUnsupported).toBe(false);

    created[0].traceFailure = new Error(
      "the method debug_traceBlockByNumber does not exist",
    );
    await created[0].emitBlock(1000);
    await vi.advanceTimersByTimeAsync(2000);

    const after = manager.getAllHealth().find((h) => h.chainId === CHAIN_ID);
    // Without this a chain that has stopped trace matching reports
    // connected: true with N trace subscribers and nothing else to go on,
    // which reads as healthy.
    expect(after?.traceUnsupported).toBe(true);
    expect(after?.connected).toBe(true);
    expect(after?.traceSubscriberCount).toBe(1);
  });

  describe("the watched address is required, not optional", () => {
    /**
     * The vendored matcher reads a falsy `callee` as a wildcard.
     *
     * `frameMatches` skips the callee test when `filter.callee` is falsy, so an
     * empty `contractAddress` is not "matches nothing" but "every frame in
     * every block that passes the remaining filters", billed up to
     * TRACE_DISPATCH_CAP_PER_BLOCK executions per block per subscription. The
     * hand-rolled predicate this replaced compared the address
     * unconditionally and could not be widened that way, so the seam never had
     * to state the rule. It does now.
     */
    async function subscribeWith(contractAddress: string): Promise<void> {
      await manager.subscribeToTrace({
        chainId: CHAIN_ID,
        wssUrl: WSS_URL,
        contractAddress,
        handler: async () => undefined,
      });
    }

    it("refuses an empty contractAddress instead of matching every frame", async () => {
      await expect(subscribeWith("")).rejects.toThrow(
        /contractAddress is required/,
      );
    });

    it("refuses a whitespace-only contractAddress too", async () => {
      // `" "` is truthy, so it does not become a wildcard - it matches
      // nothing at all, for the life of the workflow, silently. Same class of
      // defect, opposite direction, so it is refused at the same boundary.
      await expect(subscribeWith("   ")).rejects.toThrow(
        /contractAddress is required/,
      );
    });

    it("registers no subscriber when it refuses", async () => {
      // A half-registered chain would keep the block listener and the
      // heartbeat alive with nothing to serve.
      await expect(subscribeWith("")).rejects.toThrow();
      expect(manager.traceSubscriberCount(CHAIN_ID)).toBe(0);
    });

    it("is the wildcard the matcher would otherwise apply", () => {
      // The premise, asserted directly rather than inferred. This is why the
      // check above has to exist: `frameMatches` does not treat an empty
      // callee as "matches nothing", it skips the callee test altogether, so
      // a frame into a completely unrelated contract passes. Nothing about
      // this is wrong in the matcher - an absent filter field is a wildcard
      // throughout it - which is exactly why the subscription boundary is
      // where the required field has to be enforced.
      const unrelatedFrame: FlatCall = {
        type: "CALL",
        from: OTHER.toLowerCase(),
        to: OTHER.toLowerCase(),
        value: "0x0",
        input: PAUSE_SELECTOR,
        depth: 0,
        reverted: false,
      };

      expect(frameMatches(unrelatedFrame, { callee: "" })).toBe(true);
      // And with the address actually set, the same frame is rejected. That
      // is the behaviour a subscription is asking for and the behaviour an
      // empty value silently loses.
      expect(frameMatches(unrelatedFrame, { callee: WATCHED })).toBe(false);
    });

    it("still accepts a real address", async () => {
      // Without this the four cases above pass against a method that refuses
      // everything.
      await subscribeWith(WATCHED);
      expect(manager.traceSubscriberCount(CHAIN_ID)).toBe(1);
    });
  });

  describe("an upstream that refuses the method after passing the gate", () => {
    it("does not report a fully green pod while trace matching is paused", async () => {
      // `recordTraceRefusal` pauses matching for the life of the connection:
      // one warn line, the range counted as served so the shared mark keeps
      // advancing, and no further asking. `allHealthy` was computed from
      // `connected` alone, so /healthz stayed 200 with no signal anywhere that
      // the trigger had stopped.
      await manager.subscribeToTrace({
        chainId: CHAIN_ID,
        wssUrl: WSS_URL,
        contractAddress: WATCHED,
        handler: async () => undefined,
      });

      // Healthy first, so the case cannot pass by always being degraded.
      expect(buildHealthResponse(manager).status).toBe(200);

      created[0].traceFailure = Object.assign(new Error("method not found"), {
        code: -32601,
      });
      await created[0].emitBlock(1000);
      await vi.advanceTimersByTimeAsync(2000);

      const health = buildHealthResponse(manager);
      expect(health.body.chains[0].traceUnsupported).toBe(true);
      expect(health.body.chains[0].connected).toBe(true);
      expect(health.status).toBe(503);
      expect(health.body.status).toBe("degraded");
    });

    it("leaves a chain with no trace subscribers alone", async () => {
      // The flag outlives the last unsubscribe. A chain with no trace work
      // left is not degraded by a capability it no longer needs, so the gate
      // is on the subscriber count as well as the flag.
      const unsubscribe = await manager.subscribeToTrace({
        chainId: CHAIN_ID,
        wssUrl: WSS_URL,
        contractAddress: WATCHED,
        handler: async () => undefined,
      });
      created[0].traceFailure = Object.assign(new Error("method not found"), {
        code: -32601,
      });
      await created[0].emitBlock(1000);
      await vi.advanceTimersByTimeAsync(2000);
      expect(buildHealthResponse(manager).status).toBe(503);

      unsubscribe();

      const health = buildHealthResponse(manager);
      expect(health.body.chains[0].traceUnsupported).toBe(true);
      expect(health.status).toBe(200);
    });
  });

  describe("revert propagation", () => {
    /** A watched-contract call nested inside an outer frame that reverted. */
    function revertedParentWithInnerCall() {
      return {
        type: "CALL",
        from: CALLER,
        to: OTHER,
        value: "0x0",
        input: "0xdeadbeef",
        error: "execution reverted",
        calls: [pauseCall()],
      };
    }

    it("marks a frame rolled back by an ancestor as reverted", async () => {
      // geth's callTracer sets `error` only on the frame that threw, never on
      // its descendants, even though the EVM rolls all of them back. Read
      // per-frame, the inner call reads as a success that never happened.
      const received = await runBlock(
        [{ txHash: "0xrollback", result: revertedParentWithInnerCall() }],
        { status: "any" },
      );

      expect(received).toHaveLength(1);
      expect(received[0].reverted).toBe(true);
    });

    it("does not fire a success-filtered trigger on a rolled-back call", async () => {
      // The default status is "success". Without ancestor propagation this
      // dispatched a workflow on a call with no on-chain effect.
      const received = await runBlock([
        { txHash: "0xrollback", result: revertedParentWithInnerCall() },
      ]);

      expect(received).toHaveLength(0);
    });

    it("finds a rolled-back call for a reverted-filtered trigger", async () => {
      // The other direction, and the one the trigger exists for: a drain
      // attempt that was rolled back by an ancestor is exactly what
      // status: "reverted" is asking to see, and per-frame `error` missed
      // every frame except the one that threw.
      const received = await runBlock(
        [{ txHash: "0xrollback", result: revertedParentWithInnerCall() }],
        { status: "reverted" },
      );

      expect(received).toHaveLength(1);
      expect(received[0].to).toBe(WATCHED);
    });

    it("leaves a sibling of a reverted frame alone", async () => {
      // Propagation is top-down only. A frame beside the one that threw was
      // not rolled back by it, so it must not inherit the flag.
      const received = await runBlock(
        [
          {
            txHash: "0xmixed",
            result: {
              type: "CALL",
              from: CALLER,
              to: OTHER,
              value: "0x0",
              input: "0xdeadbeef",
              calls: [
                { ...pauseCall(), error: "execution reverted" },
                pauseCall(),
              ],
            },
          },
        ],
        { status: "any" },
      );

      expect(received).toHaveLength(2);
      expect(received.map((f) => f.reverted)).toEqual([true, false]);
    });

    /**
     * An empty or null `error` reads as NOT reverted.
     *
     * This is a behaviour change from the hand-rolled predicate, which tested
     * `call.error !== undefined` and so read both shapes as reverted. The
     * vendored matcher tests `Boolean(node.error)`.
     *
     * The new direction is the safe one and these cases pin it. `error` is an
     * optional field, and an upstream that normalises absent fields to `""` or
     * `null` would, under the old rule, have marked every frame of every block
     * reverted - at which point the default `status: "success"` filter matches
     * nothing at all, for every subscription on that chain, with no error and
     * no log line. Requiring a non-empty error fails towards the trigger still
     * firing on the calls it was asked about.
     */
    describe("an error field that is present but empty", () => {
      it("reads an empty-string error as not reverted", async () => {
        const received = await runBlock([
          { txHash: "0xempty", result: { ...pauseCall(), error: "" } },
        ]);

        // Default status is "success", so a match here is the assertion that
        // the frame was not treated as reverted.
        expect(received).toHaveLength(1);
        expect(received[0].reverted).toBe(false);
      });

      it("reads a null error as not reverted", async () => {
        const received = await runBlock([
          { txHash: "0xnull", result: { ...pauseCall(), error: null } },
        ]);

        expect(received).toHaveLength(1);
        expect(received[0].reverted).toBe(false);
      });

      it("does not offer either shape to a reverted-filtered trigger", async () => {
        // The counterpart. If `""` or `null` were still reverting the frame,
        // a status: "reverted" subscription would fire on every ordinary call.
        const received = await runBlock(
          [
            { txHash: "0xempty", result: { ...pauseCall(), error: "" } },
            { txHash: "0xnull", result: { ...pauseCall(), error: null } },
          ],
          { status: "reverted" },
        );

        expect(received).toHaveLength(0);
      });

      it("still treats a non-empty error as reverted", async () => {
        // Without this the three cases above pass against a matcher that
        // never marks anything reverted.
        const received = await runBlock(
          [
            {
              txHash: "0xreal",
              result: { ...pauseCall(), error: "execution reverted" },
            },
          ],
          { status: "reverted" },
        );

        expect(received).toHaveLength(1);
        expect(received[0].reverted).toBe(true);
      });
    });
  });

  it("matches a callTypes filter against an upstream that lower-cases the type", async () => {
    // The comparison upper-cases only the subscriber side, and
    // lib/web3/trace-decode.ts normalises the frame. An upstream answering
    // "delegatecall" made the filter match nothing, silently.
    const received = await runBlock(
      [
        {
          txHash: "0xdelegate",
          result: { ...pauseCall(), type: "delegatecall" },
        },
      ],
      { callTypes: ["DELEGATECALL"] },
    );

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("DELEGATECALL");
  });

  describe("the shared high-water mark", () => {
    /** Subscribe a trace-only chain and establish the mark at `first - 1`. */
    async function primed(first = 1000): Promise<void> {
      await manager.subscribeToTrace({
        chainId: CHAIN_ID,
        wssUrl: WSS_URL,
        contractAddress: WATCHED,
        handler: async () => undefined,
      });
      await created[0].emitBlock(first);
      await vi.advanceTimersByTimeAsync(2000);
    }

    function tracedBlocks(provider: MockProvider): string[] {
      return callsTo(provider, "debug_traceBlockByNumber").map((c) =>
        String(c.params[0]),
      );
    }

    it("re-traces a block whose trace failed transiently", async () => {
      await primed();
      created[0].sendCalls.length = 0;
      // Retryable. The range stays owed, so the mark does not move past it and
      // the next drain asks for the same block again. Traces share the log
      // path's mark, so a result that is lost here is not re-owed anywhere
      // else.
      created[0].traceFailure = new Error("rate limit exceeded");

      await created[0].emitBlock(1001);
      await vi.advanceTimersByTimeAsync(5000);

      const asked = tracedBlocks(created[0]).filter(
        (hex) => Number(hex) === 0x3e9,
      );
      expect(asked.length).toBeGreaterThan(1);
    });

    it("stops owing a block once the refusal is permanent", async () => {
      await primed();
      created[0].sendCalls.length = 0;
      // A connection that will never answer must not pin the mark: the log
      // path would then be stalled behind a capability the chain does not
      // have. Served, so the mark advances, and the flag stops any further
      // asking until a reconnect clears it.
      created[0].traceFailure = new Error(
        "the method debug_traceBlockByNumber does not exist",
      );

      await created[0].emitBlock(1001);
      await vi.advanceTimersByTimeAsync(5000);

      expect(tracedBlocks(created[0])).toHaveLength(1);
      const health = manager.getAllHealth().find((h) => h.chainId === CHAIN_ID);
      expect(health?.blocksBehindHead).toBe(0);
      expect(health?.traceUnsupported).toBe(true);
    });

    it("bounds one drain's traced span below the log span", async () => {
      await primed();
      created[0].sendCalls.length = 0;

      // 100 blocks behind in one jump. The log path would take
      // GETLOGS_MAX_BLOCK_SPAN (25) in a single ranged eth_getLogs, which
      // costs one request. Tracing that range costs 25 sequential
      // debug_traceBlockByNumber calls against one WSS connection, and the
      // survey measures those responses at 62 kB to 1.91 MB each.
      await created[0].emitBlock(1100);
      await vi.advanceTimersByTimeAsync(500);

      const traced = tracedBlocks(created[0]);
      expect(traced).toHaveLength(TRACE_MAX_BLOCK_SPAN);
      // Contiguous from the mark, so nothing inside the span is skipped.
      expect(traced[0]).toBe("0x3e9");
      expect(traced.at(-1)).toBe(
        `0x${(1000 + TRACE_MAX_BLOCK_SPAN).toString(16)}`,
      );
      // The remainder is not lost, only deferred: the mark sits at the end of
      // the traced span, not at the head.
      const health = manager.getAllHealth().find((h) => h.chainId === CHAIN_ID);
      expect(health?.blocksBehindHead).toBe(
        1100 - (1000 + TRACE_MAX_BLOCK_SPAN),
      );
    });
  });

  describe("reconnect on a trace-carrying chain", () => {
    it("re-attaches the block listener for a trace-only chain", async () => {
      await manager.subscribeToTrace({
        chainId: CHAIN_ID,
        wssUrl: WSS_URL,
        contractAddress: WATCHED,
        handler: async () => undefined,
      });
      expect(created).toHaveLength(1);

      created[0].emitError(new Error("wss dropped"));
      await vi.advanceTimersByTimeAsync(1_500);

      expect(created).toHaveLength(2);
      // The guard used to test the log-subscriber set alone. A trace-only
      // chain therefore came back from any reconnect with no block listener,
      // so no drain ever ran on it again and trace matching stopped
      // permanently, with the subscription still present and reporting
      // healthy. This is reachable without the staleness watchdog:
      // triggerReconnect is called from the provider error listener and from
      // the heartbeat as well.
      expect(created[1].hasBlockHandler()).toBe(true);
      expect(manager.traceSubscriberCount(CHAIN_ID)).toBe(1);
    });

    it("still matches traces after the reconnect", async () => {
      // The listener being attached is the mechanism; this is the behaviour
      // that mechanism exists for, asserted end to end rather than inferred.
      const received: TraceCallFrame[] = [];
      await manager.subscribeToTrace({
        chainId: CHAIN_ID,
        wssUrl: WSS_URL,
        contractAddress: WATCHED,
        handler: async (matches) => {
          received.push(...matches);
        },
      });

      created[0].emitError(new Error("wss dropped"));
      await vi.advanceTimersByTimeAsync(1_500);

      created[1].traceResponses.push([
        { txHash: "0xafter", result: pauseCall() },
      ]);
      await created[1].emitBlock(2000);
      await vi.advanceTimersByTimeAsync(2000);

      expect(received).toHaveLength(1);
      expect(received[0].transactionHash).toBe("0xafter");
    });

    it("clears the learned refusal so the replacement re-learns", async () => {
      await manager.subscribeToTrace({
        chainId: CHAIN_ID,
        wssUrl: WSS_URL,
        contractAddress: WATCHED,
        handler: async () => undefined,
      });
      created[0].traceFailure = new Error(
        "the method debug_traceBlockByNumber does not exist",
      );
      await created[0].emitBlock(1000);
      await vi.advanceTimersByTimeAsync(2000);
      expect(
        manager.getAllHealth().find((h) => h.chainId === CHAIN_ID)
          ?.traceUnsupported,
      ).toBe(true);

      created[0].emitError(new Error("wss dropped"));
      await vi.advanceTimersByTimeAsync(1_500);

      // Failover can land on a different upstream, so a verdict learned from
      // the connection being replaced must not be inherited by the
      // replacement.
      expect(
        manager.getAllHealth().find((h) => h.chainId === CHAIN_ID)
          ?.traceUnsupported,
      ).toBe(false);
    });
  });

  describe("the vendored matcher's guards, which the local copy had lost", () => {
    it("does not let a CREATE frame satisfy a selector filter", async () => {
      // A CREATE frame carries init code in `input`. Its first four bytes are
      // constructor bytecode, not a function selector. The local copy read
      // them as one, so a subscription with a selector and no `callTypes`
      // fired on a contract deployment whose init code happened to start with
      // those bytes.
      const received = await runBlock(
        [
          {
            txHash: "0xdeploy",
            result: {
              type: "CREATE",
              from: CALLER,
              to: WATCHED,
              value: "0x0",
              input: `${PAUSE_SELECTOR}60806040523480`,
            },
          },
        ],
        { selector: PAUSE_SELECTOR },
      );

      expect(received).toEqual([]);
    });

    it("reports no selector on a CREATE frame it does dispatch", async () => {
      // The guard is on the frame, not only on the filter, so the dispatched
      // payload does not advertise constructor bytecode as a selector either.
      const received = await runBlock([
        {
          txHash: "0xdeploy",
          result: {
            type: "CREATE",
            from: CALLER,
            to: WATCHED,
            value: "0x0",
            input: `${PAUSE_SELECTOR}60806040523480`,
          },
        },
      ]);

      expect(received).toHaveLength(1);
      expect(received[0].selector).toBe("0x");
    });

    it("keeps a frame whose value cannot be priced rather than dropping it", async () => {
      // "0x" is what some upstreams return for a zero-value frame and BigInt
      // refuses it. The local copy answered `catch { return false }`, so a
      // frame a value filter cannot price failed the threshold silently. On a
      // security trigger that is the unsafe direction: the frame nothing can
      // price is the one worth looking at.
      const received = await runBlock(
        [{ txHash: "0xodd", result: { ...pauseCall(), value: "0x" } }],
        { minValueWei: "1000000000000000000" },
      );

      expect(received).toHaveLength(1);
      expect(received[0].value).toBe("0x");
    });

    it("still applies the threshold to a value it can price", async () => {
      // The control on the case above: keeping unpriceable frames must not
      // turn the filter off for the frames it can read.
      const received = await runBlock(
        [
          { txHash: "0xsmall", result: { ...pauseCall(), value: "0x1" } },
          {
            txHash: "0xbig",
            result: { ...pauseCall(), value: "0xde0b6b3a7640000" },
          },
        ],
        { minValueWei: "1000000000000000000" },
      );

      expect(received).toHaveLength(1);
      expect(received[0].transactionHash).toBe("0xbig");
    });
  });

  describe("the watchdog and the catch-up on a trace-only chain", () => {
    /** A manager with a short staleness ceiling. Destroyed by the caller. */
    function staleManager(timeoutMs: number): {
      mgr: ChainProviderManager;
      made: MockProvider[];
    } {
      const f = makeFactory();
      const mgr = new ChainProviderManager({
        factory: f.factory,
        onPermanentFailure: () => undefined,
        blockStalenessTimeoutMs: timeoutMs,
      });
      return { mgr, made: f.created };
    }

    it("reconnects a trace-only chain that answers the ping but stops delivering blocks", async () => {
      const { mgr, made } = staleManager(60_000);
      await mgr.subscribeToTrace({
        chainId: CHAIN_ID,
        wssUrl: WSS_URL,
        contractAddress: WATCHED,
        handler: async () => undefined,
      });
      const reasons: string[] = [];
      mgr.onDisconnect(CHAIN_ID, (ev) => {
        reasons.push(ev.reason);
      });

      // One block, then silence while eth_blockNumber keeps answering. The
      // watchdog tested the log set alone, so on a trace-only chain it
      // returned immediately and this connection was never replaced: the
      // subscription kept reporting healthy while matching nothing.
      await made[0].emitBlock(1000);
      await vi.advanceTimersByTimeAsync(92_100);

      expect(reasons).toContain("block_staleness");
      expect(made.length).toBeGreaterThanOrEqual(2);
      await mgr.destroy();
    });

    it("leaves a provider with no subscriber of any kind alone", async () => {
      const { mgr, made } = staleManager(60_000);
      await mgr.getOrCreateProvider(CHAIN_ID, WSS_URL);
      const reasons: string[] = [];
      mgr.onDisconnect(CHAIN_ID, (ev) => {
        reasons.push(ev.reason);
      });

      await vi.advanceTimersByTimeAsync(120_000);

      expect(reasons).toEqual([]);
      expect(made).toHaveLength(1);
      await mgr.destroy();
    });

    it("drains the range owed from an outage without waiting for the next block", async () => {
      await manager.subscribeToTrace({
        chainId: CHAIN_ID,
        wssUrl: WSS_URL,
        contractAddress: WATCHED,
        handler: async () => undefined,
      });

      // Block 1000 serves and takes the rate-limit slot. 1001 to 1005 then
      // arrive inside GETLOGS_MIN_INTERVAL_MS, so that drain arms the catch-up
      // and returns with the mark still at 1000.
      await created[0].emitBlock(1000);
      await created[0].emitBlock(1005);
      created[0].sendCalls.length = 0;

      // The reconnect disarms that timer on purpose. Re-arming it is
      // `reconnectLoop`'s job, and it tested the log set alone, so a
      // trace-only chain sat on the owed range until the next block.
      created[0].emitError(new Error("wss dropped"));
      await vi.advanceTimersByTimeAsync(5_000);

      expect(created).toHaveLength(2);
      // No block was emitted on the replacement.
      const traced = callsTo(created[1], "debug_traceBlockByNumber").map((c) =>
        String(c.params[0]),
      );
      expect(traced).toEqual(["0x3e9", "0x3ea", "0x3eb", "0x3ec", "0x3ed"]);
      const health = manager.getAllHealth().find((h) => h.chainId === CHAIN_ID);
      expect(health?.blocksBehindHead).toBe(0);
    });
  });

  it("caps dispatch per block, not per transaction", async () => {
    // Twenty transactions, each with two matching frames: 40 matches for one
    // subscription in one block. The cap used to sit inside the per-
    // transaction loop, so this dispatched all 40 - a block with 200 matching
    // transactions would have dispatched up to 5,000, each taking a pacer
    // token and a phantom-create round trip.
    const traces = Array.from({ length: 20 }, (_unused, i) => ({
      txHash: `0xtx${i}`,
      result: { ...pauseCall(OTHER), calls: [pauseCall(), pauseCall()] },
    }));

    const received = await runBlock(traces);

    expect(received).toHaveLength(25);
    const capWarnings = warn.mock.calls.filter((c) =>
      String(c[0]).includes("capping trace"),
    );
    // One warn for the block, naming the real total, rather than one per
    // transaction or none at all.
    expect(capWarnings).toHaveLength(1);
    expect(String(capWarnings[0][0])).toContain("from 40 to 25");
  });
});
