import { ethers } from "ethers";
import { describe, expect, it } from "vitest";
import {
  type Aggregate3Call,
  type Aggregate3Result,
  MULTICALL3_ADDRESS,
  STATE_CALL_MAX_BATCH,
  chunkCalls,
  decodeAggregate3,
  encodeAggregate3,
} from "../../src/chains/multicall3";
import {
  type ArmState,
  DEFAULT_HYSTERESIS_BPS,
  type EvaluationResult,
  type StateThresholdSubscription,
  type ThresholdFire,
  buildStateDispatchKey,
  decodeCallResult,
  evaluateThreshold,
  exitHolds,
  initialArmState,
} from "../../src/listener/state-threshold";

const coder = ethers.AbiCoder.defaultAbiCoder();

/** A health-factor style subscription: fire below 1.05, 18 decimals. */
function makeSub(
  overrides: Partial<StateThresholdSubscription> = {},
): StateThresholdSubscription {
  return {
    subscriptionId: "sub-1",
    workflowId: "wf-1",
    chainId: 1,
    contractAddress: "0x1111111111111111111111111111111111111111",
    callData: "0xdeadbeef",
    outputTypes: ["uint256"],
    outputIndex: 0,
    threshold: 100n,
    comparator: "lt",
    ...overrides,
  };
}

function ok(returnData: string): Aggregate3Result {
  return { success: true, returnData };
}

describe("decodeCallResult", () => {
  it("decodes a uint256 output", () => {
    const value = decodeCallResult(
      ok(coder.encode(["uint256"], [42n])),
      ["uint256"],
      0,
    );
    expect(value).toBe(42n);
  });

  it("decodes a negative int256 as negative, not as 2^256 - 1", () => {
    // The defect this test exists for: `decode(["uint256"], data)` succeeds
    // for any 32-byte word, so a decoder that tries uint256 first and only
    // falls back to int256 on a throw never reaches the fallback. An int256
    // of -1 then reads as 2^256 - 1, which on an `lt` threshold turns a
    // breach into the most comfortable value representable.
    const encoded = coder.encode(["int256"], [-1n]);
    expect(decodeCallResult(ok(encoded), ["int256"], 0)).toBe(-1n);
    // Same bytes under the wrong declared type - shown so the reason the
    // type must travel with the call is on the record, not inferred.
    expect(decodeCallResult(ok(encoded), ["uint256"], 0)).toBe(2n ** 256n - 1n);
  });

  it("selects the requested output from a multi-output return", () => {
    // Aave's getUserAccountData shape: healthFactor is the last of six.
    const outputs = [
      "uint256",
      "uint256",
      "uint256",
      "uint256",
      "uint256",
      "uint256",
    ];
    const encoded = coder.encode(outputs, [1n, 2n, 3n, 4n, 5n, 1_050n]);
    expect(decodeCallResult(ok(encoded), outputs, 5)).toBe(1_050n);
    expect(decodeCallResult(ok(encoded), outputs, 0)).toBe(1n);
  });

  it("decodes a named tuple output formatted in full", () => {
    const type = "tuple(uint256 a, uint256 b) result";
    const encoded = coder.encode([type], [[7n, 9n]]);
    // The tuple itself is not a comparable scalar, so it decodes to no value
    // rather than to something arbitrary.
    expect(decodeCallResult(ok(encoded), [type], 0)).toBeNull();
  });

  it("returns null for a reverted call", () => {
    expect(
      decodeCallResult({ success: false, returnData: "0x" }, ["uint256"], 0),
    ).toBeNull();
  });

  it("returns null when the data does not match the declared outputs", () => {
    expect(decodeCallResult(ok("0x1234"), ["uint256"], 0)).toBeNull();
  });

  it("returns null when the output index is out of range", () => {
    const encoded = coder.encode(["uint256"], [1n]);
    expect(decodeCallResult(ok(encoded), ["uint256"], 1)).toBeNull();
    expect(decodeCallResult(ok(encoded), ["uint256"], -1)).toBeNull();
  });

  it("returns null when the selected output is not numeric", () => {
    const encoded = coder.encode(["address"], [MULTICALL3_ADDRESS]);
    expect(decodeCallResult(ok(encoded), ["address"], 0)).toBeNull();
  });
});

