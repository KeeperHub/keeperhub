import { describe, expect, it } from "vitest";

/**
 * The production defect (PR review, second pass): the executor and
 * workflow-runner Docker stages do not copy instrumentation.ts, so the
 * async-local storage behind getWorkflowErrorContext() was never registered in
 * those processes - currentExecutionId() returned undefined, markBroadcast()
 * dropped the sidecar, and executor.broadcast.latency_ms stayed empty for
 * in-process runs. The bootstrap module is the fix: a side-effect import that
 * registers the storage, the same thing instrumentation.ts register() does in
 * the Next runtime.
 */
describe("workflow error context bootstrap (non-Next processes)", () => {
  it("registers the storage so entered context is readable", async () => {
    // Import the bootstrap for its side effect (register the ALS storage).
    await import("./workflow-error-context-bootstrap");
    const { enterWorkflowErrorContext, getWorkflowErrorContext } =
      await import("@/lib/workflow/executor/error-context");

    // Before: getWorkflowErrorContext() was always undefined in these
    // processes. After: entered context is readable across async legs.
    expect(getWorkflowErrorContext()).toBeUndefined();
    enterWorkflowErrorContext({ execution_id: "exec-boot-1" });
    await Promise.resolve();
    expect(getWorkflowErrorContext()?.execution_id).toBe("exec-boot-1");
  });

  it("makes the execution id resolvable the way markBroadcast reads it", async () => {
    await import("./workflow-error-context-bootstrap");
    const { enterWorkflowErrorContext } = await import(
      "@/lib/workflow/executor/error-context"
    );
    const { currentExecutionId } = await import("./broadcast-marker");

    enterWorkflowErrorContext({ execution_id: "exec-boot-2" });
    expect(currentExecutionId()).toBe("exec-boot-2");
  });
});
