import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockGetCompleted, mockAwaitAtIteration } = vi.hoisted(() => ({
  mockGetCompleted: vi.fn(),
  mockAwaitAtIteration: vi.fn(),
}));

vi.mock("@/lib/workflow/executor/get-completed-step-output", () => ({
  getCompletedStepOutput: mockGetCompleted,
}));

vi.mock("@/lib/workflow/executor/get-completed-step-output.step", () => ({
  awaitCompletedStepOutputAtIterationStep: mockAwaitAtIteration,
}));

import {
  resolveIterationSpuriousRecovery,
  SPURIOUS_RECOVERY_INFLIGHT_TIMEOUT_MS,
  SPURIOUS_RECOVERY_POLL_INTERVAL_MS,
  SPURIOUS_RECOVERY_POLL_TIMEOUT_MS,
} from "@/lib/workflow/executor/iteration-spurious-recovery";

const MAX_RETRIES_ERROR =
  'Step "step//./lib/workflow/nodes/http-request/step//httpRequestStep" exceeded max retries (1 retry)';

function resolve(
  errorMessage: string,
  onPollError: (error: Error) => void = vi.fn()
): Promise<{ output: unknown } | null> {
  return resolveIterationSpuriousRecovery({
    executionId: "exec-1",
    nodeId: "http-trace",
    forEachNodeId: "loop-1",
    iterationIndex: 2,
    errorMessage,
    onPollError,
  });
}

describe("resolveIterationSpuriousRecovery", () => {
  beforeEach(() => {
    mockGetCompleted.mockReset();
    mockAwaitAtIteration.mockReset();
  });

  it("returns the recorded output without polling when the row already exists", async () => {
    mockGetCompleted.mockResolvedValue({ output: { ok: 1 }, source: "db" });

    await expect(resolve(MAX_RETRIES_ERROR)).resolves.toEqual({
      output: { ok: 1 },
    });
    expect(mockGetCompleted).toHaveBeenCalledWith("exec-1", "http-trace", {
      forEachNodeId: "loop-1",
      iterationIndex: 2,
    });
    expect(mockAwaitAtIteration).not.toHaveBeenCalled();
  });

  it("waits for the in-flight attempt of the same iteration on a max-retries error", async () => {
    mockGetCompleted.mockResolvedValue(null);
    mockAwaitAtIteration.mockResolvedValue({ outputRaw: { trace: "0x1" } });

    await expect(resolve(MAX_RETRIES_ERROR)).resolves.toEqual({
      output: { trace: "0x1" },
    });
    expect(mockAwaitAtIteration).toHaveBeenCalledWith(
      "exec-1",
      "http-trace",
      "loop-1",
      2,
      SPURIOUS_RECOVERY_POLL_TIMEOUT_MS,
      SPURIOUS_RECOVERY_POLL_INTERVAL_MS,
      SPURIOUS_RECOVERY_INFLIGHT_TIMEOUT_MS
    );
  });

  it("keeps a recorded null output", async () => {
    mockGetCompleted.mockResolvedValue(null);
    mockAwaitAtIteration.mockResolvedValue({ outputRaw: null });

    await expect(resolve(MAX_RETRIES_ERROR)).resolves.toEqual({
      output: null,
    });
  });

  it("returns null when the poll finds no success row", async () => {
    mockGetCompleted.mockResolvedValue(null);
    mockAwaitAtIteration.mockResolvedValue(null);

    await expect(resolve(MAX_RETRIES_ERROR)).resolves.toBeNull();
  });

  it("does not poll for an error without a max-retries shape", async () => {
    mockGetCompleted.mockResolvedValue(null);

    await expect(resolve("HTTP 500: upstream error")).resolves.toBeNull();
    expect(mockAwaitAtIteration).not.toHaveBeenCalled();
  });

  it("reports a failed poll and returns null", async () => {
    mockGetCompleted.mockResolvedValue(null);
    mockAwaitAtIteration.mockRejectedValue("poll step exceeded max retries");
    const onPollError = vi.fn();

    await expect(resolve(MAX_RETRIES_ERROR, onPollError)).resolves.toBeNull();
    expect(onPollError).toHaveBeenCalledWith(
      new Error("poll step exceeded max retries")
    );
  });
});