describe("aggregate3 encoding", () => {
  it("round-trips through encode and decode with allowFailure set", () => {
    const calls: Aggregate3Call[] = [
      {
        target: "0x1111111111111111111111111111111111111111",
        callData: "0xaa",
      },
      {
        target: "0x2222222222222222222222222222222222222222",
        callData: "0xbb",
      },
    ];
    const data = encodeAggregate3(calls);

    // Decode the calldata back through the same ABI to assert the batch
    // actually carries what was asked, rather than asserting on a plain
    // object that nothing sends.
    const iface = new ethers.Interface([
      "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
    ]);
    const [decodedCalls] = iface.decodeFunctionData("aggregate3", data);
    expect(decodedCalls).toHaveLength(2);
    for (const [index, call] of (
      decodedCalls as Array<[string, boolean, string]>
    ).entries()) {
      expect(call[0].toLowerCase()).toBe(calls[index].target.toLowerCase());
      expect(call[1]).toBe(true);
      expect(call[2]).toBe(calls[index].callData);
    }

    const returned = iface.encodeFunctionResult("aggregate3", [
      [
        [true, coder.encode(["uint256"], [1n])],
        [false, "0x"],
      ],
    ]);
    const slots = decodeAggregate3(returned);
    expect(slots).toHaveLength(2);
    expect(slots[0].success).toBe(true);
    expect(slots[1].success).toBe(false);
    expect(decodeCallResult(slots[0], ["uint256"], 0)).toBe(1n);
    expect(decodeCallResult(slots[1], ["uint256"], 0)).toBeNull();
  });
});

describe("chunkCalls", () => {
  it("splits at the batch ceiling and leaves a remainder chunk", () => {
    const items = Array.from({ length: STATE_CALL_MAX_BATCH + 3 }, (_, i) => i);
    const chunks = chunkCalls(items);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(STATE_CALL_MAX_BATCH);
    expect(chunks[1]).toHaveLength(3);
    expect(chunks.flat()).toEqual(items);
  });

  it("produces no chunks for an empty list", () => {
    expect(chunkCalls([])).toEqual([]);
  });

  it("falls back to the ceiling for a non-positive size", () => {
    const items = Array.from({ length: 3 }, (_, i) => i);
    expect(chunkCalls(items, 0)).toEqual([items]);
  });
});

