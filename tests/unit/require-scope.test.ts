import { describe, expect, it } from "vitest";
import { requireScope } from "@/lib/middleware/require-scope";

describe("requireScope (A-03)", () => {
  it("returns null for an undefined scope (non-OAuth full access)", () => {
    expect(requireScope(undefined, "mcp:write")).toBeNull();
  });

  it("returns null when the granted scope satisfies the requirement", () => {
    expect(requireScope("mcp:write", "mcp:write")).toBeNull();
    expect(requireScope("mcp:admin", "mcp:write")).toBeNull();
    expect(requireScope("mcp:read", "mcp:read")).toBeNull();
  });

  it("returns a 403 insufficient_scope envelope when under-scoped", async () => {
    const response = requireScope("mcp:read", "mcp:write");

    expect(response).not.toBeNull();
    expect(response?.status).toBe(403);

    const body = await response?.json();
    expect(body).toMatchObject({
      error: "insufficient_scope",
      required_scope: "mcp:write",
      granted_scope: "mcp:read",
    });
  });

  it("reports an empty granted scope as the empty string in the envelope", async () => {
    const response = requireScope("", "mcp:write");

    expect(response?.status).toBe(403);
    const body = await response?.json();
    expect(body.granted_scope).toBe("");
  });
});
