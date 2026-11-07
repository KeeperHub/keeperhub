import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetOrgRole, mockResolveSessionOrg } = vi.hoisted(() => ({
  mockGetOrgRole: vi.fn(),
  mockResolveSessionOrg: vi.fn(),
}));

vi.mock("@/lib/security/org-role", () => ({ getOrgRole: mockGetOrgRole }));
vi.mock("@/lib/middleware/auth-helpers", () => ({
  resolveSessionOrg: mockResolveSessionOrg,
}));

import {
  isViewerForRequest,
  viewerForbidden,
} from "@/lib/security/viewer-gate";

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
      isViewerForRequest(request("/api/projects"), "u1", "org-1")
    ).resolves.toBe(true);
    expect(mockResolveSessionOrg).toHaveBeenCalledWith(
      expect.any(Request),
      "u1",
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
      isViewerForRequest(request("/api/projects"), "u1", "org-1")
    ).resolves.toBe(false);
  });

  it("prefers the organization in the path", async () => {
    mockGetOrgRole.mockResolvedValue("viewer");
    await expect(
      isViewerForRequest(
        request("/api/organizations/org-2/mfa-enforcement"),
        "u1",
        "org-1"
      )
    ).resolves.toBe(true);
    expect(mockGetOrgRole).toHaveBeenCalledWith("u1", "org-2");
    expect(mockResolveSessionOrg).not.toHaveBeenCalled();
  });

  it("blocks a viewer in the active org who names an unknown org in the header", async () => {
    mockResolveSessionOrg.mockResolvedValue(NOT_FOUND);
    mockGetOrgRole.mockResolvedValue("viewer");
    await expect(
      isViewerForRequest(
        request("/api/workflows/current", { "x-organization-id": "nope" }),
        "u1",
        "org-1"
      )
    ).resolves.toBe(true);
    expect(mockGetOrgRole).toHaveBeenCalledWith("u1", "org-1");
  });

  it("blocks a viewer in the active org who names an org they administer", async () => {
    mockResolveSessionOrg.mockResolvedValue({
      organizationId: "org-2",
      role: "admin",
    });
    mockGetOrgRole.mockResolvedValue("viewer");
    await expect(
      isViewerForRequest(
        request("/api/workflows/current", { "x-organization-id": "org-2" }),
        "u1",
        "org-1"
      )
    ).resolves.toBe(true);
  });

  it("blocks a viewer in the org the header names", async () => {
    mockResolveSessionOrg.mockResolvedValue({
      organizationId: "org-2",
      role: "viewer",
    });
    await expect(
      isViewerForRequest(
        request("/api/projects", { "x-organization-id": "org-2" }),
        "u1",
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
      isViewerForRequest(request("/api/projects"), "u1", null)
    ).resolves.toBe(false);
    expect(mockGetOrgRole).not.toHaveBeenCalled();
  });
});

describe("viewerForbidden", () => {
  beforeEach(() => {
    mockGetOrgRole.mockReset();
  });

  it("returns a 403 for a viewer", async () => {
    mockGetOrgRole.mockResolvedValue("viewer");
    const res = await viewerForbidden("u1", "org-1");
    expect(res?.status).toBe(403);
    expect(await res?.json()).toMatchObject({ code: "viewer_read_only" });
  });

  it("returns null for other roles and when there is no org", async () => {
    mockGetOrgRole.mockResolvedValue("member");
    await expect(viewerForbidden("u1", "org-1")).resolves.toBeNull();
    await expect(viewerForbidden("u1", null)).resolves.toBeNull();
  });
});
