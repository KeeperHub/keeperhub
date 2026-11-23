import { describe, expect, it, vi } from "vitest";
import { assignmentToRunnerEnv } from "../warm-pool-protocol";
import { waitForAssignment } from "./warm-pool-client";

const assignment = {
  workflowId: "wf-1",
  executionId: "exec-1",
  input: { blockNumber: 7 },
  triggerType: "block",
  scheduleId: "sched-1",
  correlationId: "abc123",
  receivedAt: 1000,
  observedAt: 900,
};

function response(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
  });
}

function sequence(
  ...steps: Array<Response | Error>
): ReturnType<typeof vi.fn> {
  const fetchImpl = vi.fn();
  for (const step of steps) {
    if (step instanceof Error) {
      fetchImpl.mockRejectedValueOnce(step);
    } else {
      fetchImpl.mockResolvedValueOnce(step);
    }
  }
  return fetchImpl;
}

describe("waitForAssignment", () => {
  it("polls through empty answers until assigned, presenting its token", async () => {
    const fetchImpl = sequence(
      response(204),
      response(204),
      response(200, assignment)
    );
    const onIdle = vi.fn(() => Promise.resolve());

    const outcome = await waitForAssignment({
      claimUrl: "http://10.0.0.5:3080",
      token: "secret-token",
      maxIdleMs: 60_000,
      onIdle,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: () => Promise.resolve(),
    });

    expect(outcome).toEqual({ kind: "assigned", assignment });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(onIdle).toHaveBeenCalledTimes(2);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://10.0.0.5:3080/warm-pool/claim");
    expect(init.method).toBe("POST");
    expect(init.headers["x-warm-pool-token"]).toBe("secret-token");
  });

  it("waits before polling again after an empty answer that came back fast", async () => {
    const sleep = vi.fn(() => Promise.resolve());
    await waitForAssignment({
      claimUrl: "http://10.0.0.5:3080",
      token: "t",
      maxIdleMs: 60_000,
      fetchImpl: sequence(
        response(204),
        response(200, assignment)
      ) as unknown as typeof fetch,
      now: () => 0,
      sleep,
    });
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it("exits when the executor releases it", async () => {
    const outcome = await waitForAssignment({
      claimUrl: "http://10.0.0.5:3080",
      token: "t",
      maxIdleMs: 60_000,
      fetchImpl: sequence(response(410)) as unknown as typeof fetch,
    });
    expect(outcome).toEqual({ kind: "exit", reason: "released by executor" });
  });

  it("exits on an assignment that fails validation", async () => {
    const outcome = await waitForAssignment({
      claimUrl: "http://10.0.0.5:3080",
      token: "t",
      maxIdleMs: 60_000,
      fetchImpl: sequence(
        response(200, { workflowId: "wf-1" })
      ) as unknown as typeof fetch,
    });
    expect(outcome.kind).toBe("exit");
  });

  it("retries an unreachable executor, then gives up after the grace period", async () => {
    let now = 0;
    const fetchImpl = vi.fn(() => {
      now += 1000;
      return Promise.reject(new Error("ECONNREFUSED"));
    });
    const outcome = await waitForAssignment({
      claimUrl: "http://10.0.0.5:3080",
      token: "t",
      maxIdleMs: 600_000,
      unreachableGraceMs: 10_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => now,
      sleep: (ms) => {
        now += ms;
        return Promise.resolve();
      },
    });
    expect(outcome.kind).toBe("exit");
    expect(outcome.kind === "exit" && outcome.reason).toContain(
      "executor unreachable"
    );
  });

  it("recovers when the executor comes back within the grace period", async () => {
    const outcome = await waitForAssignment({
      claimUrl: "http://10.0.0.5:3080",
      token: "t",
      maxIdleMs: 60_000,
      fetchImpl: sequence(
        new Error("ECONNREFUSED"),
        response(503),
        response(200, assignment)
      ) as unknown as typeof fetch,
      sleep: () => Promise.resolve(),
    });
    expect(outcome.kind).toBe("assigned");
  });

  it("exits once its idle lifetime is reached", async () => {
    let now = 0;
    const fetchImpl = vi.fn(() => {
      now += 20_000;
      return Promise.resolve(response(204));
    });
    const outcome = await waitForAssignment({
      claimUrl: "http://10.0.0.5:3080",
      token: "t",
      maxIdleMs: 50_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => now,
    });
    expect(outcome).toEqual({ kind: "exit", reason: "idle lifetime reached" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe("assignmentToRunnerEnv", () => {
  it("produces the env a per-run Job carries, marked as a warm-pool run", () => {
    expect(assignmentToRunnerEnv(assignment)).toEqual({
      WORKFLOW_ID: "wf-1",
      EXECUTION_ID: "exec-1",
      WORKFLOW_INPUT: JSON.stringify({ blockNumber: 7 }),
      TRIGGER_TYPE: "block",
      SCHEDULE_ID: "sched-1",
      KH_CORRELATION_ID: "abc123",
      KH_RECEIVED_AT: "1000",
      KH_OBSERVED_AT: "900",
      KH_DISPATCH_TARGET: "warm-pool",
    });
  });

  it("omits optional fields that are absent", () => {
    const env = assignmentToRunnerEnv({
      workflowId: "wf-1",
      executionId: "exec-1",
      input: {},
      triggerType: "schedule",
    });
    expect(Object.keys(env).sort()).toEqual(
      [
        "EXECUTION_ID",
        "KH_DISPATCH_TARGET",
        "TRIGGER_TYPE",
        "WORKFLOW_ID",
        "WORKFLOW_INPUT",
      ].sort()
    );
  });
});
