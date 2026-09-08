/**
 * Pitfall 15 regression guard: assert validate_workflow is accessible across
 * all three OAuth scope tiers. If the entry is ever missing from READ_TOOLS,
 * this test fails immediately and clearly.
 */
import { describe, expect, it } from "vitest";
import { isToolAllowed } from "@/lib/mcp/oauth-scopes";

describe("oauth-scopes: validate_workflow scope guard (Pitfall 15)", () => {
  it("is allowed for mcp:read scope", () => {
    expect(isToolAllowed("validate_workflow", "mcp:read")).toBe(true);
  });

  it("is allowed for mcp:write scope (inherits READ_TOOLS via spread)", () => {
    expect(isToolAllowed("validate_workflow", "mcp:write")).toBe(true);
  });

  it("is allowed for mcp:admin scope", () => {
    expect(isToolAllowed("validate_workflow", "mcp:admin")).toBe(true);
  });

  it("is denied when no scope is provided", () => {
    expect(isToolAllowed("validate_workflow", "")).toBe(false);
  });
});
