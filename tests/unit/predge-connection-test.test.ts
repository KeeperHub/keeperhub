import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { VALIDATION: "VALIDATION" },
  logUserError: vi.fn(),
}));

// The connection test must egress through safeFetch behind the SSRF guard, the
// same way the signal fetch does. Mocking both lets the tests assert on which
// one was reached, rather than on network behaviour.
const { safeFetch, assertUrlIsPublic, SsrfBlockedError } = vi.hoisted(() => ({
  safeFetch: vi.fn(),
  assertUrlIsPublic: vi.fn(() => Promise.resolve()),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));
vi.mock("@/lib/safe-fetch", () => ({
  safeFetch,
  assertUrlIsPublic,
  SsrfBlockedError,
}));

import { testPredge } from "@/plugins/predge/test";

describe("testPredge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assertUrlIsPublic.mockImplementation(() => Promise.resolve());
    safeFetch.mockResolvedValue({ ok: true, status: 200 });
  });

  it("never reaches the network without the SSRF guard first", async () => {
    await testPredge({});

    expect(assertUrlIsPublic).toHaveBeenCalledTimes(1);
    expect(safeFetch).toHaveBeenCalledTimes(1);
    const guardOrder = assertUrlIsPublic.mock.invocationCallOrder[0];
    const fetchOrder = safeFetch.mock.invocationCallOrder[0];
    expect(guardOrder).toBeLessThan(fetchOrder);
  });

  it("does not use the raw fetch global", async () => {
    const rawFetch = vi.spyOn(globalThis, "fetch");

    await testPredge({ PREDGE_SIGNAL_URL: "https://api.predge.io" });

    expect(rawFetch).not.toHaveBeenCalled();
    rawFetch.mockRestore();
  });

  it("refuses a private address instead of reporting it as reachable", async () => {
    assertUrlIsPublic.mockRejectedValueOnce(
      new SsrfBlockedError("169.254.169.254 is not a public address")
    );

    const result = await testPredge({
      PREDGE_SIGNAL_URL: "http://169.254.169.254",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("is not allowed");
    // The whole point: no request is made, so no HTTP status can leak back and
    // turn this button into an internal-network probe.
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("reports an unparseable URL as a typo, not as an unreachable service", async () => {
    const result = await testPredge({ PREDGE_SIGNAL_URL: "api.predge.io" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("is not a valid URL");
    expect(assertUrlIsPublic).not.toHaveBeenCalled();
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("succeeds when the published keyset answers", async () => {
    const result = await testPredge({});

    expect(result).toEqual({ success: true });
    expect(safeFetch).toHaveBeenCalledWith(
      "https://api.predge.io/.well-known/predge-keys.json",
      expect.objectContaining({ plugin: "predge", method: "GET" })
    );
  });

  it("passes a non-2xx status through for the operator to read", async () => {
    safeFetch.mockResolvedValueOnce({ ok: false, status: 503 });

    const result = await testPredge({});

    expect(result.success).toBe(false);
    expect(result.error).toContain("503");
  });
});
