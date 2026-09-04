import { describe, expect, it } from "vitest";
import { resourceLink } from "@/lib/policy/ui/resource-link";

const ORG = "org_1";

describe("where an identifier in a policy points", () => {
  it("sends a workflow to the workflow", () => {
    expect(resourceLink("kh:workflow/wf_9", ORG)?.href).toBe("/workflows/wf_9");
  });

  it.each([
    ["kh:apikey/key_1", "/settings/org_1/api-keys?highlight=key_1"],
    ["kh:member/user_1", "/settings/org_1/users?highlight=user_1"],
    ["kh:policy/pol_1", "/settings/org_1/policies?highlight=pol_1"],
    ["kh:wallet/w_1", "/settings/org_1/wallets?highlight=w_1"],
    ["kh:integration/i_1", "/settings/org_1/connections?highlight=i_1"],
  ])("sends %s to the page that manages it", (identifier, href) => {
    expect(resourceLink(identifier, ORG)?.href).toBe(href);
  });

  it("sends a contract to a block explorer, in a new tab", () => {
    const link = resourceLink(
      "kh:chain/1/contract/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/fn/0x18160ddd",
      ORG
    );
    expect(link?.external).toBe(true);
    expect(link?.href).toContain("etherscan.io/address/0xa0b8");
  });

  it("reads the chain, not just the address", () => {
    const link = resourceLink(
      "kh:chain/8453/asset/0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      ORG
    );
    expect(link?.href).toContain("basescan.org");
  });

  it("leaves a wildcard alone", () => {
    // `kh:workflow/*` names every workflow. A link to a workflow called `*`
    // is worse than no link.
    expect(resourceLink("kh:workflow/*", ORG)).toBeNull();
    expect(resourceLink("kh:chain/8453/contract/**", ORG)).toBeNull();
  });

  it("leaves a settings link alone when no organization is in hand", () => {
    expect(resourceLink("kh:apikey/key_1", null)).toBeNull();
  });

  it("leaves a chain nobody has an explorer for alone", () => {
    expect(resourceLink("kh:chain/999999/contract/0xabc", ORG)).toBeNull();
  });

  it("returns nothing for something that is not an identifier", () => {
    expect(resourceLink("not-an-arn", ORG)).toBeNull();
  });
});
