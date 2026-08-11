import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { logUserError, safeFetch } = vi.hoisted(() => ({
  logUserError: vi.fn(),
  safeFetch: vi.fn(),
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: {
    EXTERNAL_SERVICE: "external_service",
    VALIDATION: "validation",
  },
  logUserError,
}));

vi.mock("@/lib/safe-fetch", () => ({ safeFetch }));

import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import {
  HYPERLIQUID_INFO_URL,
  isEvmAddress,
  postInfo,
} from "@/plugins/hyperliquid/steps/info-request-core";

function jsonResponse(
  data: unknown,
  init: { status?: number; contentType?: string } = {}
): Response {
  return {
    ok: (init.status ?? 200) >= 200 && (init.status ?? 200) < 300,
    status: init.status ?? 200,
    statusText: "OK",
    headers: {
      get: (k: string) =>
        k.toLowerCase() === "content-type"
          ? (init.contentType ?? "application/json")
          : null,
    },
    json: async () => data,
    text: async () => (typeof data === "string" ? data : JSON.stringify(data)),
  } as unknown as Response;
}

beforeEach(() => {
  safeFetch.mockReset();
  logUserError.mockReset();
});

describe("isEvmAddress", () => {
  it("accepts a checksummed 42-char 0x address", () => {
    expect(isEvmAddress("0xdfc24b077bc1425ad1dea75bcb6f8158e10df303")).toBe(
      true
    );
  });

  it("accepts uppercase hex", () => {
    expect(isEvmAddress("0xDFC24B077BC1425AD1DEA75BCB6F8158E10DF303")).toBe(
      true
    );
  });

  it("rejects too-short, too-long, missing prefix, and non-hex inputs", () => {
    expect(isEvmAddress("0xdfc24b077bc1425ad1dea75bcb6f8158e10df30")).toBe(
      false
    );
    expect(isEvmAddress("0xdfc24b077bc1425ad1dea75bcb6f8158e10df3030")).toBe(
      false
    );
    expect(isEvmAddress("dfc24b077bc1425ad1dea75bcb6f8158e10df303")).toBe(
      false
    );
    expect(isEvmAddress("0xZZZZ4b077bc1425ad1dea75bcb6f8158e10df303")).toBe(
      false
    );
    expect(isEvmAddress("")).toBe(false);
    expect(isEvmAddress(undefined)).toBe(false);
    expect(isEvmAddress(null)).toBe(false);
    expect(isEvmAddress(123)).toBe(false);
  });
});

describe("postInfo", () => {
  it("posts JSON body to the Info endpoint and unwraps a 200 JSON response", async () => {
    safeFetch.mockResolvedValue(jsonResponse({ marginSummary: {}, time: 1 }));

    const result = await postInfo(
      { type: "clearinghouseState", user: "0x00" },
      "clearinghouse-state"
    );

    expect(safeFetch).toHaveBeenCalledWith(
      HYPERLIQUID_INFO_URL,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ type: "clearinghouseState", user: "0x00" }),
        plugin: "hyperliquid",
      })
    );
    expect(result).toEqual({
      success: true,
      data: { marginSummary: {}, time: 1 },
    });
    expect(logUserError).not.toHaveBeenCalled();
  });

  it("returns 'HTTP <status>: <body>' envelope and logs EXTERNAL_SERVICE on non-2xx", async () => {
    safeFetch.mockResolvedValue(
      jsonResponse("bad request", { status: 422, contentType: "text/plain" })
    );

    const result = await postInfo({ type: "vaultDetails" }, "vault-details");

    expect(result).toEqual({
      success: false,
      error: "HTTP 422: bad request",
      errorClass: ExecutionErrorType.USER,
    });
    expect(logUserError).toHaveBeenCalledWith(
      "external_service",
      expect.stringContaining("API error"),
      expect.objectContaining({ status: 422 }),
      expect.objectContaining({
        plugin_name: "hyperliquid",
        action_name: "vault-details",
      })
    );
  });

  it("rejects non-JSON 2xx with content-type guard and logs VALIDATION", async () => {
    safeFetch.mockResolvedValue(
      jsonResponse("<html>maintenance</html>", { contentType: "text/html" })
    );

    const result = await postInfo({ type: "referral" }, "referral");

    expect(result).toEqual({
      success: false,
      error: 'Hyperliquid returned non-JSON content-type "text/html"',
      errorClass: ExecutionErrorType.EXTERNAL,
    });
    expect(logUserError).toHaveBeenCalledWith(
      "validation",
      expect.stringContaining("Non-JSON"),
      expect.objectContaining({ contentType: "text/html" }),
      expect.any(Object)
    );
  });

  it("returns parse-error envelope when response.json() throws", async () => {
    safeFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (k: string) =>
          k.toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON at position 0");
      },
      text: async () => "<not json>",
    } as unknown as Response);

    const result = await postInfo({ type: "subAccounts" }, "sub-accounts");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Invalid JSON response");
    }
    expect(logUserError).toHaveBeenCalledWith(
      "validation",
      expect.stringContaining("Failed to parse"),
      expect.any(Error),
      expect.any(Object)
    );
  });

  it("returns thrown-error envelope and logs EXTERNAL_SERVICE on network failure", async () => {
    safeFetch.mockRejectedValue(new Error("ECONNRESET"));

    const result = await postInfo(
      { type: "validatorSummaries" },
      "validator-summaries"
    );

    expect(result).toEqual({
      success: false,
      error: "ECONNRESET",
      errorClass: ExecutionErrorType.EXTERNAL,
    });
    expect(logUserError).toHaveBeenCalledWith(
      "external_service",
      expect.stringContaining("Network error"),
      expect.any(Error),
      expect.any(Object)
    );
  });
});
