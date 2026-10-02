import { describe, expect, it } from "vitest";
import {
  applyErrorClassHint,
  classifyExecutionError,
} from "@/lib/errors/classify";
import { getCustomerRunErrorMessage } from "@/lib/errors/customer-message";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { statusForErrorType } from "@/lib/errors/execution-status";
import {
  boundStoredOutput,
  oversizeStepResult,
  oversizeStoredOutputMessage,
  STEP_OUTPUT_TOO_LARGE_CODE,
  storedOutputOverflow,
} from "@/lib/workflow/executor/stored-output-cap";
import {
  MAX_STORED_OUTPUT_BYTES,
  TRUNCATED_PREVIEW_CHARS,
} from "@/lib/workflow/output-limits";

describe("boundStoredOutput", () => {
  it("passes a value within the limit through JSON-safe", () => {
    const bounded = boundStoredOutput({
      amount: BigInt(10),
      when: new Date(0),
    });
    expect(bounded.oversize).toBeNull();
    expect(bounded.value).toEqual({
      amount: "10",
      when: "1970-01-01T00:00:00.000Z",
    });
  });

  it("keeps null and undefined as null, the way the column was written before", () => {
    expect(boundStoredOutput(null)).toEqual({ value: null, oversize: null });
    expect(boundStoredOutput(undefined)).toEqual({
      value: null,
      oversize: null,
    });
  });

  it("replaces an oversized value with the marker and reports its size", () => {
    const text = "x".repeat(MAX_STORED_OUTPUT_BYTES);
    const bounded = boundStoredOutput({ results: text });
    const expectedBytes = JSON.stringify({ results: text }).length;

    expect(bounded.oversize).toBe(expectedBytes);
    expect(bounded.value).toEqual({
      _truncated: true,
      originalSize: expectedBytes,
      preview: `{"results":"${"x".repeat(TRUNCATED_PREVIEW_CHARS - 12)}`,
    });
  });

  it("measures bytes, not characters", () => {
    // Four bytes per character in UTF-8; the limit is in bytes.
    const bounded = boundStoredOutput("\u{1F600}".repeat(300), 1000);
    expect(bounded.oversize).toBe(1202);
  });

  it("accepts a value exactly at the limit", () => {
    const text = "y".repeat(100 - 2);
    expect(storedOutputOverflow(text, 100)).toBeNull();
    expect(storedOutputOverflow(`${text}z`, 100)).toBe(101);
  });
});

describe("oversizeStepResult", () => {
  it("is a failed step result naming both sizes", () => {
    const result = oversizeStepResult(184_421_952);
    expect(result.success).toBe(false);
    expect(result.code).toBe(STEP_OUTPUT_TOO_LARGE_CODE);
    expect(result.error).toBe(oversizeStoredOutputMessage(184_421_952));
    expect(result.error).toContain("175.9 MiB");
    expect(result.error).toContain("1.0 MiB");
  });

  it("finalises as a user error that shows the customer the actionable text", () => {
    const result = oversizeStepResult(184_421_952);
    expect(result.errorClass).toBe(ExecutionErrorType.USER);

    // The message matches no classifier rule, so on its own the run would be
    // a system fault: it would page, and the customer would see a generic
    // internal error. The tag on the result is what the run finaliser applies
    // over that reading.
    const byMessage = classifyExecutionError(result.error);
    expect(byMessage.errorType).toBe(ExecutionErrorType.SYSTEM);
    const classification = applyErrorClassHint(byMessage, result.errorClass);
    expect(classification.errorType).toBe(ExecutionErrorType.USER);
    expect(classification.code).toBeNull();

    const status = statusForErrorType(classification.errorType);
    expect(status).toBe("error");
    expect(
      getCustomerRunErrorMessage({
        status,
        error: result.error,
        errorType: classification.errorType,
        errorCategory: classification.errorCategory,
        errorCode: classification.code,
      })
    ).toBe(result.error);
  });
});
