import { describe, expect, it } from "vitest";
import {
  formatGasAsEth,
  formatGasExactEth,
  formatGasSplit,
  gasDecimals,
  walletShareWei,
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
    expect(formatGasAsEth(null)).toBe("-");
    expect(formatGasAsEth("0")).toBe("0 ETH");
  });
});

describe("formatGasExactEth", () => {
  // The value the headline renders as "0.0002 ETH", taken off a real receipt.
  it("keeps every wei the headline rounds away", () => {
    expect(formatGasExactEth("244920726760244")).toBe(
      "0.000244920726760244 ETH"
    );
    expect(formatGasAsEth("244920726760244", 4)).toBe("0.0002 ETH");
  });

  it("trims trailing zeros but keeps interior ones", () => {
    expect(formatGasExactEth("2374215600000000")).toBe("0.0023742156 ETH");
    expect(formatGasExactEth("1000000000000000000")).toBe("1 ETH");
    expect(formatGasExactEth("1000000000000000001")).toBe(
      "1.000000000000000001 ETH"
    );
  });

  it("renders a single wei rather than collapsing it to zero", () => {
    expect(formatGasExactEth("1")).toBe("0.000000000000000001 ETH");
  });

  it("stays exact past float53", () => {
    expect(formatGasExactEth("9007199254740993123456789")).toBe(
      "9007199.254740993123456789 ETH"
    );
  });

  it("returns -- for missing input and 0 ETH for zero", () => {
    expect(formatGasExactEth(null)).toBe("-");
    expect(formatGasExactEth("")).toBe("-");
    expect(formatGasExactEth("nonsense")).toBe("-");
    expect(formatGasExactEth("0")).toBe("0 ETH");
  });
});

describe("walletShareWei", () => {
  it("subtracts the sponsorship ledger from the run total", () => {
    expect(walletShareWei("13698054300000000", "11323838600000000")).toBe(
      "2374215700000000"
    );
  });

  it("returns the whole total when nothing was sponsored", () => {
    expect(walletShareWei("2374215600000000", "0")).toBe("2374215600000000");
  });

  it("returns 0 when every wei was sponsored", () => {
    expect(walletShareWei("11323838600000000", "11323838600000000")).toBe("0");
  });

  // Run start and ledger insert are different time axes, so a window edge can
  // hold a sponsored tx in one and not the other.
  it("clamps to 0 when the ledger exceeds the run total", () => {
    expect(walletShareWei("1000", "5000")).toBe("0");
  });

  it("stays exact beyond float53", () => {
    expect(walletShareWei("9007199254740993000", "1")).toBe(
      "9007199254740992999"
    );
  });

  it("falls back to the total when either figure is unparseable", () => {
    expect(walletShareWei("2374215600000000", "not-a-number")).toBe(
      "2374215600000000"
    );
  });
});

// The two sub-lines must add back to the headline, which is what broke when
// the wallet figure was the run total and sponsored was added on top of it.
describe("gas split against a real sponsored period", () => {
  it("renders wallet plus sponsored as the total", () => {
    const total = "13698054300000000";
    const sponsored = "11323838600000000";
    const split = formatGasSplit(walletShareWei(total, sponsored), sponsored);

    expect(split.wallet).toBe("0.0024 ETH");
    expect(split.sponsored).toBe("0.0113 ETH");
    expect(split.total).toBe("0.0137 ETH");
  });
});
