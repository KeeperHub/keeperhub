import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const enforcePolicy = vi.fn();

vi.mock("@/lib/policy/guard", () => ({
  enforcePolicy: (...args: unknown[]) => enforcePolicy(...args),
}));
vi.mock("@/lib/policy/price", () => ({
  withUsdValue: (facts: unknown) => Promise.resolve(facts),
}));
vi.mock("@/lib/policy/catalog/call-capability", () => ({
  resolveCallCapability: ({ fallback }: { fallback: string }) =>
    Promise.resolve(fallback),
}));

const { enforceDirectNodePolicy } = await import(
  "@/lib/policy/direct-execution"
);

const BASE = {
  organizationId: "org_1",
  apiKeyId: "key_1",
};

beforeEach(() => {
  vi.clearAllMocks();
  enforcePolicy.mockResolvedValue({
    blocked: false,
    decision: { reason: "unmanaged" },
  });
});

describe("direct node policy", () => {
  it("governs a read, which never reaches a signer", async () => {
    const refusal = await enforceDirectNodePolicy({
      ...BASE,
      actionType: "web3/read-contract",
      config: { network: "1", contractAddress: "0xabc" },
    });
    expect(refusal).toBeNull();
    expect(enforcePolicy).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "contract.read" })
    );
  });

  it("names the call as coming from the direct API", async () => {
    await enforceDirectNodePolicy({
      ...BASE,
      actionType: "web3/read-contract",
      config: { network: "1", contractAddress: "0xabc" },
    });
    const [{ facts }] = enforcePolicy.mock.calls[0] as [
      { facts: { triggerType: { value?: string } } },
    ];
    expect(facts.triggerType.value).toBe("direct");
  });

  it("refuses when policy refuses", async () => {
    enforcePolicy.mockResolvedValue({
      blocked: true,
      decision: { reason: "explicit_deny", message: "Blocked by a policy" },
    });
    const refusal = await enforceDirectNodePolicy({
      ...BASE,
      actionType: "web3/read-contract",
      config: { network: "1", contractAddress: "0xabc" },
    });
    expect(refusal?.status).toBe(403);
    await expect(refusal?.json()).resolves.toMatchObject({
      code: "policy_denied",
      reason: "explicit_deny",
    });
  });

  it("governs a plugin action nothing has mapped as a contract write", async () => {
    // Deliberate: an unrecognised plugin slug still writes to a contract, so it
    // is judged rather than waved through.
    await enforceDirectNodePolicy({
      ...BASE,
      actionType: "somevendor/not-in-the-registry",
      config: { network: "1", contractAddress: "0xabc" },
    });
    expect(enforcePolicy).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "contract.write" })
    );
  });

  it("leaves a system action that names no capability alone", async () => {
    const refusal = await enforceDirectNodePolicy({
      ...BASE,
      actionType: "NotAnAction",
      config: {},
    });
    expect(refusal).toBeNull();
    expect(enforcePolicy).not.toHaveBeenCalled();
  });

  it("acts as the key, at the least authority a key can carry", async () => {
    await enforceDirectNodePolicy({
      ...BASE,
      actionType: "web3/read-contract",
      config: { network: "1", contractAddress: "0xabc" },
    });
    expect(enforcePolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        principal: expect.objectContaining({
          kind: "api_key",
          apiKeyId: "key_1",
          role: "member",
        }),
      })
    );
  });
});
