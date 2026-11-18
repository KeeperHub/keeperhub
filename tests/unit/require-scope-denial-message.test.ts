import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { AUTHORIZATION: "authorization" },
  logSecurityEvent: vi.fn(),
  logUserError: vi.fn(),
}));

import { requireScope } from "@/lib/middleware/require-scope";

async function denialBody(
  context?: Parameters<typeof requireScope>[2]
): Promise<{ message: string; error: string }> {
  const response = requireScope("mcp:read", "mcp:write", context);
  if (!response) {
    throw new Error("expected a denial");
  }
  return await response.json();
}

describe("requireScope denial message — remediation matches the credential", () => {
  it("tells an API-key caller to mint a new key, not to ask an admin", async () => {
    const body = await denialBody({ credentialType: "api-key" });

    expect(body.error).toBe("insufficient_scope");
    expect(body.message).toContain("fixed when the key is created");
    expect(body.message).toContain("A new key has to be issued");
    // An API key's scope is not governed by the org ceiling, and the key row
    // exposes only DELETE, so both of these would send the caller nowhere.
    expect(body.message).not.toContain("Settings > Developer > Agents");
    expect(body.message).not.toContain("ask them to raise it");
  });

  it("keeps the admin-ceiling remediation for an OAuth caller", async () => {
    const body = await denialBody({ credentialType: "oauth" });

    expect(body.message).toContain("Settings > Developer > Agents");
    expect(body.message).toContain("ask them to raise it");
    expect(body.message).not.toContain("A new key has to be issued");
  });

  it("claims no remediation when the credential family is unknown", async () => {
    const body = await denialBody();

    expect(body.message).not.toContain("Settings > Developer > Agents");
    expect(body.message).not.toContain("A new key has to be issued");
  });

  it("always states the requirement, the grant, and that retrying will not help", async () => {
    for (const context of [
      { credentialType: "api-key" as const },
      { credentialType: "oauth" as const },
      undefined,
    ]) {
      const body = await denialBody(context);
      expect(body.message).toContain("`mcp:write`");
      expect(body.message).toContain("`mcp:read`");
      expect(body.message).toContain("Retrying will not widen it");
    }
  });

  it("does not describe the grant as an OAuth scope, since API keys reach it too", async () => {
    const body = await denialBody({ credentialType: "api-key" });
    expect(body.message).not.toContain("OAuth scope");
  });

  it("still allows a satisfied scope regardless of credential type", () => {
    expect(
      requireScope("mcp:write", "mcp:read", { credentialType: "api-key" })
    ).toBeNull();
  });
});
