import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  buildPerChainEarnings,
  computeRevenueSplit,
  deriveSettlementStatus,
  formatUsdc,
  groupTopCallers,
  parsePlatformFeePercent,
} from "@/lib/earnings/queries";

describe("parsePlatformFeePercent", () => {
  it('returns 30 for "30"', () => {
    expect(parsePlatformFeePercent("30")).toBe(30);
  });

  it("returns 30 for undefined", () => {
    expect(parsePlatformFeePercent(undefined)).toBe(30);
  });

  it('returns 30 for "abc" (non-numeric fallback)', () => {
    expect(parsePlatformFeePercent("abc")).toBe(30);
  });

  it('returns 0 for "0" (legitimate fee waiver, not coerced to default)', () => {
    expect(parsePlatformFeePercent("0")).toBe(0);
  });

  it('returns 100 for "100" (full platform take)', () => {
    expect(parsePlatformFeePercent("100")).toBe(100);
  });

  it('returns 30 for "-5" (negative out of range)', () => {
    expect(parsePlatformFeePercent("-5")).toBe(30);
  });

  it('returns 30 for "150" (>100 out of range)', () => {
    expect(parsePlatformFeePercent("150")).toBe(30);
  });
});

describe("computeRevenueSplit", () => {
  it("returns correct 70/30 split for gross=100", () => {
    const result = computeRevenueSplit(100, 30);
    expect(result.creatorShare).toBeCloseTo(70);
    expect(result.platformFee).toBeCloseTo(30);
  });

  it("returns full amount to creator when fee is 0", () => {
    const result = computeRevenueSplit(100, 0);
    expect(result.creatorShare).toBe(100);
    expect(result.platformFee).toBe(0);
  });

  it("returns zeros when gross is 0", () => {
    const result = computeRevenueSplit(0, 30);
    expect(result.creatorShare).toBe(0);
    expect(result.platformFee).toBe(0);
  });

  it("handles fractional splits correctly for gross=99.99", () => {
    const result = computeRevenueSplit(99.99, 30);
    expect(result.creatorShare).toBeCloseTo(69.993);
    expect(result.platformFee).toBeCloseTo(29.997);
    expect(result.creatorShare + result.platformFee).toBeCloseTo(99.99);
  });
});

describe("formatUsdc", () => {
  it('returns "$70.00 USDC" for 70', () => {
    expect(formatUsdc(70)).toBe("$70.00 USDC");
  });

  it('returns "$0.00 USDC" for 0', () => {
    expect(formatUsdc(0)).toBe("$0.00 USDC");
  });

  it("formats fractional amounts to 2 decimal places", () => {
    expect(formatUsdc(1.5)).toBe("$1.50 USDC");
    expect(formatUsdc(99.999)).toBe("$100.00 USDC");
  });
});

describe("deriveSettlementStatus", () => {
  it('returns "settled" when invocationCount > 0', () => {
    expect(deriveSettlementStatus(5)).toBe("settled");
    expect(deriveSettlementStatus(1)).toBe("settled");
  });

  it('returns "no_payments" when invocationCount is 0', () => {
    expect(deriveSettlementStatus(0)).toBe("no_payments");
  });
});

describe("groupTopCallers", () => {
  it("groups by workflowId and returns top 3 by call count descending", () => {
    const rows = [
      { workflowId: "wf-1", payerAddress: "0xAAA", callCount: 5 },
      { workflowId: "wf-1", payerAddress: "0xBBB", callCount: 10 },
      { workflowId: "wf-1", payerAddress: "0xCCC", callCount: 3 },
      { workflowId: "wf-1", payerAddress: "0xDDD", callCount: 1 },
      { workflowId: "wf-2", payerAddress: "0xEEE", callCount: 7 },
    ];
    const result = groupTopCallers(rows);

    const wf1Callers = result.get("wf-1") ?? [];
    expect(wf1Callers).toHaveLength(3);
    expect(wf1Callers[0]).toBe("0xBBB");
    expect(wf1Callers[1]).toBe("0xAAA");
    expect(wf1Callers[2]).toBe("0xCCC");

    const wf2Callers = result.get("wf-2") ?? [];
    expect(wf2Callers).toHaveLength(1);
    expect(wf2Callers[0]).toBe("0xEEE");
  });

  it("excludes null addresses (empty string treated as excluded)", () => {
    const rows = [
      { workflowId: "wf-1", payerAddress: "0xAAA", callCount: 5 },
      { workflowId: "wf-1", payerAddress: "0xBBB", callCount: 10 },
    ];
    const result = groupTopCallers(rows);
    const wf1Callers = result.get("wf-1") ?? [];
    expect(wf1Callers.every((addr: string) => addr.length > 0)).toBe(true);
  });

  it("limits to top 3 per workflow", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      workflowId: "wf-1",
      payerAddress: `0x${String(i).padStart(40, "0")}`,
      callCount: 10 - i,
    }));
    const result = groupTopCallers(rows);
    expect((result.get("wf-1") ?? []).length).toBe(3);
  });

  it("returns empty map for empty input", () => {
    const result = groupTopCallers([]);
    expect(result.size).toBe(0);
  });
});

describe("buildPerChainEarnings", () => {
  it("returns zeros for both chains when no rows are present", () => {
    const result = buildPerChainEarnings([]);
    expect(result.base).toEqual({
      grossRevenue: "$0.00 USDC",
      invocationCount: 0,
    });
    expect(result.tempo).toEqual({
      grossRevenue: "$0.00 USDC",
      invocationCount: 0,
    });
  });

  it("maps base and tempo chain rows into the fixed shape", () => {
    const result = buildPerChainEarnings([
      { chain: "base", grossRevenue: "1.50", invocationCount: 15 },
      { chain: "tempo", grossRevenue: "0.75", invocationCount: 9 },
    ]);
    expect(result.base.grossRevenue).toBe("$1.50 USDC");
    expect(result.base.invocationCount).toBe(15);
    expect(result.tempo.grossRevenue).toBe("$0.75 USDC");
    expect(result.tempo.invocationCount).toBe(9);
  });

  it("leaves the missing chain at zero when only one chain has activity", () => {
    const result = buildPerChainEarnings([
      { chain: "base", grossRevenue: "2.00", invocationCount: 20 },
    ]);
    expect(result.base.grossRevenue).toBe("$2.00 USDC");
    expect(result.tempo.grossRevenue).toBe("$0.00 USDC");
    expect(result.tempo.invocationCount).toBe(0);
  });

  it("ignores unknown chain values without throwing", () => {
    const result = buildPerChainEarnings([
      { chain: "solana", grossRevenue: "99.00", invocationCount: 1 },
    ]);
    expect(result.base.grossRevenue).toBe("$0.00 USDC");
    expect(result.tempo.grossRevenue).toBe("$0.00 USDC");
  });

  it("treats null grossRevenue as zero", () => {
    const result = buildPerChainEarnings([
      { chain: "base", grossRevenue: null, invocationCount: 0 },
    ]);
    expect(result.base.grossRevenue).toBe("$0.00 USDC");
    expect(result.base.invocationCount).toBe(0);
  });
});
