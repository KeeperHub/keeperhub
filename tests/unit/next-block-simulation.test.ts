import { ethers } from "ethers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { RpcProviderManager } from "@/lib/rpc/providers";
import { isNonRetryableError } from "@/lib/rpc/providers/error-classification";
import { formatContractError } from "@/lib/web3/decode-revert-error";
import {
  clearSlotSecondsCache,
  failedNextBlockCheck,
  getNextBlockSimulation,
  isNextBlockSimulationUnsupported,
  NextBlockSimulationUnsupportedError,
  nextBlockFailure,
  nextSlotTime,
  readSimulationSettings,
  simulateCallAtNextBlock,
  simulateSendAtNextBlock,
  tagNextBlockSimulation,
} from "@/lib/web3/next-block-simulation";

// A contract that reverts with "too-soon" until block.timestamp >= unlockAt.
const IFACE = new ethers.Interface([
  "function run()",
  "function workable() view returns (bool)",
]);
const CONTRACT = "0x00000000000000000000000000000000000c0de1";
const WALLET = "0x00000000000000000000000000000000000a11ce";
const CHAIN_ID = 31_337;
const SLOT = 12;
const RUN_GAS = 46_097;
const NOOP_GAS = 21_000;
const SIMULATED_GAS = 30_000;
const coder = ethers.AbiCoder.defaultAbiCoder();
// Error("too-soon")
const TOO_SOON = `0x08c379a0${coder.encode(["string"], ["too-soon"]).slice(2)}`;
// The proof's init code: 0x42 0x67 <8-byte time> ...
const PROOF_PREFIX = "0x4267";

type RpcError = { code: number; message: string; data?: string };
type JsonRpcAnswer = { result: unknown } | { error: RpcError };
type Tx = { to?: string; data: string };
type Overrides = { number: string; time: string } | undefined;
type Support = "supported" | "rejected" | "ignored";
type Outcome = { result: string; gas: number } | { error: RpcError };

const HEADER_NOT_FOUND: RpcError = {
  code: -32_000,
  message: "header not found",
};

class FakeNode {
  latestNumber = 100;
  latestTimestamp = 1_000_000;
  unlockAt = 1_000_000;
  timestampOf = (n: number): number =>
    this.latestTimestamp - (this.latestNumber - n) * SLOT;
  callOverrides: Support = "supported";
  estimateOverrides: Support = "supported";
  simulateV1: Support | "missing" = "supported";
  // Before the unlock, run() is a cheap no-op instead of a revert.
  noopWhenLocked = false;
  // run() uses up all the gas left in a simulated block.
  burnsGas = false;
  // Block numbers this node does not return (a lagging backend).
  missing = new Set<number>();
  // Errors the node answers for the real call or the proof of a method.
  realCallError: { method: string; error: RpcError } | undefined;
  proofError: { method: string; error: RpcError } | undefined;
  seen: { method: string; blockTag: unknown; overrides: Overrides }[] = [];
  methods: string[] = [];

  handle(method: string, params: unknown[]): JsonRpcAnswer {
    this.methods.push(method);
    switch (method) {
      case "eth_getBlockByNumber":
        return { result: this.block(params[0] as string) };
      case "eth_call":
      case "eth_estimateGas":
        return this.single(method, params);
      case "eth_simulateV1":
        return this.simulate(params);
      default:
        return { error: { code: -32_601, message: `${method} not found` } };
    }
  }

  private block(tag: string): Record<string, unknown> | null {
    const n = tag === "latest" ? this.latestNumber : Number(BigInt(tag));
    if (this.missing.has(n)) {
      return null;
    }
    const timestamp =
      n === this.latestNumber ? this.latestTimestamp : this.timestampOf(n);
    return {
      hash: ethers.zeroPadValue(ethers.toBeHex(n + 1), 32),
      parentHash: ethers.zeroPadValue(ethers.toBeHex(n), 32),
      number: ethers.toQuantity(n),
      timestamp: ethers.toQuantity(timestamp),
      nonce: "0x0000000000000000",
      difficulty: "0x0",
      gasLimit: "0x1c9c380",
      gasUsed: "0x0",
      miner: ethers.ZeroAddress,
      extraData: "0x",
      baseFeePerGas: "0x3b9aca00",
      transactions: [],
    };
  }

  private timeFor(mode: Support, overrides: Overrides): number {
    return mode === "supported" && overrides
      ? Number(BigInt(overrides.time))
      : this.latestTimestamp;
  }

  // Runs the proof's init code as the EVM would: success when TIMESTAMP is
  // the embedded time, else a revert carrying TIMESTAMP.
  private evaluate(tx: Tx, time: number): Outcome {
    if (tx.to === undefined) {
      const embedded = Number(BigInt(`0x${tx.data.slice(6, 22)}`));
      // Pins the init code byte for byte; this fake runs its semantics.
      expect(tx.data).toBe(
        `${PROOF_PREFIX}${embedded.toString(16).padStart(16, "0")}146017574260005260206000fd5b00`
      );
      return embedded === time
        ? { result: "0x", gas: 53_000 }
        : {
            error: {
              code: 3,
              message: "execution reverted",
              data: coder.encode(["uint256"], [time]),
            },
          };
    }
    const unlocked = time >= this.unlockAt;
    if (tx.data === IFACE.encodeFunctionData("workable")) {
      return { result: coder.encode(["bool"], [unlocked]), gas: NOOP_GAS };
    }
    if (unlocked) {
      return { result: "0x", gas: RUN_GAS };
    }
    if (this.noopWhenLocked) {
      return { result: "0x", gas: NOOP_GAS };
    }
    return {
      error: {
        code: 3,
        message: "execution reverted: too-soon",
        data: TOO_SOON,
      },
    };
  }

  private single(method: string, params: unknown[]): JsonRpcAnswer {
    const mode =
      method === "eth_call" ? this.callOverrides : this.estimateOverrides;
    if (params.length > 3 && mode === "rejected") {
      return {
        error: { code: -32_602, message: "too many arguments, want at most 3" },
      };
    }
    const tx = params[0] as Tx;
    const injected = tx.to === undefined ? this.proofError : this.realCallError;
    if (injected?.method === method) {
      return { error: injected.error };
    }
    this.seen.push({
      method,
      blockTag: params[1],
      overrides: params[3] as Overrides,
    });
    const outcome = this.evaluate(
      tx,
      this.timeFor(mode, params[3] as Overrides)
    );
    if ("error" in outcome) {
      return outcome;
    }
    return method === "eth_call"
      ? { result: outcome.result }
      : { result: ethers.toQuantity(outcome.gas) };
  }

