import { describe, expect, it } from "vitest";
import { publicTagSlug } from "@/lib/workflow/public-tag-slug";

describe("publicTagSlug", () => {
  it("lowercases and joins words with single dashes", () => {
    expect(publicTagSlug("Cross-chain Bridges")).toBe("cross-chain-bridges");
    expect(publicTagSlug("DeFi & Lending")).toBe("defi-lending");
  });

  it("drops leading and trailing spaces and symbols", () => {
    expect(publicTagSlug("  Monitoring  ")).toBe("monitoring");
    expect(publicTagSlug("--NFTs!")).toBe("nfts");
  });
});
