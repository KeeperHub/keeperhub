import { describe, expect, it } from "vitest";
import { toSpendCaps } from "@/lib/wallet/spend-cap";

const RESPONSE = {
  dailyCapWei: null,
  dailyUsedWei: "5000000000000000",
  dailySolanaCapLamports: "1000000000",
  dailySolanaUsedLamports: "250000000",
  effectiveDailyCapWei: "20000000000000000",
  effectiveDailySolanaCapLamports: "1000000000",
  usingDefaultDailyCap: true,
  usingDefaultDailySolanaCap: false,
};

describe("toSpendCaps", () => {
  it("carries the enforced figure through for a chain family with no cap of its own", () => {
    const [evm] = toSpendCaps(RESPONSE);

    // An unset cap is not an uncapped one: the row has to be able to show the
    // platform default the API is enforcing.
    expect(evm.cap).toBeNull();
    expect(evm.effectiveCap).toBe("20000000000000000");
    expect(evm.usingDefault).toBe(true);
  });

  it("reports a configured cap as the org's own", () => {
    const [, solana] = toSpendCaps(RESPONSE);

    expect(solana.cap).toBe("1000000000");
    expect(solana.effectiveCap).toBe("1000000000");
    expect(solana.usingDefault).toBe(false);
  });

  it("claims no default when the response is missing", () => {
    for (const cap of toSpendCaps(null)) {
      expect(cap.effectiveCap).toBeNull();
      expect(cap.usingDefault).toBe(false);
    }
  });
});
