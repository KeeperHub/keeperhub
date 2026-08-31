import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockContract = vi.fn();
vi.mock("ethers", () => ({
  ethers: {
    Contract: class {
      uiMultiplier: () => Promise<bigint>;
      constructor(address: string) {
        this.uiMultiplier = () => mockContract(address);
      }
    },
  },
}));

// Mirrors the real classifier: CALL_EXCEPTION means the function is not there,
// a timeout means we simply could not reach the chain.
vi.mock("@/lib/rpc/providers/error-classification", () => ({
  isNonRetryableError: (e: unknown) =>
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { code: string }).code === "CALL_EXCEPTION",
}));

import {
  __clearUiMultiplierCache,
  chainMayScaleTokens,
  convertAmountForWrite,
  isScaledToken,
  rawToUi,
  resolveForDisplay,
  resolveForWrite,
  UI_MULTIPLIER_UNIT,
  uiToRaw,
} from "@/lib/web3/ui-multiplier";

const CRWD = "0xea72Ecca2d0f6bFA1394DBBCff85b52CD4233931";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const FOUR = BigInt(4) * UI_MULTIPLIER_UNIT;

const absent = () =>
  Object.assign(new Error("missing revert data"), {
    code: "CALL_EXCEPTION",
  });
const transient = () =>
  Object.assign(new Error("timeout"), { code: "TIMEOUT" });

const run = <T>(op: (p: never) => Promise<T>): Promise<T> =>
  op(undefined as never);

beforeEach(() => {
  __clearUiMultiplierCache();
  mockContract.mockReset();
});

describe("conversions", () => {
  it("is the identity at unit multiplier", () => {
    expect(rawToUi(BigInt(123), UI_MULTIPLIER_UNIT)).toBe(BigInt(123));
    expect(uiToRaw(BigInt(123), UI_MULTIPLIER_UNIT)).toBe(BigInt(123));
    expect(isScaledToken(UI_MULTIPLIER_UNIT)).toBe(false);
  });

  it("scales a real CRWD position the way the chain reports it", () => {
    // Live values: balanceOf 7.572731046613574564, balanceOfUI
    // 30.290924186454298256, exactly 4x.
    expect(rawToUi(BigInt("7572731046613574564"), FOUR)).toBe(
      BigInt("30290924186454298256")
    );
  });

  it("converts a typed amount down, not up: the over-send bug", () => {
    const tenUi = BigInt(10) * UI_MULTIPLIER_UNIT;
    expect(uiToRaw(tenUi, FOUR)).toBe(BigInt("2500000000000000000"));
  });

  it("floors rather than rounds up, so a transfer never exceeds the ask", () => {
    const aapl = BigInt("1000566080061092436"); // AAPL's live multiplier
    const tenUi = BigInt(10) * UI_MULTIPLIER_UNIT;
    const raw = uiToRaw(tenUi, aapl);
    expect(raw).toBeLessThan(tenUi);
    expect(rawToUi(raw, aapl)).toBeLessThanOrEqual(tenUi);
  });
});

describe("convertAmountForWrite", () => {
  it("rejects a non-zero amount that floors to zero", () => {
    // transfer(to, 0) succeeds and moves nothing; approve(spender, 0) is a
    // revocation. Either would be reported as the amount the user asked for.
    const result = convertAmountForWrite(BigInt(3), FOUR);
    expect(result.ok).toBe(false);
  });

  it("allows a genuine zero through", () => {
    const result = convertAmountForWrite(BigInt(0), FOUR);
    expect(result).toEqual({ ok: true, raw: BigInt(0) });
  });
});

