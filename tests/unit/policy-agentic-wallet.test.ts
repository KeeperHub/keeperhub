import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const enforcePolicy = vi.fn();
vi.mock("@/lib/policy/guard", () => ({
  enforcePolicy: (...args: unknown[]) => enforcePolicy(...args),
}));

const { enforceAgenticWalletPolicy } = await import(
  "@/lib/policy/agentic-wallet"
);

const BASE = {
  organizationId: "org_1",
  subOrgId: "sub_1",
  chainId: 8453,
  recipient: "0xAbCdEf0000000000000000000000000000000001",
};

function factsFromLastCall(): Record<string, { value?: unknown }> {
  const [{ facts }] = enforcePolicy.mock.calls[0] as [
    { facts: Record<string, { value?: unknown }> },
  ];
  return facts;
}

beforeEach(() => {
  vi.clearAllMocks();
  enforcePolicy.mockResolvedValue({
    blocked: false,
    decision: { reason: "unmanaged" },
  });
});

describe("agentic wallet policy", () => {
  it("judges a payment as a token transfer", async () => {
    await enforceAgenticWalletPolicy({ ...BASE, amountMicro: "1500000" });
    expect(enforcePolicy).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "asset.transfer.token" })
    );
  });

  it.each([
    ["1500000", "1.5"],
    ["1000000", "1"],
    ["1", "0.000001"],
    ["0", "0"],
    ["123456789", "123.456789"],
    ["999999", "0.999999"],
  ])("reads %s micro-dollars as %s", async (micro, usd) => {
    await enforceAgenticWalletPolicy({ ...BASE, amountMicro: micro });
    expect(factsFromLastCall().usdValue.value).toBe(usd);
  });

  it("leaves the value absent when the amount is not a whole number of micros", async () => {
    await enforceAgenticWalletPolicy({ ...BASE, amountMicro: "1.5" });
    expect(factsFromLastCall().usdValue.value).toBeUndefined();
  });

  it("lowercases the recipient so a rule matches whatever case it arrives in", async () => {
    await enforceAgenticWalletPolicy({ ...BASE, amountMicro: "1000000" });
    expect(factsFromLastCall().resourceId.value).toBe(
      BASE.recipient.toLowerCase()
    );
  });

  it("presents the asset as the resource, as every other transfer does", async () => {
    // Not the recipient. A rule scoped to an asset has to bind here too, and
    // who gets paid is carried as a counterparty.
    await enforceAgenticWalletPolicy({
      ...BASE,
      amountMicro: "1000000",
      tokenAddress: "0xDEADBEEF00000000000000000000000000000001",
    });
    expect(factsFromLastCall().resource.value).toBe(
      "kh:chain/8453/asset/0xdeadbeef00000000000000000000000000000001"
    );
  });

  it("carries the recipient as a counterparty", async () => {
    await enforceAgenticWalletPolicy({ ...BASE, amountMicro: "1000000" });
    expect(factsFromLastCall().counterparties.value).toEqual([
      { address: BASE.recipient.toLowerCase(), role: "recipient" },
    ]);
  });

  it("names the agent so a rule can bound this surface", async () => {
    await enforceAgenticWalletPolicy({ ...BASE, amountMicro: "1000000" });
    expect(factsFromLastCall().triggerType.value).toBe("agent");
  });

  it("carries no recipient when the challenge names none", async () => {
    await enforceAgenticWalletPolicy({
      organizationId: "org_1",
      subOrgId: "sub_1",
      chainId: 8453,
    });
    expect(factsFromLastCall().resourceId.value).toBeUndefined();
  });

  it("refuses when policy refuses", async () => {
    enforcePolicy.mockResolvedValue({
      blocked: true,
      decision: { reason: "explicit_deny", message: "Blocked by a policy" },
    });
    const refusal = await enforceAgenticWalletPolicy({
      ...BASE,
      amountMicro: "1000000",
    });
    expect(refusal?.status).toBe(403);
    await expect(refusal?.json()).resolves.toMatchObject({
      code: "policy_denied",
    });
  });
});
