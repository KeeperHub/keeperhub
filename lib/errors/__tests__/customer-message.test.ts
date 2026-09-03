import { describe, expect, it } from "vitest";
import { getCustomerRunErrorMessage } from "@/lib/errors/customer-message";
import { ERROR_CODES } from "@/lib/errors/error-codes";

const NETWORK_MESSAGE =
  "Internal network error, please wait 5 minutes and try again.";
const GENERIC_MESSAGE = "Internal error, please wait 5 minutes and try again.";

describe("getCustomerRunErrorMessage", () => {
  it.each([
    "success",
    "running",
    "pending",
    "cancelled",
  ])("returns null for non-error status %s", (status) => {
    expect(
      getCustomerRunErrorMessage({
        status,
        error: "boom",
        errorType: "system",
        errorCategory: "network_rpc",
      })
    ).toBeNull();
  });

  it("returns the raw error for user-config failures", () => {
    expect(
      getCustomerRunErrorMessage({
        status: "error",
        error: "Unresolved template reference(s): {{@nodeId:Foo.bar}}",
        errorType: "user",
        errorCategory: "configuration",
      })
    ).toBe("Unresolved template reference(s): {{@nodeId:Foo.bar}}");
  });

  it("falls back to a generic message for user failures with no error text", () => {
    expect(
      getCustomerRunErrorMessage({
        status: "error",
        error: null,
        errorType: "user",
        errorCategory: "configuration",
      })
    ).toBe("The workflow failed. See the step details below.");
  });

  it("returns the raw error for external dependency failures", () => {
    expect(
      getCustomerRunErrorMessage({
        status: "error",
        error: "HTTP request failed: fetch failed: read ECONNRESET",
        errorType: "external",
        errorCategory: "external_service",
      })
    ).toBe("HTTP request failed: fetch failed: read ECONNRESET");
  });

  it("returns the network message for system network_rpc failures", () => {
    expect(
      getCustomerRunErrorMessage({
        status: "error",
        error: "RPC failed on both endpoints",
        errorType: "system",
        errorCategory: "network_rpc",
      })
    ).toBe(NETWORK_MESSAGE);
  });

  it.each([
    "infrastructure",
    "database",
    "workflow_engine",
    "unknown",
  ])("returns the generic message for system %s failures", (errorCategory) => {
    expect(
      getCustomerRunErrorMessage({
        status: "error",
        error: "something internal",
        errorType: "system",
        errorCategory,
      })
    ).toBe(GENERIC_MESSAGE);
  });

  it("treats null errorType/errorCategory as a generic system failure", () => {
    expect(
      getCustomerRunErrorMessage({
        status: "error",
        error: null,
        errorType: null,
        errorCategory: null,
      })
    ).toBe(GENERIC_MESSAGE);
  });

  it("prefers the registry message for a system failure with a known code", () => {
    expect(
      getCustomerRunErrorMessage({
        status: "error",
        error: "Execution did not start",
        errorType: "system",
        errorCategory: "workflow_engine",
        errorCode: "P-0001",
      })
    ).toBe(ERROR_CODES["P-0001"].customerMessage);
  });

  it("uses the coded message even when the category would map elsewhere", () => {
    // network_rpc would otherwise return NETWORK_MESSAGE; the code wins.
    expect(
      getCustomerRunErrorMessage({
        status: "error",
        error: "RPC failed on both endpoints",
        errorType: "system",
        errorCategory: "network_rpc",
        errorCode: "N-0001",
      })
    ).toBe(ERROR_CODES["N-0001"].customerMessage);
  });

  it("falls back to the generic message for an unknown code", () => {
    expect(
      getCustomerRunErrorMessage({
        status: "error",
        error: "something internal",
        errorType: "system",
        errorCategory: "infrastructure",
        errorCode: "Z-9999",
      })
    ).toBe(GENERIC_MESSAGE);
  });

  it("ignores the code when the run did not fail", () => {
    expect(
      getCustomerRunErrorMessage({
        status: "success",
        error: null,
        errorType: null,
        errorCategory: null,
        errorCode: "P-0001",
      })
    ).toBeNull();
  });
});