describe("resolveForDisplay", () => {
  it("returns the on-chain multiplier", async () => {
    mockContract.mockResolvedValue(FOUR);
    await expect(resolveForDisplay(run, 4663, CRWD)).resolves.toBe(FOUR);
  });

  it("falls back to unit for a plain ERC-20", async () => {
    mockContract.mockRejectedValue(absent());
    await expect(resolveForDisplay(run, 4663, USDG)).resolves.toBe(
      UI_MULTIPLIER_UNIT
    );
  });

  it("keeps a known multiplier when a later refresh fails", async () => {
    vi.useFakeTimers();
    try {
      mockContract.mockResolvedValueOnce(FOUR);
      await resolveForDisplay(run, 4663, CRWD);
      expect(mockContract).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(10 * 60 * 1000);
      mockContract.mockRejectedValue(transient());

      // The refresh must actually be attempted, or this asserts nothing.
      await expect(resolveForDisplay(run, 4663, CRWD)).resolves.toBe(FOUR);
      expect(mockContract).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caches the absent verdict so a plain ERC-20 pays once", async () => {
    mockContract.mockRejectedValue(absent());
    await resolveForDisplay(run, 4663, USDG);
    await resolveForDisplay(run, 4663, USDG);
    expect(mockContract).toHaveBeenCalledTimes(1);
  });

  it("does NOT cache a transient failure", async () => {
    mockContract.mockRejectedValueOnce(transient());
    await expect(resolveForDisplay(run, 4663, CRWD)).resolves.toBe(
      UI_MULTIPLIER_UNIT
    );
    // A five-second blip must not pin the token to unit for the process.
    mockContract.mockResolvedValue(FOUR);
    await expect(resolveForDisplay(run, 4663, CRWD)).resolves.toBe(FOUR);
  });

  it("de-duplicates concurrent first reads", async () => {
    mockContract.mockResolvedValue(FOUR);
    await Promise.all([
      resolveForDisplay(run, 4663, CRWD),
      resolveForDisplay(run, 4663, CRWD),
      resolveForDisplay(run, 4663, CRWD),
    ]);
    expect(mockContract).toHaveBeenCalledTimes(1);
  });
});

describe("resolveForWrite", () => {
  it("refuses when the multiplier cannot be read", async () => {
    mockContract.mockRejectedValue(transient());
    const result = await resolveForWrite(run, 4663, CRWD);
    // Falling back to unit here would move 4x the intended amount.
    expect(result.ok).toBe(false);
  });

  it("accepts the permanent absent verdict without a call", async () => {
    mockContract.mockRejectedValue(absent());
    await resolveForWrite(run, 4663, USDG);
    const second = await resolveForWrite(run, 4663, USDG);
    expect(second).toEqual({ ok: true, multiplier: UI_MULTIPLIER_UNIT });
    expect(mockContract).toHaveBeenCalledTimes(1);
  });

  it("re-reads a positive multiplier rather than trusting the cache", async () => {
    mockContract.mockResolvedValue(FOUR);
    await resolveForWrite(run, 4663, CRWD);
    await resolveForWrite(run, 4663, CRWD);
    // updateMultiplier is callable at will, so a signature must not be built
    // on a value cached for a display.
    expect(mockContract).toHaveBeenCalledTimes(2);
  });

  it("treats a zero multiplier as absent rather than dividing by zero", async () => {
    mockContract.mockResolvedValue(BigInt(0));
    await expect(resolveForWrite(run, 4663, CRWD)).resolves.toEqual({
      ok: true,
      multiplier: UI_MULTIPLIER_UNIT,
    });
  });
});

describe("chain scoping", () => {
  it("knows which chains can host the standard", () => {
    expect(chainMayScaleTokens(4663)).toBe(true);
    expect(chainMayScaleTokens(46_630)).toBe(true);
    expect(chainMayScaleTokens(1)).toBe(false);
    expect(chainMayScaleTokens(8453)).toBe(false);
  });

  it("never probes a chain that cannot host one", async () => {
    mockContract.mockRejectedValue(transient());
    await expect(resolveForDisplay(run, 1, DAI)).resolves.toBe(
      UI_MULTIPLIER_UNIT
    );
    expect(mockContract).not.toHaveBeenCalled();
  });

  it("does not refuse a write on a chain that cannot host one", async () => {
    // The whole point of the scoping: a transient RPC failure must not block a
    // DAI transfer on Ethereum, where an ERC-8056 token cannot exist.
    mockContract.mockRejectedValue(transient());
    await expect(resolveForWrite(run, 1, DAI)).resolves.toEqual({
      ok: true,
      multiplier: UI_MULTIPLIER_UNIT,
    });
    expect(mockContract).not.toHaveBeenCalled();
  });
});
