import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Keep the SSRF guard's `instanceof SsrfBlockedError` check working while
// avoiding loading the real server-only safe-fetch module (undici/sentry).
const { assertUrlIsPublic, FakeSsrfBlockedError } = vi.hoisted(() => {
  class HoistedSsrfBlockedError extends Error {}
  return {
    assertUrlIsPublic: vi.fn(),
    FakeSsrfBlockedError: HoistedSsrfBlockedError,
  };
});
vi.mock("@/lib/safe-fetch", () => ({
  assertUrlIsPublic,
  SsrfBlockedError: FakeSsrfBlockedError,
}));

const { testFn, getIntegration, getCredentialMapping } = vi.hoisted(() => ({
  testFn: vi.fn(),
  getIntegration: vi.fn(),
  getCredentialMapping: vi.fn(),
}));
vi.mock("@/plugins/registry", () => ({
  getIntegration,
  getCredentialMapping,
}));

import { handlePluginTest } from "@/lib/db/test-connection";

const URL_FIELD = {
  id: "apiUrl",
  label: "Blockscout Instance URL",
  type: "url" as const,
  configKey: "apiUrl",
  envVar: "BLOCKSCOUT_API_URL",
};

function pluginWithUrlField() {
  return {
    type: "blockscout",
    formFields: [
      URL_FIELD,
      {
        id: "apiKey",
        label: "API Key",
        type: "password" as const,
        configKey: "apiKey",
        envVar: "BLOCKSCOUT_API_KEY",
      },
    ],
    testConfig: { getTestFunction: () => Promise.resolve(testFn) },
  };
}

describe("handlePluginTest url-field SSRF guard", () => {
  beforeEach(() => {
    assertUrlIsPublic.mockReset();
    testFn.mockReset();
    getIntegration.mockReset();
    getCredentialMapping.mockReset().mockReturnValue({});
  });

  it("blocks a url field pointing at an internal address and never runs the test", async () => {
    getIntegration.mockReturnValue(pluginWithUrlField());
    assertUrlIsPublic.mockRejectedValue(
      new FakeSsrfBlockedError(
        "Outbound request to 169.254.169.254 blocked by SSRF policy (link-local)."
      )
    );

    const result = await handlePluginTest("blockscout", {
      apiUrl: "http://169.254.169.254",
    });

    expect(result.status).toBe("error");
    expect(result.message).toContain("Blockscout Instance URL");
    expect(testFn).not.toHaveBeenCalled();
  });

  it("allows a public url field and runs the test", async () => {
    getIntegration.mockReturnValue(pluginWithUrlField());
    assertUrlIsPublic.mockResolvedValue(undefined);
    testFn.mockResolvedValue({ success: true });

    const result = await handlePluginTest("blockscout", {
      apiUrl: "https://eth.blockscout.com",
    });

    expect(assertUrlIsPublic).toHaveBeenCalledWith(
      "https://eth.blockscout.com"
    );
    expect(testFn).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("success");
  });

  it("skips an empty url field and still runs the test", async () => {
    getIntegration.mockReturnValue(pluginWithUrlField());
    testFn.mockResolvedValue({ success: true });

    const result = await handlePluginTest("blockscout", {});

    expect(assertUrlIsPublic).not.toHaveBeenCalled();
    expect(testFn).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("success");
  });
});
