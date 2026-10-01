import { describe, expect, it } from "vitest";
import { credentialLabel } from "@/lib/security/credential-label";

describe("credentialLabel", () => {
  it("names the API key an action came through", () => {
    expect(
      credentialLabel({ authMethod: "api-key", apiKeyName: "Automation key" })
    ).toBe("via API Key - Automation key");
  });

  it("still marks an API-key action when the key is gone", () => {
    expect(credentialLabel({ authMethod: "api-key", apiKeyName: null })).toBe(
      "via API Key"
    );
  });

  it("labels OAuth and internal callers", () => {
    expect(credentialLabel({ authMethod: "oauth", apiKeyName: null })).toBe(
      "via OAuth app"
    );
    expect(credentialLabel({ authMethod: "internal", apiKeyName: null })).toBe(
      "via system"
    );
  });

  it("adds nothing for a signed-in edit", () => {
    expect(credentialLabel({ authMethod: "session", apiKeyName: null })).toBe(
      null
    );
    expect(credentialLabel(null)).toBe(null);
  });
});
