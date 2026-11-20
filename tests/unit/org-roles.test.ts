import { describe, expect, it } from "vitest";
import { orgRoles } from "@/lib/auth-access-control";
import { isViewerRole, roleLabel } from "@/lib/organization/role-label";

describe("viewer role permissions", () => {
  it("reads every resource", () => {
    const result = orgRoles.viewer.authorize({
      workflow: ["read"],
      credential: ["read"],
      wallet: ["read"],
      organization: ["read"],
      member: ["read"],
    });
    expect(result.success).toBe(true);
  });

  it.each([
    ["workflow", "create"],
    ["workflow", "update"],
    ["workflow", "delete"],
    ["credential", "create"],
    ["wallet", "update"],
    ["organization", "update"],
    ["organization", "delete"],
    ["member", "create"],
    ["member", "update"],
    ["member", "delete"],
    ["invitation", "create"],
    ["invitation", "cancel"],
  ] as const)("cannot %s:%s", (resource, action) => {
    const result = orgRoles.viewer.authorize({ [resource]: [action] });
    expect(result.success).toBe(false);
  });

  it("keeps members able to write workflows", () => {
    expect(
      orgRoles.member.authorize({ workflow: ["create", "update"] }).success
    ).toBe(true);
  });
});

describe("isViewerRole", () => {
  it("matches the viewer role in any case", () => {
    expect(isViewerRole("viewer")).toBe(true);
    expect(isViewerRole("Viewer")).toBe(true);
  });

  it("rejects other roles and missing values", () => {
    for (const role of ["owner", "admin", "member", "", null, undefined]) {
      expect(isViewerRole(role)).toBe(false);
    }
  });

  it("labels the role", () => {
    expect(roleLabel("viewer")).toBe("Viewer");
  });
});
