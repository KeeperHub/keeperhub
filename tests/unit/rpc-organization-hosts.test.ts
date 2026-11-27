import { describe, expect, it } from "vitest";
import { OrgRpcError } from "@/lib/rpc/engine/org-rpc-error";
import {
  isOrganizationHost,
  markOrganizationHost,
  redactOrganizationHosts,
  runCheckingOrganizationUrl,
} from "@/lib/rpc/engine/organization-hosts";

describe("organization hosts", () => {
  it("covers a saved config's host for the process", () => {
    markOrganizationHost("Key1.Saved-RPC.example");
    expect(isOrganizationHost("key1.saved-rpc.example")).toBe(true);
  });

  it("covers a host being checked only while its check runs", async () => {
    const during = await runCheckingOrganizationUrl(async () => {
      await Promise.resolve();
      return isOrganizationHost("unsaved.rpc.example");
    });
    expect(during).toBe(true);
    expect(isOrganizationHost("unsaved.rpc.example")).toBe(false);
  });

  it("keeps a saved host out of an organization failure's text", () => {
    markOrganizationHost("abc123key.provider.example");
    const error = new OrgRpcError(
      "RPC failed. Primary: Cannot resolve host: abc123key.provider.example"
    );
    expect(error.message).not.toContain("abc123key");
    expect(redactOrganizationHosts("calls to other.example stay")).toBe(
      "calls to other.example stay"
    );
  });
});