  // Like geth: a failed call carries its revert data in error.data and an
  // empty returnData.
  private simulate(params: unknown[]): JsonRpcAnswer {
    if (this.simulateV1 === "missing" || this.simulateV1 === "rejected") {
      return {
        error: {
          code: -32_601,
          message: "the method eth_simulateV1 does not exist/is not available",
        },
      };
    }
    if (this.realCallError?.method === "eth_simulateV1") {
      return { error: this.realCallError.error };
    }
    const [{ blockStateCalls }, blockTag] = params as [
      { blockStateCalls: { blockOverrides: Overrides; calls: Tx[] }[] },
      unknown,
    ];
    const [{ blockOverrides, calls }] = blockStateCalls;
    this.seen.push({
      method: "eth_simulateV1",
      blockTag,
      overrides: blockOverrides,
    });
    const time = this.timeFor(this.simulateV1, blockOverrides);
    let gasLeft = true;
    return {
      result: [
        {
          calls: calls.map((call) => {
            const burns = this.burnsGas && call.to === CONTRACT;
            const outcome: Outcome =
              gasLeft && !burns
                ? this.evaluate(call, time)
                : { error: { code: -32_015, message: "out of gas" } };
            if (burns) {
              gasLeft = false;
            }
            if ("result" in outcome) {
              return {
                status: "0x1",
                gasUsed: ethers.toQuantity(SIMULATED_GAS),
                returnData: outcome.result,
                logs: [],
              };
            }
            return {
              status: "0x0",
              gasUsed: ethers.toQuantity(SIMULATED_GAS),
              returnData: "0x",
              error: outcome.error,
              logs: [],
            };
          }),
        },
      ],
    };
  }
}

class FakeProvider extends ethers.JsonRpcProvider {
  private readonly node: FakeNode;

  constructor(node: FakeNode, url = "http://fake.invalid") {
    super(url, CHAIN_ID, { staticNetwork: true, batchMaxCount: 1 });
    this.node = node;
  }

  override _send(
    payload: ethers.JsonRpcPayload | ethers.JsonRpcPayload[]
  ): Promise<ethers.JsonRpcResult[]> {
    const list = Array.isArray(payload) ? payload : [payload];
    return Promise.resolve(
      list.map(
        (p) =>
          ({
            id: p.id,
            jsonrpc: "2.0",
            ...this.node.handle(p.method, p.params as unknown[]),
          }) as unknown as ethers.JsonRpcResult
      )
    );
  }
}

function managerFor(provider: ethers.JsonRpcProvider): RpcProviderManager {
  return {
    executeWithFailover: <T>(
      operation: (p: ethers.JsonRpcProvider) => Promise<T>
    ): Promise<T> => operation(provider),
  } as unknown as RpcProviderManager;
}

function httpError(status: number, body?: string): Error {
  return ethers.makeError(`server response ${status}`, "SERVER_ERROR", {
    request: new ethers.FetchRequest("https://relay.invalid/key123"),
    response: new ethers.FetchResponse(
      status,
      "status",
      {},
      body === undefined ? null : ethers.toUtf8Bytes(body)
    ),
  });
}

// Flashbots Protect's answer to a method it does not allow.
const NOT_WHITELISTED_BODY =
  '{"jsonrpc":"2.0","error":{"code":-32601,"message":"rpc method is not whitelisted"},"id":1}';

const RUN_TX = {
  from: WALLET,
  to: CONTRACT,
  data: IFACE.encodeFunctionData("run"),
};
const WORKABLE_TX = {
  to: CONTRACT,
  data: IFACE.encodeFunctionData("workable"),
};
const PADDED_SIMULATED_GAS = BigInt(Math.floor((SIMULATED_GAS * 80) / 63));

describe("readSimulationSettings", () => {
  it("keeps today's behaviour when unset or latest", () => {
    for (const value of [undefined, null, "", "latest", " Latest "]) {
      expect(readSimulationSettings(value, "5")).toEqual({
        ok: true,
        options: undefined,
      });
    }
  });

  it("reads next-block with an automatic or explicit offset", () => {
    expect(readSimulationSettings("next-block", undefined)).toEqual({
      ok: true,
      options: {},
    });
    expect(readSimulationSettings(" Next-Block ", "")).toEqual({
      ok: true,
      options: {},
    });
    expect(readSimulationSettings("next-block", 6)).toEqual({
      ok: true,
      options: { timestampOffsetSec: 6 },
    });
    expect(readSimulationSettings("next-block", " 60 ")).toEqual({
      ok: true,
      options: { timestampOffsetSec: 60 },
    });
  });

  it("refuses unknown modes and offsets outside 1..60 as user errors naming the field", () => {
    expect(readSimulationSettings("pending", undefined)).toEqual({
      ok: false,
      failure: {
        success: false,
        error:
          'Invalid Simulate at "pending": expected "latest" or "next-block"',
        errorClass: "user",
      },
    });
    for (const offset of ["0", "-1", "1.5", "61", "abc", "1e1"]) {
      expect(readSimulationSettings("next-block", offset)).toMatchObject({
        ok: false,
        failure: {
          error: expect.stringContaining("Invalid Next block timestamp offset"),
        },
      });
    }
  });
});

