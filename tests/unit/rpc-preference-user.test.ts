import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockGetOrgRole, mockLimit } = vi.hoisted(() => ({
  mockGetOrgRole: vi.fn(),
  mockLimit: vi.fn(),
}));

vi.mock("@/lib/security/org-role", () => ({ getOrgRole: mockGetOrgRole }));

vi.mock("@/lib/db", () => {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit: mockLimit,
  };
  return { db: { select: () => chain } };
});

import {
  getRpcPreferenceUserId,
  rpcPreferenceUserId,
} from "@/lib/workflow/executor/helpers";

describe("rpcPreferenceUserId", () => {
  beforeEach(() => {
    mockGetOrgRole.mockReset();
  });

  it("keeps the preferences of a member who can act in the org", async () => {
    mockGetOrgRole.mockResolvedValue("member");
    await expect(rpcPreferenceUserId("u1", "org-1")).resolves.toBe("u1");
    expect(mockGetOrgRole).toHaveBeenCalledWith("u1", "org-1");
  });

  it("drops a viewer's preferences", async () => {
    mockGetOrgRole.mockResolvedValue("viewer");
    await expect(
      rpcPreferenceUserId("u-viewer", "org-1")
    ).resolves.toBeUndefined();
  });

  it("drops the preferences of someone no longer in the org", async () => {
    mockGetOrgRole.mockResolvedValue(null);
    await expect(
      rpcPreferenceUserId("u-removed", "org-1")
    ).resolves.toBeUndefined();
  });

  it("reuses one role answer across a run's steps", async () => {
    mockGetOrgRole.mockResolvedValue("member");
    await rpcPreferenceUserId("u-cached", "org-1");
    await rpcPreferenceUserId("u-cached", "org-1");
    expect(mockGetOrgRole).toHaveBeenCalledOnce();
  });

  it("needs both a user and an org", async () => {
    await expect(rpcPreferenceUserId(undefined, "org-1")).resolves.toBe(
      undefined
    );
    await expect(rpcPreferenceUserId("u1", undefined)).resolves.toBe(undefined);
    expect(mockGetOrgRole).not.toHaveBeenCalled();
  });
});

describe("getRpcPreferenceUserId", () => {
  beforeEach(() => {
    mockGetOrgRole.mockReset();
    mockLimit.mockReset();
  });

  it("checks the run's org, preferring the execution's own column", async () => {
    mockLimit.mockResolvedValue([
      {
        userId: "u-run",
        executionOrganizationId: "org-run",
        workflowOrganizationId: "org-workflow",
      },
    ]);
    mockGetOrgRole.mockResolvedValue("admin");
    await expect(getRpcPreferenceUserId("exec-1")).resolves.toBe("u-run");
    expect(mockGetOrgRole).toHaveBeenCalledWith("u-run", "org-run");
  });

  it("falls back to the workflow's org for older runs", async () => {
    mockLimit.mockResolvedValue([
      {
        userId: "u-old",
        executionOrganizationId: null,
        workflowOrganizationId: "org-workflow",
      },
    ]);
    mockGetOrgRole.mockResolvedValue("viewer");
    await expect(getRpcPreferenceUserId("exec-1")).resolves.toBeUndefined();
    expect(mockGetOrgRole).toHaveBeenCalledWith("u-old", "org-workflow");
  });

  it("uses the chain default when the run is unknown or the lookup fails", async () => {
    mockLimit.mockResolvedValueOnce([]);
    await expect(getRpcPreferenceUserId("missing")).resolves.toBeUndefined();
    mockLimit.mockRejectedValueOnce(new Error("db down"));
    await expect(getRpcPreferenceUserId("exec-1")).resolves.toBeUndefined();
    await expect(getRpcPreferenceUserId(undefined)).resolves.toBeUndefined();
  });
});
