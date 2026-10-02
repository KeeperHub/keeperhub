import { describe, expect, it } from "vitest";
import {
  actionConnectionMode,
  integrationOffersConnection,
} from "@/lib/integration-helpers";
import { getAllIntegrations } from "@/plugins/registry";

// Runs against the real registry: tests/setup.ts imports "@/plugins".

// Plugins whose formFields map to credentials but whose connection is
// deliberately not offered. sendgrid always sends with the platform key, so a
// user key stored on a connection would be fetched and then ignored.
const HIDDEN_CONNECTION_SETTINGS = new Set(["sendgrid"]);

describe("integrationOffersConnection", () => {
  it.each([
    ["requires credentials", "slack", true],
    ["system integration", "database", true],
    ["optional connection settings", "blockscout", true],
    ["placeholder-only formFields", "hyperliquid", false],
    ["placeholder-only formFields", "code", false],
    ["placeholder-only formFields", "webhook", false],
    ["no formFields", "math", false],
    ["settings the step ignores", "sendgrid", false],
  ])("%s: %s -> %s", (_label, type, expected) => {
    expect(integrationOffersConnection(type)).toBe(expected);
  });

  it("offers nothing for a missing type", () => {
    expect(integrationOffersConnection(undefined)).toBe(false);
  });
});

describe("actionConnectionMode", () => {
  it.each([
    ["slack/send-message", "required"],
    ["web3/write-contract", "required"],
    ["blockscout/get-address-balance", "optional"],
    ["hyperliquid/clearinghouse-state", "none"],
    ["sendgrid/send-email", "none"],
    ["web3/check-balance", "none"],
    ["math/aggregate", "none"],
  ])("%s -> %s", (actionId, expected) => {
    expect(actionConnectionMode(actionId)).toBe(expected);
  });

  it("is none for an unknown or missing action", () => {
    expect(actionConnectionMode("nope/nothing")).toBe("none");
    expect(actionConnectionMode(undefined)).toBe("none");
  });
});

describe("optionalConnection registry invariants", () => {
  const plugins = getAllIntegrations();

  it("is only set on plugins that do not require credentials", () => {
    const misused = plugins
      .filter((p) => p.optionalConnection && p.requiresCredentials !== false)
      .map((p) => p.type);
    expect(misused).toEqual([]);
  });

  it("is set on every no-credential plugin whose formFields feed credentials", () => {
    const unreachable = plugins
      .filter(
        (p) =>
          p.requiresCredentials === false &&
          !p.optionalConnection &&
          !HIDDEN_CONNECTION_SETTINGS.has(p.type) &&
          p.formFields.some((field) => field.envVar)
      )
      .map((p) => p.type);
    expect(unreachable).toEqual([]);
  });
});
