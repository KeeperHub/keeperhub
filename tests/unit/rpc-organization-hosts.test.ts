import { describe, expect, it } from "vitest";
import {
  isOrganizationHost,
  markOrganizationHost,
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
});
