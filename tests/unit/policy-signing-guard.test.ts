import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const enforcePolicy = vi.fn();
const consumeReceiptRows = vi.fn();

vi.mock("@/lib/policy/guard", () => ({
  enforcePolicy: (...a: unknown[]) => enforcePolicy(...a),
}));
vi.mock("@/lib/policy/catalog/call-capability", () => ({
  resolveCallCapability: ({ fallback }: { fallback: string }) =>
    Promise.resolve(fallback),
}));
// The receipt lookup is the only database read this does.
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => consumeReceiptRows() }),
      }),
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  },
}));

const { assertSigningAllowed } = await import("@/lib/policy/signing-guard");

const CONTEXT = { organizationId: "org_1", chainId: 8453 };
const TARGET = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
// transfer(address,uint256)
const TRANSFER = `0xa9059cbb${"0".repeat(128)}`;

function capabilityOfCall(index = 0): string {
  const [{ capability }] = enforcePolicy.mock.calls[index] as [
    { capability: string },
  ];
  return capability;
}

beforeEach(() => {
  vi.clearAllMocks();
  consumeReceiptRows.mockResolvedValue([]);
  enforcePolicy.mockResolvedValue({
    blocked: false,
    decision: { reason: "unmanaged", matched: [] },
  });
});

describe("the check every signature passes through", () => {
  it("permits a call policy permits", async () => {
    await expect(
      assertSigningAllowed(CONTEXT, { to: TARGET, data: TRANSFER, value: null })
    ).resolves.toBeUndefined();
    expect(enforcePolicy).toHaveBeenCalledTimes(1);
  });

  it("throws rather than returning when policy refuses", async () => {
    // A signer that returns on refusal signs anyway. This has to throw.
    enforcePolicy.mockResolvedValue({
      blocked: true,
      decision: { reason: "explicit_deny", matched: [{ sid: "no-transfers" }] },
    });
    await expect(
      assertSigningAllowed(CONTEXT, { to: TARGET, data: TRANSFER, value: null })
    ).rejects.toThrow();
  });

  it("reads empty calldata as moving native value, not as a contract call", async () => {
    await assertSigningAllowed(CONTEXT, {
      to: TARGET,
      data: null,
      value: BigInt(10),
    });
    expect(capabilityOfCall()).toBe("asset.transfer.native");
  });

  it("reads calldata as a contract write", async () => {
    await assertSigningAllowed(CONTEXT, {
      to: TARGET,
      data: TRANSFER,
      value: null,
    });
    expect(capabilityOfCall()).toBe("contract.write");
  });

  it("lets a deployment through, having no target any rule could name", async () => {
    await assertSigningAllowed(CONTEXT, { to: null, data: TRANSFER });
    expect(enforcePolicy).not.toHaveBeenCalled();
  });

  it("does not charge a call the node check already cleared", async () => {
    // A live receipt means this exact intent was decided and its budget taken.
    consumeReceiptRows.mockResolvedValue([{ id: "rcpt_1" }]);
    await assertSigningAllowed(CONTEXT, {
      to: TARGET,
      data: TRANSFER,
      value: null,
    });
    expect(enforcePolicy).not.toHaveBeenCalled();
  });

  it("does not crash the signer when the receipt cannot be read", async () => {
    // An unreadable receipt is not a receipt. Letting the error escape would
    // turn an infrastructure problem into a crash inside the signer, where the
    // point is that every outcome is a decision. It falls through to the full
    // check, which refuses on its own if the store is unreachable.
    consumeReceiptRows.mockRejectedValue(new Error("database is down"));
    await expect(
      assertSigningAllowed(CONTEXT, { to: TARGET, data: TRANSFER })
    ).resolves.toBeUndefined();
    expect(enforcePolicy).toHaveBeenCalledTimes(1);
  });

  it("treats a missing value as zero rather than as undetermined", async () => {
    await assertSigningAllowed(CONTEXT, { to: TARGET, data: TRANSFER });
    const [{ facts }] = enforcePolicy.mock.calls[0] as [
      { facts: { nativeValueWei: { value?: unknown } } },
    ];
    expect(facts.nativeValueWei.value).toBe("0");
  });

  it("names the organization whose rules apply", async () => {
    await assertSigningAllowed(CONTEXT, { to: TARGET, data: TRANSFER });
    expect(enforcePolicy).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org_1" })
    );
  });

  it("judges it at the signing checkpoint", async () => {
    await assertSigningAllowed(CONTEXT, { to: TARGET, data: TRANSFER });
    expect(enforcePolicy).toHaveBeenCalledWith(
      expect.objectContaining({ checkpoint: "signing" })
    );
  });
});
