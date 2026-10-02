import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const decideControlPlane = vi.fn();
const getOrgRole = vi.fn();

vi.mock("@/lib/policy/control-plane", () => ({
  decideControlPlane: (...args: unknown[]) => decideControlPlane(...args),
}));
vi.mock("@/lib/security/org-role", () => ({
  getOrgRole: (...args: unknown[]) => getOrgRole(...args),
}));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { CONFIGURATION: "configuration" },
  logSystemError: () => undefined,
}));

const { policyRefusalFor } = await import("@/lib/middleware/policy-gate");

const CONTEXT = { organizationId: "org_1", userId: "user_1" };

function post(url: string, body?: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getOrgRole.mockResolvedValue("owner");
  decideControlPlane.mockResolvedValue({ blocked: false, reason: "allow" });
});

describe("policy gate", () => {
  it("refuses a mutating API route the manifest does not classify", async () => {
    const refusal = await policyRefusalFor(
      post("http://localhost/api/newly-added-thing"),
      CONTEXT
    );
    expect(refusal).toMatchObject({ code: "policy_denied", status: 403 });
    expect(decideControlPlane).not.toHaveBeenCalled();
  });

  it("leaves a path outside /api alone", async () => {
    expect(
      await policyRefusalFor(post("http://localhost/test"), CONTEXT)
    ).toBeNull();
  });

  it("leaves reads alone", async () => {
    const request = new Request("http://localhost/api/anything");
    expect(await policyRefusalFor(request, CONTEXT)).toBeNull();
  });

  it("does not consult policy for a route classified as ungoverned", async () => {
    expect(
      await policyRefusalFor(post("http://localhost/api/feedback"), CONTEXT)
    ).toBeNull();
    expect(decideControlPlane).not.toHaveBeenCalled();
  });

  it("does not consult policy for a route with no capability yet", async () => {
    expect(
      await policyRefusalFor(post("http://localhost/api/tags"), CONTEXT)
    ).toBeNull();
    expect(decideControlPlane).not.toHaveBeenCalled();
  });

  it("names the new-object sentinel for a creation", async () => {
    await policyRefusalFor(
      post("http://localhost/api/workflows/create"),
      CONTEXT
    );
    expect(decideControlPlane).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "workflow.create",
        resource: { type: "workflow", id: "new" },
      })
    );
  });

  it("reads the resource id out of the path", async () => {
    await policyRefusalFor(
      new Request("http://localhost/api/workflows/wf_9", { method: "DELETE" }),
      CONTEXT
    );
    expect(decideControlPlane).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "workflow.delete",
        resource: { type: "workflow", id: "wf_9" },
      })
    );
  });

  it("reads the project a creation targets from the body", async () => {
    await policyRefusalFor(
      post("http://localhost/api/workflows/create", { projectId: "proj_7" }),
      CONTEXT
    );
    expect(decideControlPlane).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "proj_7" })
    );
  });

  it("reads a resource id out of the body when the path has none", async () => {
    await policyRefusalFor(
      post("http://localhost/api/address-book", { address: "0xAbC" }),
      CONTEXT
    );
    expect(decideControlPlane).toHaveBeenCalledWith(
      expect.objectContaining({
        resource: { type: "addressbook", id: "0xAbC" },
      })
    );
  });

  it("leaves the body readable for the route", async () => {
    const request = post("http://localhost/api/workflows/create", { a: 1 });
    await policyRefusalFor(request, CONTEXT);
    await expect(request.json()).resolves.toEqual({ a: 1 });
  });

  it("passes the refusal on when policy blocks", async () => {
    decideControlPlane.mockResolvedValue({
      blocked: true,
      message: "Blocked by an organization policy",
      reason: "no_matching_allow",
    });
    const refusal = await policyRefusalFor(
      post("http://localhost/api/workflows/create"),
      CONTEXT
    );
    expect(refusal).toMatchObject({ code: "policy_denied", status: 403 });
  });

  it("falls back to the least authority when the role is unknown", async () => {
    getOrgRole.mockResolvedValue(null);
    await policyRefusalFor(
      post("http://localhost/api/workflows/create"),
      CONTEXT
    );
    expect(decideControlPlane).toHaveBeenCalledWith(
      expect.objectContaining({ role: "member" })
    );
  });
});
