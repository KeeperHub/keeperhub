import { describe, expect, it } from "vitest";
import { buildAddressUrl, joinExplorerUrl } from "@/lib/build-explorer-url";

describe("joinExplorerUrl", () => {
  it("preserves a query string on the base (Solana devnet cluster)", () => {
    expect(
      joinExplorerUrl("https://solscan.io/?cluster=devnet", "/tx/abc123")
    ).toBe("https://solscan.io/tx/abc123?cluster=devnet");
    expect(
      joinExplorerUrl("https://solscan.io/?cluster=devnet", "/account/4k3Dyjz")
    ).toBe("https://solscan.io/account/4k3Dyjz?cluster=devnet");
  });

  it("places the query before a path fragment", () => {
    expect(
      joinExplorerUrl(
        "https://solscan.io/?cluster=devnet",
        "/account/4k3Dyjz#anchorProgramIDL"
      )
    ).toBe(
      "https://solscan.io/account/4k3Dyjz?cluster=devnet#anchorProgramIDL"
    );
  });

  it("leaves query-less bases unchanged (EVM / Solana mainnet)", () => {
    expect(joinExplorerUrl("https://etherscan.io", "/tx/0xdead")).toBe(
      "https://etherscan.io/tx/0xdead"
    );
    expect(joinExplorerUrl("https://etherscan.io", "/address/0xabc#code")).toBe(
      "https://etherscan.io/address/0xabc#code"
    );
    expect(joinExplorerUrl("https://solscan.io", "/account/So111")).toBe(
      "https://solscan.io/account/So111"
    );
  });
});

describe("buildAddressUrl", () => {
  it("returns null when explorer url or path is missing", () => {
    expect(buildAddressUrl(null, "/address/{address}", "0xabc")).toBeNull();
    expect(buildAddressUrl("https://etherscan.io", null, "0xabc")).toBeNull();
  });

  it("builds a Solana devnet address url with the cluster preserved", () => {
    expect(
      buildAddressUrl(
        "https://solscan.io/?cluster=devnet",
        "/account/{address}",
        "4k3Dyjz"
      )
    ).toBe("https://solscan.io/account/4k3Dyjz?cluster=devnet");
  });

  it("builds an EVM address url", () => {
    expect(
      buildAddressUrl("https://etherscan.io", "/address/{address}", "0xabc")
    ).toBe("https://etherscan.io/address/0xabc");
  });
});
