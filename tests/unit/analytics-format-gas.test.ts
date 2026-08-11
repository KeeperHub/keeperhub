import { describe, expect, it } from "vitest";
import {
  formatGasAsEth,
  formatGasSplit,
  gasDecimals,
} from "@/lib/analytics/format-gas";

const ETH_AMOUNT_RE = /^([\d.]+) ETH$/;

function amount(formatted: string): number {
  const match = formatted.match(ETH_AMOUNT_RE);
  if (!match) {
    throw new Error(`not an ETH amount: ${formatted}`);
  }
  return Number(match[1]);
}

describe("formatGasSplit", () => {
  it("widens past four decimals so sub-0.0001 parts stay visible", () => {
    // 0.00004 + 0.00021 shows as 0.0000 + 0.0002 against a 0.0003 total at a
    // fixed four decimals.
    const split = formatGasSplit("40000000000000", "210000000000000");

    expect(split.wallet).toBe("0.000040 ETH");
    expect(split.sponsored).toBe("0.000210 ETH");
    expect(split.total).toBe("0.000250 ETH");
    expect(amount(split.wallet) + amount(split.sponsored)).toBeCloseTo(
      amount(split.total),
      12
    );
  });

  it("folds a carry residual into the larger part", () => {
    // 0.01113 + 0.02223 rounds to 0.0111 + 0.0222, one ulp short of the
    // 0.0334 total.
    const split = formatGasSplit("11130000000000000", "22230000000000000");

    expect(split.total).toBe("0.0334 ETH");
    expect(split.wallet).toBe("0.0111 ETH");
    expect(split.sponsored).toBe("0.0223 ETH");
    expect(amount(split.wallet) + amount(split.sponsored)).toBeCloseTo(
      amount(split.total),
      12
    );
  });

  it("stays at four decimals once every figure is large enough", () => {
    const split = formatGasSplit("12000000000000000", "34000000000000000");

    expect(split.wallet).toBe("0.0120 ETH");
    expect(split.sponsored).toBe("0.0340 ETH");
    expect(split.total).toBe("0.0460 ETH");
  });

  it("renders a zero part as 0 ETH without widening the others", () => {
    const split = formatGasSplit("0", "210000000000000");

    expect(split.wallet).toBe("0 ETH");
    expect(split.sponsored).toBe("0.00021 ETH");
    expect(split.total).toBe("0.00021 ETH");
  });

  it("treats unparseable wei as zero", () => {
    const split = formatGasSplit("not-a-number", "0");

    expect(split.total).toBe("0 ETH");
  });
});

describe("gasDecimals", () => {
  it("widens until the smallest non-zero figure has two significant digits", () => {
    expect(gasDecimals([BigInt("10000000000000000")])).toBe(4);
    expect(gasDecimals([BigInt("40000000000000")])).toBe(6);
    expect(
      gasDecimals([BigInt("1000000000000000000"), BigInt("40000000000000")])
    ).toBe(6);
  });

  it("caps the widening so true dust does not blow out the label", () => {
    expect(gasDecimals([BigInt(1)])).toBe(8);
  });

  it("ignores zero and unparseable entries", () => {
    expect(gasDecimals([BigInt(0), null])).toBe(4);
  });
});

describe("formatGasAsEth", () => {
  it("rounds half-up at the requested precision", () => {
    expect(formatGasAsEth("5000000000000", 4)).toBe("0.0000 ETH");
    expect(formatGasAsEth("50000000000000", 4)).toBe("0.0001 ETH");
    expect(formatGasAsEth("210000000000000", 6)).toBe("0.000210 ETH");
  });

  it("keeps full precision on values beyond float53", () => {
    expect(formatGasAsEth("1234567890123456789", 4)).toBe("1.2346 ETH");
  });

  it("returns -- for missing input and 0 ETH for zero", () => {
    expect(formatGasAsEth(null)).toBe("--");
    expect(formatGasAsEth("0")).toBe("0 ETH");
  });
});
