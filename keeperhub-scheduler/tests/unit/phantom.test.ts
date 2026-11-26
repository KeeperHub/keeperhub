import { beforeEach, describe, expect, it, vi } from "vitest";

const apiRequest = vi.fn();
const apiRequestWithAttempts = vi.fn();
vi.mock("../../lib/http-client.js", async (importOriginal) => ({
  ApiError: (await importOriginal<typeof import("../../lib/http-client.js")>())
    .ApiError,
  apiRequest: (...args: unknown[]) => apiRequest(...args),
  apiRequestWithAttempts: (...args: unknown[]) =>
    apiRequestWithAttempts(...args),
}));

import { ApiError } from "../../lib/http-client.js";
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

  it("asks for skip-if-running and reports a skipped row", async () => {
    apiRequestWithAttempts.mockResolvedValue(
      firstAttempt({ executionId: "exec_skip", skipped: true }),
    );

    const result = await createPhantomExecution(
      "wf_1",
      "block",
      "owner_1",
      "block:wf_1:1:99",
      { skipIfRunning: true },
    );

    expect(result).toEqual({
      executionId: "exec_skip",
      alreadyExisted: false,
      skipped: true,
    });
    const body = JSON.parse(apiRequestWithAttempts.mock.calls[0][1].body);
    expect(body.skipIfRunning).toBe(true);
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

  it("skips a skip-if-running dispatch when the API call fails, logging the workflow", async () => {
    apiRequestWithAttempts.mockRejectedValue(new Error("statement timeout"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await createPhantomExecution(
      "wf_1",
      "block",
      "owner_1",
      "block:wf_1:1:99",
      { skipIfRunning: true },
    );

    expect(result).toEqual({
      alreadyExisted: false,
      skipped: true,
      skipCheck: "failed",
    });
    expect(String(error.mock.calls[0]?.[0])).toContain("wf_1");
    error.mockRestore();
  });

  it.each([
    [
      "a 5xx",
      new ApiError(
        "POST /api/internal/executions",
        500,
        "Internal Server Error",
      ),
    ],
    [
      "a 404 without the platform's code",
      new ApiError(
        "POST /api/internal/executions",
        404,
        "<html>not found</html>",
      ),
    ],
    [
      "a 403 from authentication",
      new ApiError(
        "POST /api/internal/executions",
        403,
        '{"error":"Forbidden"}',
      ),
    ],
  ])("counts %s as a failed skip check", async (_label, failure) => {
    apiRequestWithAttempts.mockRejectedValue(failure);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await createPhantomExecution(
      "wf_1",
      "block",
      "owner_1",
      "block:wf_1:1:99",
      { skipIfRunning: true },
    );

    expect(result.skipCheck).toBe("failed");
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it.each([
    [
      "workflow_gone",
      404,
      '{"error":"Workflow not found","code":"WORKFLOW_NOT_FOUND"}',
    ],
    [
      "workflow_inactive",
      403,
      '{"error":"This workflow may not run","code":"WORKFLOW_INACTIVE"}',
    ],
  ] as const)(
    "reports %s as its own outcome, not a failure, and logs it once per workflow",
    async (outcome, status, body) => {
      apiRequestWithAttempts.mockRejectedValue(
        new ApiError("POST /api/internal/executions", status, body),
      );
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const workflowId = `wf_${outcome}`;

      for (const block of [1, 2, 3]) {
        const result = await createPhantomExecution(
          workflowId,
          "block",
          "owner_1",
          `block:${workflowId}:1:${block}`,
          { skipIfRunning: true },
        );
        expect(result).toEqual({
          alreadyExisted: false,
          skipped: true,
          skipCheck: outcome,
        });
      }

      expect(error).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledOnce();
      expect(String(log.mock.calls[0]?.[0])).toContain(workflowId);
      error.mockRestore();
      log.mockRestore();
    },
  );

  it("skips a skip-if-running dispatch when the API answers with no id", async () => {
    apiRequestWithAttempts.mockResolvedValue(firstAttempt({}));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await createPhantomExecution(
      "wf_1",
      "block",
      "owner_1",
      "block:wf_1:1:99",
      { skipIfRunning: true },
    );

    expect(result).toEqual({
      alreadyExisted: false,
      skipped: true,
      skipCheck: "failed",
    });
    error.mockRestore();
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
