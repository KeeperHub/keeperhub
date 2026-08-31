import { ethers } from "ethers";
import { describe, expect, it } from "vitest";

import {
  encodeExactInSingleSwap,
  type PoolKey,
} from "@/plugins/robinhood/steps/v4-swap-encoding";

const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const AAPL = "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9";
const ZERO_HOOKS = "0x0000000000000000000000000000000000000000";

// Live pool shape: USDG sorts below AAPL. The USDG-quoted stock pools that
// actually trade are hookless and use canonical tiers (NVDA at 3000/60, AMD,
// MU and SNDK at 10000/200). Pools elsewhere on this chain do carry hooks and
// dynamic fees, so this is a fact about the stock pairs, not the chain.
const POOL: PoolKey = {
  currency0: USDG,
  currency1: AAPL,
  fee: 10_000,
  tickSpacing: 200,
  hooks: ZERO_HOOKS,
};

const coder = ethers.AbiCoder.defaultAbiCoder();
const ONE_USDG = BigInt(1_000_000); // 6 decimals
const MIN_OUT = BigInt("3000000000000000"); // 0.003 AAPL, 18 decimals

function decodeV4Input(input: string) {
  const [actions, params] = coder.decode(["bytes", "bytes[]"], input);
  return { actions: actions as string, params: params as string[] };
}

describe("command and action sequence", () => {
  it("issues V4_SWAP with swap, settle, take in that order", () => {
    const encoded = encodeExactInSingleSwap({
      poolKey: POOL,
      inputCurrency: USDG,
      amountIn: ONE_USDG,
      minAmountOut: MIN_OUT,
    });

    // 0x10 is Commands.V4_SWAP in the deployed router.
    expect(encoded.commands).toBe("0x10");
    expect(encoded.inputs).toHaveLength(1);

    const { actions, params } = decodeV4Input(encoded.inputs[0]);
    // SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL.
    expect(actions).toBe("0x060c0f");
    expect(params).toHaveLength(3);
  });
});

describe("the non-canonical struct", () => {
  it("encodes six fields, not the five upstream v4 defines", () => {
    const encoded = encodeExactInSingleSwap({
      poolKey: POOL,
      inputCurrency: USDG,
      amountIn: ONE_USDG,
      minAmountOut: MIN_OUT,
    });
    const { params } = decodeV4Input(encoded.inputs[0]);

    // Decoding with the deployed shape must round-trip. If this file is ever
    // "corrected" to the canonical five-field struct, this fails.
    const [decoded] = coder.decode(
      [
        "tuple(tuple(address,address,uint24,int24,address),bool,uint128,uint128,uint256,bytes)",
      ],
      params[0]
    );
    expect(decoded[1]).toBe(true); // zeroForOne
    expect(decoded[2]).toBe(ONE_USDG);
    expect(decoded[3]).toBe(MIN_OUT);
    expect(decoded[4]).toBe(BigInt(0)); // minHopPriceX36 disabled
    expect(decoded[5]).toBe("0x"); // hookData lands where it should

    // And the canonical five-field shape must NOT round-trip to the same
    // values, which is the whole reason this encoding is hand-written.
    const canonical = coder.encode(
      [
        "tuple(tuple(address,address,uint24,int24,address),bool,uint128,uint128,bytes)",
      ],
      [[[USDG, AAPL, 10_000, 200, ZERO_HOOKS], true, ONE_USDG, MIN_OUT, "0x"]]
    );
    expect(canonical).not.toBe(params[0]);
  });
});

describe("direction is derived, never trusted", () => {
  it("buys the stock when spending the quote currency", () => {
    const encoded = encodeExactInSingleSwap({
      poolKey: POOL,
      inputCurrency: USDG,
      amountIn: ONE_USDG,
      minAmountOut: MIN_OUT,
    });
    expect(encoded.zeroForOne).toBe(true);
    expect(encoded.outputCurrency).toBe(ethers.getAddress(AAPL));
  });

  it("sells the stock when spending the stock", () => {
    const encoded = encodeExactInSingleSwap({
      poolKey: POOL,
      inputCurrency: AAPL,
      amountIn: MIN_OUT,
      minAmountOut: ONE_USDG,
    });
    expect(encoded.zeroForOne).toBe(false);
    expect(encoded.outputCurrency).toBe(ethers.getAddress(USDG));
  });

  it("refuses a currency that is not in the pool", () => {
    expect(() =>
      encodeExactInSingleSwap({
        poolKey: POOL,
        inputCurrency: "0x000000000000000000000000000000000000dEaD",
        amountIn: ONE_USDG,
        minAmountOut: MIN_OUT,
      })
    ).toThrow(/not part of this pool/);
  });
});

describe("settle and take carry the bounds", () => {
  it("caps the input at amountIn and floors the output at minAmountOut", () => {
    const encoded = encodeExactInSingleSwap({
      poolKey: POOL,
      inputCurrency: USDG,
      amountIn: ONE_USDG,
      minAmountOut: MIN_OUT,
    });
    const { params } = decodeV4Input(encoded.inputs[0]);

    const [settleCurrency, settleMax] = coder.decode(
      ["address", "uint256"],
      params[1]
    );
    expect(settleCurrency).toBe(ethers.getAddress(USDG));
    expect(settleMax).toBe(ONE_USDG);

    // TAKE_ALL reverts below this, which is the second of the two places the
    // minimum is enforced on-chain.
    const [takeCurrency, takeMin] = coder.decode(
      ["address", "uint256"],
      params[2]
    );
    expect(takeCurrency).toBe(ethers.getAddress(AAPL));
    expect(takeMin).toBe(MIN_OUT);
  });
});

describe("refusals", () => {
  it("rejects an unsorted pool key rather than hashing to a nonexistent pool", () => {
    expect(() =>
      encodeExactInSingleSwap({
        poolKey: { ...POOL, currency0: AAPL, currency1: USDG },
        inputCurrency: AAPL,
        amountIn: ONE_USDG,
        minAmountOut: MIN_OUT,
      })
    ).toThrow(/sorted/);
  });

  it("rejects a zero minimum, which is an unbounded swap", () => {
    expect(() =>
      encodeExactInSingleSwap({
        poolKey: POOL,
        inputCurrency: USDG,
        amountIn: ONE_USDG,
        minAmountOut: BigInt(0),
      })
    ).toThrow(/minAmountOut/);
  });

  it("rejects a zero input", () => {
    expect(() =>
      encodeExactInSingleSwap({
        poolKey: POOL,
        inputCurrency: USDG,
        amountIn: BigInt(0),
        minAmountOut: MIN_OUT,
      })
    ).toThrow(/amountIn/);
  });

  it("rejects amounts that do not fit uint128", () => {
    expect(() =>
      encodeExactInSingleSwap({
        poolKey: POOL,
        inputCurrency: USDG,
        amountIn: BigInt(1) << BigInt(128),
        minAmountOut: MIN_OUT,
      })
    ).toThrow(/uint128/);
  });
});