describe("next-block simulation", () => {
  let node: FakeNode;
  let provider: FakeProvider;

  function send(): ReturnType<typeof simulateSendAtNextBlock> {
    return simulateSendAtNextBlock(managerFor(provider), {
      chainId: CHAIN_ID,
      tx: RUN_TX,
      options: { timestampOffsetSec: SLOT },
    });
  }

  function read(
    options: { timestampOffsetSec?: number } = {}
  ): ReturnType<typeof simulateCallAtNextBlock> {
    return simulateCallAtNextBlock(managerFor(provider), {
      chainId: CHAIN_ID,
      tx: WORKABLE_TX,
      options,
    });
  }

  // The slot clock reads the wall clock: one second into the slot after the
  // latest block unless a test moves it.
  function setClock(seconds: number): void {
    vi.spyOn(Date, "now").mockReturnValue(seconds * 1000);
  }

  beforeEach(() => {
    clearSlotSecondsCache();
    node = new FakeNode();
    provider = new FakeProvider(node);
    setClock(node.latestTimestamp + 1);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("a send", () => {
    it("passes one block before the unlock with eth_estimateGas alone, where latest reverts", async () => {
      node.unlockAt = node.latestTimestamp + 5;
      await expect(provider.estimateGas(RUN_TX)).rejects.toMatchObject({
        code: "CALL_EXCEPTION",
      });

      const result = await send();

      expect(result.gasEstimate).toBe(BigInt(RUN_GAS));
      expect(result.simulation).toEqual({
        mode: "next-block",
        baseBlock: 100,
        assumedBlockNumber: 101,
        assumedTimestamp: node.latestTimestamp + SLOT,
        timestampOffsetSec: SLOT,
        rpcMethod: "eth_estimateGas+blockOverrides",
      });
      // Works on relays that refuse eth_call and eth_simulateV1.
      expect(node.methods).not.toContain("eth_call");
      expect(node.methods).not.toContain("eth_simulateV1");
    });

    it("pins every call to the base block and overrides number to base + 1", async () => {
      node.unlockAt = node.latestTimestamp + 5;
      node.estimateOverrides = "rejected";

      await send();
      await read({ timestampOffsetSec: SLOT });

      expect(node.seen.length).toBeGreaterThan(0);
      for (const call of node.seen) {
        expect(call.blockTag).toBe(ethers.toQuantity(100));
        expect(call.overrides).toEqual({
          number: ethers.toQuantity(101),
          time: ethers.toQuantity(node.latestTimestamp + SLOT),
        });
      }
    });

    it.each(["rejected", "ignored"] as const)(
      "falls back to padded eth_simulateV1 gas when eth_estimateGas has %s the overrides",
      async (mode) => {
        // At latest run() is a cheap no-op: that estimate must not be used.
        node.unlockAt = node.latestTimestamp + 5;
        node.noopWhenLocked = true;
        node.estimateOverrides = mode;

        const result = await send();
        expect(result.gasEstimate).toBe(PADDED_SIMULATED_GAS);
        expect(result.simulation.rpcMethod).toBe("eth_simulateV1");
      }
    );

    it("fails as unsupported, not as a revert, when neither method takes overrides", async () => {
      node.unlockAt = node.latestTimestamp + 5;
      node.estimateOverrides = "ignored";
      node.simulateV1 = "missing";

      const error = await send().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(NextBlockSimulationUnsupportedError);
      expect((error as Error).message).toContain("eth_estimateGas");
      expect(getNextBlockSimulation(error)).toBeUndefined();
      expect(isNonRetryableError(error)).toBe(true);
    });

    it.each([
      ["eth_estimateGas+blockOverrides", "supported"],
      ["eth_simulateV1", "rejected"],
    ] as const)(
      "still reverts two blocks early (%s), keeping the revert reason",
      async (method, estimateOverrides) => {
        node.unlockAt = node.latestTimestamp + 30;
        node.estimateOverrides = estimateOverrides;

        const error = await send().catch((e: unknown) => e);

        expect(error).toMatchObject({ code: "CALL_EXCEPTION" });
        expect(formatContractError(error, IFACE)).toContain("too-soon");
        expect(getNextBlockSimulation(error)?.rpcMethod).toBe(method);
        expect(
          nextBlockFailure("failed", getNextBlockSimulation(error)).error
        ).toBe(
          `failed (simulated as of next block 101, timestamp ${node.latestTimestamp + SLOT})`
        );
      }
    );

    it("keeps the node's reason for an eth_simulateV1 failure without revert data", async () => {
      node.unlockAt = node.latestTimestamp + 30;
      node.estimateOverrides = "rejected";
      vi.spyOn(node, "handle").mockImplementation(function (
        this: FakeNode,
        method,
        params
      ) {
        const answer = FakeNode.prototype.handle.call(this, method, params);
        if (method === "eth_simulateV1" && "result" in answer) {
          const [block] = answer.result as {
            calls: Record<string, unknown>[];
          }[];
          block.calls[1] = {
            status: "0x0",
            gasUsed: "0x1",
            returnData: "0x",
            error: { code: -32_015, message: "out of gas" },
          };
        }
        return answer;
      });

      const error = await send().catch((e: unknown) => e);
      expect((error as { shortMessage?: string }).shortMessage).toBe(
        "out of gas"
      );
    });
  });

  describe("a send whose call burns the block's gas", () => {
    it("reports the call's failure, not an unsupported RPC", async () => {
      node.unlockAt = node.latestTimestamp + 5;
      node.estimateOverrides = "rejected";
      node.burnsGas = true;

      const error = await send().catch((e: unknown) => e);
      expect(error).not.toBeInstanceOf(NextBlockSimulationUnsupportedError);
      expect(error).toMatchObject({ code: "CALL_EXCEPTION" });
      expect((error as { shortMessage?: string }).shortMessage).toBe(
        "out of gas"
      );
      expect(getNextBlockSimulation(error)?.rpcMethod).toBe("eth_simulateV1");
    });
  });

  describe("a read", () => {
    it("answers as of the next block with eth_simulateV1 or eth_call", async () => {
      node.unlockAt = node.latestTimestamp + 5;
      const atLatest = await provider.call(WORKABLE_TX);
      expect(IFACE.decodeFunctionResult("workable", atLatest)[0]).toBe(false);

      for (const [simulateV1, method] of [
        ["supported", "eth_simulateV1"],
        ["missing", "eth_call+blockOverrides"],
        ["ignored", "eth_call+blockOverrides"],
      ] as const) {
        node.simulateV1 = simulateV1;
        const { returnData, simulation } = await read({
          timestampOffsetSec: SLOT,
        });
        expect(IFACE.decodeFunctionResult("workable", returnData)[0]).toBe(
          true
        );
        expect(simulation.rpcMethod).toBe(method);
      }
    });

    it("keeps a geth-shaped eth_simulateV1 revert reason", async () => {
      node.unlockAt = node.latestTimestamp + 30;
      const error = await simulateCallAtNextBlock(managerFor(provider), {
        chainId: CHAIN_ID,
        tx: RUN_TX,
        options: { timestampOffsetSec: SLOT },
      }).catch((e: unknown) => e);
      expect(formatContractError(error, IFACE)).toContain("too-soon");
      expect(getNextBlockSimulation(error)?.rpcMethod).toBe("eth_simulateV1");
    });

    it("keeps a revert reason carried only in eth_simulateV1 returnData", async () => {
      node.unlockAt = node.latestTimestamp + 30;
      const handle = node.handle.bind(node);
      vi.spyOn(node, "handle").mockImplementation((method, params) => {
        const answer = handle(method, params);
        if (method === "eth_simulateV1" && "result" in answer) {
          const [block] = answer.result as {
            calls: Record<string, unknown>[];
          }[];
          block.calls[1] = {
            status: "0x0",
            gasUsed: "0x1",
            returnData: TOO_SOON,
          };
        }
        return answer;
      });
      const error = await simulateCallAtNextBlock(managerFor(provider), {
        chainId: CHAIN_ID,
        tx: RUN_TX,
        options: { timestampOffsetSec: SLOT },
      }).catch((e: unknown) => e);
      expect(formatContractError(error, IFACE)).toContain("too-soon");
    });

    it("uses eth_call when eth_simulateV1 is refused in an unknown way", async () => {
      node.unlockAt = node.latestTimestamp + 5;
      node.realCallError = {
        method: "eth_simulateV1",
        error: { code: -32_005, message: "rpc method is not whitelisted" },
      };

      const { simulation } = await read({ timestampOffsetSec: SLOT });
      expect(simulation.rpcMethod).toBe("eth_call+blockOverrides");
    });

    it("fails clearly when eth_call rejects block overrides", async () => {
      node.simulateV1 = "missing";
      node.callOverrides = "rejected";

      const error = await read({ timestampOffsetSec: SLOT }).catch(
        (e: unknown) => e
      );
      expect(error).toBeInstanceOf(NextBlockSimulationUnsupportedError);
      expect((error as Error).message).toContain("does not accept");
    });

    it("fails clearly instead of answering at latest when eth_call ignores the overrides", async () => {
      node.simulateV1 = "missing";
      node.callOverrides = "ignored";
      node.unlockAt = node.latestTimestamp + 5;

      const error = await read({ timestampOffsetSec: SLOT }).catch(
        (e: unknown) => e
      );
      expect(error).toBeInstanceOf(NextBlockSimulationUnsupportedError);
      expect((error as Error).message).toContain("ignored the block overrides");
    });
  });

  describe("the slot clock", () => {
    it("predicts the next slot after a missed one, not a slot that has passed", async () => {
      // The slot after the latest block was missed: 15 s since it, no block.
      setClock(node.latestTimestamp + 15);
      node.unlockAt = node.latestTimestamp + 2 * SLOT;

      const result = await send();
      expect(result.simulation.assumedTimestamp).toBe(
        node.latestTimestamp + 2 * SLOT
      );
      expect(result.simulation.assumedBlockNumber).toBe(101);
    });

    it("refuses a call valid only from a later slot after a missed one", async () => {
      setClock(node.latestTimestamp + 15);
      node.unlockAt = node.latestTimestamp + 3 * SLOT;

      const error = await send().catch((e: unknown) => e);
      expect(formatContractError(error, IFACE)).toContain("too-soon");
      expect(getNextBlockSimulation(error)?.assumedTimestamp).toBe(
        node.latestTimestamp + 2 * SLOT
      );
    });

    it("moves to the next slot exactly at a slot start", async () => {
      setClock(node.latestTimestamp + SLOT);
      const { simulation } = await read({ timestampOffsetSec: SLOT });
      expect(simulation.assumedTimestamp).toBe(node.latestTimestamp + 2 * SLOT);
    });

    it("never predicts earlier than one slot after the latest block", async () => {
      // A server clock behind the chain.
      setClock(node.latestTimestamp - 30);
      const { simulation } = await read({ timestampOffsetSec: SLOT });
      expect(simulation.assumedTimestamp).toBe(node.latestTimestamp + SLOT);
    });

    it("uses the set offset as the slot length", async () => {
      setClock(node.latestTimestamp + 7);
      const { simulation } = await read({ timestampOffsetSec: 5 });
      expect(simulation.assumedTimestamp).toBe(node.latestTimestamp + 10);
      expect(simulation.timestampOffsetSec).toBe(5);
    });

    it("matches the beacon clock on Ethereum mainnet", () => {
      // Mainnet genesis 1606824023, 12 s slots: slot starts are on that grid.
      const genesis = 1_606_824_023;
      const latest = genesis + 1_000_000 * SLOT;
      const beaconNextSlotAfter = (t: number): number =>
        genesis + (Math.floor((t - genesis) / SLOT) + 1) * SLOT;
      for (const now of [
        latest,
        latest + 1,
        latest + 11,
        latest + 12,
        latest + 25,
      ]) {
        expect(nextSlotTime(latest, SLOT, now)).toBe(
          Math.max(beaconNextSlotAfter(now), latest + SLOT)
        );
      }
    });
  });

  describe("the automatic offset", () => {
    it("is the smallest recent gap, so a missed slot does not stretch it", async () => {
      node.timestampOf = (n: number): number =>
        node.latestTimestamp -
        (node.latestNumber - n) * SLOT -
        (n < 97 ? SLOT : 0);

      const { simulation } = await read();
      expect(simulation.timestampOffsetSec).toBe(SLOT);
    });

    it("is cached per chain and RPC, so another RPC or chain cannot set it", async () => {
      const forged = new FakeNode();
      forged.timestampOf = (n: number): number =>
        forged.latestTimestamp - (forged.latestNumber - n) * 30;
      await simulateCallAtNextBlock(
        managerFor(new FakeProvider(forged, "http://custom.invalid")),
        { chainId: CHAIN_ID, tx: WORKABLE_TX, options: {} }
      );
      await simulateCallAtNextBlock(managerFor(new FakeProvider(forged)), {
        chainId: CHAIN_ID + 1,
        tx: WORKABLE_TX,
        options: {},
      });

      const { simulation } = await read();
      expect(simulation.timestampOffsetSec).toBe(SLOT);
    });

    it("is refreshed after 10 minutes", async () => {
      const now = (node.latestTimestamp + 1) * 1000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      await read();
      node.timestampOf = (n: number): number =>
        node.latestTimestamp - (node.latestNumber - n) * 2;
      // Same URL, so the same cache entry; a fresh provider skips ethers'
      // own short request cache.
      provider = new FakeProvider(node);

      clock.mockReturnValue(now + 9 * 60_000);
      expect((await read()).simulation.timestampOffsetSec).toBe(SLOT);
      clock.mockReturnValue(now + 11 * 60_000);
      expect((await read()).simulation.timestampOffsetSec).toBe(2);
    });

    it("keeps at most 256 cached RPCs", async () => {
      for (let i = 0; i < 257; i += 1) {
        await simulateCallAtNextBlock(
          managerFor(new FakeProvider(node, `http://rpc-${i}.invalid`)),
          { chainId: CHAIN_ID, tx: WORKABLE_TX, options: {} }
        );
      }
      const before = node.methods.length;
      // The first one was evicted, so it samples blocks again.
      await simulateCallAtNextBlock(
        managerFor(new FakeProvider(node, "http://rpc-0.invalid")),
        { chainId: CHAIN_ID, tx: WORKABLE_TX, options: {} }
      );
      const sampled = node.methods
        .slice(before)
        .filter((m) => m === "eth_getBlockByNumber").length;
      expect(sampled).toBeGreaterThan(1);
    });

    it("only measures adjacent blocks, so missing ones cannot stretch it", async () => {
      // A 2-second chain whose lagging backend lacks most recent blocks.
      node.timestampOf = (n: number): number =>
        node.latestTimestamp - (node.latestNumber - n) * 2;
      node.missing = new Set([96, 97]);

      const { simulation } = await read();
      expect(simulation.timestampOffsetSec).toBe(2);
    });

    it("does not trust a single measured gap, which may span a missed slot", async () => {
      node.timestampOf = (n: number): number =>
        node.latestTimestamp - (node.latestNumber - n) * 24;
      node.missing = new Set([94, 95, 96, 97, 98]);
      const error = await read().catch((e: unknown) => e);
      expect(isNonRetryableError(error)).toBe(false);
      expect((error as Error).message).toContain("block time");
    });

    it("fails as a temporary error, uncached, when no gap can be measured", async () => {
      node.timestampOf = (n: number): number =>
        node.latestTimestamp - (node.latestNumber - n) * 2;
      node.missing = new Set([95, 96, 97, 98, 99]);

      const error = await read().catch((e: unknown) => e);
      expect(error).not.toBeInstanceOf(NextBlockSimulationUnsupportedError);
      expect(isNonRetryableError(error)).toBe(false);
      expect((error as Error).message).toContain("block time");

      node.missing = new Set();
      provider = new FakeProvider(node);
      expect((await read()).simulation.timestampOffsetSec).toBe(2);
    });

    it("never goes above 60 seconds", async () => {
      node.timestampOf = (n: number): number =>
        node.latestTimestamp - (node.latestNumber - n) * 100_000;

      const { simulation } = await read();
      expect(simulation.timestampOffsetSec).toBe(60);
    });

    it("refuses to guess when recent blocks share a timestamp", async () => {
      node.timestampOf = (): number => node.latestTimestamp;

      const error = await read().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NextBlockSimulationUnsupportedError);
      expect((error as Error).message).toContain("share a timestamp");
    });
  });

  describe("node errors", () => {
    it.each([
      ["code 3 with no data", { code: 3, message: "execution reverted" }],
      [
        "an older Nethermind revert",
        { code: -32_015, message: "VM execution error.", data: "revert" },
      ],
    ])(
      "treats a proof that reverted with %s as overrides ignored",
      async (_label, error) => {
        // Reads: a clear refusal, not an endless retry.
        node.simulateV1 = "missing";
        node.proofError = { method: "eth_call", error };
        const readError = await read({ timestampOffsetSec: SLOT }).catch(
          (e: unknown) => e
        );
        expect(readError).toBeInstanceOf(NextBlockSimulationUnsupportedError);

        // Sends: the eth_simulateV1 fallback is still reached.
        node.simulateV1 = "supported";
        node.unlockAt = node.latestTimestamp + 5;
        node.proofError = { method: "eth_estimateGas", error };
        const result = await send();
        expect(result.simulation.rpcMethod).toBe("eth_simulateV1");
      }
    );

    it("keeps the relay's refusal in the send-path unsupported message", async () => {
      node.simulateV1 = "missing";
      node.proofError = {
        method: "eth_estimateGas",
        error: { code: -32_601, message: "rpc method is not whitelisted" },
      };
      const error = await send().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NextBlockSimulationUnsupportedError);
      expect((error as Error).message).toContain(
        "eth_estimateGas does not apply block overrides (rpc method is not whitelisted), and eth_simulateV1"
      );
    });

    it("does not show an ignored proof's revert as if the user's call reverted", async () => {
      node.simulateV1 = "missing";
      node.estimateOverrides = "ignored";
      const error = await send().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NextBlockSimulationUnsupportedError);
      expect((error as Error).message).not.toContain("execution reverted");
    });

    it.each([
      ["-32005 alone", { code: -32_005, message: "limit exceeded" }],
      [
        "a Nethermind missing block",
        { code: -32_001, message: "Block 100 could not be found" },
      ],
    ])(
      "keeps %s on the real estimate retryable, not final",
      async (_label, error) => {
        node.unlockAt = node.latestTimestamp + 5;
        node.realCallError = { method: "eth_estimateGas", error };
        const thrown = await send().catch((e: unknown) => e);
        expect(isNonRetryableError(thrown)).toBe(false);
        expect((thrown as Error).message).toContain("retried automatically");
      }
    );

    it.each([
      [
        "a timeout",
        () =>
          ethers.makeError("request timeout", "TIMEOUT", {
            operation: "request",
            reason: "timeout",
          }),
      ],
      [
        "a network error",
        () =>
          ethers.makeError("network error", "NETWORK_ERROR", {
            event: "request",
          }),
      ],
      ["HTTP 503", () => httpError(503)],
      ["HTTP 429", () => httpError(429)],
    ])(
      "keeps %s on the proof or the real estimate retryable",
      async (_label, makeErr) => {
        for (const onProof of [true, false]) {
          node.unlockAt = node.latestTimestamp + 5;
          vi.spyOn(provider, "_send").mockImplementation((payload) => {
            const p = Array.isArray(payload) ? payload[0] : payload;
            const tx = (p.params as Tx[] | undefined)?.[0];
            if (
              p.method === "eth_estimateGas" &&
              (tx?.to === undefined) === onProof
            ) {
              return Promise.reject(makeErr());
            }
            return FakeProvider.prototype._send.call(provider, payload);
          });
          const thrown = await send().catch((e: unknown) => e);
          // Rethrown as it came, so the failover keeps its code and response.
          expect(thrown).toMatchObject({
            code: (makeErr() as Error & { code: string }).code,
          });
          expect(isNonRetryableError(thrown)).toBe(false);
          vi.restoreAllMocks();
        }
      }
    );

    it.each([
      ["a gateway's brief 401", () => httpError(401)],
      ["a 403 without a method refusal", () => httpError(403, "forbidden")],
    ])("keeps %s on the proof retryable", async (_label, makeErr) => {
      node.simulateV1 = "missing";
      vi.spyOn(provider, "_send").mockImplementation((payload) => {
        const p = Array.isArray(payload) ? payload[0] : payload;
        const tx = (p.params as Tx[] | undefined)?.[0];
        if (p.method === "eth_call" && tx?.to === undefined) {
          return Promise.reject(makeErr());
        }
        return FakeProvider.prototype._send.call(provider, payload);
      });
      const error = await read({ timestampOffsetSec: SLOT }).catch(
        (e: unknown) => e
      );
      expect(error).not.toBeInstanceOf(NextBlockSimulationUnsupportedError);
      expect(isNonRetryableError(error)).toBe(false);
    });

    it.each([
      ["requested block 100 is not available"],
      ["block 100 does not exist"],
      ["header for block 100 not found"],
    ])(
      'keeps a lagging node\'s "%s" on the proof retryable',
      async (message) => {
        node.simulateV1 = "missing";
        node.proofError = {
          method: "eth_call",
          error: { code: -32_000, message },
        };
        const error = await read({ timestampOffsetSec: SLOT }).catch(
          (e: unknown) => e
        );
        expect(error).not.toBeInstanceOf(NextBlockSimulationUnsupportedError);
        expect(isNonRetryableError(error)).toBe(false);
      }
    );

    it("rethrows a transport error unchanged, so the failover keeps its details", async () => {
      node.unlockAt = node.latestTimestamp + 5;
      const rateLimited = httpError(429);
      vi.spyOn(provider, "_send").mockImplementation((payload) => {
        const p = Array.isArray(payload) ? payload[0] : payload;
        const tx = (p.params as Tx[] | undefined)?.[0];
        if (p.method === "eth_estimateGas" && tx?.to === CONTRACT) {
          return Promise.reject(rateLimited);
        }
        return FakeProvider.prototype._send.call(provider, payload);
      });
      const error = await send().catch((e: unknown) => e);
      expect(error).toBe(rateLimited);
    });

    it("keeps a node's own transient answer as the cause of the retryable error", async () => {
      node.unlockAt = node.latestTimestamp + 5;
      node.realCallError = {
        method: "eth_estimateGas",
        error: HEADER_NOT_FOUND,
      };
      const error = (await send().catch((e: unknown) => e)) as Error;
      expect(isNonRetryableError(error)).toBe(false);
      expect(error.cause).toMatchObject({ code: "CALL_EXCEPTION" });
    });

    it("treats an HTTP 403 refusal as unsupported and keeps the URL out of the message", async () => {
      node.simulateV1 = "missing";
      vi.spyOn(provider, "_send").mockImplementation((payload) => {
        const p = Array.isArray(payload) ? payload[0] : payload;
        if (p.method === "eth_call") {
          return Promise.reject(httpError(403, NOT_WHITELISTED_BODY));
        }
        return FakeProvider.prototype._send.call(provider, payload);
      });

      const error = await read({ timestampOffsetSec: SLOT }).catch(
        (e: unknown) => e
      );
      expect(error).toBeInstanceOf(NextBlockSimulationUnsupportedError);
      expect((error as Error).message).not.toContain("key123");
    });

    it.each([
      ["code -32602", { code: -32_602, message: "bad request" }],
      [
        "a refused-parameter message",
        { code: -32_000, message: "too many arguments, want at most 3" },
      ],
      [
        "a method-not-found message",
        { code: -32_000, message: "block override not supported" },
      ],
      [
        "a not-whitelisted message",
        { code: -32_601, message: "rpc method is not whitelisted" },
      ],
    ])(
      "treats %s on the eth_call proof as unsupported",
      async (_label, error) => {
        node.simulateV1 = "missing";
        node.proofError = { method: "eth_call", error };

        const thrown = await read({ timestampOffsetSec: SLOT }).catch(
          (e: unknown) => e
        );
        expect(thrown).toBeInstanceOf(NextBlockSimulationUnsupportedError);
      }
    );

    it.each([
      ["-32603 internal error", { code: -32_603, message: "internal error" }],
      [
        "service unavailable",
        { code: -32_000, message: "service unavailable" },
      ],
      [
        "a Nethermind missing block",
        { code: -32_001, message: "Block 100 could not be found" },
      ],
      ["a Besu missing block", { code: -32_000, message: "Block not found" }],
    ])(
      "keeps %s on a proof retryable, not unsupported",
      async (_label, error) => {
        node.unlockAt = node.latestTimestamp + 5;
        node.proofError = { method: "eth_estimateGas", error };

        const thrown = await send().catch((e: unknown) => e);
        expect(thrown).not.toBeInstanceOf(NextBlockSimulationUnsupportedError);
        expect(isNonRetryableError(thrown)).toBe(false);
        expect((thrown as Error).message).toContain("retried automatically");
      }
    );

    it.each([
      ["code 3 with no data", { code: 3, message: "execution failed" }],
      [
        "a geth -32000 invalid opcode",
        { code: -32_000, message: "invalid opcode: INVALID" },
      ],
      [
        "a geth aborted call",
        { code: -32_000, message: "execution aborted (timeout = 5s)" },
      ],
    ])(
      "treats %s on the real estimate as final, like latest does",
      async (_label, error) => {
        node.unlockAt = node.latestTimestamp + 5;
        node.realCallError = { method: "eth_estimateGas", error };

        const thrown = await send().catch((e: unknown) => e);
        expect(thrown).toMatchObject({ code: "CALL_EXCEPTION" });
        expect(isNonRetryableError(thrown)).toBe(true);
        expect(getNextBlockSimulation(thrown)).toBeDefined();
      }
    );

    it.each([
      ["the real eth_estimateGas", "realCallError", "eth_estimateGas"],
      ["the eth_estimateGas proof", "proofError", "eth_estimateGas"],
    ] as const)(
      "keeps a transient error on %s retryable",
      async (_label, slot, method) => {
        node.unlockAt = node.latestTimestamp + 5;
        node[slot] = { method, error: HEADER_NOT_FOUND };

        const error = await send().catch((e: unknown) => e);
        expect(isNonRetryableError(error)).toBe(false);
        expect((error as Error).message).toContain("header not found");
      }
    );

    it.each([
      ["the real eth_call", "realCallError", "eth_call", "missing"],
      ["the eth_call proof", "proofError", "eth_call", "missing"],
      ["eth_simulateV1", "realCallError", "eth_simulateV1", "supported"],
    ] as const)(
      "keeps a transient error on %s retryable for a read",
      async (_label, slot, method, simulateV1) => {
        node.simulateV1 = simulateV1;
        node[slot] = {
          method,
          error: { code: -32_005, message: "rate limited" },
        };

        const error = await read({ timestampOffsetSec: SLOT }).catch(
          (e: unknown) => e
        );
        expect(isNonRetryableError(error)).toBe(false);
        expect((error as Error).message).toContain("rate limited");
      }
    );

    it.each([
      ["block overrides are not available on this plan"],
      ["block overrides are not allowed"],
      ["blockOverrides disabled on this endpoint"],
      ["unsupported method: eth_call with overrides"],
    ])(
      'treats a relay refusing the overrides ("%s") as unsupported, not temporary',
      async (message) => {
        node.simulateV1 = "missing";
        node.proofError = {
          method: "eth_call",
          error: { code: -32_000, message },
        };
        const error = await read({ timestampOffsetSec: SLOT }).catch(
          (e: unknown) => e
        );
        expect(error).toBeInstanceOf(NextBlockSimulationUnsupportedError);
      }
    );

    it('keeps a gateway\'s "IP not whitelisted" retryable, not unsupported', async () => {
      node.simulateV1 = "missing";
      node.proofError = {
        method: "eth_call",
        error: { code: -32_000, message: "IP 10.0.0.1 not whitelisted" },
      };
      const error = await read({ timestampOffsetSec: SLOT }).catch(
        (e: unknown) => e
      );
      expect(error).not.toBeInstanceOf(NextBlockSimulationUnsupportedError);
      expect(isNonRetryableError(error)).toBe(false);
    });

    it.each([
      ["execution reverted: try again later"],
      ["execution reverted: timed out"],
      ["execution reverted: block 7 not found"],
    ])(
      'treats a revert whose reason reads like an RPC error ("%s") as a revert',
      async (message) => {
        node.unlockAt = node.latestTimestamp + 5;
        node.realCallError = {
          method: "eth_estimateGas",
          error: { code: -32_000, message },
        };
        const error = await send().catch((e: unknown) => e);
        expect(error).toMatchObject({ code: "CALL_EXCEPTION" });
        expect(isNonRetryableError(error)).toBe(true);
        expect(getNextBlockSimulation(error)).toBeDefined();
      }
    );

    it.each([
      [
        "a JSON-RPC -32602 body",
        '{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"bad params"}}',
      ],
      [
        "an unsupported-method message",
        '{"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"Unsupported method: eth_call"}}',
      ],
    ])("treats an HTTP 400 with %s as unsupported", async (_label, body) => {
      node.simulateV1 = "missing";
      vi.spyOn(provider, "_send").mockImplementation((payload) => {
        const p = Array.isArray(payload) ? payload[0] : payload;
        if (p.method === "eth_call") {
          return Promise.reject(httpError(400, body));
        }
        return FakeProvider.prototype._send.call(provider, payload);
      });
      const error = await read({ timestampOffsetSec: SLOT }).catch(
        (e: unknown) => e
      );
      expect(error).toBeInstanceOf(NextBlockSimulationUnsupportedError);
    });

    it("does not count a code that only contains -32601 as a refusal", async () => {
      node.simulateV1 = "missing";
      vi.spyOn(provider, "_send").mockImplementation((payload) => {
        const p = Array.isArray(payload) ? payload[0] : payload;
        if (p.method === "eth_call") {
          return Promise.reject(
            httpError(403, '{"error":{"code":-326012,"message":"denied"}}')
          );
        }
        return FakeProvider.prototype._send.call(provider, payload);
      });
      const error = await read({ timestampOffsetSec: SLOT }).catch(
        (e: unknown) => e
      );
      expect(error).not.toBeInstanceOf(NextBlockSimulationUnsupportedError);
    });

    it("falls back to eth_call when eth_simulateV1 is refused in an HTTP 4xx body", async () => {
      vi.spyOn(provider, "_send").mockImplementation((payload) => {
        const p = Array.isArray(payload) ? payload[0] : payload;
        if (p.method === "eth_simulateV1") {
          return Promise.reject(
            httpError(
              400,
              '{"error":{"code":-32600,"message":"Unsupported method: eth_simulateV1"}}'
            )
          );
        }
        return FakeProvider.prototype._send.call(provider, payload);
      });
      const { simulation } = await read({ timestampOffsetSec: SLOT });
      expect(simulation.rpcMethod).toBe("eth_call+blockOverrides");
    });

    it("keeps a brief HTTP 401 on eth_simulateV1 retryable on a send", async () => {
      // The send's last resort: estimateGas refuses the overrides.
      node.estimateOverrides = "rejected";
      vi.spyOn(provider, "_send").mockImplementation((payload) => {
        const p = Array.isArray(payload) ? payload[0] : payload;
        if (p.method === "eth_simulateV1") {
          return Promise.reject(httpError(401, "unauthorized"));
        }
        return FakeProvider.prototype._send.call(provider, payload);
      });
      const error = await send().catch((e: unknown) => e);
      expect(error).not.toBeInstanceOf(NextBlockSimulationUnsupportedError);
      expect(isNonRetryableError(error)).toBe(false);
    });

    it.each([
      ["method eth_call: header not found"],
      ["upstream error for method eth_call: block 0x65 not found"],
      [
        "failed to call method eth_call, requested block not available, try again",
      ],
      ["method eth_call is not available right now, try again later"],
    ])(
      'keeps "%s" on the proof retryable, not unsupported',
      async (message) => {
        node.simulateV1 = "missing";
        node.proofError = {
          method: "eth_call",
          error: { code: -32_000, message },
        };
        const error = await read({ timestampOffsetSec: SLOT }).catch(
          (e: unknown) => e
        );
        expect(error).not.toBeInstanceOf(NextBlockSimulationUnsupportedError);
        expect(isNonRetryableError(error)).toBe(false);
      }
    );

    it("checks a refusal of the overrides before transient wording", async () => {
      node.simulateV1 = "missing";
      node.proofError = {
        method: "eth_call",
        error: {
          code: -32_000,
          message:
            "block overrides not supported on this plan, try again with a paid key",
        },
      };
      const error = await read({ timestampOffsetSec: SLOT }).catch(
        (e: unknown) => e
      );
      expect(error).toBeInstanceOf(NextBlockSimulationUnsupportedError);
    });

    it("treats an HTTP 403 whose body carries code -32601 alone as unsupported", async () => {
      node.simulateV1 = "missing";
      vi.spyOn(provider, "_send").mockImplementation((payload) => {
        const p = Array.isArray(payload) ? payload[0] : payload;
        if (p.method === "eth_call") {
          return Promise.reject(
            httpError(403, '{"error":{"code":-32601,"message":"rejected"}}')
          );
        }
        return FakeProvider.prototype._send.call(provider, payload);
      });
      const error = await read({ timestampOffsetSec: SLOT }).catch(
        (e: unknown) => e
      );
      expect(error).toBeInstanceOf(NextBlockSimulationUnsupportedError);
    });

    it.each([
      ["QuickNode", { code: -32_007, message: "request limit reached" }],
      [
        "Alchemy",
        {
          code: 429,
          message:
            "Your app has exceeded its compute units per second capacity",
        },
      ],
    ])(
      "keeps a %s rate limit on the real estimate retryable",
      async (_label, error) => {
        node.unlockAt = node.latestTimestamp + 5;
        node.realCallError = { method: "eth_estimateGas", error };
        const thrown = await send().catch((e: unknown) => e);
        expect(isNonRetryableError(thrown)).toBe(false);
        expect((thrown as Error).message).toContain("retried automatically");
      }
    );

    it.each([
      ["code -32007 alone", { code: -32_007, message: "slow down" }],
      ["code 429 alone", { code: 429, message: "exceeded" }],
      [
        "compute-units wording alone",
        {
          code: -32_000,
          message: "exceeded its compute units per second capacity",
        },
      ],
      [
        "limit wording alone",
        { code: -32_000, message: "request limit reached" },
      ],
    ])(
      "keeps a rate limit with %s retryable on the proof and the real call",
      async (_label, error) => {
        for (const slot of ["proofError", "realCallError"] as const) {
          node.unlockAt = node.latestTimestamp + 5;
          node.proofError = undefined;
          node.realCallError = undefined;
          node[slot] = { method: "eth_estimateGas", error };
          provider = new FakeProvider(node);
          const thrown = await send().catch((e: unknown) => e);
          expect(thrown).not.toBeInstanceOf(
            NextBlockSimulationUnsupportedError
          );
          expect(isNonRetryableError(thrown)).toBe(false);
        }
      }
    );

    it("keeps a node error that merely mentions a method final, not unsupported", async () => {
      node.unlockAt = node.latestTimestamp + 5;
      node.realCallError = {
        method: "eth_estimateGas",
        error: {
          code: -32_000,
          message: "method handler error: account not found",
        },
      };
      const error = await send().catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "CALL_EXCEPTION" });
      expect(error).not.toBeInstanceOf(NextBlockSimulationUnsupportedError);
    });

    it.each([
      [
        "Alchemy's allowlist refusal",
        { code: -32_000, message: "eth_call is not allowlisted for this app" },
      ],
      [
        "Alchemy's allowlist refusal with -32600",
        { code: -32_600, message: "eth_call is not allowlisted for this app" },
      ],
    ])("treats %s on the proof as unsupported", async (_label, error) => {
      node.simulateV1 = "missing";
      node.proofError = { method: "eth_call", error };
      const thrown = await read({ timestampOffsetSec: SLOT }).catch(
        (e: unknown) => e
      );
      expect(thrown).toBeInstanceOf(NextBlockSimulationUnsupportedError);
    });

    it("keeps a bare -32600 (an auth failure, say) on the proof retryable", async () => {
      node.simulateV1 = "missing";
      node.proofError = {
        method: "eth_call",
        error: { code: -32_600, message: "Must be authenticated!" },
      };
      const thrown = await read({ timestampOffsetSec: SLOT }).catch(
        (e: unknown) => e
      );
      expect(thrown).not.toBeInstanceOf(NextBlockSimulationUnsupportedError);
      expect(isNonRetryableError(thrown)).toBe(false);
    });

    it("falls back to eth_call when eth_simulateV1 fails for good", async () => {
      vi.spyOn(provider, "_send").mockImplementation((payload) => {
        const p = Array.isArray(payload) ? payload[0] : payload;
        if (p.method === "eth_simulateV1") {
          return Promise.resolve([
            {
              id: p.id,
              jsonrpc: "2.0",
              error: { code: -32_001, message: "Unauthorized" },
            } as unknown as ethers.JsonRpcResult,
          ]);
        }
        return FakeProvider.prototype._send.call(provider, payload);
      });
      const { simulation } = await read({ timestampOffsetSec: SLOT });
      expect(simulation.rpcMethod).toBe("eth_call+blockOverrides");
    });

    it("keeps the node's message when the real call is refused inside an HTTP 4xx body", async () => {
      node.unlockAt = node.latestTimestamp + 5;
      vi.spyOn(provider, "_send").mockImplementation((payload) => {
        const p = Array.isArray(payload) ? payload[0] : payload;
        const tx = (p.params as Tx[] | undefined)?.[0];
        if (p.method === "eth_estimateGas" && tx?.to === CONTRACT) {
          return Promise.reject(
            httpError(
              400,
              '{"error":{"code":-32602,"message":"invalid argument 0: bad from"}}'
            )
          );
        }
        return FakeProvider.prototype._send.call(provider, payload);
      });
      const error = (await send().catch((e: unknown) => e)) as Error;
      expect(error.message).toContain("invalid argument 0: bad from");
      expect(error).not.toMatchObject({ code: "CALL_EXCEPTION" });
      // Final, as the same answer over HTTP 200 would be: no failover.
      expect(isNonRetryableError(error)).toBe(true);
    });

    it("reads a revert inside an HTTP 4xx body as a final, decodable revert", async () => {
      node.unlockAt = node.latestTimestamp + 5;
      vi.spyOn(provider, "_send").mockImplementation((payload) => {
        const p = Array.isArray(payload) ? payload[0] : payload;
        const tx = (p.params as Tx[] | undefined)?.[0];
        if (p.method === "eth_estimateGas" && tx?.to === CONTRACT) {
          return Promise.reject(
            httpError(
              400,
              JSON.stringify({
                error: {
                  code: 3,
                  message: "execution reverted",
                  data: TOO_SOON,
                },
              })
            )
          );
        }
        return FakeProvider.prototype._send.call(provider, payload);
      });
      const error = await send().catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "CALL_EXCEPTION" });
      expect(isNonRetryableError(error)).toBe(true);
      expect(formatContractError(error, IFACE)).toContain("too-soon");
      expect(getNextBlockSimulation(error)).toBeDefined();
    });

    it("reads a missing block inside an HTTP 4xx body as temporary, as over HTTP 200", async () => {
      node.unlockAt = node.latestTimestamp + 5;
      vi.spyOn(provider, "_send").mockImplementation((payload) => {
        const p = Array.isArray(payload) ? payload[0] : payload;
        const tx = (p.params as Tx[] | undefined)?.[0];
        if (p.method === "eth_estimateGas" && tx?.to === CONTRACT) {
          return Promise.reject(
            httpError(
              400,
              '{"error":{"code":-32602,"message":"requested block 100 is not available"}}'
            )
          );
        }
        return FakeProvider.prototype._send.call(provider, payload);
      });
      const error = await send().catch((e: unknown) => e);
      expect(error).not.toBeInstanceOf(NextBlockSimulationUnsupportedError);
      expect(isNonRetryableError(error)).toBe(false);
    });
  });

  describe("a send after an earlier check", () => {
    async function checked(): Promise<
      Awaited<ReturnType<typeof simulateCallAtNextBlock>>["simulation"]
    > {
      return (await read({ timestampOffsetSec: SLOT })).simulation;
    }

    function sendBasedOn(
      basedOn: Awaited<ReturnType<typeof checked>>
    ): ReturnType<typeof simulateSendAtNextBlock> {
      return simulateSendAtNextBlock(managerFor(provider), {
        chainId: CHAIN_ID,
        tx: RUN_TX,
        options: { timestampOffsetSec: SLOT, basedOn },
      });
    }

    it("reuses the checked prediction while its block is still the latest", async () => {
      const check = await checked();
      // A prediction the send's own offset would not make: reuse is visible.
      const basedOn = {
        ...check,
        assumedTimestamp: check.assumedTimestamp + 18,
        timestampOffsetSec: SLOT + 18,
      };
      node.unlockAt = basedOn.assumedTimestamp;

      const { simulation } = await sendBasedOn(basedOn);
      expect(simulation.baseBlock).toBe(check.baseBlock);
      expect(simulation.assumedTimestamp).toBe(basedOn.assumedTimestamp);
      expect(node.seen.at(-1)?.overrides?.time).toBe(
        ethers.toQuantity(basedOn.assumedTimestamp)
      );
    });

    it("checks again against a fresh block once a new one landed", async () => {
      const basedOn = await checked();
      node.latestNumber += 3;
      node.latestTimestamp += 3 * SLOT;
      // A fresh provider skips ethers' short request cache.
      provider = new FakeProvider(node);
      node.unlockAt = node.latestTimestamp + SLOT;

      const { simulation } = await sendBasedOn(basedOn);
      expect(simulation.baseBlock).toBe(node.latestNumber);
      expect(node.seen.at(-1)?.blockTag).toBe(
        ethers.toQuantity(node.latestNumber)
      );
    });

    it("checks again when a slot passed with no new block while it waited", async () => {
      const basedOn = await checked();
      // The predicted slot was missed: same latest block, a slot later.
      setClock(node.latestTimestamp + 13);
      node.unlockAt = node.latestTimestamp + 2 * SLOT;
      provider = new FakeProvider(node);

      const { simulation } = await sendBasedOn(basedOn);
      expect(simulation.baseBlock).toBe(basedOn.baseBlock);
      expect(simulation.assumedTimestamp).toBe(node.latestTimestamp + 2 * SLOT);
    });

    it("fails as a temporary error on an RPC behind the checked block", async () => {
      const basedOn = await checked();
      // Failed over to a backend two blocks behind.
      node.latestNumber -= 2;
      node.latestTimestamp -= 2 * SLOT;
      provider = new FakeProvider(node);

      const error = await sendBasedOn(basedOn).catch((e: unknown) => e);
      expect(isNonRetryableError(error)).toBe(false);
      expect((error as Error).message).toContain("behind the block");
      expect(failedNextBlockCheck(error)).toBe(true);
    });

    it("refuses a call that became invalid while it waited", async () => {
      node.unlockAt = node.latestTimestamp + SLOT;
      const basedOn = await checked();
      // Later blocks, and the contract locked again (another keeper ran it).
      node.latestNumber += 2;
      node.latestTimestamp += 2 * SLOT;
      // A fresh provider skips ethers' short request cache.
      provider = new FakeProvider(node);
      node.unlockAt = node.latestTimestamp + 10 * SLOT;

      const error = await sendBasedOn(basedOn).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "CALL_EXCEPTION" });
    });
  });

  describe("a failed send check", () => {
    it("is marked as failing before anything was sent", async () => {
      node.unlockAt = node.latestTimestamp + 30;
      const reverted = await send().catch((e: unknown) => e);
      expect(failedNextBlockCheck(reverted)).toBe(true);

      node.realCallError = {
        method: "eth_estimateGas",
        error: HEADER_NOT_FOUND,
      };
      const transient = await send().catch((e: unknown) => e);
      expect(failedNextBlockCheck(transient)).toBe(true);
    });

    it("leaves a frozen error from the check as it is instead of throwing", async () => {
      const frozen = Object.freeze(new Error("relay closed the socket"));
      vi.spyOn(provider, "_send").mockImplementation((payload) => {
        const p = Array.isArray(payload) ? payload[0] : payload;
        if (p.method === "eth_estimateGas") {
          return Promise.reject(frozen);
        }
        return FakeProvider.prototype._send.call(provider, payload);
      });
      const error = await send().catch((e: unknown) => e);
      expect((error as Error).message).not.toContain("not extensible");
    });

    it("leaves errors thrown after the check unmarked", () => {
      expect(failedNextBlockCheck(new Error("broadcast failed"))).toBe(false);
    });
  });
});

