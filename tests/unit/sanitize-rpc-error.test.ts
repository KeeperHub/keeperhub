import { describe, expect, it } from "vitest";
import {
  formatSanitizedRpcError,
  sanitizeRpcError,
} from "@/lib/rpc/sanitize-rpc-error";

// Fake key - matches the generic 32+ char fallback in scrub-rpc-urls.
const FAKE_KEY = "FAKE_TEST_KEY_DO_NOT_USE_AAAAAAAAAA";
const FAKE_URL = `https://avax-mainnet.g.alchemy.com/v2/${FAKE_KEY}`;

// Top-level regex (biome lint/performance/useTopLevelRegex).
const SERVER_ERROR_SUFFIX_RE = /\(SERVER_ERROR\)$/;

type EthersServerErrorShape = Error & {
  code: string;
  shortMessage: string;
  info?: { requestUrl: string; responseStatus: string };
};

/**
 * Structurally faithful to the ethers 6.16.0 SERVER_ERROR shape: `.message`
 * inlines the full URL with key, `.shortMessage` does not, `.code` is the
 * stable ethers code, and `.info.requestUrl` exposes the URL separately.
 */
function makeEthersServerError(): EthersServerErrorShape {
  const err = new Error(
    "server response 403 Forbidden (request={  }, response={  }, error=null, " +
      `info={ "requestUrl": "${FAKE_URL}", "responseStatus": "403 Forbidden" }, ` +
      "code=SERVER_ERROR, version=6.16.0)"
  ) as EthersServerErrorShape;
  err.code = "SERVER_ERROR";
  err.shortMessage = "server response 403 Forbidden";
  err.info = { requestUrl: FAKE_URL, responseStatus: "403 Forbidden" };
  return err;
}

describe("sanitizeRpcError", () => {
  it("never leaks the key embedded in an ethers SERVER_ERROR.message", () => {
    const result = sanitizeRpcError(makeEthersServerError());
    expect(result.message).not.toContain(FAKE_KEY);
    expect(result.message).not.toContain(FAKE_URL);
  });

  it("preserves the ethers error code for retry-decision callers", () => {
    const result = sanitizeRpcError(makeEthersServerError());
    expect(result.code).toBe("SERVER_ERROR");
  });

  it("returns the ethers shortMessage when no URL is embedded there", () => {
    const result = sanitizeRpcError(makeEthersServerError());
    expect(result.shortMessage).toBe("server response 403 Forbidden");
    // Prefers shortMessage as the .message field too.
    expect(result.message).toBe("server response 403 Forbidden");
  });

  it("sanitizes a plain Error whose .message embeds a URL", () => {
    const err = new Error(`fetch failed: GET ${FAKE_URL}`);
    const result = sanitizeRpcError(err);
    expect(result.message).not.toContain(FAKE_KEY);
    expect(result.code).toBeUndefined();
    expect(result.shortMessage).toBeUndefined();
  });

  it("sanitizes a thrown string containing a URL", () => {
    const result = sanitizeRpcError(`connect ECONNREFUSED at ${FAKE_URL}`);
    expect(result.message).not.toContain(FAKE_KEY);
  });

  it("handles undefined", () => {
    expect(sanitizeRpcError(undefined).message).toBe(
      "Unknown error (no error value)"
    );
  });

  it("handles null", () => {
    expect(sanitizeRpcError(null).message).toBe(
      "Unknown error (no error value)"
    );
  });

  it("handles a thrown number", () => {
    expect(sanitizeRpcError(42).message).toBe("42");
  });

  it("falls back to code when only a code is available", () => {
    expect(sanitizeRpcError({ code: "TIMEOUT" }).message).toBe("TIMEOUT");
  });

  it("falls back to a constant when nothing is available", () => {
    expect(sanitizeRpcError({}).message).toBe("Unknown RPC error");
  });

  it("scrubs URLs that ever appear inside shortMessage too (defensive)", () => {
    const err = {
      code: "SERVER_ERROR",
      shortMessage: `bad gateway at ${FAKE_URL}`,
      message: "bad gateway",
    };
    const result = sanitizeRpcError(err);
    expect(result.shortMessage).not.toContain(FAKE_KEY);
    expect(result.message).not.toContain(FAKE_KEY);
  });
});

describe("formatSanitizedRpcError", () => {
  it("appends the code in parentheses when present", () => {
    const out = formatSanitizedRpcError(makeEthersServerError());
    expect(out).toMatch(SERVER_ERROR_SUFFIX_RE);
    expect(out).not.toContain(FAKE_KEY);
  });

  it("omits the parenthesized code when none is available", () => {
    expect(formatSanitizedRpcError(new Error("boom"))).toBe("boom");
  });

  it("never returns an empty string", () => {
    expect(formatSanitizedRpcError(undefined)).not.toBe("");
    expect(formatSanitizedRpcError(null)).not.toBe("");
    expect(formatSanitizedRpcError({})).not.toBe("");
  });
});
