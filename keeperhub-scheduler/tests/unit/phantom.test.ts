import { beforeEach, describe, expect, it, vi } from "vitest";

const apiRequest = vi.fn();
const apiRequestWithAttempts = vi.fn();
vi.mock("../../lib/http-client.js", () => ({
  apiRequest: (...args: unknown[]) => apiRequest(...args),
  apiRequestWithAttempts: (...args: unknown[]) =>
    apiRequestWithAttempts(...args),
}));

import {
  createPhantomExecution,
  failPhantomExecution,
} from "../../lib/phantom.js";

/** The API reply as apiRequestWithAttempts reports it: answered on attempt 1. */
function firstAttempt(data: unknown): { data: unknown; attempts: number } {
  return { data, attempts: 1 };
}

describe("createPhantomExecution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("POSTs a phantom row and returns the new execution id", async () => {
    apiRequestWithAttempts.mockResolvedValue(
      firstAttempt({ executionId: "exec_123" }),
    );

    const result = await createPhantomExecution("wf_1", "schedule");

    expect(result).toEqual({ executionId: "exec_123", alreadyExisted: false });
    const [path, options] = apiRequestWithAttempts.mock.calls[0];
    expect(path).toBe("/api/internal/executions");
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body)).toEqual({
      workflowId: "wf_1",
      status: "phantom",
      triggerSource: "schedule",
    });
  });

  it("forwards userId and dispatchKey when provided (block path)", async () => {
    apiRequestWithAttempts.mockResolvedValue(
      firstAttempt({ executionId: "exec_456" }),
    );

    await createPhantomExecution("wf_1", "block", "owner_1", "block:wf_1:1:99");

    const body = JSON.parse(apiRequestWithAttempts.mock.calls[0][1].body);
    expect(body.userId).toBe("owner_1");
    expect(body.triggerSource).toBe("block");
    expect(body.dispatchKey).toBe("block:wf_1:1:99");
  });

  it("reports alreadyExisted when the API returns it (dedup hit)", async () => {
    apiRequestWithAttempts.mockResolvedValue(
      firstAttempt({ executionId: "exec_existing", alreadyExisted: true }),
    );

    const result = await createPhantomExecution(
      "wf_1",
      "schedule",
      undefined,
      "schedule:s1:2026-01-01T00:00:00.000Z",
    );

    expect(result).toEqual({
      executionId: "exec_existing",
      alreadyExisted: true,
    });
  });

  // After a retry the existing row may be this dispatcher's own, created by an
  // attempt whose reply was lost and therefore never enqueued. Reporting it as
  // fresh makes the caller enqueue; the executor's claim CAS absorbs the rare
  // genuine duplicate, whereas a skip would strand the phantom for the reaper.
  it("does not trust alreadyExisted from a retried attempt", async () => {
    apiRequestWithAttempts.mockResolvedValue({
      data: { executionId: "exec_mine", alreadyExisted: true },
      attempts: 2,
    });

    const result = await createPhantomExecution(
      "wf_1",
      "schedule",
      undefined,
      "schedule:s1:2026-01-01T00:00:00.000Z",
    );

    expect(result).toEqual({ executionId: "exec_mine", alreadyExisted: false });
  });

  it("returns no id and alreadyExisted=false when the API call fails", async () => {
    apiRequestWithAttempts.mockRejectedValue(new Error("api down"));

    const result = await createPhantomExecution("wf_1", "schedule");

    expect(result).toEqual({ alreadyExisted: false });
  });

  // A transport failure and a refusal must stay distinguishable: the first
  // still falls back to the id-less enqueue, the second must not enqueue.
  it("reports a refusal when the platform declines the dispatch", async () => {
    apiRequestWithAttempts.mockResolvedValue(
      firstAttempt({
        refused: true,
        reason: "plan_feature",
        error: "gated action",
      }),
    );

    const result = await createPhantomExecution("wf_1", "schedule");

    expect(result).toEqual({ alreadyExisted: false, refused: "plan_feature" });
    expect(result.executionId).toBeUndefined();
  });

  it("defaults an unlabelled refusal to execution_limit", async () => {
    apiRequestWithAttempts.mockResolvedValue(firstAttempt({ refused: true }));

    const result = await createPhantomExecution("wf_1", "schedule");

    expect(result.refused).toBe("execution_limit");
  });
});

describe("failPhantomExecution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("PATCHes the phantom row to a coded error", async () => {
    apiRequest.mockResolvedValue({ success: true });

    await failPhantomExecution("exec_123", "CS-0001", "dispatch failed");

    const [path, options] = apiRequest.mock.calls[0];
    expect(path).toBe("/api/internal/executions/exec_123");
    expect(options.method).toBe("PATCH");
    expect(JSON.parse(options.body)).toEqual({
      status: "system_error",
      error: "dispatch failed",
      errorCode: "CS-0001",
    });
  });

  it("swallows API errors (the reaper is the backstop)", async () => {
    apiRequest.mockRejectedValue(new Error("api down"));

    await expect(
      failPhantomExecution("exec_123", "CS-0001", "dispatch failed"),
    ).resolves.toBeUndefined();
  });
});
