import { describe, expect, it } from "vitest";
import { getChainName, getExplorerUrl } from "@/lib/chain-utils";

describe("chain utilities", () => {
  it("labels Hoodi instead of falling back to its numeric chain ID", () => {
    expect(getChainName("560048")).toBe("Ethereum Hoodi");
  });

  it("builds a Hoodi Etherscan address URL", () => {
    expect(getExplorerUrl("560048", "0xabc")).toBe(
      "https://hoodi.etherscan.io/address/0xabc"
    );
  });
});
