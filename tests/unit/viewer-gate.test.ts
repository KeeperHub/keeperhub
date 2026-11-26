import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetOrgRole, mockResolveSessionOrg } = vi.hoisted(() => ({
  mockGetOrgRole: vi.fn(),
  mockResolveSessionOrg: vi.fn(),
}));

vi.mock("@/lib/security/org-role", () => ({ getOrgRole: mockGetOrgRole }));
vi.mock("@/lib/middleware/auth-helpers", () => ({
  ORG_HEADER: "x-organization-id",
  resolveSessionOrg: mockResolveSessionOrg,
}));

import { isViewerForRequest } from "@/lib/security/viewer-gate";

const NOT_FOUND = {
  error: "Organization not found",
  code: "not_found",
  status: 404,
};

function request(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost:3000${path}`, {
    method: "POST",
    headers,
  });
}

// Results are cached per caller and target, so each case uses its own user.
describe("isViewerForRequest", () => {
  beforeEach(() => {
    mockGetOrgRole.mockReset();
    mockResolveSessionOrg.mockReset();
  });

  it("uses the role from the shared org resolver", async () => {
    mockResolveSessionOrg.mockResolvedValue({
      organizationId: "org-1",
      role: "viewer",
    });
    await expect(
      isViewerForRequest(request("/api/projects"), "u-resolver", "org-1")
    ).resolves.toBe(true);
    expect(mockResolveSessionOrg).toHaveBeenCalledWith(
      expect.any(Request),
      "u-resolver",
      "org-1"
    );
    expect(mockGetOrgRole).not.toHaveBeenCalled();
  });

  it("passes a member", async () => {
    mockResolveSessionOrg.mockResolvedValue({
      organizationId: "org-1",
      role: "member",
    });
    await expect(
      isViewerForRequest(request("/api/projects"), "u-member", "org-1")
    ).resolves.toBe(false);
  });

  it("prefers the organization in the path", async () => {
    mockGetOrgRole.mockResolvedValue("viewer");
    await expect(
      isViewerForRequest(
        request("/api/organizations/org-2/mfa-enforcement"),
        "u-path",
        "org-1"
      )
    ).resolves.toBe(true);
    expect(mockGetOrgRole).toHaveBeenCalledWith("u-path", "org-2");
    expect(mockResolveSessionOrg).not.toHaveBeenCalled();
  });

  it("lets an admin of the header org through who is not a viewer in the active org", async () => {
    mockResolveSessionOrg.mockResolvedValue({
      organizationId: "org-2",
      role: "admin",
    });
    mockGetOrgRole.mockResolvedValue("member");
    await expect(
      isViewerForRequest(
        request("/api/projects/p1", { "x-organization-id": "org-2" }),
        "u-header-admin",
        "org-1"
      )
    ).resolves.toBe(false);
    expect(mockGetOrgRole).toHaveBeenCalledWith("u-header-admin", "org-1");
  });

  it("blocks a viewer in the org the header names", async () => {
    mockResolveSessionOrg.mockResolvedValue({
      organizationId: "org-2",
      role: "viewer",
    });
    await expect(
      isViewerForRequest(
        request("/api/projects", { "x-organization-id": "org-2" }),
        "u-header-viewer",
        "org-1"
      )
    ).resolves.toBe(true);
  });

  it("blocks a viewer in the active org even when the header names another org", async () => {
    mockResolveSessionOrg.mockResolvedValue({
      organizationId: "personal",
      role: "owner",
    });
    mockGetOrgRole.mockResolvedValue("viewer");
    await expect(
      isViewerForRequest(
        request("/api/user/wallet/withdraw", {
          "x-organization-id": "personal",
        }),
        "u-header-escape",
        "org-1"
      )
    ).resolves.toBe(true);
    expect(mockGetOrgRole).toHaveBeenCalledWith("u-header-escape", "org-1");
  });

  it("skips the second lookup when the header names the active org", async () => {
    mockResolveSessionOrg.mockResolvedValue({
      organizationId: "org-1",
      role: "member",
    });
    await expect(
      isViewerForRequest(
        request("/api/projects", { "x-organization-id": "org-1" }),
        "u-header-same",
        "org-1"
      )
    ).resolves.toBe(false);
    expect(mockGetOrgRole).not.toHaveBeenCalled();
  });

  it("leaves an org that does not resolve to the route", async () => {
    mockResolveSessionOrg.mockResolvedValue(NOT_FOUND);
    mockGetOrgRole.mockResolvedValue("member");
    await expect(
      isViewerForRequest(
        request("/api/projects", { "x-organization-id": "nope" }),
        "u-unknown",
        "org-1"
      )
    ).resolves.toBe(false);
  });

  it("still checks the active org when the header org does not resolve", async () => {
    mockResolveSessionOrg.mockResolvedValue(NOT_FOUND);
    mockGetOrgRole.mockResolvedValue("viewer");
    await expect(
      isViewerForRequest(
        request("/api/projects", { "x-organization-id": "nope" }),
        "u-unknown-viewer",
        "org-1"
      )
    ).resolves.toBe(true);
  });

  it("follows the resolver's first-membership fallback when there is no active org", async () => {
    mockResolveSessionOrg.mockResolvedValue({
      organizationId: "personal",
      role: "owner",
    });
    await expect(
      isViewerForRequest(request("/api/projects"), "u-no-active", null)
    ).resolves.toBe(false);
  });

  it("answers a repeat request from the cache", async () => {
    mockResolveSessionOrg.mockResolvedValue({
      organizationId: "org-1",
      role: "viewer",
    });
    await isViewerForRequest(request("/api/projects"), "u-cached", "org-1");
    await expect(
      isViewerForRequest(request("/api/tags"), "u-cached", "org-1")
    ).resolves.toBe(true);
    expect(mockResolveSessionOrg).toHaveBeenCalledOnce();
  });

  describe("cache expiry", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("looks the role up again after the TTL", async () => {
      vi.useFakeTimers();
      mockResolveSessionOrg.mockResolvedValue({
        organizationId: "org-1",
        role: "member",
      });
      await expect(
        isViewerForRequest(request("/api/projects"), "u-ttl", "org-1")
      ).resolves.toBe(false);

      mockResolveSessionOrg.mockResolvedValue({
        organizationId: "org-1",
        role: "viewer",
      });
      vi.advanceTimersByTime(9000);
      await expect(
        isViewerForRequest(request("/api/projects"), "u-ttl", "org-1")
      ).resolves.toBe(false);

      vi.advanceTimersByTime(2000);
      await expect(
        isViewerForRequest(request("/api/projects"), "u-ttl", "org-1")
      ).resolves.toBe(true);
      expect(mockResolveSessionOrg).toHaveBeenCalledTimes(2);
    });
  });
});
