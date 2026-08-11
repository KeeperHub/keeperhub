import { afterEach, describe, expect, it, vi } from "vitest";

const captureMessageMock = vi.fn();
vi.mock("@sentry/nextjs", () => ({
  captureMessage: (message: string, context: unknown): void => {
    captureMessageMock(message, context);
  },
}));

const { withBackstopCapture } = await import("@/lib/security/backstop-capture");

afterEach(() => {
  captureMessageMock.mockReset();
});

function makeBackstopError(message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = "42501";
  return err;
}

describe("withBackstopCapture", () => {
  const ctx = {
    workflowId: "wf_1",
    userId: "u_1",
    source: "manual" as const,
  };

  it("returns insert result when no error", async () => {
    const result = await withBackstopCapture(ctx, () =>
      Promise.resolve({ id: "exec_1" })
    );
    expect(result).toEqual({ id: "exec_1" });
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it("captures + rethrows on deactivated-user backstop reject", async () => {
    const err = makeBackstopError(
      "Workflow owner is deactivated; new executions are not allowed"
    );
    await expect(
      withBackstopCapture(ctx, () => Promise.reject(err))
    ).rejects.toBe(err);
    expect(captureMessageMock).toHaveBeenCalledTimes(1);
    const [message, options] = captureMessageMock.mock.calls[0];
    expect(message).toBe("security.backstop_execution_blocked");
    expect(options).toMatchObject({
      level: "warning",
      tags: { security: "backstop_execution_blocked", source: "manual" },
      user: { id: "u_1" },
      extra: { workflowId: "wf_1", source: "manual" },
    });
  });

  it("captures + rethrows on soft-deleted workflow backstop reject", async () => {
    const err = makeBackstopError(
      "workflow is soft-deleted; new executions are not allowed"
    );
    await expect(
      withBackstopCapture(ctx, () => Promise.reject(err))
    ).rejects.toBe(err);
    expect(captureMessageMock).toHaveBeenCalledTimes(1);
  });

  it("captures any 42501 reject on a wrapped insert (ERRCODE-only gate)", async () => {
    // Detection no longer gates on message substring -- the earlier
    // message-fragment match would silently break if the trigger text was
    // ever reworded. ERRCODE 42501 is rare enough on a workflow_executions
    // INSERT path that the false-positive risk is acceptable; the wrapper
    // is intentionally only applied to those insert sites.
    const err = makeBackstopError("Some other 42501 error");
    await expect(
      withBackstopCapture(ctx, () => Promise.reject(err))
    ).rejects.toBe(err);
    expect(captureMessageMock).toHaveBeenCalledTimes(1);
  });

  it("captures a Drizzle-wrapped 42501 reject (cause chain)", async () => {
    // Regression guard for the live-found bug: Drizzle wraps the driver's
    // PostgresError in a DrizzleQueryError, so the 42501 SQLSTATE sits on
    // `.cause.code`, not the top-level `.code`. A bare top-level check missed
    // every real executor reject and the backstop never fired in production.
    const wrapped = new Error(
      "Failed query: insert into workflow_executions ..."
    ) as Error & { cause: unknown };
    wrapped.cause = makeBackstopError(
      "Workflow owner is deactivated; new executions are not allowed."
    );
    await expect(
      withBackstopCapture(ctx, () => Promise.reject(wrapped))
    ).rejects.toBe(wrapped);
    expect(captureMessageMock).toHaveBeenCalledTimes(1);
    expect(captureMessageMock.mock.calls[0][0]).toBe(
      "security.backstop_execution_blocked"
    );
  });

  it("captures a 42501 nested two levels deep in the cause chain", async () => {
    const inner = makeBackstopError("pg reject");
    const mid = new Error("driver wrap") as Error & { cause: unknown };
    mid.cause = inner;
    const outer = new Error("orm wrap") as Error & { cause: unknown };
    outer.cause = mid;
    await expect(
      withBackstopCapture(ctx, () => Promise.reject(outer))
    ).rejects.toBe(outer);
    expect(captureMessageMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT capture when no 42501 anywhere in the cause chain", async () => {
    const inner = new Error("unique violation") as Error & { code: string };
    inner.code = "23505";
    const wrapped = new Error("orm wrap") as Error & { cause: unknown };
    wrapped.cause = inner;
    await expect(
      withBackstopCapture(ctx, () => Promise.reject(wrapped))
    ).rejects.toBe(wrapped);
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it("does NOT capture for different ERRCODE", async () => {
    const err = new Error("Workflow owner is deactivated") as Error & {
      code: string;
    };
    err.code = "23505"; // unique_violation
    await expect(
      withBackstopCapture(ctx, () => Promise.reject(err))
    ).rejects.toBe(err);
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it("does NOT capture for plain Error without pg fields", async () => {
    const err = new Error("Workflow owner is deactivated");
    await expect(
      withBackstopCapture(ctx, () => Promise.reject(err))
    ).rejects.toBe(err);
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it("does NOT capture for non-Error rejection values", async () => {
    await expect(
      withBackstopCapture(ctx, () => Promise.reject("string rejection"))
    ).rejects.toBe("string rejection");
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it("propagates the original error even if capture itself throws", async () => {
    captureMessageMock.mockImplementationOnce(() => {
      throw new Error("sentry transport failed");
    });
    const err = makeBackstopError("Workflow owner is deactivated");
    // Capture is observability, not a contract. A Sentry transport failure
    // must never shadow the original pg backstop error -- downstream error
    // classifiers and HTTP response codes depend on the ERRCODE 42501 shape.
    await expect(
      withBackstopCapture(ctx, () => Promise.reject(err))
    ).rejects.toBe(err);
  });
});
