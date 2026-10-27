import { beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("@/lib/db/schema", () => ({
  member: { id: "id", organizationId: "organizationId", userId: "userId" },
  organization: { id: "id", slug: "slug" },
}));

import { isViewerForRequest } from "@/lib/security/viewer-gate";

function request(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost:3000${path}`, {
    method: "POST",
    headers,
  });
}

describe("isViewerForRequest", () => {
  beforeEach(() => {
    mockGetOrgRole.mockReset();
    mockLimit.mockReset();
  });

  it("uses the active organization by default", async () => {
    mockGetOrgRole.mockResolvedValue("viewer");
    await expect(
      isViewerForRequest(request("/api/projects"), "u1", "org-1")
    ).resolves.toBe(true);
    expect(mockGetOrgRole).toHaveBeenCalledWith("u1", "org-1");
  });

  it("passes a member of the active organization", async () => {
    mockGetOrgRole.mockResolvedValue("member");
    await expect(
      isViewerForRequest(request("/api/projects"), "u1", "org-1")
    ).resolves.toBe(false);
  });

  it("prefers the organization in the path over the active one", async () => {
    mockGetOrgRole.mockResolvedValue("viewer");
    await expect(
      isViewerForRequest(
        request("/api/organizations/org-2/mfa-enforcement"),
        "u1",
        "org-1"
      )
    ).resolves.toBe(true);
    expect(mockGetOrgRole).toHaveBeenCalledWith("u1", "org-2");
  });

  it("honours the X-Organization-Id header the routes honour", async () => {
    mockLimit.mockResolvedValue([{ role: "viewer" }]);
    await expect(
      isViewerForRequest(
        request("/api/projects", { "x-organization-id": "other-org" }),
        "u1",
        "org-1"
      )
    ).resolves.toBe(true);
    expect(mockGetOrgRole).not.toHaveBeenCalled();
  });

  it("leaves a header naming an org the caller is not in to the route", async () => {
    mockLimit.mockResolvedValue([]);
    await expect(
      isViewerForRequest(
        request("/api/projects", { "x-organization-id": "nope" }),
        "u1",
        "org-1"
      )
    ).resolves.toBe(false);
  });

  it("fails closed for a viewer anywhere when no organization resolves", async () => {
    mockLimit.mockResolvedValue([{ id: "m1" }]);
    await expect(
      isViewerForRequest(request("/api/projects"), "u1", null)
    ).resolves.toBe(true);
  });

  it("passes when no organization resolves and the caller is a viewer nowhere", async () => {
    mockLimit.mockResolvedValue([]);
    await expect(
      isViewerForRequest(request("/api/projects"), "u1", undefined)
    ).resolves.toBe(false);
  });
});
