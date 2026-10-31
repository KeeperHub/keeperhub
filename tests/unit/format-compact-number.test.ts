import { describe, expect, it } from "vitest";
import { formatCompactNumber } from "@/lib/utils/format-number";

describe("formatCompactNumber", () => {
  it("keeps one decimal at most", () => {
    expect(formatCompactNumber(950)).toBe("950");
    expect(formatCompactNumber(12_345)).toBe("12.3K");
    expect(formatCompactNumber(999_949)).toBe("999.9K");
    expect(formatCompactNumber(1_234_567)).toBe("1.2M");
  });
});
