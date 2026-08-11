/**
 * Wave 0 RED scaffold for lib/agentic-wallet/approval.ts.
 *
 * Contract anchor: 33-CONTEXT.md /approval-request decisions (lines 22-23) +
 * 33-RESEARCH.md Pattern 6 pre-filter (auto should not produce rows).
 *
 *   createApprovalRequest({ subOrgId, riskLevel: "ask" | "block",
 *                            operationPayload })
 *     -> inserts a row with status default "pending" and returns { id }
 *     -> throws when riskLevel === "auto" (auto-approved ops bypass approval)
 *
 * Baseline: every case throws because createApprovalRequest is a stub.
 * Plan 33-03 flips this suite GREEN.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockInsertCall, mockReturning } = vi.hoisted(() => ({
  mockInsertCall: vi.fn(),
  mockReturning: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    insert: (table: unknown): unknown => ({
      values: (payload: unknown): unknown => {
        mockInsertCall(table, payload);
        return { returning: mockReturning };
      },
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  walletApprovalRequests: { _tableName: "wallet_approval_requests" },
}));

const { createApprovalRequest } = await import("@/lib/agentic-wallet/approval");

const SUB_ORG = "subOrg_approval_test";

// Phase 37 fix B1: the binding arg is required on every createApprovalRequest
// call. Unit tests use a canonical fixture so they exercise the insert shape
// rather than the route-level validation (which is covered in the integration
// test).
const BINDING_FIXTURE = {
  recipient: "0x1111111111111111111111111111111111111111",
  amountMicro: "50000000",
  chain: "base",
  contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
} as const;

describe("createApprovalRequest", () => {
  beforeEach(() => {
    mockInsertCall.mockReset();
    mockReturning.mockReset();
    mockReturning.mockResolvedValue([{ id: "ar_abc" }]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("inserts a pending row into wallet_approval_requests for a risk='ask' op", async () => {
    await createApprovalRequest({
      subOrgId: SUB_ORG,
      riskLevel: "ask",
      operationPayload: { foo: "bar" },
      binding: { ...BINDING_FIXTURE },
    });
    expect(mockInsertCall).toHaveBeenCalledTimes(1);
    const payload = mockInsertCall.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(payload.subOrgId).toBe(SUB_ORG);
    expect(payload.riskLevel).toBe("ask");
    expect(payload.operationPayload).toEqual({ foo: "bar" });
    // status is either omitted (relies on DB default "pending") or explicitly
    // set to "pending"; tolerate either.
    const statusOrMissing = (payload.status as string | undefined) ?? "pending";
    expect(statusOrMissing).toBe("pending");
    // Phase 37 fix B1: bound_* columns must be populated from the binding arg.
    expect(payload.boundRecipient).toBe(BINDING_FIXTURE.recipient);
    expect(payload.boundAmountMicro).toBe(BINDING_FIXTURE.amountMicro);
    expect(payload.boundChain).toBe(BINDING_FIXTURE.chain);
    expect(payload.boundContract).toBe(BINDING_FIXTURE.contract);
  });

  it("returns the inserted row id", async () => {
    mockReturning.mockResolvedValueOnce([{ id: "ar_generated_xyz" }]);
    const result = await createApprovalRequest({
      subOrgId: SUB_ORG,
      riskLevel: "ask",
      operationPayload: { k: "v" },
      binding: { ...BINDING_FIXTURE },
    });
    expect(result.id).toBe("ar_generated_xyz");
  });

  it("inserts risk='block' operations for audit (they will never transition to approved)", async () => {
    await createApprovalRequest({
      subOrgId: SUB_ORG,
      riskLevel: "block",
      operationPayload: { k: "v" },
      binding: { ...BINDING_FIXTURE },
    });
    const payload = mockInsertCall.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(payload.riskLevel).toBe("block");
  });

  it("throws when riskLevel is 'auto' (auto ops must not create approval rows)", async () => {
    await expect(
      createApprovalRequest({
        subOrgId: SUB_ORG,
        // @ts-expect-error -- "auto" is deliberately outside the allowed type
        // for createApprovalRequest; Phase 34's pre-filter should never reach
        // this call-site with auto-tier ops. The helper must still throw
        // defensively if a caller ignores the type hint.
        riskLevel: "auto",
        operationPayload: { k: "v" },
        binding: { ...BINDING_FIXTURE },
      })
    ).rejects.toThrow();
    expect(mockInsertCall).not.toHaveBeenCalled();
  });
});
