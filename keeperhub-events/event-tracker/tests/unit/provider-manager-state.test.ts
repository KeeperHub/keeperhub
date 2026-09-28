import { ethers } from "ethers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../lib/utils/logger";
import {
  MULTICALL3_ADDRESS,
  STATE_CALL_MAX_BATCH,
} from "../../src/chains/multicall3";
import {
  ChainProviderManager,
  GETLOGS_MIN_INTERVAL_MS,
  type ProviderFactory,
} from "../../src/chains/provider-manager";

/**
 * State sampling on the shared block subscription (issue #2240). Covers the
 * two paths the reviewer asked to see exercised - the batch, and the chain
 * that cannot batch - plus the chunk ceiling that keeps one oversized
 * `eth_call` from failing every subscription on a chain at once.
 */

const CHAIN_ID = 31_337;
const WSS_URL = "ws://localhost:8546";
const CONTRACT = "0x1111111111111111111111111111111111111111";
const CALLDATA = "0xdeadbeef";

const coder = ethers.AbiCoder.defaultAbiCoder();
const aggregate3Interface = new ethers.Interface([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);

interface SendCall {
  method: string;
  params: unknown[];
}

class MockProvider {
  public sendCalls: SendCall[] = [];
  /** Empty bytecode at the Multicall3 address - the not-deployed case. */
  public multicall3Code = "0x60806040";
  /** When set, the next `eth_call` to Multicall3 rejects. */
  public aggregate3Failures = 0;
  public getCodeFailure: Error | null = null;
  public ethCallResult: string | null = null;
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
    if (method === "eth_getCode") {
      if (this.getCodeFailure) {
        throw this.getCodeFailure;
      }
      return this.multicall3Code;
    }
    if (method === "eth_call") {
      const target = (params[0] as { to: string }).to;
      if (target.toLowerCase() === MULTICALL3_ADDRESS.toLowerCase()) {
        if (this.aggregate3Failures > 0) {
          this.aggregate3Failures -= 1;
          throw new Error("execution reverted: out of gas");
        }
        const data = (params[0] as { data: string }).data;
        const [calls] = aggregate3Interface.decodeFunctionData(
          "aggregate3",
          data,
        );
        const slots = (calls as unknown[]).map(() => [
          true,
          coder.encode(["uint256"], [7n]),
        ]);
        return aggregate3Interface.encodeFunctionResult("aggregate3", [slots]);
      }
      return this.ethCallResult ?? coder.encode(["uint256"], [7n]);
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

function ethCalls(provider: MockProvider): SendCall[] {
  return provider.sendCalls.filter((call) => call.method === "eth_call");
}

function aggregate3Batches(provider: MockProvider): number[] {
  return ethCalls(provider)
    .filter(
      (call) =>
        (call.params[0] as { to: string }).to.toLowerCase() ===
        MULTICALL3_ADDRESS.toLowerCase(),
    )
    .map((call) => {
      const [calls] = aggregate3Interface.decodeFunctionData(
        "aggregate3",
        (call.params[0] as { data: string }).data,
      );
      return (calls as unknown[]).length;
    });
}

describe("ChainProviderManager state sampling", () => {
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

  async function subscribeState(
    count: number,
    onSample?: (value: string, block: number) => void,
  ): Promise<MockProvider> {
    for (let i = 0; i < count; i += 1) {
      await manager.subscribeToState({
        chainId: CHAIN_ID,
        wssUrl: WSS_URL,
        contractAddress: CONTRACT,
        callData: `${CALLDATA}${i.toString(16).padStart(2, "0")}`,
        handler: (result, blockNumber) => {
          onSample?.(result.returnData, blockNumber);
        },
      });
    }
    return created[0];
  }

  it("batches every subscription on a chain into one aggregate3 per drain", async () => {
    const samples: number[] = [];
    const provider = await subscribeState(5, (_v, block) => {
      samples.push(block);
    });

    await provider.emitBlock(100);

    expect(aggregate3Batches(provider)).toEqual([5]);
    expect(samples).toEqual([100, 100, 100, 100, 100]);
    // One additional RPC call for the chain, not one per subscription.
    expect(ethCalls(provider)).toHaveLength(1);
  });

  it("probes Multicall3 once and pins the block tag to the sampled height", async () => {
    const provider = await subscribeState(2);

    await provider.emitBlock(0x100);
    await vi.advanceTimersByTimeAsync(GETLOGS_MIN_INTERVAL_MS);
    await provider.emitBlock(0x101);

    const codeCalls = provider.sendCalls.filter(
      (call) => call.method === "eth_getCode",
    );
    expect(codeCalls).toHaveLength(1);
    expect(codeCalls[0].params[0]).toBe(MULTICALL3_ADDRESS);

    // The block tag is the head, not "latest": the observation is attributed
    // to the height it was read at.
    const tags = ethCalls(provider).map((call) => call.params[1]);
    expect(tags).toEqual(["0x100", "0x101"]);
  });

  it("falls back to one call per subscription where Multicall3 is absent", async () => {
    const samples: number[] = [];
    const provider = await subscribeState(3, (_v, block) => {
      samples.push(block);
    });
    provider.multicall3Code = "0x";

    await provider.emitBlock(100);

    expect(aggregate3Batches(provider)).toEqual([]);
    expect(ethCalls(provider)).toHaveLength(3);
    for (const call of ethCalls(provider)) {
      expect((call.params[0] as { to: string }).to).toBe(CONTRACT);
    }
    // Degrading is logged rather than silent: a batching design that quietly
    // becomes an N-call design is worse than one that says so.
    expect(
      warn.mock.calls.some((args) => String(args[0]).includes("no Multicall3")),
    ).toBe(true);
    expect(samples).toHaveLength(3);
  });

  it("re-probes after a probe error rather than pinning to the fallback", async () => {
    const provider = await subscribeState(2);
    provider.getCodeFailure = new Error("upstream 502");

    await provider.emitBlock(100);
    // Probe failed, so this drain sampled one call per subscription.
    expect(ethCalls(provider)).toHaveLength(2);

    provider.getCodeFailure = null;
    await vi.advanceTimersByTimeAsync(GETLOGS_MIN_INTERVAL_MS);
    await provider.emitBlock(101);

    expect(
      provider.sendCalls.filter((call) => call.method === "eth_getCode"),
    ).toHaveLength(2);
    expect(aggregate3Batches(provider)).toEqual([2]);
  });

  it("chunks above the batch ceiling so one oversized call cannot fail the chain", async () => {
    const count = STATE_CALL_MAX_BATCH * 2 + 7;
    const samples: string[] = [];
    const provider = await subscribeState(count, (value) => {
      samples.push(value);
    });

    await provider.emitBlock(100);

    expect(aggregate3Batches(provider)).toEqual([
      STATE_CALL_MAX_BATCH,
      STATE_CALL_MAX_BATCH,
      7,
    ]);
    expect(samples).toHaveLength(count);
  });

  it("costs a failed chunk its own subscriptions and no others", async () => {
    const count = STATE_CALL_MAX_BATCH + 4;
    const sampled: number[] = [];
    const provider = await subscribeState(count, (_v, block) => {
      sampled.push(block);
    });
    // Only the first chunk fails.
    provider.aggregate3Failures = 1;

    await provider.emitBlock(100);

    expect(aggregate3Batches(provider)).toEqual([STATE_CALL_MAX_BATCH, 4]);
    expect(sampled).toHaveLength(4);
  });

  it("advances the high-water mark on a chain with no log subscribers", async () => {
    // Without this the mark never moves, the catch-up timer is armed on a gap
    // nothing will close, and the drain spins at the rate limit forever.
    const provider = await subscribeState(1);

    await provider.emitBlock(100);
    await vi.advanceTimersByTimeAsync(GETLOGS_MIN_INTERVAL_MS * 3);

    expect(
      provider.sendCalls.filter((call) => call.method === "eth_getLogs"),
    ).toHaveLength(0);
    expect(manager.getHealth(CHAIN_ID)?.blocksBehindHead).toBe(0);
    expect(ethCalls(provider)).toHaveLength(1);
  });

  it("keeps the block subscription while either kind of subscriber remains", async () => {
    const unsubState = await manager.subscribeToState({
      chainId: CHAIN_ID,
      wssUrl: WSS_URL,
      contractAddress: CONTRACT,
      callData: CALLDATA,
      handler: () => undefined,
    });
    const unsubLogs = await manager.subscribeToLogs({
      chainId: CHAIN_ID,
      wssUrl: WSS_URL,
      address: CONTRACT,
      topic0: `0x${"11".repeat(32)}`,
      handler: () => undefined,
    });
    expect(manager.stateSubscriberCount(CHAIN_ID)).toBe(1);
    expect(manager.subscriberCount(CHAIN_ID)).toBe(1);

    const provider = created[0];
    unsubState();
    await provider.emitBlock(100);
    // The log subscriber alone keeps the block listener attached.
    expect(
      provider.sendCalls.filter((call) => call.method === "eth_getLogs").length,
    ).toBeGreaterThan(0);

    unsubLogs();
    const before = provider.sendCalls.length;
    await provider.emitBlock(101);
    expect(provider.sendCalls).toHaveLength(before);
  });
});