describe("evaluateThreshold", () => {
  it("fires on the first sample in breach and disarms", () => {
    const sub = makeSub();
    const result: EvaluationResult = evaluateThreshold(
      sub,
      50n,
      10,
      initialArmState(10),
    );
    const fired = result.fired as ThresholdFire;
    expect(fired.dispatchKey).toBe("state:wf-1:1:sub-1:10");
    expect(fired.observedValue).toBe(50n);
    expect(fired.threshold).toBe(sub.threshold);
    expect(fired.comparator).toBe("lt");
    // The sampled height is reported, but is not what the key is built from.
    expect(fired.blockNumber).toBe(10);
    expect(result.nextState).toEqual({
      phase: "FIRED",
      armGeneration: 10,
      lastFiredBlock: 10,
    });
  });

  it("does not fire while the condition does not hold", () => {
    const sub = makeSub();
    const armed = initialArmState(10);
    const result = evaluateThreshold(sub, 200n, 11, armed);
    expect(result.fired).toBeNull();
    expect(result.nextState).toBe(armed);
  });

  it("does not re-fire across the blocks the condition keeps holding", () => {
    const sub = makeSub();
    let state = initialArmState(10);
    const keys: string[] = [];
    for (const [block, value] of [
      [10, 50n],
      [11, 40n],
      [12, 30n],
      [13, 45n],
    ] as const) {
      const result = evaluateThreshold(sub, value, block, state);
      if (result.fired) {
        keys.push(result.fired.dispatchKey);
      }
      state = result.nextState;
    }
    expect(keys).toEqual(["state:wf-1:1:sub-1:10"]);
    expect(state.phase).toBe("FIRED");
  });

  it("re-arms at a new generation once the band is cleared, without firing", () => {
    const sub = makeSub({ hysteresis: 10n });
    const fired = evaluateThreshold(sub, 50n, 10, initialArmState(10));
    // Back above the threshold but still inside the band: no re-arm.
    const inBand = evaluateThreshold(sub, 105n, 11, fired.nextState);
    expect(inBand.fired).toBeNull();
    expect(inBand.nextState.phase).toBe("FIRED");
    expect(inBand.nextState.armGeneration).toBe(10);
    // Past the band: re-arms silently at the current block.
    const cleared = evaluateThreshold(sub, 111n, 12, inBand.nextState);
    expect(cleared.fired).toBeNull();
    expect(cleared.nextState).toEqual({
      phase: "ARMED",
      armGeneration: 12,
      lastFiredBlock: 10,
    });
    // The next breach is a different episode, so a different key.
    const again = evaluateThreshold(sub, 50n, 13, cleared.nextState);
    expect(again.fired?.dispatchKey).toBe("state:wf-1:1:sub-1:12");
  });

  it("does not oscillate on a value resting on the threshold", () => {
    // The exit predicate is not `!enter`. A value alternating either side of
    // the threshold by one unit would fire on every other sample if it were.
    const sub = makeSub({ hysteresis: 10n });
    let state: ArmState = initialArmState(1);
    let fires = 0;
    for (let block = 1; block <= 40; block += 1) {
      const value = block % 2 === 0 ? 99n : 101n;
      const result = evaluateThreshold(sub, value, block, state);
      if (result.fired) {
        fires += 1;
      }
      state = result.nextState;
    }
    expect(fires).toBe(1);
  });

  it("defaults the band to DEFAULT_HYSTERESIS_BPS of the threshold", () => {
    const sub = makeSub({ threshold: 10_000n });
    expect(DEFAULT_HYSTERESIS_BPS).toBe(200n);
    // 2% of 10000 is 200, so 10200 is on the boundary and does not clear it.
    expect(exitHolds(10_200n, sub)).toBe(false);
    expect(exitHolds(10_201n, sub)).toBe(true);
  });

  it("mirrors the band below the threshold for gt/gte", () => {
    const sub = makeSub({ comparator: "gt", threshold: 10_000n });
    const fired = evaluateThreshold(sub, 10_001n, 5, initialArmState(5));
    expect(fired.fired).not.toBeNull();
    expect(exitHolds(9_800n, sub)).toBe(false);
    expect(exitHolds(9_799n, sub)).toBe(true);
  });

  it("holds a dispatch inside the cooldown without losing it", () => {
    const sub = makeSub({ hysteresis: 10n, minBlocksBetweenFires: 5 });
    const first = evaluateThreshold(sub, 50n, 10, initialArmState(10));
    expect(first.fired).not.toBeNull();
    const cleared = evaluateThreshold(sub, 200n, 11, first.nextState);
    expect(cleared.nextState.phase).toBe("ARMED");

    // Back in breach two blocks later: inside the cooldown, so held, and the
    // generation does not move - the episode is still the one opened at 11.
    const held = evaluateThreshold(sub, 50n, 12, cleared.nextState);
    expect(held.fired).toBeNull();
    expect(held.nextState).toBe(cleared.nextState);

    // Past the floor: the held dispatch goes out, under that same generation.
    const released = evaluateThreshold(sub, 50n, 16, held.nextState);
    expect(released.fired?.dispatchKey).toBe("state:wf-1:1:sub-1:11");
  });

  it("supports every comparator at its boundary", () => {
    const cases: Array<
      [StateThresholdSubscription["comparator"], bigint, boolean]
    > = [
      ["lt", 100n, false],
      ["lt", 99n, true],
      ["lte", 100n, true],
      ["gt", 100n, false],
      ["gt", 101n, true],
      ["gte", 100n, true],
    ];
    for (const [comparator, value, shouldFire] of cases) {
      const sub = makeSub({ comparator, threshold: 100n });
      const result = evaluateThreshold(sub, value, 1, initialArmState(1));
      expect(result.fired !== null, `${comparator} at ${value}`).toBe(
        shouldFire,
      );
    }
  });

  it("rebuilds the same key for a crossing re-observed at another height", () => {
    // Reorg safety: the key carries the arming generation, not the block the
    // value was sampled at, so the same episode cannot dispatch twice.
    const sub = makeSub();
    const state = initialArmState(10);
    const atBlock12 = evaluateThreshold(sub, 50n, 12, state);
    const atBlock11 = evaluateThreshold(sub, 50n, 11, state);
    expect(atBlock12.fired?.dispatchKey).toBe(atBlock11.fired?.dispatchKey);
    expect(atBlock12.fired?.dispatchKey).toBe(
      buildStateDispatchKey(sub, state.armGeneration),
    );
  });
});