describe("tagNextBlockSimulation", () => {
  it("leaves a frozen error as it is instead of throwing", () => {
    const frozen = Object.freeze(new Error("relay said no"));
    const simulation = {
      mode: "next-block",
      baseBlock: 1,
      assumedBlockNumber: 2,
      assumedTimestamp: 3,
      timestampOffsetSec: 1,
      rpcMethod: "eth_estimateGas+blockOverrides",
    } as const;
    expect(tagNextBlockSimulation(frozen, simulation)).toBe(frozen);
    expect(getNextBlockSimulation(frozen)).toBeUndefined();
  });
});

describe("isNextBlockSimulationUnsupported", () => {
  it("recognises the error by name and marker, not by class identity", () => {
    // A copy of the class from another bundle is a different constructor.
    const fromAnotherBundle = Object.assign(new Error("no"), {
      name: "NextBlockSimulationUnsupportedError",
      nonRetryable: true,
    });
    expect(isNextBlockSimulationUnsupported(fromAnotherBundle)).toBe(true);
    expect(
      isNextBlockSimulationUnsupported(
        new NextBlockSimulationUnsupportedError("x")
      )
    ).toBe(true);
    expect(isNextBlockSimulationUnsupported(new Error("x"))).toBe(false);
    expect(
      isNextBlockSimulationUnsupported({
        name: "NextBlockSimulationUnsupportedError",
      })
    ).toBe(false);
  });
});
