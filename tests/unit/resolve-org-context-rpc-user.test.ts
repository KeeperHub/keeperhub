import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockRpcPreferenceUserId, mockExecutionRows } = vi.hoisted(() => ({
  mockRpcPreferenceUserId: vi.fn(),
  mockExecutionRows: vi.fn(),
}));

vi.mock("@/lib/workflow/executor/helpers", () => ({
  getOrganizationIdFromExecution: vi.fn().mockResolvedValue("org-1"),
  rpcPreferenceUserId: mockRpcPreferenceUserId,
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { VALIDATION: "validation" },
  logUserError: vi.fn(),
}));

vi.mock("@/lib/db", () => {
  const chain = {
    from: () => chain,
    where: mockExecutionRows,
  };
  return { db: { select: () => chain } };
});

import { resolveOrganizationContext } from "@/lib/web3/resolve-org-context";

describe("resolveOrganizationContext RPC preference user", () => {
  beforeEach(() => {
    mockRpcPreferenceUserId.mockReset();
    mockExecutionRows.mockResolvedValue([{ userId: "creator" }]);
  });

  it("drops a viewer creator's preferences but keeps them as the run's user", async () => {
    mockRpcPreferenceUserId.mockResolvedValue(undefined);
    const result = await resolveOrganizationContext(
      { executionId: "exec-1" },
      "[Test]",
      "test"
    );
    expect(result).toEqual({
      success: true,
      organizationId: "org-1",
      userId: undefined,
      executionUserId: "creator",
    });
    expect(mockRpcPreferenceUserId).toHaveBeenCalledWith("creator", "org-1");
  });

  it("keeps a member creator's preferences", async () => {
    mockRpcPreferenceUserId.mockResolvedValue("creator");
    const result = await resolveOrganizationContext(
      { executionId: "exec-1" },
      "[Test]",
      "test"
    );
    expect(result).toMatchObject({ success: true, userId: "creator" });
  });
});
