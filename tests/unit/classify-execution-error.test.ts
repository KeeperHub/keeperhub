import { describe, expect, it } from "vitest";

import { classifyExecutionError } from "@/lib/errors/classify";
import { ErrorCategory } from "@/lib/logging";
import { redactAllUrls } from "@/lib/rpc/scrub-rpc-urls";

describe("classifyExecutionError", () => {
  it("classifies a missing integration credential as a user config error", () => {
    const result = classifyExecutionError(
      "Safe API key is required. Configure it in the integration settings."
    );
    expect(result).toEqual({
      errorCategory: ErrorCategory.CONFIGURATION,
      errorType: "user",
      // User-config failures carry no system error code.
      code: null,
    });
  });

  it("classifies a missing network as a user validation error, including step-wrapped forms", () => {
    const bare = classifyExecutionError("Network is required");
    expect(bare).toEqual({
      errorCategory: ErrorCategory.VALIDATION,
      errorType: "user",
      code: null,
    });

    const wrapped = classifyExecutionError(
      "Failed to check balance: Network is required"
    );
    expect(wrapped.errorType).toBe("user");
    expect(wrapped.errorCategory).toBe(ErrorCategory.VALIDATION);
  });

  it("classifies an unsupported network name as a user validation error", () => {
    const result = classifyExecutionError(
      "Unsupported network: polygon. Supported: mainnet, sepolia or numeric chain IDs"
    );
    expect(result).toEqual({
      errorCategory: ErrorCategory.VALIDATION,
      errorType: "user",
      code: null,
    });
  });

  it("keeps RPC failover exhaustion as system even when the provider response mentions an unsupported network", () => {
    const result = classifyExecutionError(
      'Event query failed: RPC failed on both endpoints. Primary: server response 400 Bad Request ({ "message": "Unsupported network: eth" }). Fallback: timeout'
    );
    expect(result).toEqual({
      errorCategory: ErrorCategory.NETWORK_RPC,
      errorType: "system",
      code: "N-0001",
    });
  });

  it("defaults unmatched messages to system so real engine faults still page", () => {
    const result = classifyExecutionError("some unexpected internal failure");
    expect(result.errorType).toBe("system");
    expect(result.errorCategory).toBe(ErrorCategory.WORKFLOW_ENGINE);
  });

  it("classifies null/empty messages as system", () => {
    expect(classifyExecutionError(null).errorType).toBe("system");
    expect(classifyExecutionError("   ").errorType).toBe("system");
  });

  it("classifies an unconfigured condition node as a user config error", () => {
    const result = classifyExecutionError(
      "Condition node has no expression configured. Please add a condition expression."
    );
    expect(result).toEqual({
      errorCategory: ErrorCategory.CONFIGURATION,
      errorType: "user",
      code: null,
    });
  });

  it("classifies an invalid condition expression as a user validation error", () => {
    const result = classifyExecutionError(
      'Condition expression is invalid: unexpected token. Expression: "foo &&"'
    );
    expect(result).toEqual({
      errorCategory: ErrorCategory.VALIDATION,
      errorType: "user",
      code: null,
    });
  });

  it("still classifies RPC failover errors after URL redaction", () => {
    // Error messages have provider URLs fully redacted before
    // classification; the redaction must not disturb the prose the patterns
    // match on.
    const fakeDrpcKey = "FAKE_TEST_KEY_DO_NOT_USE_AAAAAAAAAAAAAAAAAAAA";
    const raw =
      "Event query failed: RPC failed on both endpoints. Primary: could not coalesce error. " +
      `Fallback: server response 400 Bad Request (info={ "requestUrl": "https://lb.drpc.live/ethereum/${fakeDrpcKey}" })`;
    const result = classifyExecutionError(redactAllUrls(raw));
    expect(result).toEqual({
      errorCategory: ErrorCategory.NETWORK_RPC,
      errorType: "system",
      code: "N-0001",
    });
  });
});
