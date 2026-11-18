import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockRevoke, mockLogSystemError } = vi.hoisted(() => ({
  mockRevoke: vi.fn(),
  mockLogSystemError: vi.fn(),
}));

vi.mock("@/lib/mcp/oauth-store", () => ({
  revokeRefreshTokensForUserOrg: mockRevoke,
}));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { AUTH: "AUTH" },
  logSystemError: mockLogSystemError,
}));

import { revokeMcpGrantsOnViewerDowngrade } from "@/lib/org/viewer-downgrade";

describe("revokeMcpGrantsOnViewerDowngrade", () => {
  beforeEach(() => {
    mockRevoke.mockReset();
    mockLogSystemError.mockReset();
  });

  it("revokes the member's refresh tokens on a downgrade to viewer", async () => {
    await revokeMcpGrantsOnViewerDowngrade({
      userId: "u1",
      organizationId: "org-1",
      previousRole: "member",
      role: "viewer",
    });
    expect(mockRevoke).toHaveBeenCalledWith("u1", "org-1");
  });

  it.each([
    ["viewer", "member"],
    ["member", "admin"],
    ["viewer", "viewer"],
  ])("leaves tokens alone for %s -> %s", async (previousRole, role) => {
    await revokeMcpGrantsOnViewerDowngrade({
      userId: "u1",
      organizationId: "org-1",
      previousRole,
      role,
    });
    expect(mockRevoke).not.toHaveBeenCalled();
  });

  it("logs and swallows a revocation failure", async () => {
    mockRevoke.mockRejectedValue(new Error("db down"));
    await expect(
      revokeMcpGrantsOnViewerDowngrade({
        userId: "u1",
        organizationId: "org-1",
        previousRole: "admin",
        role: "viewer",
      })
    ).resolves.toBeUndefined();
    expect(mockLogSystemError).toHaveBeenCalledOnce();
  });
});
